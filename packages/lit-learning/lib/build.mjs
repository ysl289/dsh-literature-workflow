import path from 'node:path';
import fsp from 'node:fs/promises';
import {
  existsSync, listDirsStrict, readJsonStrict, readTextStrict, serialize, sha256,
  writeIfChanged, writeJson, withFileLock,
} from './fsx.mjs';
import { assertBoundaries, describeConfig, readonlyDeclarations, resolveInside } from './config.mjs';
import { loadCards, loadLexicon, loadPapers, normalizeStrategy, stableProjection } from './sources.mjs';
import { ratePaper } from './rating.mjs';
import {
  buildCitations, buildCommonsense, buildCrossQuestions, buildGaps, buildQuestions, buildRecital,
} from './derive.mjs';
import {
  buildDomainMap, buildLinks, buildMagnitudeIndex, buildStrategyIndex,
} from './indices.mjs';
import { buildItems, buildSchedule, ensureLogFile, ensureState, readLog, todayISO, trackItems } from './review.mjs';
import { validateLearningLayer } from './validate.mjs';
import { renderIndexHtml, renderMapHtml, renderPaperMd } from './render.mjs';
import {
  createStaging, currentGeneration, currentManifest, currentSnapshot, discardStaging,
  ensureLegacySnapshot, hasLegacyContent, publishGeneration, layerPath, reclaimGenerations,
} from './storage.mjs';

/** 生成器版本：改动规则导致内容变化时必须抬，否则「陈旧」判断会失真（清单 17）。 */
export const GENERATOR_VERSION = 9;

const CONTENT_DIRS = ['papers', 'indices', 'map', 'exam', 'gaps', 'commonsense'];
const CONTENT_FILES = ['citations.json'];
const STATE_ONLY = ['index.html', 'dashboard.json', 'manifest.json', 'report/validate.json', 'review/schedule.json', 'state.json'];

/** 输入预检：坏 JSON 必须在生成前失败，不能经 readJson 回落成空库。 */
async function assertInputsReadable(config) {
  const dirs = await listDirsStrict(config.jobsDir);
  for (const dir of dirs) {
    const job = await readJsonStrict(path.join(dir, 'job.json'), { optional: true });
    if (!job) continue;
    const local = path.join(dir, 'paper.extract.json');
    const declared = typeof job.extractPath === 'string' ? job.extractPath : '';
    // 与 loadPaper 保持同一套顺序与边界：本地副本优先，声明路径必须真实在 workflowRoot 内。
    if (existsSync(local)) await readJsonStrict(local);
    else if (declared) {
      try {
        await readJsonStrict(resolveInside(config.workflowRoot, declared, 'job.json 声明的抽取文件'));
      } catch (error) {
        if (error?.code === 'PATH_OUTSIDE_ROOT') {
          throw Object.assign(new Error(`论文 ${job.id} 的 extractPath 指向工作流目录之外，已拒绝读取`),
            { code: 'PATH_OUTSIDE_ROOT' });
        }
        throw error;
      }
    }
    await readJsonStrict(path.join(dir, 'pages.json'), { optional: true });
    const localMd = path.join(dir, 'full.md');
    if (existsSync(localMd)) await readTextStrict(localMd);
  }
  await readJsonStrict(path.join(config.cardsHome, 'catalog.json'), { optional: true });
  for (const file of [config.rubricPath, path.join(config.lexiconDir, 'strategies.json'), path.join(config.lexiconDir, 'magnitudes.json'), path.join(config.lexiconDir, 'commonsense.json')]) {
    if (existsSync(file)) await readJsonStrict(file);
  }
}

/** 输入指纹：论文（含正文/分页）、卡片（含正文/人工来源）、口径与词表、生成器版本。 */
export function inputsFingerprint({ papers, cardLib, lexicon }) {
  // 卡片指纹必须覆盖「产物实际用到的一切」，否则就是假的可复现性（QA P2）。
  // 旧版只取 id/title_zh/status/body/sources/manualRefs/dropRefs，
  // 漏了 title_en、aliases、relations —— 而 indices.mjs 正是用这三个字段
  // 算 concept 命中与关系边。于是「改个英文名」会让产物变、输入指纹不变，
  // 幂等检查就会报「输入没变但产物变了」，把一次正常编辑指控成不可复现。
  //
  // 这里直接投影整张卡（去掉 path/mtime 等噪声），而不是再手写一份字段清单：
  // 手写清单每加一个字段就得同步一次，漏一次就是一条假警报。
  const cardDetail = (cardLib.cards || [])
    .map(card => JSON.stringify(stableProjection(card)))
    .sort()
    .join('\u0002');
  return sha256([
    `generator:${GENERATOR_VERSION}`,
    `rubric:${lexicon.rubricHash || ''}`,
    `lexicon:${lexicon.lexiconHash || ''}`,
    `cards:${cardLib.fingerprint}`,
    `cardDetail:${sha256(cardDetail)}`,
    ...papers.map(paper => `${paper.id}:${paper.fingerprint}`),
  ].join('\n'));
}

/** 只清理「上一代清单里列过、这一代不再产出」的内容文件，不对目录盲删（清单 16）。 */
async function reclaimStale(learningRoot, previous, current) {
  const removed = [];
  const before = new Set(previous?.outputs?.content || []);
  for (const rel of before) {
    if (current.has(rel)) continue;
    const target = layerPath(learningRoot, rel);
    try {
      await fsp.rm(target, { force: true });
      removed.push(rel);
    } catch { /* 删不掉不影响本次提交，下次再试 */ }
  }
  return removed.sort();
}

function distribution(ratings) {
  const out = { A: 0, B: 0, C: 0, D: 0 };
  for (const rating of ratings.values()) out[rating.grade] = (out[rating.grade] || 0) + 1;
  return out;
}

function average(values) {
  const list = values.filter(v => Number.isFinite(v));
  if (!list.length) return 0;
  return Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 100) / 100;
}

/**
 * report/build.json 写入失败不允许无声吞：先 console.error，
 * 再带上 reportWriteErrors 诊断字段重试一次；重试仍失败就再报一次错并放弃。
 * 构建结果本身不受影响——报告写不出去是可观测性问题，不是构建失败。
 */
async function writeBuildReport(learningRoot, report) {
  const file = path.join(learningRoot, 'report', 'build.json');
  try {
    await writeJson(file, report);
  } catch (error) {
    const message = String(error?.message || error).slice(0, 500);
    console.error(`[lit-learning] report/build.json 写入失败：${message}`);
    try {
      await writeJson(file, {
        ...report,
        reportWriteErrors: [...(report.reportWriteErrors || []), message],
      });
    } catch (retryError) {
      console.error(`[lit-learning] report/build.json 诊断重写仍失败：${String(retryError?.message || retryError).slice(0, 500)}`);
    }
  }
}

/**
 * 代际构建：先把全部内容与视图写进同一磁盘的 staging，校验/组装完成后再发布。
 * 发布 = 写入 generations/<id> + 根目录兼容视图 + 最后原子替换 .current.json。
 * 中途失败时指针仍指向上一代；读端不会看到半新半旧。
 */
export async function buildLearningLayer(config, { rebuild = false, now = new Date(), acceptCardsHome = false } = {}) {
  const started = Date.now();
  const lockBase = path.join(config.learningRoot, '.build');
  return withFileLock(lockBase, async () => {
    assertBoundaries(config);
    for (const rel of [...CONTENT_DIRS, ...CONTENT_FILES, ...STATE_ONLY, 'review/log.jsonl', 'report/build.json', '.current.json']) layerPath(config.learningRoot, rel);
    await assertInputsReadable(config);
    const existingGeneration = await currentGeneration(config.learningRoot);
    if (!existingGeneration) {
      const rootManifest = await readJsonStrict(path.join(config.learningRoot, 'manifest.json'), { optional: true });
      if (!rootManifest && await hasLegacyContent(config.learningRoot)) {
        throw Object.assign(new Error('学习层根目录有旧输出但没有 manifest，无法确认完整性；请先备份并人工诊断，不会原地覆盖。'), {
          code: 'LEGACY_INCOMPLETE',
        });
      }
      await ensureLegacySnapshot(config.learningRoot);
    }

    const lexicon = await loadLexicon(config);
    const { papers, skipped } = await loadPapers(config);
    const cardLib = await loadCards(config);
    const today = todayISO(now);

    const previousManifest = await currentManifest(config.learningRoot);
    const state = await ensureState(config.learningRoot, today);
    await ensureLogFile(config.learningRoot);

    const recitalByPaper = new Map();
    const ratings = new Map();
    const citationsByPaper = new Map();
    const questionsByPaper = new Map();

    for (const paper of papers) {
      paper.strategy = normalizeStrategy(paper.extract?.design?.identification?.strategy, lexicon.strategies);
      const recital = buildRecital(paper);
      const rating = ratePaper(paper, lexicon);
      const citations = buildCitations(paper, rating, recital);
      recitalByPaper.set(paper.id, recital);
      ratings.set(paper.id, rating);
      citationsByPaper.set(paper.id, citations);
      questionsByPaper.set(paper.id, buildQuestions(paper, rating, recital));
    }

    const links = buildLinks(papers, cardLib.cards);
    const map = buildDomainMap(papers, cardLib.cards, links, lexicon, ratings);
    const strategies = buildStrategyIndex(papers, lexicon, ratings);
    const magnitudes = buildMagnitudeIndex(papers, lexicon, ratings);
    const gaps = buildGaps(papers, cardLib.cards, ratings, links);
    const commonsense = buildCommonsense(papers, cardLib.cards, lexicon);
    const crossQuestions = buildCrossQuestions(papers, ratings);
    const questions = [...papers.flatMap(p => questionsByPaper.get(p.id)), ...crossQuestions];

    for (const paper of papers) {
      paper.gaps = gaps.filter(g => g.from === paper.id);
      paper.cards = cardLib.cards.filter(c => (links.byPaper[paper.id] || []).includes(c.id));
    }

    const items = buildItems(papers, cardLib.cards, recitalByPaper, ratings);
    const tracked = await trackItems(config.learningRoot, state, items, today, { persist: false });
    const log = await readLog(config.learningRoot);
    const schedule = buildSchedule({
      items, log, params: config.review, createdOn: state.createdOn, today,
      startedOn: tracked.state.items || {},
    });

    // ── 组装内容文件 ───────────────────────────────────────────
    const artifacts = new Map();
    const add = (rel, text) => artifacts.set(rel, String(text).replace(/\r\n/g, '\n'));

    for (const paper of papers) {
      const payload = {
        schema: 1,
        paperId: paper.id,
        citation: { apa: paper.apa, authors: paper.authors, year: paper.year, journal: paper.journal, doi: paper.doi },
        title: paper.title,
        status: paper.status,
        stage: paper.stage,
        readiness: paper.readiness || null,
        source: { jobId: paper.jobId || paper.id, kind: paper.sourceKind || '', citationUnit: paper.citationUnit || 'unknown' },
        strategy: paper.strategy,
        recital: recitalByPaper.get(paper.id),
        rating: ratings.get(paper.id),
        citations: citationsByPaper.get(paper.id),
        questions: questionsByPaper.get(paper.id),
        cards: (links.byPaper[paper.id] || []).map(id => {
          const card = cardLib.cards.find(c => c.id === id);
          const link = links.links.find(l => l.paperId === paper.id && l.cardId === id);
          return { id, title: card?.title_zh || '', shelf: card?.shelf || '', strength: link?.strength, basis: link?.basis || [] };
        }),
        gaps: paper.gaps.map(g => ({ id: g.id, title: g.title, source: g.source })),
        evidence: {
          total: paper.evidence.total,
          verified: paper.evidence.verifiedCount,
          fields: [...paper.evidence.byField.keys()].sort(),
        },
        fingerprint: paper.fingerprint,
      };
      add(`papers/${paper.id}.json`, serialize(payload));
      add(`papers/${paper.id}.md`, renderPaperMd({
        paper, recital: payload.recital, rating: payload.rating, citations: payload.citations,
        questions: payload.questions, links: links.links.filter(l => l.paperId === paper.id), cards: cardLib.cards,
      }));
    }

    add('indices/strategies.json', serialize(strategies));
    add('indices/magnitudes.json', serialize(magnitudes));
    add('indices/links.json', serialize(links));
    add('map/domain-map.json', serialize(map));
    add('map/domain-map.html', renderMapHtml(map));
    add('citations.json', serialize({
      version: 1,
      note: '引用草稿需要逐主张核对依据、范围与条件；本库准备度不等于引用许可，缺证据时明确标记。',
      papers: papers.map(paper => ({
        paperId: paper.id,
        title: paper.title,
        grade: ratings.get(paper.id).grade,
        ...citationsByPaper.get(paper.id),
      })),
    }));
    add('exam/questions.json', serialize({
      version: 1,
      note: '审稿人与答辩问题库：每问都指向抽取里的具体字段，便于回原文找答案。',
      total: questions.length,
      questions,
    }));
    add('gaps/pool.json', serialize({
      version: 1,
      note: '选题缺口池：来源分「作者自述 / 局限外推 / 卡片未被覆盖 / 评级驱动」，难度 1 易到 3 难。',
      total: gaps.length,
      gaps,
    }));
    add('commonsense/library.json', serialize({
      version: 1,
      note: '数据与制度常识库：只收本批论文或卡片真正用到的条目，未命中的不写入。',
      total: commonsense.length,
      entries: commonsense,
    }));

    // ── 内容指纹 ───────────────────────────────────────────────
    const contentHash = sha256([...artifacts.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([rel, text]) => `${rel}:${sha256(text)}`)
      .join('\n'));

    const artifactsObject = Object.fromEntries(artifacts);
    const inputsHash = inputsFingerprint({ papers, cardLib, lexicon });

    // ── 校验 ───────────────────────────────────────────────────
    // 论文「消失」要按原因分级（安全 #19/#22）：
    //   已隐藏            → 用户明确意图，不算退化
    //   目录还在但读不出来 → 事故（extract/job 损坏），要抓的就是这个
    //   目录整个没了      → 有意删除（撤稿/误入/换范围），属正常操作
    // 旧版把三种混成一个 gone 列表，于是「删一篇」会让整个构建失败，
    // 而「配置里显式指定了卡片库」又会把这条一起降级成 warn —— 两头都不对。
    const currentIds = new Set(papers.map(paper => paper.id));
    const hiddenIds = new Set(
      // 稳定判定优先用 hidden 布尔（sources.mjs 会输出），中文字面量只作旧数据兼容。
      skipped.filter(item => (item.hidden === true || item.reason === '已隐藏') && item.id).map(item => String(item.id)),
    );
    const papersGone = (previousManifest?.inputs?.paperIds || [])
      .map(id => String(id))
      .filter(id => !currentIds.has(id))
      .map(id => {
        if (hiddenIds.has(id)) return { id, kind: 'hidden' };
        const dirStillThere = existsSync(path.join(config.jobsDir, id));
        return { id, kind: dirStillThere ? 'broken' : 'removed' };
      });

    const validate = validateLearningLayer({
      config, papers, cards: cardLib.cards, links, map, ratings, recitalByPaper, citationsByPaper,
      questions, gaps, commonsense, artifacts: artifactsObject,
      previousHash: previousManifest?.contentHash || null,
      previousInputsHash: previousManifest?.inputsHash || null,
      // 上一代读的是哪个卡片库、有哪些论文：基线漂移要显式确认（审计 #17 / #19）
      previousCardsHome: previousManifest?.config?.cardsHome || previousManifest?.inputs?.cardsHome || '',
      // 论文减少的分级结果由 papersGone 传下去；隐藏的已在上面剔除，不算退化。
      papersGone,
      // 显式接受本次基线（#20）：有了它，用户不必去删 manifest.json。
      acceptBaseline: acceptCardsHome === true,
      contentHash,
      inputsHash,
    });
    const structural = validate.checks.filter(check => check.layer === 'structure' && check.status === 'fail' && check.level !== 'warn');
    if (structural.length) throw Object.assign(new Error('结构校验未通过，未发布新代：' + structural.map(check => check.label).join('、')), {code:'VALIDATION_STRUCTURE',committed:false});
    const supportAssessed = [...citationsByPaper.values()].every(citations =>
      (citations.claims || []).every(claim => ['confirmed', 'human-confirmed'].includes(claim.supportStatus)));
    const publicationStatus = validate.summary.publishable && supportAssessed ? 'checked' : 'draft';

    const dashboard = {
      version: 1,
      asOf: today,
      createdOn: state.createdOn,
      counts: {
        papers: papers.length,
        cards: cardLib.cards.length,
        strategies: strategies.strategies.length,
        magnitudes: magnitudes.total,
        questions: questions.length,
        gaps: gaps.length,
        commonsense: commonsense.length,
        sentences: papers.length * 4,
      },
      ratings: {
        distribution: distribution(ratings),
        average: {
          internal: average([...ratings.values()].map(r => r.axes.internal.score)),
          external: average([...ratings.values()].map(r => r.axes.external.score)),
          sufficiency: average([...ratings.values()].map(r => r.axes.sufficiency.score)),
        },
      },
      review: {
        dueToday: schedule.counts.dueToday,
        overdue: schedule.counts.overdue,
        total: schedule.counts.total,
        reviewed: schedule.counts.reviewed,
      },
      coverage: {
        recitalComplete: papers.filter(p => recitalByPaper.get(p.id).complete).length,
        evidenceVerified: papers.reduce((sum, p) => sum + p.evidence.verifiedCount, 0),
        evidenceTotal: papers.reduce((sum, p) => sum + p.evidence.total, 0),
        linkedPapers: papers.filter(p => (links.byPaper[p.id] || []).length).length,
      },
      map: map.stats,
      validation: {
        publicationStatus,
        ok: validate.summary.ok,
        publishable: validate.summary.publishable,
        errors: validate.summary.errors,
        warnings: validate.summary.warnings,
        na: validate.summary.na,
      },
      contentHash,
      inputs: {
        workflowRoot: config.workflowRoot,
        cardsHome: config.cardsHome,
        cardsHomeSource: config.cardsHomeSource || 'unknown',
        learningRoot: config.learningRoot,
        paperIds: papers.map(p => p.id),
        // 实际选中了哪个抽取文件必须落进清单（QA #4）：
        // 本地副本优先、声明路径只作 fallback，这个顺序是行为改变，
        // 不记下来事后就分不清「读的是副本」还是「读的是 job.json 声明的外部文件」。
        extractSources: Object.fromEntries(papers.map(p => [p.id, p.extractSource || 'none'])),
        skipped,
        rubricVersion: lexicon.rubric.version,
        strategiesVersion: lexicon.strategies.version,
      },
      readonly: readonlyDeclarations(config),
    };

    add('dashboard.json', serialize(dashboard));
    add('report/validate.json', serialize(validate));
    add('review/schedule.json', serialize(schedule));
    add('index.html', renderIndexHtml({
      dashboard, papers, ratings, schedule, gaps, map, links, validate,
    }));

    const generation = `g-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const manifest = {
      publicationStatus,
      schema: 2,
      generation,
      plugin: 'dsh-lit-learning',
      generatedAt: new Date().toISOString(),
      createdOn: state.createdOn,
      generatorVersion: GENERATOR_VERSION,
      inputs: dashboard.inputs,
      inputsHash,
      contentHash,
      incremental: {
        fingerprints: Object.fromEntries(papers.map(p => [p.id, p.fingerprint])),
        recomputed: papers.map(p => p.id),
        written: [],
        unchanged: [],
        reclaimed: [],
      },
      outputs: {
        content: [...artifacts.keys()].filter(rel => !STATE_ONLY.includes(rel)).sort(),
        state: STATE_ONLY.slice().sort(),
      },
      rebuild: {
        command: 'lit_learning build {"rebuild":true}',
        preserved: ['review/log.jsonl', 'state.json'],
        note: '删掉整个学习层目录也能重建；复习记录与首次构建日期会随之丢失，需要保留时先备份。',
      },
      readonly: readonlyDeclarations(config),
      config: describeConfig(config),
      durationMs: Date.now() - started,
    };
    add('manifest.json', serialize(manifest));

    const staging = await createStaging(config.learningRoot);
    let published;
    try {
      for (const [rel, text] of artifacts) {
        await writeIfChanged(path.join(staging, rel), text);
      }
      published = await publishGeneration(config.learningRoot, staging, {
        generation,
        files: [...artifacts.keys()],
      });
    } catch (error) {
      await discardStaging(staging);
      await writeBuildReport(config.learningRoot, {
        version: 1,
        committed: false,
        at: new Date().toISOString(),
        error: String(error?.message || error).slice(0, 500),
        generation: error?.generation || generation,
        note: '本次构建未提交；.current.json 仍指向上一代，读端不应看到半新半旧。',
      });
      throw error;
    }

    try {
    // 只有发布成功后才推进每项 firstSeen；失败构建不提前占用「今天」。
    // 放在发布之后：即使这里失败，也不能谎称旧代仍是当前代。
    if (tracked.changed) {
      try {
        await writeIfChanged(path.join(config.learningRoot, 'state.json'), serialize(tracked.state));
      } catch (error) {
        error.committed = true;
        error.newGeneration = generation;
        error.generation = generation;
        await writeBuildReport(config.learningRoot, {
          version: 1,
          committed: true,
          at: new Date().toISOString(),
          error: String(error?.message || error).slice(0, 500),
          generation,
          newGeneration: generation,
          note: '新一代已发布，但个人 state.json 写入失败；不要按“保留旧代”恢复，请检查 state 并按新一代继续。',
        });
        throw error;
      }
    }

    // 根目录兼容视图已经写入；这里只回收上一代清单列过、本代不再产出的内容。
    const reclaimed = await reclaimStale(
      config.learningRoot, previousManifest, new Set(artifacts.keys()),
    );
    manifest.incremental.reclaimed = reclaimed;
    // 清单是最后一份可读元数据，但它在发布前已随 generation 写入；这里补上回收结果。
    const contentWritten = published.written.filter(rel => !STATE_ONLY.includes(rel));
    const contentUnchanged = published.unchanged.filter(rel => !STATE_ONLY.includes(rel));
    const currentPath = path.join(published.target, 'manifest.json');
    const finalManifest = {
      ...manifest,
      generation,
      incremental: { ...manifest.incremental, written: contentWritten, unchanged: contentUnchanged, reclaimed },
    };
    await writeIfChanged(currentPath, serialize(finalManifest));
    await writeIfChanged(path.join(config.learningRoot, 'manifest.json'), serialize(finalManifest));

    // 代际回收：留当前代 + 最近 2 代（审计 #7）。
    // 必须在指针推进之后、且已经持有构建锁，才不会删掉别人正在读的代。
    // 失败不拦构建（旧代多留一轮没有危害），但必须可见：failed/error 进 gc 结果与 build.json。
    const gc = await reclaimGenerations(config.learningRoot, { keep: 2 })
      .catch(error => {
        const message = String(error?.message || error).slice(0, 500);
        console.error(`[lit-learning] 代际回收失败：${message}`);
        return {
          removed: [], kept: 0, freedBytes: 0,
          failed: true,
          failedGeneration: String(error?.generation || ''),
          error: message,
        };
      });

    // 「这一代是基准」要写进报告（审计 #19）：
    // 首次构建没有上一代可比，幂等检查只能是 N/A——那不是「通过」，是「还没开始比」。
    const baselineEstablished = !previousManifest?.contentHash;
    await writeBuildReport(config.learningRoot, {
      version: 1,
      committed: true,
      at: new Date().toISOString(),
      generation,
      baselineEstablished,
      note: baselineEstablished
        ? '本代是基准代：幂等检查为 N/A，下一次构建才能真正比较两次产物。'
        : '本代已与上一代比对过，幂等检查有效。',
      generationsRemoved: gc.removed,
      generationsFreedBytes: gc.freedBytes,
      generationsGcFailed: gc.failed === true,
      generationsGcError: gc.failed ? gc.error : '',
      generationsGcFailedGeneration: gc.failed ? (gc.failedGeneration || '') : '',
    });

    return {
      ok: validate.summary.ok,
      committed: true,
      publicationStatus,
      generation,
      baselineEstablished,
      contentHash,
      inputsHash,
      reclaimed,
      generationsRemoved: gc.removed,
      generationsFreedBytes: gc.freedBytes,
      generationsGcFailed: gc.failed === true,
      changed: contentWritten.length > 0,
      written: contentWritten,
      unchanged: contentUnchanged,
      counts: dashboard.counts,
      ratings: dashboard.ratings,
      review: schedule.counts,
      validation: validate.summary,
      checks: validate.checks.map(c => ({ id: c.id, ok: c.ok, detail: c.detail })),
      learningRoot: config.learningRoot,
      skipped,
    };
    } catch (error) {
      error.committed = true;
      error.newGeneration = generation;
      throw error;
    }
  }, { timeoutMs: 60000, samePid: 'fail' });
}

/** 只读状态查询：优先读当前代，不读根目录可能残留的旧文件。 */
export async function readLearningLayer(config) {
  const snapshot = await currentSnapshot(config.learningRoot);
  const root = snapshot.root;
  const manifest = snapshot.manifest;
  const dashboard = await readJsonStrict(layerPath(root, 'dashboard.json'), { optional: true });
  const schedule = await readJsonStrict(layerPath(root, 'review/schedule.json'), { optional: true });
  const validate = await readJsonStrict(layerPath(root, 'report/validate.json'), { optional: true });
  return {
    exists: Boolean(manifest),
    generation: manifest?.generation || snapshot.generation,
    learningRoot: config.learningRoot,
    readRoot: root,
    manifest,
    dashboard,
    schedule,
    validate,
  };
}
