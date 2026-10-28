import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildEvidenceIndex } from '../lib/evidence.mjs';
import { splitSegments } from '../lib/fsx.mjs';
import { parseQuantity } from '../lib/number.mjs';
import { scoreInternal, scorePublication, ratePaper } from '../lib/rating.mjs';
import {
  buildCitations, buildCommonsense, buildGaps, buildRecital,
} from '../lib/derive.mjs';
import { buildLinks, buildMagnitudeIndex } from '../lib/indices.mjs';
import { assessPaperReadiness, loadCards, loadPaper } from '../lib/sources.mjs';
import { validateLearningLayer } from '../lib/validate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUBRIC = JSON.parse(fs.readFileSync(path.join(ROOT, 'lexicon/rating-rubric.json'), 'utf8'));
const MAGNITUDES = JSON.parse(fs.readFileSync(path.join(ROOT, 'lexicon/magnitudes.json'), 'utf8'));
const COMMONSENSE = JSON.parse(fs.readFileSync(path.join(ROOT, 'lexicon/commonsense.json'), 'utf8'));

const ref = (field, state = 'verified', extra = {}) => ({
  field,
  page: state === 'verified' ? 1 : null,
  segment: state === 'verified' ? 1 : null,
  declaredPage: null,
  computedPage: state === 'verified' ? 1 : null,
  quote: 'synthetic quote',
  source: 'extract',
  match: state === 'verified' ? 'verbatim' : 'none',
  pageCheck: state === 'verified' ? 'confirmed' : 'unknown',
  support: 'direct',
  state,
  stateLabel: state,
  reason: 'synthetic',
  verified: state === 'verified',
  ...extra,
});

function mockEvidence(fields = {}, record = []) {
  const entries = Object.entries(fields).flatMap(([field, rows]) => rows.map(row => ({ ...ref(field, row.state || 'verified'), ...row })));
  const byField = new Map();
  for (const entry of entries) {
    if (!byField.has(entry.field)) byField.set(entry.field, []);
    byField.get(entry.field).push(entry);
  }
  return {
    entries,
    byField,
    total: entries.length,
    verifiedCount: entries.filter(entry => entry.state === 'verified').length,
    candidateCount: entries.filter(entry => entry.state === 'candidate').length,
    unsupportedCount: entries.filter(entry => entry.state === 'unsupported').length,
    resolve(field) { return (byField.get(field) || []).slice(); },
    record() { return record; },
    locate() { return null; },
  };
}

function basePaper(overrides = {}) {
  return {
    id: 'p1',
    title: 'A Synthetic Paper',
    authors: 'Lerner, J.; Manley, H. J.',
    year: '2024',
    journal: 'Some Unlisted Journal',
    apa: 'Lerner and Manley (2024)',
    extract: {
      research_questions: ['本文研究宽带接入对企业进入的影响'],
      abstract: 'We estimate an effect around 0.16.',
      data: '县级面板，1983—1993，样本 12000 个县年',
      design: {
        identification: {
          strategy: '双重差分',
          assumption: '平行趋势假设成立',
          threats: ['预期效应导致处理前趋势差异', '同期政策冲击'],
        },
        robustness: [
          { check: '事件研究', what_it_guards: '预期效应导致处理前趋势差异' },
          { check: '安慰剂检验' },
          { check: '替换控制组' },
        ],
        key_coefficients: [{ term: '接入效应', coef: '0.16', se: '0.02' }],
      },
    },
    strategy: { id: 'DID', label: '双重差分', family: '准实验' },
    evidence: mockEvidence({}),
    ...overrides,
  };
}

test('证据：无页表时不伪造 confirmed 页码，record 保留未知页', () => {
  const full = '第一段没有引文。\n\n第二段：原文在这里，Page text with a result of 0.16 percent.';
  const pages = [];
  const index = buildEvidenceIndex({
    evidence: [{ field: 'data', quote: 'Page text with a result of 0.16 percent.', page: 1 }],
  }, full, splitSegments(full), pages);
  const entry = index.entries[0];
  assert.equal(entry.match, 'verbatim');
  assert.equal(entry.computedPage, null);
  assert.equal(entry.pageCheck, 'unknown');
  assert.equal(entry.supportStatus, 'unassessed');
  assert.equal(entry.fieldRelation, 'exact');
  assert.match(entry.reason, /页表没有|页码未知|未提供/);

  const record = index.record('meta.journal', 'Some Unlisted Journal');
  assert.equal(record[0].page, null);
  assert.equal(record[0].state, 'record');
  assert.match(record[0].reason, /页码未知/);
});

test('证据：只有 startChar 的页表也能核对页码；错页降为候选', () => {
  const full = 'Page one. We use a randomized controlled trial and find 0.2.';
  const pages = [{ page: 1, startChar: 0 }];
  const index = buildEvidenceIndex({
    evidence: [
      { field: 'design.identification.strategy', quote: 'We use a randomized controlled trial', page: 1 },
      { field: 'design.identification.strategy', quote: 'We use a randomized controlled trial', page: 999 },
    ],
  }, full, splitSegments(full), pages);
  assert.equal(index.entries[0].computedPage, 1);
  assert.equal(index.entries[0].pageCheck, 'confirmed');
  assert.equal(index.entries[0].state, 'verified');
  assert.equal(index.entries[1].computedPage, 1);
  assert.equal(index.entries[1].pageCheck, 'mismatch');
  assert.equal(index.entries[1].state, 'candidate');
  assert.match(index.entries[1].reason, /999/);
});

test('证据：父字段证据只能作为子字段候选，祖先不自动升级', () => {
  const full = 'We identify the effect using a randomized controlled trial.';
  const index = buildEvidenceIndex({
    evidence: [{ field: 'design.identification', quote: 'randomized controlled trial', page: 1 }],
  }, full, splitSegments(full), [{ page: 1, startChar: 0, endChar: full.length }]);
  const child = index.resolve('design.identification.strategy', 'randomized controlled trial')[0];
  assert.equal(child.support, 'ancestor');
  assert.equal(child.state, 'candidate');
});

test('发表状态：未知期刊不冒充正式期刊；短缩写按整词；显式状态优先', () => {
  const evidence = mockEvidence({}, [ref('meta.journal', 'record', { page: null, source: 'record', pageCheck: 'unknown' })]);
  const unknown = scorePublication({ journal: 'Some Unlisted Journal', extract: {}, evidence }, RUBRIC);
  assert.equal(unknown.score, 1);
  assert.equal(unknown.publicationStatus, 'unverifiedJournal');
  assert.equal(unknown.degraded, true);
  assert.match(unknown.label, /未核对/);

  const aerospace = scorePublication({ journal: 'Aerospace', extract: {}, evidence }, RUBRIC);
  assert.notEqual(aerospace.publicationStatus, 'top');
  const top = scorePublication({ journal: 'American Economic Review', extract: {}, evidence }, RUBRIC);
  assert.equal(top.publicationStatus, 'top');
  assert.equal(top.score, 2);
  const explicit = scorePublication({ journal: 'Some Unlisted Journal', extract: { publication_status: 'journal' }, evidence }, RUBRIC);
  assert.equal(explicit.score, 1.5);
  assert.equal(explicit.degraded, false);
});

test('评级复算输入：bonus evidence state 进入 reproducible inputs，相同计数不等价', () => {
  const verifiedFields = {
    'design.identification.strategy': [{ state: 'verified' }],
    'design.identification.first_stage_or_balance': [{ state: 'verified' }],
    'design.identification.threats': [{ state: 'verified' }],
    'design.robustness': [{ state: 'verified' }],
  };
  const candidateFields = {
    'design.identification.strategy': [{ state: 'verified' }],
    'design.identification.first_stage_or_balance': [{ state: 'candidate' }],
    'design.identification.threats': [{ state: 'candidate' }],
    'design.robustness': [{ state: 'candidate' }],
  };
  const paperA = { ...basePaper(), evidence: mockEvidence(verifiedFields) };
  const paperB = { ...basePaper(), evidence: mockEvidence(candidateFields) };
  const a = scoreInternal(paperA, RUBRIC);
  const b = scoreInternal(paperB, RUBRIC);
  assert.ok(Array.isArray(a.inputs.bonusStates));
  assert.notDeepEqual(a.inputs.bonusStates, b.inputs.bonusStates);
  assert.notEqual(a.score, b.score);
  assert.ok(a.inputs.baseState);
});

test('完整评级：A–D 只作为本库准备度，复算输入可审计', () => {
  const paper = basePaper({
    evidence: mockEvidence({
      'design.identification.strategy': [{ state: 'verified' }],
      'design.identification.assumption': [{ state: 'verified' }],
      'design.identification.first_stage_or_balance': [{ state: 'candidate' }],
      'data': [{ state: 'verified' }],
      'core_variables.0': [{ state: 'candidate' }],
    }),
  });
  const rating = ratePaper(paper, { rubric: RUBRIC, strategies: { version: 1 }, rubricHash: 'synthetic' });
  assert.ok(['A', 'B', 'C', 'D'].includes(rating.grade));
  assert.equal(rating.scope, 'library-readiness');
  assert.equal(rating.notCitationLicense, true);
  assert.doesNotMatch(rating.gradeLabel, /可直接引用|暂不引用|仅作旁证/);
  assert.match(rating.rubricLabel, /引用|旁证|限定/);
  assert.match(rating.readinessLabel, /本库材料/);
  assert.ok(rating.limitations.some(text => /准备度/.test(text)));
  assert.equal(rating.reproducible.inputs.construct, rating.modifiers.construct.ratio);
  assert.ok(rating.reproducible.inputs.constructDetail);
  assert.equal(rating.reproducible.inputs.publication, rating.modifiers.publication.label);
  assert.ok(rating.reproducible.inputs.publicationDetail);
  assert.ok(Array.isArray(rating.reproducible.inputs.internal.bonusStates));
});

test('引文：每条主张带自身证据，数值缺量级证据时进入 missingEvidence', () => {
  const paper = basePaper();
  const rating = { grade: 'B', modifiers: { publication: { score: 1.5 }, construct: { score: 2 } } };
  const recital = {
    sentences: [
      { key: 'question', label: '问题', text: '它问的是：合成问题。', status: 'ok', evidenceState: 'verified', derivedFrom: 'research_questions', evidence: [ref('research_questions.0')] },
      { key: 'identification', label: '识别', text: '识别靠双重差分。', status: 'ok', evidenceState: 'verified', derivedFrom: 'design.identification', evidence: [ref('design.identification.strategy')] },
      { key: 'magnitude', label: '量级与方向', text: '核心系数 = 0.16，方向正向。', status: 'candidate', evidenceState: 'none', derivedFrom: 'design.key_coefficients', evidence: [] },
      { key: 'failure', label: '失效', text: '结论在预期效应下松动。', status: 'ok', evidenceState: 'verified', derivedFrom: 'limitations', evidence: [ref('limitations.0')] },
    ],
    complete: false,
    missing: [],
  };
  const citations = buildCitations(paper, rating, recital);
  const magnitude = citations.claims.find(claim => claim.id === 'magnitude');
  assert.equal(magnitude.hasEvidence, false);
  assert.ok(citations.levels.some(level => level.missingEvidence.includes('magnitude')));
  assert.ok(citations.levels.every(level => !/按本库|可直接引用/.test(level.copyable || '')));
  assert.ok(Array.isArray(citations.claims) && citations.claims.every(claim => 'support' in claim));
});

test('量级：解析与可比性分离；负号/占位/零/显式单位', () => {
  const paper = {
    id: 'p', title: 'T', year: '2024',
    extract: { design: { key_coefficients: [
      { term: 'a', coef: '−0.25', se: '0.02' },
      { term: 'b', coef: '【待补】', se: '' },
      { term: 'c', coef: '0', se: '' },
      { term: 'd', coef: '0.16', se: '0.01', unit: '百分点' },
      { term: 'e', coef: '0.16', se: '0.01', unit: '百分点', estimate: 'ATT', model: 'TWFE', sample: '县级面板' },
    ] }, economic_concepts: [] },
    evidence: mockEvidence({}),
  };
  const out = buildMagnitudeIndex([paper], { magnitudes: MAGNITUDES }, new Map([['p', { grade: 'B' }]]));
  const rows = out.themes.flatMap(theme => theme.rows);
  const byTerm = Object.fromEntries(rows.map(row => [row.term, row]));
  assert.equal(byTerm.a.direction, '负向');
  assert.equal(byTerm.b.parseStatus, 'missing');
  assert.equal(byTerm.c.direction, '零效应');
  assert.equal(byTerm.a.comparable, false);
  assert.equal(byTerm.a.comparisonStatus, 'insufficient');
  assert.match(byTerm.a.comparisonReason, /缺少显式单位/);
  assert.equal(byTerm.d.comparable, false);
  assert.match(byTerm.d.comparisonReason, /只有单位|估计对象/);
  assert.equal(byTerm.e.comparable, true);
  assert.equal(parseQuantity('−0.25').value, -0.25);
  assert.equal(parseQuantity('−.25').value, -0.25);
  assert.equal(parseQuantity('+0.25').value, 0.25);
  assert.equal(parseQuantity('1,234.50').value, 1234.5);
  assert.equal(parseQuantity('1,2').status, 'invalid');
  assert.equal(parseQuantity('1e-3').value, 0.001);
});

test('卡片来源：refs_drop 大小写/手工 refs 一致；单字母姓不作 strong；缺口只作候选', () => {
  const paper = basePaper({
    id: 'p1',
    authors: 'Lerner, J.; Manley, H. J.',
    extract: { economic_concepts: ['知识溢出'], economic_theories: [] },
    evidence: mockEvidence({}),
  });
  const droppedCard = {
    id: 'T-0007', title_zh: '合成卡', shelf: '合成架', aliases: [],
    firstSource: { citation: 'Lerner, J., Manley, H. J., Stein, C., & Williams, H. L. (2024). The Wandering Scholars. NBER.' },
    sources: [], dropRefs: ['lerner_2024', 'Lerner_2024'], manualRefs: [],
  };
  const manualCard = {
    id: 'T-0008', title_zh: '手工卡', shelf: '合成架', aliases: [],
    firstSource: null, sources: [], dropRefs: [],
    manualRefs: [{ key: 'Lerner_2024', role: '人工' }],
  };
  const idx = buildLinks([paper], [droppedCard, manualCard]);
  assert.equal(idx.links.some(link => link.cardId === 'T-0007'), false);
  assert.ok(idx.droppedByCardDecision.some(item => item.cardId === 'T-0007' && item.key === 'lerner_2024'));
  const manual = idx.links.find(link => link.cardId === 'T-0008');
  assert.ok(manual && manual.strength === 'strong' && manual.basis.some(item => item.kind === 'manual'));

  const card = { id: 'T-0009', title_zh: '未覆盖卡', shelf: '合成架', aliases: ['知识溢出'] };
  const gaps = buildGaps([paper], [card], new Map(), { links: [{ paperId: 'p1', cardId: 'T-0009', strength: 'strong' }] });
  assert.equal(gaps[0].status, 'candidate');
  assert.equal(gaps[0].coverageStatus, 'linked');
  assert.doesNotMatch(gaps[0].whyOpen, /都没有直接检验/);
  assert.doesNotMatch(gaps[0].strategy, /建议优先|优先\s*(?:DID|IV)/);
  const inferred = buildGaps([paper], [card], new Map());
  assert.equal(inferred.length, 1);
  assert.equal(inferred[0].status, 'candidate');
  assert.ok(['linked', 'mentioned', 'unknown'].includes(inferred[0].coverageStatus));
});

test('复述：缺研究问题/系数不可解析时降为候选，不再把摘要或首系数冒充完整', () => {
  const paper = basePaper({
    extract: {
      abstract: 'This paper estimates a large positive effect around 12 percent.',
      data: '',
      design: { identification: { strategy: 'DID' }, key_coefficients: [{ term: 'x', coef: '【待补】', se: '' }, { term: 'y', coef: '0.1', se: '' }] },
    },
    evidence: mockEvidence({}),
  });
  const recital = buildRecital(paper);
  const question = recital.sentences.find(sentence => sentence.key === 'question');
  const magnitude = recital.sentences.find(sentence => sentence.key === 'magnitude');
  const identification = recital.sentences.find(sentence => sentence.key === 'identification');
  assert.equal(question.status, 'candidate');
  assert.equal(magnitude.status, 'candidate');
  assert.match(magnitude.principalCoefficient.term, /x/);
  assert.equal(magnitude.principalCoefficient.needsConfirmation, true);
  assert.equal(identification.status, 'candidate');
  assert.equal(recital.complete, false);
});

test('常识：词表事实与论文 context 分开，无来源时明确 missing', () => {
  const paper = basePaper({ extract: { data: '使用 Web of Science 数据构建面板', core_theory: '', abstract: '' } });

  // 用合成条目而不是词表第一条：词表随时会补来源，测试不该依赖它的当前状态。
  const withoutSource = {
    id: 'DS-TEST', kind: 'dataset', label: '测试数据源', keywords: ['Web of Science'],
    fact: '用于测试的合成事实。', whyItMatters: '测试。', caveat: '测试。',
  };
  const out = buildCommonsense([paper], [], { commonsense: { entries: [withoutSource] } });
  assert.equal(out[0].sourceStatus, 'missing');
  assert.deepEqual(out[0].evidence, []);
  assert.equal(out[0].factEvidence.length, 0);
  assert.ok(Array.isArray(out[0].contextEvidence));

  // 补了来源就该变成 record —— 这是「有独立来源」那一半行为
  const withSource = { ...withoutSource, source: 'Clarivate, Web of Science 官方说明' };
  const sourced = buildCommonsense([paper], [], { commonsense: { entries: [withSource] } });
  assert.equal(sourced[0].sourceStatus, 'record');
  assert.equal(sourced[0].factSource, 'Clarivate, Web of Science 官方说明');
});

test('卡片读取：refs/refs_drop 经 front matter 后键统一规范化', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'lit-content-cards-'));
  try {
    await fsp.mkdir(path.join(home, 'cards'), { recursive: true });
    await fsp.writeFile(path.join(home, 'catalog.json'), JSON.stringify({ cards: [{ id: 'T-0001', path: 'cards/T-0001.md' }] }), 'utf8');
    await fsp.writeFile(path.join(home, 'cards/T-0001.md'), [
      '---',
      'id: T-0001',
      'type: theory',
      'shelf: 合成架',
      'title_zh: 合成卡片',
      'title_en: Synthetic Card',
      'aliases: ["合成"]',
      'sources:',
      '  - citation: "Lerner, J. (2024). Synthetic."',
      '    role: source',
      'refs:',
      '  - key: Lerner_2024',
      '    role: 人工',
      'refs_drop:',
      '  - Smith_2020',
      '---',
      '正文',
    ].join('\n'), 'utf8');
    const lib = await loadCards({ cardsHome: home });
    assert.equal(lib.cards.length, 1);
    assert.deepEqual(lib.cards[0].manualRefs.map(ref => ref.key), ['lerner_2024']);
    assert.deepEqual(lib.cards[0].dropRefs, ['smith_2020']);
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test('就绪度：读取阶段完成后暂停仍为 provisional；无正文/extract 明确降级', async () => {
  assert.equal(assessPaperReadiness({ job: { stage: 'paused', completedStages: ['read'] }, extract: {}, full: '正文', pages: [], evidence: { total: 1, verifiedCount: 1 } }).status, 'provisional');
  // 暂停可能发生在阅读前：paused 本身不是 read 完成证据。
  const pausedBeforeRead = assessPaperReadiness({ job: { stage: 'paused', status: 'paused', completedStages: ['prepare'] }, extract: { research_questions: ['暂定'] }, full: '合成正文', pages: [{ page: 1, startChar: 0, endChar: 4 }], evidence: { total: 1, verifiedCount: 1 } });
  assert.equal(pausedBeforeRead.readStage, false);
  assert.notEqual(pausedBeforeRead.status, 'ready');
  assert.equal(assessPaperReadiness({ job: { stage: 'done', completedStages: ['read'] }, extract: {}, full: '', pages: [], evidence: { total: 0 } }).status, 'extract-only');
  assert.equal(assessPaperReadiness({ job: { stage: 'done', completedStages: ['read'] }, extract: {}, full: '正文', pages: [{ page: 1, startChar: 0 }], evidence: { total: 1, verifiedCount: 1 } }).status, 'ready');

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lit-content-readiness-'));
  try {
    await fsp.writeFile(path.join(dir, 'job.json'), JSON.stringify({ id: 'p_ready', status: 'paused', stage: 'paused', completedStages: ['read'], inputKind: 'markdown', kind: 'paper', metadata: { title: 'Ready paper' } }), 'utf8');
    await fsp.writeFile(path.join(dir, 'paper.extract.json'), JSON.stringify({ meta: { citation_unit: 'segment' }, evidence: [] }), 'utf8');
    await fsp.writeFile(path.join(dir, 'full.md'), '本文是合成正文，用于就绪度检查。', 'utf8');
    const paper = await loadPaper(dir);
    assert.equal(paper.readiness.status, 'provisional');
    assert.equal(paper.readiness.citationUnit, 'segment');
    assert.equal(paper.sourceKind, 'markdown');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('校验：引用数值缺量级证据、常识无来源、缺口无状态问题可报告', () => {
  const paper = {
    id: 'p1', segments: [], extract: { abstract: '' },
    evidence: { total: 1, verifiedCount: 1, candidateCount: 0, unsupportedCount: 0 },
  };
  const rating = {
    grade: 'B', degraded: [], rationale: '合成理由',
    axes: Object.fromEntries(['internal', 'external', 'sufficiency'].map(key => [key, {
      reasons: [{ text: '合成理由', status: 'ok', evidence: [ref(key)] }], degraded: false,
    }])),
  };
  const recital = { complete: true, missing: [], sentences: [] };
  const citations = {
    levels: [{ id: 'L1', text: '效应约 0.16', copyable: '效应约 0.16', missingEvidence: [], evidence: [] }],
    claims: [{ id: 'magnitude', text: '0.16', hasEvidence: false, support: 'none', evidence: [] }],
  };
  const report = validateLearningLayer({
    config: { learningRoot: path.join(os.tmpdir(), 'lit-validate'), writeCards: false, writeOutsideLearningRoot: false },
    papers: [paper], cards: [], links: { links: [] }, map: { dangling: [] },
    ratings: new Map([['p1', rating]]), recitalByPaper: new Map([['p1', recital]]),
    citationsByPaper: new Map([['p1', citations]]), questions: [], gaps: [{ id: 'G01', title: '候选缺口' }],
    artifacts: { 'commonsense/library.json': JSON.stringify({ entries: [{ id: 'DS-X', label: '合成常识', fact: 'x', sourceStatus: 'missing' }] }) },
    previousHash: null, contentHash: 'x', inputsHash: 'y', previousInputsHash: 'y',
  });
  const byId = Object.fromEntries(report.checks.map(check => [check.id, check]));
  assert.equal(byId['citation-numbers'].ok, false);
  assert.equal(byId['commonsense-source'].ok, false);
  assert.equal(byId['gap-status'].ok, false);
  assert.equal(byId['claims'].ok, false);
});
