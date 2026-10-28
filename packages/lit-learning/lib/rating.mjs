import { clamp, round, truncate } from './fsx.mjs';
import { stateLabel } from './evidence.mjs';

const AXIS_KEYS = ['internal', 'external', 'sufficiency'];

/** 证据只保留状态机给出的四个维度，不再压成一个布尔。 */
function refs(evidence, field, value, limit = 2) {
  return evidence.resolve(field, value).slice(0, limit).map(entry => ({
    field: entry.field || field,
    requestedField: entry.requestedField || field,
    page: entry.page,
    declaredPage: entry.declaredPage ?? null,
    computedPage: entry.computedPage ?? null,
    segment: entry.segment,
    quote: truncate(entry.quote, 180),
    source: entry.source,
    match: entry.match,
    pageCheck: entry.pageCheck,
    support: entry.support,
    supportStatus: entry.supportStatus || 'unassessed',
    fieldRelation: entry.fieldRelation || 'unknown',
    state: entry.state,
    stateLabel: stateLabel(entry.state),
    reason: entry.reason || '',
    verified: entry.state === 'verified',
  }));
}

function hasValue(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.filter(v => String(v ?? '').trim()).length > 0;
  if (typeof value === 'object') return Object.values(value).some(v => hasValue(v));
  const text = String(value).trim();
  return Boolean(text) && text !== '【待补】' && !/^【待核对/.test(text);
}

/** 证据强弱折算：已核验全分、待核验半分、无正文支持不计分（清单 01）。 */
function weightOf(states) {
  if (states.includes('verified')) return 1;
  if (states.includes('candidate') || states.includes('record')) return 0.5;
  return 0;
}

function bonus({ id, label, points, evidence, field, value }) {
  const cited = refs(evidence, field, value);
  if (!cited.length) {
    return { id, label, points: 0, status: 'missing', evidence: [], weight: 0, evidenceStates: [], note: `资料不足：${field} 没有可回溯的证据` };
  }
  const states = [...new Set(cited.map(ref => ref.state))];
  const weight = weightOf(states);
  const awarded = round(points * weight, 2);
  const note = weight === 1 ? ''
    : weight === 0.5 ? `证据未完成核验（${cited[0].stateLabel}），按半分计`
      : `证据无正文支持，不计分（${cited[0].reason}）`;
  return {
    id, label, points: awarded,
    status: weight === 0 ? 'missing' : 'ok',
    evidence: cited,
    weight,
    evidenceStates: states,
    note,
  };
}

function scopeOf(dataText) {
  const text = String(dataText || '');
  if (/全球|跨国|多国|cross-country|multi-country/i.test(text)) return 'multiCountry';
  const big = /(\d{5,}|百万|million|亿)/i.test(text);
  if (big) return 'singleCountryLarge';
  if (/全国|国家级|上市公司|全样本|nationally representative/i.test(text)) return 'singleCountry';
  if (/单一|某市|某省|一家|单校|single|one university|case study/i.test(text)) return 'singleSetting';
  if (text.trim()) return 'singleCountry';
  return 'unknown';
}

export function scoreInternal(paper, rubric) {
  const axis = rubric.axes.internal;
  const design = paper.extract?.design || {};
  const strategyValue = design.identification?.strategy;
  const strategy = paper.strategy || { id: 'OTHER', label: '其他/未标注' };
  const base = Number(axis.strategyStrength[strategy.id] ?? axis.strategyStrength.OTHER ?? 1);
  const baseEvidence = refs(paper.evidence, 'design.identification.strategy', strategyValue);

  const reasons = [];
  if (!baseEvidence.length) {
    reasons.push({
      text: `识别策略为「${strategy.label}」，但在抽取与正文里都定位不到对应表述。`,
      points: 0, status: 'missing', evidence: [], note: '资料不足：识别策略无证据',
    });
    return { score: 0, reasons, degraded: true, inputs: { strategy: strategy.id, base: 0, baseWeight: 0 } };
  }

  const baseWeight = weightOf(baseEvidence.map(ref => ref.state));
  const basePoints = round(base * baseWeight, 2);
  reasons.push({
    text: baseWeight === 1
      ? `识别策略为「${strategy.label}」（${strategy.family || '未分类'}），基础强度 ${base} 分。`
      : `识别策略为「${strategy.label}」，但正文未直接支持该表述（${baseEvidence[0].reason}），基础分按 ${baseWeight} 折算为 ${basePoints}。`,
    points: basePoints,
    status: baseWeight === 0 ? 'missing' : 'ok',
    evidence: baseEvidence,
    note: baseWeight === 1 ? '' : baseEvidence[0].reason,
  });

  const threats = Array.isArray(design.identification?.threats) ? design.identification.threats.filter(hasValue) : [];
  const robustness = Array.isArray(design.robustness) ? design.robustness.filter(r => hasValue(r?.check)) : [];
  const balance = design.identification?.first_stage_or_balance;
  const cluster = design.cluster_level;

  const bonusSpecs = [
    { id: 'pretrend', field: 'design.identification.first_stage_or_balance', value: balance, active: hasValue(balance) },
    { id: 'threats', field: 'design.identification.threats', value: threats[0], active: threats.length >= 2 },
    { id: 'robustness', field: 'design.robustness', value: robustness[0]?.check, active: robustness.length >= 3 },
    { id: 'cluster', field: 'design.cluster_level', value: cluster, active: hasValue(cluster) },
  ];

  const bonusStates = [];
  for (const spec of bonusSpecs) {
    const declared = (axis.bonuses || []).find(b => b.id === spec.id);
    if (!declared || !spec.active) continue;
    const item = bonus({ id: declared.id, label: declared.label, points: declared.points, evidence: paper.evidence, field: spec.field, value: spec.value });
    bonusStates.push({ id: item.id, weight: item.weight, states: item.evidenceStates, points: item.points });
    reasons.push({
      text: item.status === 'ok'
        ? `${declared.label}（+${item.points}）${item.note ? `，${item.note}` : '。'}`
        : `${declared.label}：${item.note || '没有可回溯证据'}`,
      points: item.points, status: item.status, evidence: item.evidence, note: item.note,
    });
  }

  const total = clamp(reasons.reduce((sum, r) => sum + r.points, 0), 0, axis.max);
  return {
    score: round(total, 2),
    reasons,
    degraded: reasons.some(r => r.status === 'missing'),
    inputs: {
      strategy: strategy.id, base, baseWeight,
      baseState: baseEvidence[0]?.state || 'none',
      baseStates: [...new Set(baseEvidence.map(ref => ref.state))],
      bonusStates,
      threatCount: threats.length, robustCount: robustness.length,
      hasBalance: hasValue(balance), hasCluster: hasValue(cluster),
    },
  };
}

export function scoreExternal(paper, rubric) {
  const axis = rubric.axes.external;
  const design = paper.extract?.design || {};
  const scope = scopeOf(paper.extract?.data);
  const base = Number(axis.scopeBase[scope] ?? 0);
  const dataEvidence = refs(paper.evidence, 'data', paper.extract?.data, 1);

  const reasons = [];
  if (!dataEvidence.length) {
    reasons.push({
      text: '数据来源在抽取与正文里都定位不到，无法判断样本范围。',
      points: 0, status: 'missing', evidence: [], note: '资料不足：data 无证据',
    });
    return { score: 0, reasons, degraded: true, inputs: { scope, base: 0, baseWeight: 0 } };
  }

  const baseWeight = weightOf(dataEvidence.map(ref => ref.state));
  const scopeLabel = {
    multiCountry: '跨国样本', singleCountryLarge: '单国大样本', singleCountry: '单国样本',
    singleSetting: '单一场景/机构', unknown: '样本范围未说明',
  }[scope];
  reasons.push({
    text: `样本为${scopeLabel}，外推基础 ${base} 分${baseWeight === 1 ? '。' : `（证据未核验，按 ${baseWeight} 折算）。`}`,
    points: round(base * baseWeight, 2),
    status: baseWeight === 0 ? 'missing' : 'ok',
    evidence: dataEvidence,
    note: baseWeight === 1 ? '' : dataEvidence[0].reason,
  });

  const hetero = Array.isArray(design.heterogeneity) ? design.heterogeneity.filter(h => hasValue(h?.finding)) : [];
  const mechanism = Array.isArray(design.mechanism) ? design.mechanism.filter(m => hasValue(m?.result)) : [];

  const specs = [
    { id: 'heterogeneity', field: 'design.heterogeneity', value: hetero[0]?.finding, active: hetero.length >= 3 },
    { id: 'mechanism', field: 'design.mechanism', value: mechanism[0]?.result, active: mechanism.length >= 1 },
  ];
  const bonusStates = [];
  for (const spec of specs) {
    const declared = (axis.bonuses || []).find(b => b.id === spec.id);
    if (!declared || !spec.active) continue;
    const item = bonus({ id: declared.id, label: declared.label, points: declared.points, evidence: paper.evidence, field: spec.field, value: spec.value });
    bonusStates.push({ id: item.id, weight: item.weight, states: item.evidenceStates, points: item.points });
    reasons.push({
      text: item.status === 'ok'
        ? `${declared.label}（+${item.points}）${item.note ? `，${item.note}` : '。'}`
        : `${declared.label}：${item.note || '没有可回溯证据'}`,
      points: item.points, status: item.status, evidence: item.evidence, note: item.note,
    });
  }

  const total = clamp(reasons.reduce((sum, r) => sum + r.points, 0), 0, axis.max);
  return {
    score: round(total, 2),
    reasons,
    degraded: reasons.some(r => r.status === 'missing'),
    inputs: {
      scope, base, baseWeight,
      baseState: dataEvidence[0]?.state || 'none',
      baseStates: [...new Set(dataEvidence.map(ref => ref.state))],
      bonusStates,
      heteroCount: hetero.length, mechanismCount: mechanism.length,
    },
  };
}

export function scoreSufficiency(paper, rubric) {
  const axis = rubric.axes.sufficiency;
  const required = axis.requiredFields || [];
  const weights = axis.weights || { fieldCoverage: 0.6, evidenceCoverage: 0.4 };
  const valueOf = field => field.split('.').reduce((node, key) => (node == null ? undefined : node[key]), paper.extract);

  const missing = [];
  let present = 0;
  let evidenced = 0;
  for (const field of required) {
    const value = valueOf(field);
    if (hasValue(value)) present += 1;
    else missing.push(field);

    if (field === 'evidence') {
      if (paper.evidence.verifiedCount > 0) evidenced += 1;
      continue;
    }
    const refsOfField = paper.evidence.resolve(field, value);
    // 只有「已核验」才算证据覆盖；待核验与无正文支持都不算（清单 01）
    if (refsOfField.some(ref => ref.state === 'verified')) evidenced += 1;
  }

  const fieldCoverage = required.length ? present / required.length : 0;
  const evidenceCoverage = required.length ? evidenced / required.length : 0;
  const ratio = fieldCoverage * weights.fieldCoverage + evidenceCoverage * weights.evidenceCoverage;
  let score = round(ratio * axis.max, 2);

  const verified = paper.evidence.verifiedCount;
  const penaltyApplied = verified < (axis.minVerifiedQuotes || 8);
  if (penaltyApplied) score = round(Math.max(0, score - (axis.quotePenalty || 0.5)), 2);

  const sampleRefs = paper.evidence.entries.filter(e => e.state === 'verified').slice(0, 2).map(e => ({
    field: e.field, page: e.page, segment: e.segment, quote: truncate(e.quote, 180),
    source: e.source, match: e.match, pageCheck: e.pageCheck, support: e.support,
    state: e.state, stateLabel: stateLabel(e.state), reason: e.reason, verified: true,
  }));

  const reasons = [{
    text: `字段覆盖 ${present}/${required.length}（${Math.round(fieldCoverage * 100)}%），其中证据已核验的 ${evidenced} 个（${Math.round(evidenceCoverage * 100)}%）；证据核验 ${verified}/${paper.evidence.total} 条（待核验 ${paper.evidence.candidateCount}、无正文支持 ${paper.evidence.unsupportedCount}）。`,
    points: score,
    status: sampleRefs.length ? 'ok' : 'missing',
    evidence: sampleRefs,
    note: missing.length ? `缺字段：${missing.join('、')}` : '',
  }];

  if (missing.length) {
    reasons.push({
      text: `以下字段为空或仍为【待补】，不能作为判断依据：${missing.join('、')}。`,
      points: 0, status: 'missing', evidence: [], note: '资料不足清单',
    });
  }
  if (penaltyApplied) {
    reasons.push({
      text: `已核验证据少于 ${axis.minVerifiedQuotes} 条，扣 ${axis.quotePenalty} 分。`,
      points: 0, status: 'missing', evidence: [], note: '证据密度不足',
    });
  }

  return {
    score,
    reasons,
    degraded: missing.length > 0 || penaltyApplied,
    inputs: {
      present, required: required.length, evidenced,
      fieldCoverage: round(fieldCoverage, 3), evidenceCoverage: round(evidenceCoverage, 3),
      ratio: round(ratio, 3), verified, candidate: paper.evidence.candidateCount,
      unsupported: paper.evidence.unsupportedCount, totalQuotes: paper.evidence.total, missing,
    },
  };
}

export function scoreConstruct(paper, rubric) {
  const spec = rubric.modifiers.construct;
  const vars = Array.isArray(paper.extract?.core_variables) ? paper.extract.core_variables : [];
  const objects = Array.isArray(paper.extract?.design?.variables) ? paper.extract.design.variables : [];
  const defined = objects.filter(v => hasValue(v?.definition));
  const sourced = objects.filter(v => hasValue(v?.definition) && hasValue(v?.source));
  const onlyNames = !objects.length && vars.length > 0;
  const ratio = objects.length ? sourced.length / objects.length : 0;
  const level = onlyNames
    ? { score: 1, label: '核心变量只有名称，缺少定义与数据来源' }
    : (spec.levels.find(l => ratio >= l.min) || spec.levels[spec.levels.length - 1]);

  const evidence = refs(paper.evidence, 'core_variables.0', vars[0], 1);
  const weight = weightOf(evidence.map(ref => ref.state));
  const degraded = ratio < 0.6 || weight === 0 || onlyNames;
  return {
    // 度量效度看的是「抽取里有没有定义与来源」，不因正文定位失败而折半（清单 02）
    score: level.score,
    label: level.label,
    ratio: round(ratio, 2),
    onlyNames,
    status: level.score === 0 ? 'missing' : degraded ? 'candidate' : 'ok',
    reasons: [{
      text: `${level.label}（${defined.length}/${objects.length} 个变量有定义，${sourced.length} 个同时给出数据来源）${weight === 1 ? '。' : '；变量定义有记录，但正文未定位。'}`,
      points: level.score,
      status: level.score === 0 ? 'missing' : degraded ? 'candidate' : 'ok',
      evidence,
      note: weight === 1 ? '' : (evidence[0]?.reason || '资料不足：核心变量无证据'),
    }],
    inputs: { objects: objects.length, defined: defined.length, sourced: sourced.length, onlyNames, evidenceState: evidence[0]?.state || 'none', ratio: round(ratio, 3) },
    degraded,
  };
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 短缩写必须整词匹配，避免 AER 命中 Aerospace；长刊名才允许子串。 */
function journalMatches(lower, candidates) {
  for (const raw of Array.isArray(candidates) ? candidates : []) {
    const needle = String(raw || '').trim().toLowerCase();
    if (!needle) continue;
    if (/^[a-z]{2,5}$/.test(needle)) {
      if (new RegExp(`(?:^|[^a-z])${escapeRegExp(needle)}(?:[^a-z]|$)`).test(lower)) return true;
    } else if (lower.includes(needle)) return true;
  }
  return false;
}

function explicitPublicationStatus(paper) {
  const value = paper?.extract?.publication_status
    ?? paper?.extract?.meta?.publication_status
    ?? paper?.job?.metadata?.publication_status
    ?? paper?.job?.publicationStatus
    ?? '';
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

export function scorePublication(paper, rubric) {
  const spec = rubric.modifiers.publication;
  const journal = String(paper.journal || '').trim();
  const lower = journal.toLowerCase();
  const tiers = Array.isArray(spec.tiers) ? spec.tiers : [];
  const tierOf = kind => tiers.find(t => t.kind === kind);
  const explicit = explicitPublicationStatus(paper);

  let tier;
  let publicationStatus;
  if (explicit) {
    if (explicit === 'top' || explicit === 'toptier') { tier = tierOf('top'); publicationStatus = 'top'; }
    else if (explicit === 'journal' || explicit === 'published') { tier = tierOf('journal'); publicationStatus = 'journal'; }
    else if (explicit === 'workingpaper' || explicit === 'wp') { tier = tierOf('workingPaper'); publicationStatus = 'workingPaper'; }
    else if (explicit === 'preprint' || explicit === 'conference') { tier = tierOf('preprint'); publicationStatus = 'preprint'; }
    else if (explicit === 'none' || explicit === 'unknown') { tier = tierOf('none'); publicationStatus = 'unstated'; }
    else publicationStatus = 'unknown';
  }

  if (!tier) {
    if (!journal) { tier = tierOf('none'); publicationStatus = 'unstated'; }
    else if (journalMatches(lower, spec.topTierMatch)) { tier = tierOf('top'); publicationStatus = 'top'; }
    else if (journalMatches(lower, spec.preprintMatch)) { tier = tierOf('preprint'); publicationStatus = 'preprint'; }
    else if (journalMatches(lower, spec.workingPaperMatch)) { tier = tierOf('workingPaper'); publicationStatus = 'workingPaper'; }
    else {
      // A non-empty journal string alone does not prove peer review. Keep it as
      // an unconfirmed version signal, capped below the working-paper tier.
      tier = { kind: 'unverifiedJournal', score: 1.0, label: '期刊名存在，但未核对同行审查/版本' };
      publicationStatus = 'unverifiedJournal';
    }
  }
  tier = tier || { kind: 'none', score: 0, label: '未标注发表状态' };

  // 书目记录：页码未知就写未知，不再伪造「第 1 页已验证」（清单 02）
  const evidence = paper.evidence.record('meta.journal', journal);
  const inBody = evidence.some(ref => ref.state === 'verified');
  const degraded = !journal || publicationStatus === 'unverifiedJournal' || publicationStatus === 'unknown' || publicationStatus === 'unstated';
  return {
    score: Number(tier.score) || 0,
    label: tier.label,
    kind: tier.kind || publicationStatus,
    publicationStatus,
    explicit: Boolean(explicit),
    status: degraded ? 'candidate' : 'ok',
    inBody,
    limitations: degraded
      ? ['发表状态只作版本风险；期刊名未核对时不能当作同行审查或正式发表证据。']
      : ['发表状态只表示版本/同行审查风险，不单独证明结论可信。'],
    reasons: [{
      text: `发表状态：${journal ? `「${journal}」→ ${tier.label}` : '未标注期刊或工作论文系列'}${inBody ? '（书目信息在正文中出现）' : '（书目记录，正文未定位）'}。`,
      points: Number(tier.score) || 0,
      status: degraded ? 'candidate' : 'ok',
      evidence,
      note: degraded ? '发表状态未完成核对' : '',
    }],
    degraded,
  };
}

export function applyCaps(rubric, axes, modifiers) {
  const applied = [];
  for (const cap of rubric.caps || []) {
    const match = /^\s*(\w+)\s*<\s*([\d.]+)\s*$/.exec(String(cap.when || ''));
    if (!match) continue;
    const [, key, threshold] = match;
    const value = key in axes ? axes[key].score : modifiers[key]?.score ?? 0;
    if (value < Number(threshold)) applied.push({ id: cap.id, grade: cap.grade, reason: cap.reason, value, threshold: Number(threshold) });
  }
  return applied;
}

const ORDER = ['A', 'B', 'C', 'D'];

export function ratePaper(paper, lexicon) {
  const rubric = lexicon.rubric;
  const internal = scoreInternal(paper, rubric);
  const external = scoreExternal(paper, rubric);
  const sufficiency = scoreSufficiency(paper, rubric);
  const construct = scoreConstruct(paper, rubric);
  const publication = scorePublication(paper, rubric);

  const axes = { internal, external, sufficiency };
  const modifiers = { construct, publication };
  const maxTotal = AXIS_KEYS.reduce((sum, key) => sum + rubric.axes[key].max, 0);
  const total = AXIS_KEYS.reduce((sum, key) => sum + axes[key].score, 0);
  const ratio = maxTotal ? total / maxTotal : 0;

  const grade = (rubric.grades || []).find(g => {
    const min = Number(g.minRatio ?? 0);
    const reqOk = Object.entries(g.requires || {}).every(([key, need]) => (axes[key]?.score ?? 0) >= Number(need));
    return ratio >= min && reqOk;
  }) || rubric.grades[rubric.grades.length - 1];

  const rawCaps = applyCaps(rubric, axes, modifiers);
  // 未知期刊不是“已确认的工作论文/未经同行审查”事实。只把它当本库发表
  // 资料未核对的准备度提示，不用它给论文质量加客观封顶（Codex 讨论第 4 条）。
  const suppressedCaps = publication.publicationStatus === 'unverifiedJournal'
    ? rawCaps.filter(cap => cap.id === 'workingPaperCap').map(cap => ({
      ...cap,
      basis: 'library-publication-readiness',
      notQuality: true,
      note: '未知期刊/版本未核对，只提示准备度，不据此判断论文质量。',
    }))
    : [];
  const caps = rawCaps.filter(cap => !(publication.publicationStatus === 'unverifiedJournal' && cap.id === 'workingPaperCap'));
  let finalGrade = grade.id;
  for (const cap of caps) {
    if (ORDER.indexOf(cap.grade) > ORDER.indexOf(finalGrade)) finalGrade = cap.grade;
  }

  const studyType = String(
    paper.extract?.design?.study_type
    || paper.extract?.study_type
    || paper.extract?.design?.kind
    || paper.extract?.meta?.study_type
    || '',
  ).trim();
  const causalApplicability = /理论|描述|概念|综述|theory|theoretical|conceptual|descriptive|review/i.test(studyType)
    || paper.extract?.causal_identification === false
    ? 'not-applicable'
    : 'unknown';

  const rationaleParts = [
    `三轴合计 ${round(total, 2)}/${maxTotal}（${Math.round(ratio * 100)}%），按口径落 ${grade.id} 档；`,
    `内部效度 ${internal.score}、外推性 ${external.score}、资料充分性 ${sufficiency.score}；`,
    `修正项：度量效度 ${construct.score}、发表状态 ${publication.score}。`,
  ];
  if (caps.length) {
    rationaleParts.push(`封顶规则生效：${caps.map(c => `${c.id}→${c.grade}`).join('、')}，最终 ${finalGrade} 档。`);
  }
  if (suppressedCaps.length) {
    rationaleParts.push(`未知期刊只作本库发表资料未核对提示，不据工作论文规则封顶（最终 ${finalGrade} 档）。`);
  }

  const degraded = [
    ...(internal.degraded ? ['内部效度存在无证据判断'] : []),
    ...(external.degraded ? ['外推性存在无证据判断'] : []),
    ...(sufficiency.degraded ? ['资料充分性不足'] : []),
    ...(construct.degraded ? ['度量效度无证据'] : []),
    ...(publication.degraded ? ['发表状态未完成核对'] : []),
  ];

  const gradeMeta = (rubric.grades || []).find(g => g.id === finalGrade) || { label: '', usage: '' };
  const readinessLabel = finalGrade === 'A'
    ? '本库材料准备度较高（引用仍需核对主张、范围与证据）'
    : finalGrade === 'B'
      ? '本库材料可用但需限定条件'
      : finalGrade === 'C'
        ? '本库材料仅作旁证候选'
        : '本库材料暂不足以支撑判断';
  const limitations = [
    'A–D 只表示本库资料准备度，不是论文质量评级，也不是引用许可。',
    '方法名称、稳健性条目数量与发表状态不能单独证明执行质量。',
    ...(causalApplicability === 'not-applicable'
      ? ['该研究被标注为理论/描述性/综述类型，因果识别检查不适用，不能把缺少 RCT/DID 当作论文质量差。']
      : []),
    ...(publication.degraded ? ['发表状态/版本未经核对，引用时必须注明版本。'] : []),
    ...(internal.degraded || external.degraded ? ['部分判断只有字段级或待核验证据，不能当作已验证事实。'] : []),
  ];

  return {
    rubricVersion: rubric.version,
    axes,
    modifiers,
    total: round(total, 2),
    maxTotal,
    ratio: round(ratio, 3),
    grade: finalGrade,
    // A–D 只表示「本库材料准备度」，不是论文质量评级，更不是引用许可（清单 04）。
    // 旧 rubric 词只放 rubricLabel/rubricUsage 供审计，不再作为主展示/许可语句。
    gradeLabel: readinessLabel,
    usage: readinessLabel,
    rubricLabel: gradeMeta.label,
    rubricUsage: gradeMeta.usage,
    readinessLabel,
    readinessUsage: readinessLabel,
    scope: 'library-readiness',
    studyType,
    causalApplicability,
    qualityNotAssessed: causalApplicability === 'not-applicable',
    limitations,
    notCitationLicense: true,
    capped: caps,
    suppressedCaps,
    rationale: rationaleParts.join(''),
    degraded,
    evidenceStates: {
      verified: paper.evidence.verifiedCount,
      candidate: paper.evidence.candidateCount,
      unsupported: paper.evidence.unsupportedCount,
      total: paper.evidence.total,
    },
    reproducible: {
      inputs: {
        internal: internal.inputs,
        external: external.inputs,
        sufficiency: sufficiency.inputs,
        // 保持旧字段类型（数值/标签），新增 detail 不破坏现有消费者。
        construct: construct.ratio,
        constructDetail: construct.inputs || null,
        publication: publication.label,
        publicationDetail: {
          status: publication.publicationStatus,
          explicit: publication.explicit,
          label: publication.label,
          score: publication.score,
        },
        evidenceStates: {
          verified: paper.evidence.verifiedCount,
          candidate: paper.evidence.candidateCount,
          unsupported: paper.evidence.unsupportedCount,
        },
      },
      rubricVersion: rubric.version,
      rubricHash: lexicon.rubricHash || '',
      lexiconVersion: lexicon.strategies.version,
    },
  };
}
