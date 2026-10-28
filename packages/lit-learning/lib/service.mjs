import path from 'node:path';
import { readJsonStrict, readTextStrict, existsSync } from './fsx.mjs';
import { buildLearningLayer, readLearningLayer, inputsFingerprint, GENERATOR_VERSION } from './build.mjs';
import { loadCards, loadLexicon, loadPapers } from './sources.mjs';
import { listPapers } from './catalog.mjs';
import {
  appendLog, buildSchedule, daysBetween, itemVersionOf, ratingAnswer, readLog, sentencePrompt, todayISO, REVIEW_SCHEDULE,
} from './review.mjs';
import { describeConfig, readonlyDeclarations, REQUIRED_HOST_SERVICES } from './config.mjs';
import {
  currentManifest, currentRoot, currentSnapshotSync, layerPath,
} from './storage.mjs';

const PAPER_ID = /^[A-Za-z0-9_.-]{1,120}$/;

function requirePaperId(value) {
  const id = String(value || '');
  if (!PAPER_ID.test(id)) throw new Error('论文标识不合法');
  return id;
}

function invalid(message, code) {
  return Object.assign(new Error(message), { code: code || 'INVALID_REQUEST' });
}

async function readCurrentJson(root, rel) {
  return readJsonStrict(layerPath(root, rel), { optional: true });
}

function legacyItem(item) {
  if (item.answer && item.itemVersion) return item;
  const prompt = item.kind === 'paper-rating'
    ? '不看资料，说出这篇论文的识别优劣、理由和证据位置。'
    : item.kind === 'card'
      ? '不看资料，说出这张卡的核心命题、前提假设，以及它和相邻卡的关系。'
      : '不看资料，复述这道题对应的论文内容。';
  return {
    ...item,
    prompt,
    answer: item.answer || '（旧队列没有保存参考答案；请重建学习层后再练习。）',
    itemVersion: item.itemVersion || '',
    contentStatus: item.contentStatus || 'legacy',
    evidence: item.evidence || [],
  };
}

/** 旧 schedule 只有 prompt，没有 answer/itemVersion：从当前代补齐，绝不把答案继续当题面。 */
async function currentItems(root, schedule) {
  const rows = schedule?.items || [];
  const papers = new Map();
  return Promise.all(rows.map(async item => {
    if (item.answer && item.itemVersion) return item;
    if (item.paperId) {
      if (!papers.has(item.paperId)) {
        papers.set(item.paperId, await readCurrentJson(root, `papers/${item.paperId}.json`));
      }
      const paper = papers.get(item.paperId);
      if (paper && item.kind === 'paper-rating' && paper.rating) {
        const filled = {
          ...legacyItem(item),
          prompt: '不看资料，说出这篇论文的识别优劣、理由和证据位置；再说明这是本库准备度，不是论文质量结论。',
          answer: ratingAnswer(paper.rating),
          contentStatus: paper.rating.degraded?.length ? 'caveat' : 'ok',
        };
        return { ...filled, itemVersion: itemVersionOf(filled) };
      }
      const key = String(item.id || '').split(':').pop();
      const sentence = (paper?.recital?.sentences || []).find(row => row.key === key);
      if (paper && sentence) {
        const filled = {
          ...legacyItem(item),
          prompt: sentencePrompt(key),
          answer: sentence.text || '',
          evidence: sentence.evidence || [],
          contentStatus: sentence.status === 'ok' ? (sentence.evidenceState || 'ok') : (sentence.status || 'incomplete'),
        };
        return { ...filled, itemVersion: itemVersionOf(filled) };
      }
    }
    return legacyItem(item);
  }));
}

export function createService(config) {
  let building = null;
  let buildingMode = null;

  async function build(options = {}) {
    const mode = options.rebuild === true ? 'rebuild' : 'incremental';
    if (building) {
      if (buildingMode === mode) return building;
      throw invalid(`已有 ${buildingMode} 构建在进行；不能把 ${mode} 请求静默折叠进去，请稍后重试。`, 'BUILD_BUSY');
    }
    buildingMode = mode;
    building = buildLearningLayer(config, options).finally(() => {
      building = null;
      buildingMode = null;
    });
    return building;
  }

  async function ensureBuilt() {
    const manifest = await currentManifest(config.learningRoot);
    if (manifest) return { built: false, manifest };
    if (!config.autoBuild) throw new Error('学习层尚未构建；请先调用 build。');
    const result = await build({});
    return { built: true, result };
  }

  async function paperRecord(paperId) {
    const id = requirePaperId(paperId);
    const root = await currentRoot(config.learningRoot);
    const manifest = await readCurrentJson(root, 'manifest.json');
    const listed = (manifest?.outputs?.content || []).includes(`papers/${id}.json`);
    if (manifest && !listed) {
      throw new Error(`这篇不在当前学习层里（可能已被隐藏或删除）：${id}`);
    }
    const data = await readCurrentJson(root, `papers/${id}.json`);
    if (!data) throw new Error(`没有这篇的学习层记录：${id}`);
    return { data, root };
  }

  async function paperFile(paperId) {
    return (await paperRecord(paperId)).data;
  }

  async function reviewQueue(payload = {}, snapshot = null) {
    const root = snapshot?.root || await currentRoot(config.learningRoot);
    const manifest = snapshot?.manifest ?? await readCurrentJson(root, 'manifest.json');
    const schedule = snapshot?.schedule ?? await readCurrentJson(root, REVIEW_SCHEDULE);
    const log = snapshot?.log ?? await readLog(config.learningRoot);
    const today = todayISO();
    const limit = Math.max(1, Math.min(200, Number(payload.limit) || config.review.dailyLimit));
    const rebuilt = buildSchedule({
      items: await currentItems(root, schedule),
      log,
      params: config.review,
      createdOn: manifest?.createdOn || schedule?.createdOn || today,
      today,
      startedOn: schedule?.startedOn || {},
    });
    return { ...rebuilt, queue: rebuilt.queue.slice(0, limit) };
  }

  async function freshness(manifest) {
    if (!manifest) return null;
    try {
      const [lexicon, loaded, cardLib] = await Promise.all([
        loadLexicon(config), loadPapers(config), loadCards(config),
      ]);
      const currentHash = inputsFingerprint({ papers: loaded.papers, cardLib, lexicon });
      return {
        state: currentHash === manifest.inputsHash ? 'fresh' : 'stale',
        stale: currentHash !== manifest.inputsHash,
        currentHash,
        builtHash: manifest.inputsHash || '',
        builtGeneratorVersion: manifest.generatorVersion || null,
        generatorVersion: GENERATOR_VERSION,
        note: currentHash === manifest.inputsHash ? '输入与生成器版本未变' : '输入或生成器版本已变化；刷新界面不等于重建，请手动 build',
      };
    } catch (error) {
      return { state: 'error', stale: true, error: String(error?.message || error).slice(0, 300) };
    }
  }

  async function status() {
    const state = await readLearningLayer(config);
    let review = state.dashboard?.review || null;
    let reviewError = null;
    if (state.exists) {
      try {
        const queue = await reviewQueue({}, {
          root: state.readRoot,
          manifest: state.manifest,
          schedule: state.schedule,
          log: await readLog(config.learningRoot),
        });
        review = queue.counts;
      } catch (error) {
        reviewError = { code: error?.code || 'REVIEW_QUEUE_ERROR', message: String(error?.message || error).slice(0, 300) };
      }
    }
    const fresh = await freshness(state.manifest);
    return {
      plugin: 'dsh-lit-learning',
      learningRoot: config.learningRoot,
      exists: state.exists,
      generation: state.generation || '',
      builtAt: state.manifest?.generatedAt || '',
      contentHash: state.manifest?.contentHash || '',
      counts: state.dashboard?.counts || null,
      ratings: state.dashboard?.ratings || null,
      review,
      reviewError,
      freshness: fresh,
      validation: state.validate?.summary || null,
      readonly: readonlyDeclarations(config),
      config: describeConfig(config),
      requiredHostServices: REQUIRED_HOST_SERVICES,
      preservedOnRebuild: state.manifest?.rebuild?.preserved || [],
    };
  }

  async function recordReview(payload = {}) {
    const itemId = String(payload.itemId || '');
    if (!itemId) throw invalid('缺少 itemId', 'ITEM_ID_REQUIRED');

    // 严格 number 整数；字符串 "3"、2.6、布尔值都不能被 Number() 悄悄转换。
    const grade = payload.grade;
    if (typeof grade !== 'number' || !Number.isInteger(grade) || grade < 0 || grade > 4) {
      throw invalid('grade 必须是 0–4 的整数（0 全忘，4 秒答）', 'GRADE_INVALID');
    }

    const attemptId = typeof payload.attemptId === 'string' ? payload.attemptId.trim() : '';
    if (!attemptId || attemptId.length > 200) {
      throw invalid('attemptId 必须是非空字符串，最多 200 字符', 'ATTEMPT_ID_REQUIRED');
    }
    const itemVersion = typeof payload.itemVersion === 'string' ? payload.itemVersion.trim() : '';
    if (!itemVersion) throw invalid('缺少 itemVersion；请刷新队列后重试', 'ITEM_VERSION_REQUIRED');
    const note = String(payload.note || '').slice(0, 200);
    const source = String(payload.source || 'tool');

    // 成功事件的原回执重放优先于当前条目/版本检查：内容改版或条目移出队列后，客户端仍可确认“已记录”。
    const log = await readLog(config.learningRoot);
    const existing = log.find(row => row.attemptId === attemptId);
    if (existing) {
      const same = existing.itemId === itemId
        && String(existing.itemVersion || '') === itemVersion
        && Number(existing.grade) === grade
        && String(existing.note || '') === note
        && String(existing.source || '') === source;
      if (!same) {
        throw invalid('attemptId 已用于另一次提交，参数不一致（itemId/itemVersion/grade/note/source）', 'ATTEMPT_CONFLICT');
      }
      let replayItem = null;
      let replayQueue = null;
      try {
        replayQueue = await reviewQueue({});
        replayItem = replayQueue.items.find(row => row.id === itemId) || null;
      } catch { /* 原回执已确认；实时队列失败不推翻它 */ }
      return {
        recorded: existing,
        duplicate: true,
        idempotent: true,
        item: replayItem,
        itemVersion,
        dueAt: replayItem?.dueAt || null,
        interval: replayItem?.interval || null,
        todayDue: replayQueue?.counts?.dueToday ?? null,
        review: replayQueue?.counts || null,
        replay: true,
      };
    }

    const root = await currentRoot(config.learningRoot);
    const schedule = await readCurrentJson(root, REVIEW_SCHEDULE);
    const items = await currentItems(root, schedule);
    const item = items.find(row => row.id === itemId);
    if (!item) {
      throw invalid(`复习条目不存在或已失效：${itemId}。请刷新队列后重试。`, 'ITEM_NOT_FOUND');
    }
    if (!item.itemVersion || item.itemVersion !== itemVersion) {
      throw invalid(`复习条目内容已变化（期望 ${item.itemVersion || '无版本'}，收到 ${itemVersion}）。请刷新后重试。`, 'ITEM_VERSION_STALE');
    }

    const result = await appendLog(config.learningRoot, {
      at: new Date().toISOString(),
      itemId,
      itemVersion,
      grade,
      attemptId,
      note,
      source,
    });

    const queue = await reviewQueue({}, { root, manifest: await readCurrentJson(root, 'manifest.json'), schedule });
    const current = queue.items.find(row => row.id === itemId);
    return {
      recorded: result.entry,
      duplicate: result.duplicate,
      idempotent: result.duplicate,
      item: current || null,
      itemVersion,
      dueAt: current?.dueAt || null,
      interval: current?.interval || null,
      todayDue: queue.counts.dueToday,
      review: queue.counts,
    };
  }

  async function invoke(action, payload = {}) {
    switch (action) {
      case 'papers':
        return listPapers(config, payload);
      case 'status':
        return status();
      case 'config':
        return { config: describeConfig(config), readonly: readonlyDeclarations(config), requiredHostServices: REQUIRED_HOST_SERVICES };
      case 'build':
        // acceptCardsHome 是基线门的合法出口（#20）：
        // 没有它，用户只能去删 manifest.json —— 那会把基线永久销毁，门从此静默失效。
        return build({
          rebuild: payload.rebuild === true,
          acceptCardsHome: payload.acceptCardsHome === true,
        });
      case 'validate': {
        const report = await readCurrentJson(await currentRoot(config.learningRoot), 'report/validate.json');
        if (!report) throw new Error('还没有校验报告；先 build。');
        return report;
      }
      case 'dashboard': {
        const state = await readLearningLayer(config);
        if (!state.dashboard) throw new Error('还没有仪表盘；先 build。');
        try {
          const queue = await reviewQueue({}, {
            root: state.readRoot,
            manifest: state.manifest,
            schedule: state.schedule,
            log: await readLog(config.learningRoot),
          });
          return { ...state.dashboard, review: queue.counts };
        } catch (error) {
          return { ...state.dashboard, reviewError: { code: error?.code || 'REVIEW_QUEUE_ERROR', message: String(error?.message || error).slice(0, 300) } };
        }
      }
      case 'paper': {
        const record = await paperRecord(payload.paperId);
        const markdown = await readTextStrict(layerPath(record.root, `papers/${record.data.paperId}.md`), { optional: true });
        return { ...record.data, markdown: markdown || '' };
      }
      case 'recital': {
        if (payload.paperId) return (await paperFile(payload.paperId)).recital;
        const index = await readCurrentJson(await currentRoot(config.learningRoot), 'papers/index.json');
        return index || (await readCurrentJson(await currentRoot(config.learningRoot), 'dashboard.json'))?.counts;
      }
      case 'rating': {
        if (payload.paperId) return (await paperFile(payload.paperId)).rating;
        const dashboard = await readCurrentJson(await currentRoot(config.learningRoot), 'dashboard.json');
        return dashboard?.ratings || null;
      }
      case 'strategies':
        return readCurrentJson(await currentRoot(config.learningRoot), 'indices/strategies.json');
      case 'magnitudes':
        return readCurrentJson(await currentRoot(config.learningRoot), 'indices/magnitudes.json');
      case 'links': {
        const links = await readCurrentJson(await currentRoot(config.learningRoot), 'indices/links.json');
        if (!links) return null;
        if (payload.paperId) return { paperId: payload.paperId, cards: links.byPaper[payload.paperId] || [] };
        if (payload.cardId) return { cardId: payload.cardId, papers: links.byCard[payload.cardId] || [] };
        return { total: links.links.length, orphanCards: links.orphanCards, uncoveredPapers: links.uncoveredPapers, links: links.links };
      }
      case 'map':
        return readCurrentJson(await currentRoot(config.learningRoot), 'map/domain-map.json');
      case 'citations': {
        const all = await readCurrentJson(await currentRoot(config.learningRoot), 'citations.json');
        if (!all) return null;
        if (payload.paperId) return all.papers.find(row => row.paperId === payload.paperId) || null;
        return all;
      }
      case 'review':
        return reviewQueue(payload);
      case 'review_record':
        return recordReview(payload);
      case 'questions': {
        const all = await readCurrentJson(await currentRoot(config.learningRoot), 'exam/questions.json');
        if (!all) return null;
        let rows = all.questions || [];
        if (payload.paperId) rows = rows.filter(row => row.paperId === payload.paperId || (row.targets || []).includes(payload.paperId));
        if (payload.kind) rows = rows.filter(row => row.kind === payload.kind);
        return { total: rows.length, questions: rows };
      }
      case 'gaps': {
        const all = await readCurrentJson(await currentRoot(config.learningRoot), 'gaps/pool.json');
        if (!all) return null;
        const limit = Math.max(1, Math.min(200, Number(payload.limit) || 50));
        return { total: all.total, gaps: (all.gaps || []).slice(0, limit) };
      }
      case 'commonsense': {
        const all = await readCurrentJson(await currentRoot(config.learningRoot), 'commonsense/library.json');
        if (!all) return null;
        const keyword = String(payload.keyword || '').trim();
        const entries = keyword
          ? (all.entries || []).filter(entry => `${entry.label}${entry.fact}${entry.whyItMatters}`.includes(keyword))
          : (all.entries || []);
        return { total: entries.length, entries };
      }
      case 'refresh':
        return build({});
      default:
        throw new Error(`不支持的操作：${action}`);
    }
  }

  return { invoke, status, build, reviewQueue, recordReview, ensureBuilt };
}

/** host /file 专用：同步解析当前代，并按该代 manifest 限定可读文件。 */
export function readLayerFile(config, rel) {
  const clean = String(rel || '').replace(/\\/g, '/');
  if (!clean || clean.includes('..') || clean.startsWith('/') || path.isAbsolute(clean)) {
    throw new Error('文件路径不合法');
  }
  if (!/\.(json|md|html)$/i.test(clean)) throw new Error('只允许读取 json / md / html');
  const snapshot = currentSnapshotSync(config.learningRoot);
  const root = snapshot.root;
  const manifest = snapshot.manifest;
  if (manifest) {
    const listed = new Set([
      ...(manifest.outputs?.content || []),
      ...(manifest.outputs?.state || []),
      'manifest.json',
    ]);
    if (!listed.has(clean)) throw new Error(`文件不在当前学习层清单里：${clean}`);
  }
  // 个人状态不在代际目录里复制，避免构建覆盖运行中的 state；它属于根目录的保留状态。
  const target = clean === 'state.json'
    ? path.resolve(config.learningRoot, clean)
    : path.resolve(root, clean);
  const base = path.resolve(clean === 'state.json' ? config.learningRoot : root);
  if (!target.startsWith(base + path.sep) && target !== base) throw new Error('文件路径越界');
  if (!existsSync(target)) throw new Error(`文件不存在：${clean}`);
  return layerPath(base, path.relative(base, target));
}

export { daysBetween };
