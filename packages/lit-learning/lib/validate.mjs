import { truncate } from './fsx.mjs';
import path from 'node:path';
import { realOrSelf } from './config.mjs';

const LONG_RUN = 300;

function textFieldsOfPaper(paper, recital, rating, citations) {
  const out = [];
  for (const sentence of recital.sentences) out.push({ where: `recital.${sentence.key}`, text: sentence.text });
  for (const level of citations.levels) out.push({ where: `citations.${level.id}`, text: level.text });
  for (const key of ['internal', 'external', 'sufficiency']) {
    for (const reason of rating.axes[key].reasons) out.push({ where: `rating.${key}`, text: reason.text });
  }
  out.push({ where: 'rating.rationale', text: rating.rationale });
  return out.filter(item => String(item.text || '').length > 0);
}

function findLongRun(text, segments) {
  const haystack = String(text || '');
  if (haystack.length < LONG_RUN) return null;
  for (const segment of segments) {
    if (segment.length < LONG_RUN) continue;
    for (let offset = 0; offset + LONG_RUN <= segment.length; offset += 120) {
      const window = segment.slice(offset, offset + LONG_RUN);
      if (haystack.includes(window)) return window.slice(0, 60);
    }
  }
  return null;
}

/**
 * 分层校验（清单 35）。
 * 旧版把「格式对不对」「能不能定位」「主张有没有被支持」「能不能当正式发布」混成一个 ok 布尔，
 * 空库时定位率默认 1，幂等只比相邻内容 hash。这里分四层，各自给 N/A 与失败原因。
 *
 *   structure  格式与结构一致
 *   locatable  证据能定位到页码/段号
 *   supported  主张有证据支持（不是祖先字段、不是无正文支持）
 *   publish    可以当作「当前可信内容」发布
 */
export function validateLearningLayer({
  config, papers, cards, links, map, ratings, recitalByPaper, citationsByPaper, questions, gaps, commonsense = [],
  artifacts, previousHash, contentHash, inputsHash, previousInputsHash,
  previousCardsHome = '', papersGone = [], acceptBaseline = false,
}) {
  const checks = [];
  const push = (id, label, layer, ok, detail, violations = [], extra = {}) => {
    checks.push({
      id, label, layer,
      level: extra.level || 'error',
      status: extra.na ? 'na' : (ok ? 'pass' : 'fail'),
      ok, detail, violations: violations.slice(0, 20), violationCount: violations.length,
      ...(extra.na ? { na: true } : {}),
    });
  };

  const usable = ref => ref.state === 'verified' || ref.state === 'candidate' || ref.state === 'record';
  const located = ref => ref.page != null || ref.segment != null;

  // ── 非空：输入必须真的有东西 ─────────────────────────────
  // 旧版 0 篇论文 / 0 张卡时，所有逐项检查都在空数组上「通过」，
  // 而 publishable 因为 locateRatio===null 回落到 true——「数据是空的」反而报成功。
  // 这是最危险的一种通过：路径指错时它长得和一切正常一模一样。
  //
  // 但「全新安装、还没有论文」也是 0 篇，那时不该拦。区别在于有没有历史产物：
  //   · 之前构建过（previousHash 有值）→ 现在读到 0，这是退化，按 error 拦。
  //   · 从没构建过 → 空库是正常起点，按 warn 提醒，不阻断首次构建。
  // 卡片为 0 单独处理：还没开始建卡时学习层照样能跑，只是覆盖不到卡片，
  // 所以永远只是 warn，由 publishable 去体现「还不到可发布的程度」。
  const hadPreviousBuild = Boolean(previousHash);
  const emptyInputs = [];
  if (!papers.length) emptyInputs.push(`一篇论文都没读到：${config.jobsDir}`);
  if (!cards.length) emptyInputs.push(`一张卡片都没读到：${config.cardsHome}`);
  const papersMissing = !papers.length;
  push('nonempty', '输入非空', 'structure', emptyInputs.length === 0,
    emptyInputs.length
      ? `${emptyInputs.join('；')}。${papersMissing
        ? (hadPreviousBuild
          ? '上次构建还有论文，这次一篇都没有——多半是路径指错了，不是数据没了'
          : '全新库，还没有可用的论文（首次构建属正常）')
        : '卡片库是空的：学习层能生成，但覆盖不到卡片'}`
      : `${papers.length} 篇论文、${cards.length} 张卡片`,
    emptyInputs,
    { level: papersMissing && hadPreviousBuild ? 'error' : 'warn' });

  // ── structure ────────────────────────────────────────────
  const noReason = [];
  for (const paper of papers) {
    const rating = ratings.get(paper.id);
    for (const key of ['internal', 'external', 'sufficiency']) {
      if (!rating.axes[key].reasons.length) noReason.push(`${paper.id} · ${key} 没有理由`);
    }
    if (!String(rating.rationale || '').trim()) noReason.push(`${paper.id} · 等级没有说明`);
  }
  push('reasons', '无缺理由', 'structure', noReason.length === 0,
    noReason.length ? `${noReason.length} 处缺理由` : '每个轴与等级都有成文理由', noReason);

  const paperIds = new Set(papers.map(p => p.id));
  const cardIds = new Set(cards.map(c => c.id));
  const dangling = [];
  for (const link of links.links) {
    if (!paperIds.has(link.paperId)) dangling.push(`关联指向不存在的论文：${link.paperId}`);
    if (!cardIds.has(link.cardId)) dangling.push(`关联指向不存在的卡片：${link.cardId}`);
  }
  for (const edge of map.dangling) dangling.push(`地图边端点缺失：${edge.from} → ${edge.to}`);
  for (const card of cards) {
    for (const relation of card.relations || []) {
      if (relation?.target && !cardIds.has(String(relation.target))) {
        dangling.push(`卡片 ${card.id} 的关系目标不存在：${relation.target}（卡片库自身的问题，学习层只报告不改动）`);
      }
    }
  }
  push('dangling', '无悬空引用', 'structure', dangling.length === 0,
    dangling.length ? `${dangling.length} 处悬空` : '论文、卡片、地图边、关系目标全部有对应实体', dangling);

  const boundary = [];
  if (config.writeCards) boundary.push('配置允许写卡片库：与「只读卡片库」的约定冲突');
  if (config.writeOutsideLearningRoot) boundary.push('配置允许写学习层之外的位置：与「只读边界」冲突');
  push('boundary', '只读边界', 'structure', boundary.length === 0,
    boundary.length ? boundary.join('；') : `写入范围仅限 ${config.learningRoot}`, boundary);

  // ── 基线比对：拆成两条独立检查 ────────────────────────────
  // 换库与删论文是两种不同的事，不能共用一个等级开关（安全 #22 / QA 回归）：
  //   · 换库 → 默认 error（事实基础变了）；显式配置或显式接受时降为 warn。
  //   · 论文变少 → 「目录还在却读不出来」是事故，error；
  //               「目录整个没了」是有意删除，warn 但不阻断（否则删一篇就构建不了）。
  //
  // 能力边界：它防「选错库」，不防「库被改」——同一路径下换掉卡片内容，门不会响。
  // 这里要的是防事故，不是防篡改。
  //
  // 逃生通道（#20）：拦截必须有合法出口，否则用户只能删 manifest.json，
  // 而那正好永久销毁基线、让门从此静默失效——比不装门更糟。
  const explicitConfig = config.cardsHomeSource === 'config';
  const drift = [];
  let driftLevel = 'error';
  if (previousCardsHome) {
    // 比较真实路径：目录联接/符号链接指向同一个库时不该报「换库」（安全 W4）。
    // 但指向不同目标时仍然会不同，所以真正的换库照样拦得住。
    const a = realOrSelf(path.resolve(previousCardsHome));
    const b = realOrSelf(path.resolve(config.cardsHome));
    const same = process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    if (!same) {
      drift.push(`卡片库变了：上次 ${a}，这次 ${b}（来源：${config.cardsHomeSource || '未知'}）`);
      if (explicitConfig || acceptBaseline) driftLevel = 'warn';
    }
  }
  push('cards-home-drift', '卡片库与上次一致', 'structure', drift.length === 0,
    drift.length
      ? `${drift.join('；')}。${driftLevel === 'warn'
        ? `已按${explicitConfig ? '显式配置' : '显式接受'}放行，本次重建会重写基线`
        : `换库会改变事实基础（卡片内容直接进 links/gaps/ratings）。确认要换，就在配置里显式设置 cardsHome 后重建；不要删 manifest.json`}`
      : `卡片库固定为 ${config.cardsHome}（来源：${config.cardsHomeSource || '未知'}）`,
    drift, { level: driftLevel });

  const goneBroken = (Array.isArray(papersGone) ? papersGone : []).filter(item => item.kind === 'broken');
  const goneRemoved = (Array.isArray(papersGone) ? papersGone : []).filter(item => item.kind === 'removed');
  const goneText = list => list.slice(0, 5).map(item => item.id).join('、')
    + (list.length > 5 ? ` 等 ${list.length} 篇` : '');
  push('papers-gone', '论文没有意外消失', 'structure', goneBroken.length === 0,
    goneBroken.length
      ? `这些论文的目录还在、但读不出抽取或任务文件：${goneText(goneBroken)}——这是损坏，不是删除`
      : (goneRemoved.length
        ? `已删除 ${goneRemoved.length} 篇（${goneText(goneRemoved)}）：目录已不存在，按有意删除处理`
        : '论文与上次一致'),
    goneBroken.map(item => `${item.id}：目录在、文件读不出`));
  push('papers-removed', '论文减少已记录', 'structure', goneRemoved.length === 0,
    goneRemoved.length
      ? `比上次少了 ${goneRemoved.length} 篇：${goneText(goneRemoved)}。删除是正常操作，这里只记录，不影响构建`
      : '没有论文被删除',
    goneRemoved.map(item => item.id), { level: 'warn' });

  // 基线缺失时门会变成空操作（#21）。取不到基线要能被看见，
  // 否则「门装上了但没生效」和「门挡住了」长得一样。
  const baselineMissing = Boolean(previousHash) && !previousCardsHome;
  push('baseline-present', '基线可读', 'structure', !baselineMissing,
    baselineMissing
      ? '上一代清单里没有卡片库基线：本次基线比对无法生效（旧版本清单或字段被删）'
      : '基线可读，比对有效',
    baselineMissing ? ['上一代 manifest 缺少 config.cardsHome'] : [], { level: 'warn' });

  // 落盘记录坏了要单独报（审计 #17）：损坏被当成「没写过」，
  // 等于把一次篡改洗成一次首次运行，之后再也不会有人注意。
  push('cards-home-pin', '卡片库记录可读', 'structure', !config.cardsHomePinProblem,
    config.cardsHomePinProblem
      ? `${config.cardsHomePinProblem}——已重新探测，但这次选择未经确认，请核对 cardsHome`
      : `卡片库记录状态：${config.cardsHomeSource || '未知'}`,
    config.cardsHomePinProblem ? [config.cardsHomePinProblem] : [], { level: 'warn' });

  // 越界抽取路径的拦截在 build 的 assertInputsReadable 里硬失败（fail-closed），
  // 这里不再设一条永远为绿的检查（QA P2）。
  // 留一盏从没观测过任何东西的灯，比不装更危险：它会让「本项已覆盖」看起来成立。
  // loadPaper 里的 catch 只是读取层的容错（status 等只读路径不该因一篇坏 job 全崩），
  // 不是安全边界——真正的门在构建入口。

  // ── locatable ────────────────────────────────────────────
  const noEvidence = [];
  const allRefs = [];
  for (const paper of papers) {
    const rating = ratings.get(paper.id);
    for (const key of ['internal', 'external', 'sufficiency']) {
      for (const reason of rating.axes[key].reasons) {
        if (reason.status !== 'ok') continue;
        const refs = (reason.evidence || []).filter(usable);
        if (!refs.length) noEvidence.push({ paperId: paper.id, axis: key, text: truncate(reason.text, 60) });
        allRefs.push(...refs);
      }
    }
    for (const sentence of recitalByPaper.get(paper.id).sentences) {
      if (sentence.status === 'insufficient') continue;
      const refs = (sentence.evidence || []).filter(usable);
      if (!refs.length) noEvidence.push({ paperId: paper.id, axis: `recital.${sentence.key}`, text: truncate(sentence.text, 60) });
      allRefs.push(...refs);
    }
  }
  push('evidence', '计分理由都挂得上证据', 'locatable', noEvidence.length === 0,
    noEvidence.length ? `${noEvidence.length} 条判断没有任何证据` : '所有计分理由与复述句都有证据引用',
    noEvidence.map(item => `${item.paperId} · ${item.axis} · ${item.text}`));

  const locatedCount = allRefs.filter(located).length;
  const locateRatio = allRefs.length ? locatedCount / allRefs.length : null;
  const fieldOnly = allRefs.filter(ref => !located(ref));
  push('evidence-located', '证据带页码或段号', 'locatable', locateRatio === null ? true : locateRatio >= 0.7,
    locateRatio === null
      ? '空库：没有证据可统计（N/A）'
      : `${locatedCount}/${allRefs.length} 条证据带页码或段号（${Math.round(locateRatio * 100)}%）；其余为字段级（正文定位不到）`,
    fieldOnly.slice(0, 20).map(ref => `${ref.field}：${truncate(ref.quote, 40)}`),
    { level: 'warn', na: locateRatio === null });

  const soft = [];
  for (const paper of papers) {
    const states = paper.evidence;
    if (states.candidateCount) soft.push(`${paper.id}：${states.candidateCount} 条待核验（页号不符或只有父字段证据）`);
    if (states.unsupportedCount) soft.push(`${paper.id}：${states.unsupportedCount} 条无正文支持（抽取改写了原文）`);
  }
  push('evidence-states', '证据状态已分层统计', 'locatable', true,
    soft.length ? soft.join('；') : '全部证据已核验', soft, { level: 'warn' });

  // ── supported ────────────────────────────────────────────
  const claimGaps = [];
  const numericGaps = [];
  for (const paper of papers) {
    const citations = citationsByPaper.get(paper.id);
    const magnitudeClaim = (citations.claims || []).find(claim => claim.id === 'magnitude');
    for (const claim of citations.claims || []) {
      if (claim.support === 'unsupported' || claim.supportStatus === 'unsupported' || claim.locationState === 'unsupported') {
        claimGaps.push(`${paper.id} · ${claim.id} 有证据引用但没有任何正文可定位的证据`);
      }
      if (claim.id === 'magnitude' && !claim.hasEvidence) {
        claimGaps.push(`${paper.id} · ${claim.id} 量级主张没有证据`);
      }
      if (claim.id === 'magnitude' && /\d/.test(String(claim.text || '')) && !claim.hasEvidence) {
        numericGaps.push(`${paper.id} · ${claim.id} 含数值主张但没有对应证据`);
      }
    }
    for (const level of citations.levels) {
      if (level.missingEvidence?.length) {
        claimGaps.push(`${paper.id} · ${level.id} 缺证据的主张：${level.missingEvidence.join('、')}`);
      }
      if (/按本库|评级|准备度/.test(String(level.copyable || ''))) {
        claimGaps.push(`${paper.id} · ${level.id} 的可复制正文里混进了内部评级说明`);
      }
      const numeric = /[−-]?\d+(?:\.\d+)?\s*(?:%|％|倍|个百分点|万亿|亿|万)|[−-]?\d+\.\d+/.test(String(level.copyable || level.text || ''));
      if (numeric && magnitudeClaim && !magnitudeClaim.hasEvidence) {
        numericGaps.push(`${paper.id} · ${level.id} 可复制正文含数值，但量级主张没有证据`);
      }
    }
  }
  push('claims', '引用主张逐条有依据', 'supported', claimGaps.length === 0,
    claimGaps.length ? `${claimGaps.length} 处主张缺依据` : '每条引用主张都能映射到自己的证据', claimGaps);
  push('citation-numbers', '引用中的数值能映射到量级证据', 'supported', numericGaps.length === 0,
    numericGaps.length ? `${numericGaps.length} 处数值主张没有量级证据` : '引文数值都能回溯到量级主张证据', numericGaps);

  const commonsenseEntries = (() => {
    if (Array.isArray(commonsense) && commonsense.length) return commonsense;
    try {
      const raw = artifacts?.['commonsense/library.json'];
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.entries) ? parsed.entries : [];
    } catch { return []; }
  })();
  const unsourcedFacts = commonsenseEntries
    .filter(entry => entry && entry.sourceStatus === 'missing' && !entry.factSource)
    .map(entry => `${entry.id || '未命名'}：${entry.label || entry.fact || '词典事实没有独立来源'}`);
  push('commonsense-source', '常识事实有独立来源', 'supported', unsourcedFacts.length === 0,
    unsourcedFacts.length ? `${unsourcedFacts.length} 条常识事实只有词表/论文情境，没有独立来源` : '常识事实均有独立来源记录',
    unsourcedFacts, { level: 'warn' });
  const uncategorizedGaps = (Array.isArray(gaps) ? gaps : [])
    .filter(gap => gap && (!gap.status || !gap.coverageStatus))
    .map(gap => `${gap.id || '未编号'}：${gap.title || ''}`);
  push('gap-status', '缺口是候选状态而非学界空白', 'supported', uncategorizedGaps.length === 0,
    uncategorizedGaps.length ? `${uncategorizedGaps.length} 条缺口缺少候选/覆盖状态` : '缺口均带候选与覆盖状态',
    uncategorizedGaps, { level: 'warn' });

  const incomplete = [];
  for (const paper of papers) {
    const recital = recitalByPaper.get(paper.id);
    if (!recital.complete) {
      incomplete.push(`${paper.id} 缺 ${recital.missing.map(m => `${m.sentence}:${m.field}`).join('、')}`);
    }
  }
  push('coverage', '四句复述齐全', 'supported', incomplete.length === 0,
    incomplete.length ? `${incomplete.length} 篇有四句缺口（已按资料不足/待核验标注，不补写）` : '每篇都能给出问题/识别/量级/失效四句',
    incomplete, { level: 'warn' });

  const copies = [];
  for (const paper of papers) {
    const texts = textFieldsOfPaper(paper, recitalByPaper.get(paper.id), ratings.get(paper.id), citationsByPaper.get(paper.id));
    for (const item of texts) {
      const hit = findLongRun(item.text, paper.segments);
      if (hit) copies.push(`${paper.id} · ${item.where} 出现 ≥${LONG_RUN} 字连续原文：${hit}…`);
    }
  }
  push('verbatim', '不复制正文', 'supported', copies.length === 0,
    copies.length ? `${copies.length} 处长段复制` : `未发现 ≥${LONG_RUN} 字的连续原文搬运`, copies);

  const abstractDup = [];
  for (const paper of papers) {
    const abstract = String(paper.extract?.abstract || '').trim();
    if (abstract.length < 120) continue;
    const probe = abstract.slice(0, 100);
    for (const [rel, text] of Object.entries(artifacts || {})) {
      if (String(text).includes(probe)) abstractDup.push(`${rel} 含 ${paper.id} 摘要原文`);
    }
  }
  push('abstract', '不引入第二份摘要', 'supported', abstractDup.length === 0,
    abstractDup.length ? `${abstractDup.length} 处整段摘要` : '学习层只做凝练，不复制摘要原文', abstractDup);

  const orphanQuestions = questions.filter(q => q.paperId && !paperIds.has(q.paperId));
  const orphanGaps = gaps.filter(g => g.from && !paperIds.has(g.from));
  push('anchors', '问题与缺口锚定到论文', 'supported', orphanQuestions.length === 0 && orphanGaps.length === 0,
    `问题 ${questions.length} 条、缺口 ${gaps.length} 条；未锚定 ${orphanQuestions.length + orphanGaps.length} 条`,
    [...orphanQuestions.map(q => `问题 ${q.id} 指向不存在的论文`), ...orphanGaps.map(g => `缺口 ${g.id} 指向不存在的论文`)]);

  // ── publish ──────────────────────────────────────────────
  const sameInputs = previousInputsHash ? previousInputsHash === inputsHash : null;
  const stable = previousHash ? previousHash === contentHash : null;
  if (sameInputs === null) {
    push('idempotent', '两次运行产物一致', 'publish', true,
      '首次构建或旧清单没有输入指纹：无法比较（N/A）', [], { level: 'warn', na: true });
  } else if (!sameInputs) {
    push('idempotent', '两次运行产物一致', 'publish', true,
      '输入已变化（论文/卡片/口径/生成器），内容指纹变化属预期（N/A）', [], { level: 'warn', na: true });
  } else {
    push('idempotent', '两次运行产物一致', 'publish', stable === true,
      stable
        ? `输入未变，内容指纹未变：${contentHash.slice(0, 12)}`
        : `输入未变但内容指纹变了：${String(previousHash).slice(0, 12)} → ${contentHash.slice(0, 12)}`,
      stable ? [] : [`上次 ${String(previousHash).slice(0, 12)} → 本次 ${contentHash.slice(0, 12)}`],
      // 输入没变、产物却变了 = 「同一份输入两次跑出两个结果」，这是可复现性本身坏了。
      // 旧版降成 warn，于是不可复现也能 publishable:true（审计 #9）。
      { level: 'error' });
  }

  const blocking = checks.filter(check => check.status === 'fail' && check.level !== 'warn');
  const warnings = checks.filter(check => check.status === 'fail' && check.level === 'warn');
  const na = checks.filter(check => check.status === 'na');
  return {
    version: 2,
    summary: {
      ok: blocking.length === 0,
      // 「可以当正式内容发布」：无阻塞项、输入非空、且证据不是全字段级。
      // 另外：有论文被删、或卡片库与基线不一致时也不算可发布——
      // 这些是 warn 级（不阻断构建），但必须体现在结论里，
      // 否则「警告一堆、publishable:true」正是这次要修的那种假成功（安全 #22）。
      publishable: blocking.length === 0
        && papers.length > 0
        && cards.length > 0
        && locateRatio !== null
        && locateRatio >= 0.7
        && drift.length === 0
        && goneRemoved.length === 0,
      checks: checks.length,
      errors: blocking.length,
      warnings: warnings.length,
      na: na.length,
      contentHash,
      inputsHash: inputsHash || '',
      paperCount: papers.length,
      cardCount: cards.length,
      evidenceLocateRatio: locateRatio === null ? null : Math.round(locateRatio * 100) / 100,
      evidenceStates: papers.reduce((acc, paper) => {
        acc.verified += paper.evidence.verifiedCount;
        acc.candidate += paper.evidence.candidateCount;
        acc.unsupported += paper.evidence.unsupportedCount;
        return acc;
      }, { verified: 0, candidate: 0, unsupported: 0 }),
    },
    checks,
  };
}
