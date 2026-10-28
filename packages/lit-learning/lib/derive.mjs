import { oneLine, truncate } from './fsx.mjs';
import { parseQuantity, signLabel } from './number.mjs';
import { buildLinks } from './indices.mjs';

function ev(paper, field, value, limit = 2, max = 160) {
  return paper.evidence.resolve(field, value).slice(0, limit).map(e => ({
    field: e.field || field,
    requestedField: e.requestedField || field,
    page: e.page,
    declaredPage: e.declaredPage ?? null,
    computedPage: e.computedPage ?? null,
    segment: e.segment,
    quote: truncate(e.quote, max),
    source: e.source,
    match: e.match,
    pageCheck: e.pageCheck,
    support: e.support,
    supportStatus: e.supportStatus || 'unassessed',
    fieldRelation: e.fieldRelation || 'unknown',
    state: e.state,
    stateLabel: e.state === 'verified' ? '已核验' : e.state === 'candidate' ? '待核验' : e.state === 'record' ? '书目记录' : '无正文支持',
    reason: e.reason || '',
    verified: e.state === 'verified',
  }));
}

function first(value) {
  if (Array.isArray(value)) return value.find(v => String(v ?? '').trim()) || '';
  return String(value ?? '');
}

function stripPrefix(text) {
  return String(text || '').replace(/^\s*(RQ|H|L|F|C)\s*\d+\s*[:：.、]\s*/i, '').trim();
}

function signOf(coef) {
  return signLabel(parseQuantity(coef).sign);
}

const trimEnd = value => String(value || '').replace(/[。；;，,、\s]+$/g, '');

function joinClauses(parts) {
  const clean = parts.map(trimEnd).filter(Boolean);
  return clean.length ? `${clean.join('；')}。` : '';
}

function numberSentence(text) {
  const source = String(text || '');
  const sentences = source.split(/(?<=[。；;.!?])/).map(s => s.trim()).filter(Boolean);
  const hit = sentences.find(s => /\d/.test(s) && /(%|％|倍|个百分点|万亿|亿|万)/.test(s));
  return hit ? truncate(hit, 110) : '';
}

// ─────────────────────────────────────────────────────────────
// 四句复述：问题 / 识别 / 量级与方向 / 何时失效
// ─────────────────────────────────────────────────────────────
function worstState(evidence) {
  const states = (evidence || []).map(ref => ref.state);
  if (states.includes('verified')) return 'verified';
  if (states.includes('record')) return 'record';
  if (states.includes('candidate')) return 'candidate';
  if (states.length) return 'unsupported';
  return 'none';
}

export function buildRecital(paper) {
  const extract = paper.extract || {};
  const design = extract.design || {};
  const strategy = paper.strategy || { label: '未标注' };

  // 问题：优先研究问题；只有缺研究问题时才用摘要，并且明确标出来源（清单 10）
  const researchQuestion = stripPrefix(first(extract.research_questions));
  const questionDerived = researchQuestion ? 'research_questions' : (extract.abstract ? 'abstract' : '');
  const questionText = researchQuestion || truncate(extract.abstract, 90);
  const questionEvidence = researchQuestion
    ? ev(paper, 'research_questions.0', first(extract.research_questions), 1)
    : ev(paper, 'abstract', extract.abstract, 1);
  const question = {
    key: 'question',
    label: '问题',
    text: questionText
      ? (researchQuestion ? `它问的是：${truncate(questionText, 120)}` : `摘要里能读出的问题是：${truncate(questionText, 110)}（来自摘要，待回原文核对）`)
      : '',
    status: researchQuestion ? 'ok' : (extract.abstract ? 'candidate' : 'insufficient'),
    derivedFrom: questionDerived,
    evidenceState: worstState(questionEvidence),
    evidence: questionEvidence,
    missing: researchQuestion ? [] : ['research_questions'],
  };

  const assumption = oneLine(design.identification?.assumption, 90);
  const dataHead = oneLine(extract.data, 70);
  const dataPart = dataHead ? (/^数据/.test(dataHead) ? dataHead : `数据是${dataHead}`) : '';
  const identText = joinClauses([
    strategy.label ? `识别靠「${strategy.label}」` : '',
    assumption ? `前提是${assumption}` : '',
    dataPart,
  ]).replace(/。$/, '');
  const identEvidence = [
    ...ev(paper, 'design.identification.strategy', design.identification?.strategy, 1),
    ...ev(paper, 'design.identification.assumption', design.identification?.assumption, 1),
    ...ev(paper, 'data', extract.data, 1),
  ].slice(0, 3);
  const identMissing = [
    design.identification?.strategy ? '' : 'design.identification.strategy',
    design.identification?.assumption ? '' : 'design.identification.assumption',
    extract.data ? '' : 'data',
  ].filter(Boolean);
  const identification = {
    key: 'identification',
    label: '识别',
    text: identText ? `${identText}。` : '',
    // 内容不完整时不能因为“还写得出半句”就标 ok（清单 10）。
    status: identText ? (identMissing.length ? 'candidate' : 'ok') : 'insufficient',
    derivedFrom: 'design.identification',
    evidenceState: worstState(identEvidence),
    evidence: identEvidence,
    missing: identMissing,
  };

  // 量级：主系数来自 key_coefficients；没有系数时才用摘要数字，并降为待核验（清单 10）
  const coefs = Array.isArray(design.key_coefficients) ? design.key_coefficients.filter(c => String(c?.coef ?? '').trim()) : [];
  const lead = coefs[0];
  const parsed = lead ? parseQuantity(lead.coef) : null;
  const seText = (() => {
    const se = oneLine(lead?.se, 24).replace(/[，,；;\s]+$/, '');
    if (!se) return '';
    if (/^【待核对|^【待补/.test(se)) return '（标准误未报告）';
    return `（标准误 ${se}）`;
  })();
  const coefText = lead
    ? `核心系数「${oneLine(lead.term, 40)}」= ${oneLine(lead.coef, 24)}${seText}${lead.stars && lead.stars !== '—' ? `，显著性 ${lead.stars}` : ''}`
    : '';
  const abstractNumber = numberSentence(extract.abstract);
  const magnitudeDerived = coefText ? 'design.key_coefficients' : (abstractNumber ? 'abstract' : '');
  const parseOk = Boolean(parsed && parsed.status === 'ok');
  const magnitude = {
    key: 'magnitude',
    label: '量级与方向',
    text: joinClauses([
      coefText,
      parsed && parsed.status === 'ok' ? `方向${signLabel(parsed.sign)}` : (parsed && parsed.status === 'range' ? `方向${signLabel(parsed.sign)}（区间）` : ''),
      abstractNumber && !coefText ? `${truncate(abstractNumber, 100)}（来自摘要）` : '',
    ]),
    direction: parsed ? signLabel(parsed.sign) : '未标注',
    parse: parsed ? { status: parsed.status, kind: parsed.kind, value: parsed.value, unit: parsed.unit, note: parsed.note } : null,
    status: coefText && parseOk ? 'ok' : (coefText || abstractNumber ? 'candidate' : 'insufficient'),
    derivedFrom: magnitudeDerived,
    // 第一个系数只是“列在第一位”，不冒充作者确认的主估计；多个系数时提示核对。
    principalCoefficient: lead ? {
      index: 0,
      term: oneLine(lead.term, 80),
      coef: oneLine(lead.coef, 40),
      parseStatus: parsed?.status || 'missing',
      needsConfirmation: coefs.length > 1,
    } : null,
    coefficientCandidates: coefs.slice(0, 5).map((coef, index) => ({
      index,
      term: oneLine(coef.term, 80),
      coef: oneLine(coef.coef, 40),
      parseStatus: parseQuantity(coef.coef).status,
    })),
    evidenceState: worstState([
      ...(lead ? ev(paper, 'design.key_coefficients.0.coef', lead.coef, 1) : []),
      ...(abstractNumber ? ev(paper, 'abstract', extract.abstract, 1) : []),
    ]),
    evidence: [
      ...(lead ? ev(paper, 'design.key_coefficients.0.coef', lead.coef, 1) : []),
      ...ev(paper, 'abstract', extract.abstract, 1),
    ].slice(0, 2),
    missing: coefText ? [] : ['design.key_coefficients'],
  };

  const limitation = stripPrefix(first(extract.limitations));
  const threat = first(design.identification?.threats);
  const failText = joinClauses([
    limitation ? `结论在「${truncate(limitation, 90)}」这种情况下会松动` : '',
    threat ? `识别上最怕${truncate(threat, 80)}` : '',
  ]).replace(/。$/, '');
  const failEvidence = [
    ...ev(paper, 'limitations.0', first(extract.limitations), 1),
    ...ev(paper, 'design.identification.threats', threat, 1),
  ].slice(0, 2);
  const failure = {
    key: 'failure',
    label: '何时失效',
    text: failText ? `${failText}。` : '',
    status: failText ? 'ok' : 'insufficient',
    derivedFrom: limitation ? 'limitations' : 'design.identification.threats',
    evidenceState: worstState(failEvidence),
    evidence: failEvidence,
    missing: failText ? [] : ['limitations', 'design.identification.threats'],
  };

  const sentences = [question, identification, magnitude, failure];
  return {
    sentences,
    complete: sentences.every(s => s.status === 'ok'),
    verified: sentences.every(s => s.evidenceState === 'verified'),
    derived: sentences.filter(s => s.status === 'candidate').map(s => s.key),
    missing: sentences.flatMap(s => s.missing.map(field => ({ sentence: s.key, field }))),
    oneLine: sentences.filter(s => s.text).map(s => s.text).join(' '),
  };
}

// ─────────────────────────────────────────────────────────────
// 安全引用表述
// ─────────────────────────────────────────────────────────────
/** 从「Ertugrul, M.; …」「M. Ertugrul; …」里取第一作者姓氏。 */
function firstAuthorSurname(paper) {
  const raw = String(paper.authors || paper.title || '').split(/[;,，、]/)[0].trim();
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    const initials = tokens.slice(0, -1);
    if (initials.every(token => /^[A-Z]\.?$/.test(token))) return tokens[tokens.length - 1];
  }
  return raw;
}

export function buildCitations(paper, rating, recital) {
  const authorYear = `${firstAuthorSurname(paper)}（${paper.year || 'n.d.'}）`;
  const [question, identification, magnitude, failure] = recital.sentences;
  const weak = rating.grade === 'C' || rating.grade === 'D';
  const coreQuestion = truncate(question.text.replace(/^它问的是：|^摘要里能读出的问题是：/, ''), 70).replace(/[。；，、？！\s]+$/, '');

  // 先组装「主张 → 证据」，再拼文本：每条实质主张各自带证据，不用数组 slice 硬截（清单 03）
  const claims = [
    { id: 'question', label: '研究问题', text: coreQuestion, evidence: question.evidence, state: question.evidenceState, derivedFrom: question.derivedFrom },
    { id: 'identification', label: '识别策略与假设', text: identification.text, evidence: identification.evidence, state: identification.evidenceState, derivedFrom: identification.derivedFrom },
    { id: 'magnitude', label: '量级与方向', text: magnitude.text, evidence: magnitude.evidence, state: magnitude.evidenceState, derivedFrom: magnitude.derivedFrom },
    { id: 'failure', label: '失效条件', text: failure.text, evidence: failure.evidence, state: failure.evidenceState, derivedFrom: failure.derivedFrom },
  ].filter(claim => String(claim.text || '').trim()).map(claim => {
    const evidenceStates = [...new Set((claim.evidence || []).map(ref => ref.state))];
    // 位置/页段命中只说明“可定位”，不等于“这条主张已被证据支持”。
    // 旧 state（定位状态）保留；语义支持独立标 unassessed，交给人工/后续核验。
    const locationState = !claim.evidence?.length ? 'none'
      : evidenceStates.includes('verified') ? 'verified'
        : evidenceStates.some(state => state === 'candidate' || state === 'record') ? 'candidate'
          : 'unsupported';
    return {
      ...claim,
      evidenceStates,
      locationState,
      support: 'unassessed',
      supportStatus: 'unassessed',
      hasEvidence: Boolean(claim.evidence?.length),
    };
  });

  const claimRef = ids => claims.filter(claim => ids.includes(claim.id));
  const collect = ids => [...new Set(claimRef(ids).flatMap(claim => claim.evidence || []))];
  const missingEvidence = ids => claimRef(ids).filter(claim => !(claim.evidence || []).length).map(claim => claim.id);

  const body = claims.filter(claim => claim.id !== 'failure').map(claim => claim.text).join('');
  const level1 = weak
    ? `${authorYear}关注${coreQuestion}。`
    : `${authorYear}用${paper.strategy?.label || '实证方法'}研究${truncate(coreQuestion, 60)}，主要量级是${truncate(magnitude.text || '未报告', 60)}。`;

  const readiness = `按本库材料准备度 ${rating.grade} 档（${rating.readinessLabel || rating.gradeLabel}）；这只说明本库材料够不够用，不是引用许可。`;

  return {
    authorYear,
    grade: rating.grade,
    readiness,
    claims,
    levels: [
      {
        id: 'L1', label: '一句话', text: level1, copyable: level1,
        claims: weak ? ['question'] : ['question', 'magnitude'],
        evidence: collect(weak ? ['question'] : ['question', 'magnitude']),
        missingEvidence: missingEvidence(weak ? ['question'] : ['question', 'magnitude']),
      },
      {
        id: 'L2', label: '一段话（含识别与量级）',
        text: `${body}${readiness}`,
        copyable: body,
        claims: ['question', 'identification', 'magnitude'],
        evidence: collect(['question', 'identification', 'magnitude']),
        missingEvidence: missingEvidence(['question', 'identification', 'magnitude']),
      },
      {
        id: 'L3', label: '带限定条件（组会/审稿可用）',
        text: `${body}${failure.text || ''}${readiness}`,
        copyable: `${body}${failure.text || ''}`,
        claims: ['question', 'identification', 'magnitude', 'failure'],
        evidence: collect(['question', 'identification', 'magnitude', 'failure']),
        missingEvidence: missingEvidence(['question', 'identification', 'magnitude', 'failure']),
      },
    ],
    forbidden: buildForbidden(paper, rating),
  };
}

function buildForbidden(paper, rating) {
  const forbidden = [];
  if (paper.strategy?.id && paper.strategy.id !== 'RCT') {
    forbidden.push({
      pattern: '本文证明了 X 导致 Y',
      reason: `设计是${paper.strategy.label}，只能给「在${oneLine(paper.extract?.design?.identification?.assumption, 40) || '识别假设'}成立时的估计」，不能写「证明」。`,
      alternative: '在……成立的前提下，本文估计 X 使 Y 变化……',
    });
  }
  if (rating.grade === 'C' || rating.grade === 'D') {
    forbidden.push({
      pattern: '已有研究一致表明……（把本文列为一致证据）',
      reason: `本文材料准备度为 ${rating.grade} 档，不足以承担「一致证据」的角色。`,
      alternative: '另有研究关注到……（作为旁证列出，不作结论支撑）',
    });
  }
  if (rating.modifiers.publication.score < 1.5) {
    forbidden.push({
      pattern: '（已发表文献）……',
      reason: `发表状态为「${rating.modifiers.publication.label}」，未经完整同行审查，不能标注为已发表文献。`,
      alternative: '（工作论文，……）',
    });
  }
  return forbidden;
}

// ─────────────────────────────────────────────────────────────
// 审稿人 / 答辩问题库
// ─────────────────────────────────────────────────────────────
function hasValueText(value) {
  const text = String(value ?? '').trim();
  return Boolean(text) && text !== '【待补】' && !/^【待核对/.test(text);
}

const squash = text => String(text || '').replace(/\s+/g, '').replace(/[，,。；;：:、（）()「」“”"]/g, '');

/**
 * 威胁 ↔ 检验的显式配对（清单 09）。
 * 旧实现用 robustness[index] 回应 threats[index]，重排数组就会换答案。
 * 这里只认 what_it_guards 的文本重合；对不上就明说「未找到对应检验」。
 */
export function guardForThreat(threat, robustness) {
  const target = squash(threat);
  if (!target) return null;
  const clauses = String(threat).split(/[；;，,。]/).map(s => squash(s)).filter(s => s.length >= 8);
  for (const row of robustness || []) {
    const guard = squash(row?.what_it_guards);
    if (!guard) continue;
    if (guard.includes(target) || target.includes(guard)) return row;
    if (clauses.some(clause => guard.includes(clause) || clause.includes(guard))) return row;
  }
  return null;
}

export function buildQuestions(paper, rating, recital) {
  const design = paper.extract?.design || {};
  const out = [];
  const push = (kind, question, targets, answerHint, evidence, extra = {}) => {
    out.push({
      id: `${paper.id}:Q${String(out.length + 1).padStart(2, '0')}`,
      paperId: paper.id,
      kind,
      question,
      targets,
      answerHint,
      evidence,
      ...extra,
    });
  };

  const robustness = Array.isArray(design.robustness) ? design.robustness.filter(r => hasValueText(r?.check)) : [];

  (design.identification?.threats || []).slice(0, 3).forEach((threat, index) => {
    if (!String(threat || '').trim()) return;
    const guard = guardForThreat(threat, robustness);
    push(
      '审稿人',
      `如果「${oneLine(threat, 80)}」成立，你的估计会偏向哪一边？凭什么排除？`,
      [`design.identification.threats.${index}`],
      guard
        ? `作者用「${oneLine(guard.check, 50)}」回应（该检验声明的用途：${oneLine(guard.what_it_guards, 40)}），结论是${oneLine(guard.result, 50) || '未报告'}。`
        : '抽取里没有声明「防哪一种假象」的对应检验，这是可攻击点；不要拿别的稳健性检验顶替。',
      ev(paper, `design.identification.threats.${index}`, threat, 1),
      { pairedBy: guard ? 'what_it_guards' : 'none', pairedCheck: guard ? oneLine(guard.check, 60) : '' },
    );
  });

  (paper.extract?.limitations || []).slice(0, 2).forEach((limitation, index) => {
    if (!String(limitation || '').trim()) return;
    push(
      '答辩',
      `你说「${truncate(stripPrefix(limitation), 70)}」，这条局限具体削弱了哪个结论？`,
      [`limitations.${index}`],
      '回答时点名被削弱的那个系数或机制，不要泛泛说样本可以更大。',
      ev(paper, `limitations.${index}`, limitation, 1),
    );
  });

  const vars = Array.isArray(design.variables) ? design.variables.filter(v => v?.symbol) : [];
  if (vars.length) {
    const target = vars[0];
    push(
      '审稿人',
      `「${oneLine(target.symbol, 24)}」这个度量，真的等于你说的「${oneLine(target.role, 20)}」吗？误差会往哪个方向走？`,
      ['design.variables.0'],
      `变量定义：${oneLine(target.definition, 70)}；来源：${oneLine(target.source, 40)}。`,
      ev(paper, 'core_variables.0', (paper.extract?.core_variables || [])[0], 1),
    );
  }

  if (rating.modifiers.publication.score < 1.5) {
    push(
      '审稿人',
      '这还是一份工作论文，发表版的结论有没有变？你引用的是哪个版本？',
      ['meta.journal'],
      `当前记录：${paper.journal || '未标注'}。引用时必须写明版本。`,
      [],
    );
  }

  if (!recital.complete) {
    push(
      '答辩',
      `这篇的四句复述里有 ${recital.missing.length} 处资料缺口，你打算怎么补？`,
      recital.missing.map(m => m.field),
      `缺口：${[...new Set(recital.missing.map(m => m.field))].join('、')}。`,
      [],
    );
  }

  return out;
}

export function buildCrossQuestions(papers, ratings) {
  const out = [];
  const byConcept = new Map();
  for (const paper of papers) {
    const concepts = Array.isArray(paper.extract?.economic_concepts) ? paper.extract.economic_concepts : [];
    for (const concept of concepts) {
      const key = String(concept || '').trim();
      if (!key) continue;
      if (!byConcept.has(key)) byConcept.set(key, []);
      byConcept.get(key).push(paper);
    }
  }
  for (const [concept, group] of [...byConcept.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (group.length < 2) continue;
    const strategies = [...new Set(group.map(p => p.strategy?.label || '未标注'))];
    if (strategies.length < 2) continue;
    out.push({
      id: `X${String(out.length + 1).padStart(2, '0')}`,
      paperId: '',
      kind: '组会',
      question: `同样讲「${concept}」，${group.map(p => `${p.authors.split(/[;,，、]/)[0]}(${p.year})`).join('、')}分别用${strategies.join('、')}，结论差异是识别带来的还是样本带来的？`,
      targets: group.map(p => p.id),
      answerHint: `先比识别假设，再比样本范围；评级分别为 ${group.map(p => `${p.year}:${ratings.get(p.id)?.grade || '?'}`).join('，')}。`,
      evidence: [],
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 选题缺口池
// ─────────────────────────────────────────────────────────────
export function buildGaps(papers, cards, ratings, links = null) {
  const gaps = [];
  const push = (gap) => gaps.push({ id: `G${String(gaps.length + 1).padStart(2, '0')}`, ...gap });
  let linkIndex = links;
  if (!linkIndex) {
    // The build currently calls this with three arguments. Compute the same
    // read-only link index here so card-gap wording can distinguish linked vs
    // unknown instead of claiming “no one has tested it”.
    try { linkIndex = buildLinks(papers, cards); } catch { linkIndex = null; }
  }
  const linkedByCard = new Map();
  for (const link of linkIndex?.links || []) {
    if (!link?.paperId || !link?.cardId) continue;
    if (!linkedByCard.has(link.cardId)) linkedByCard.set(link.cardId, []);
    linkedByCard.get(link.cardId).push(link.paperId);
  }

  for (const paper of papers) {
    const futures = Array.isArray(paper.extract?.future_research) ? paper.extract.future_research : [];
    futures.slice(0, 2).forEach((item, index) => {
      const text = stripPrefix(item);
      if (!text) return;
      push({
        title: truncate(text, 60),
        source: '作者自述（future_research）',
        whyOpen: `作者自述尚未做：${truncate(text, 90)}；这是作者提出的方向，不是学界空白结论。`,
        data: oneLine(paper.extract?.data, 60) || '需自建数据',
        strategy: paper.strategy?.label || '待定',
        difficulty: 2,
        cards: [],
        evidence: ev(paper, `future_research.${index}`, item, 1),
        from: paper.id,
        status: 'candidate',
        coverageStatus: 'author-future',
      });
    });

    const limitations = Array.isArray(paper.extract?.limitations) ? paper.extract.limitations : [];
    limitations.slice(0, 1).forEach((item, index) => {
      const text = stripPrefix(item);
      if (!text) return;
      push({
        title: `补掉这个漏洞：${truncate(text, 46)}`,
        source: '局限外推（limitations）',
        whyOpen: `这条局限意味着结论的某一部分还没被验证：${truncate(text, 90)}`,
        data: '需要一个能分离该渠道的新数据或新冲击',
        strategy: paper.strategy?.label || '待定',
        difficulty: 3,
        cards: [],
        evidence: ev(paper, `limitations.${index}`, item, 1),
        from: paper.id,
        status: 'candidate',
        coverageStatus: 'author-limitation',
      });
    });
  }

  // 卡片有、但本库论文没有直接使用/检验：只能作为“本库检索候选”，
  // 不能写成“学界没人研究”；linked/mentioned 与 tested 必须分开（清单 33）。
  const covered = new Set();
  for (const paper of papers) {
    for (const concept of paper.extract?.economic_concepts || []) covered.add(String(concept).trim());
    for (const theory of paper.extract?.economic_theories || []) covered.add(String(theory).trim());
  }
  for (const card of cards) {
    const names = [card.title_zh, card.title_en, ...(card.aliases || [])].filter(Boolean);
    const mentioned = names.some(name => [...covered].some(c => c && (c.includes(name) || name.includes(c))));
    const linkedPapers = linkedByCard.get(card.id) || [];
    const coverageStatus = linkedPapers.length ? 'linked' : (mentioned ? 'mentioned' : 'unknown');
    gaps.push({
      id: `G${String(gaps.length + 1).padStart(2, '0')}`,
      title: `把「${card.title_zh || card.id}」落到可检验的实证设计上`,
      source: '本库检索候选（卡片未被当前论文直接使用）',
      whyOpen: linkedPapers.length
        ? `本库已有 ${linkedPapers.length} 篇论文与该卡存在来源/概念关联，但是否被直接检验仍是 unknown；这是待核查候选，不是学界空白。`
        : mentioned
          ? '本库论文只提到了相关概念/理论，未记录直接检验；这是本库待补候选，不是学界空白。'
          : '本库当前论文没有记录与该卡的直接关联；这是本库待补候选，不代表学界没有研究。',
      data: '需要能度量该机制的代理变量',
      strategy: '待选（按研究问题、数据与识别假设选择；不预设 DID/IV）',
      difficulty: 3,
      cards: [card.id],
      linkedPapers,
      coverageStatus,
      status: 'candidate',
      evidence: [],
      from: '',
    });
  }

  // 弱评级论文 → 复现/加固缺口
  for (const paper of papers) {
    const rating = ratings.get(paper.id);
    if (!rating || (rating.grade !== 'C' && rating.grade !== 'D')) continue;
    push({
      title: `加固「${truncate(paper.title, 40)}」的识别`,
      source: '本库准备度驱动',
      whyOpen: `该篇本库准备度 ${rating.grade} 档：${rating.degraded.join('；') || '证据链偏薄'}；这是补证据候选，不是论文质量结论。`,
      data: oneLine(paper.extract?.data, 50),
      strategy: '补证据/补稳健性，或按研究问题重新评估识别',
      difficulty: 2,
      cards: [],
      evidence: [],
      from: paper.id,
      status: 'candidate',
      coverageStatus: 'library-preparation',
    });
  }

  return gaps;
}

// ─────────────────────────────────────────────────────────────
// 数据与制度常识库
// ─────────────────────────────────────────────────────────────
export function buildCommonsense(papers, cards, lexicon) {
  const entries = lexicon.commonsense.entries || [];
  const corpus = papers.map(paper => ({
    paper,
    text: [paper.extract?.data, paper.extract?.core_theory, paper.extract?.abstract].filter(Boolean).join('\n').toLowerCase(),
  }));
  const cardText = cards.map(card => ({
    card,
    text: `${card.title_zh} ${card.title_en} ${card.body}`.toLowerCase(),
  }));

  const out = [];
  for (const entry of entries) {
    const keywords = (entry.keywords || []).map(k => String(k || '').trim().toLowerCase()).filter(Boolean);
    if (!keywords.length) continue;
    const hitPapers = corpus
      .filter(row => keywords.some(k => row.text.includes(k)))
      .map(row => row.paper.id);
    const hitCards = cardText
      .filter(row => keywords.some(k => row.text.includes(k)))
      .map(row => row.card.id);
    if (!hitPapers.length && !hitCards.length) continue;

    // 词典事实与论文上下文分开：论文出现关键词只证明“这篇论文用过/提到”，
    // 不证明 lexicon.fact 的整段制度/数据描述；事实来源缺失时必须标 missing（清单 34）。
    const contextEvidence = [];
    for (const paperId of hitPapers.slice(0, 1)) {
      const paper = papers.find(p => p.id === paperId);
      if (!paper) continue;
      const resolved = paper.evidence.resolve('data', paper.extract?.data).slice(0, 1);
      contextEvidence.push(...resolved.map(e => ({
        field: e.field || 'data',
        page: e.page,
        segment: e.segment,
        quote: truncate(e.quote, 160),
        source: e.source,
        match: e.match,
        pageCheck: e.pageCheck,
        support: 'context',
        state: e.state,
        reason: e.reason || '',
        verified: e.state === 'verified',
        role: 'paper-context',
      })));
    }

    const factSource = String(entry.source || entry.sourceUrl || '').trim();
    out.push({
      id: entry.id,
      kind: entry.kind,
      label: entry.label,
      fact: entry.fact,
      whyItMatters: entry.whyItMatters,
      caveat: entry.caveat,
      factSource,
      sourceVersion: String(entry.sourceVersion || entry.version || '').trim(),
      sourceStatus: factSource ? 'record' : 'missing',
      factEvidence: [],
      contextEvidence,
      usedByPapers: [...new Set(hitPapers)].sort(),
      usedByCards: [...new Set(hitCards)].sort(),
      // 旧字段保留，但明确不是事实佐证；避免把 data 引用当成常识来源。
      evidence: [],
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}
