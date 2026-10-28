import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { normalizeConfig } from '../lib/config.mjs';
import { buildLearningLayer } from '../lib/build.mjs';
import { createService } from '../lib/service.mjs';
import { buildEvidenceIndex } from '../lib/evidence.mjs';
import { aliasHit, normalizeStrategy } from '../lib/sources.mjs';
import { parseQuantity } from '../lib/number.mjs';
import { guardForThreat } from '../lib/derive.mjs';
import { splitSegments } from '../lib/fsx.mjs';

/**
 * 独立 fixture 回归（清单 36）。
 * 全部用合成数据，不读本机的文献工作流与卡片库：这样这些用例在任何机器上都能跑，
 * 也能在修复前跑出失败（每条都对应清单里的一个具体根因）。
 */

// ── 合成正文：两页，字符偏移可算 ────────────────────────────
const PAGE1 = [
  '1. 引言',
  '',
  '本文研究宽带接入对企业进入的影响，使用县级面板数据。',
  '',
  '2. 识别策略',
  '',
  '我们采用交错双重差分（staggered DiD）识别因果效应，平行趋势假设是关键前提。',
  '',
].join('\n');
const PAGE2 = [
  '3. 结果',
  '',
  '基准估计显示，宽带接入使县企业数提高约 4.2%。',
  '',
  '4. 局限',
  '',
  '样本期较短，无法观察长期动态。',
  '',
].join('\n');
const FULL = PAGE1 + PAGE2;
const PAGES = [
  { page: 1, startChar: 0, endChar: PAGE1.length },
  { page: 2, startChar: PAGE1.length, endChar: FULL.length },
];
const SEGMENTS = splitSegments(FULL);

function extractFixture(id = 'paper_fx_0001') {
  return {
    meta: { title: `合成论文 ${id}`, journal: '合成期刊', doi: '10.0000/fixture', year: '2020' },
    apa_citation: 'Fixture, A. (2020). 合成论文. 合成期刊.',
    authors: 'Fixture, A.',
    year: '2020',
    abstract: '短摘要，避免触发摘要复制检查。',
    research_questions: ['本文研究宽带接入对企业进入的影响'],
    hypotheses: ['宽带接入提高企业进入率'],
    core_theory: '交易成本与集聚外部性',
    contribution: '给出县级层面的因果证据',
    data: '县级面板，1983—1993',
    limitations: ['样本期较短，无法观察长期动态'],
    future_research: [],
    design: {
      identification: {
        strategy: '交错双重差分',
        assumption: '平行趋势假设成立',
        threats: ['预期效应导致处理前趋势差异'],
        first_stage_or_balance: '',
      },
      robustness: [{
        check: '安慰剂检验：随机分配处理时点',
        what_it_guards: '安慰剂检验，用于排除随机性导致的伪相关',
        result: '系数接近零',
      }],
      mechanism: [],
      heterogeneity: [],
    },
    evidence: [
      { field: 'research_questions.0', quote: '本文研究宽带接入对企业进入的影响', page: 1 },
      { field: 'design.identification.strategy', quote: '我们采用交错双重差分', page: 999 },
      { field: 'contribution', quote: '这段文字在正文里根本不存在', page: 1 },
      { field: 'design.identification.assumption', quote: '平行趋势假设是关键前提', page: 1 },
    ],
  };
}

const CARD_MD = [
  '---',
  'id: A-0001',
  'type: 概念',
  'shelf: 合成架',
  'title_zh: 合成卡片',
  'status: 稳定',
  'sources:',
  '  - key: paper_fx_0001',
  '    locator: 第 1 页',
  '---',
  '',
  '这是一张合成卡片，只用于测试。',
  '',
].join('\n');

async function writeJob(workflowRoot, index) {
  const id = `paper_fx_${String(index).padStart(4, '0')}`;
  const dir = path.join(workflowRoot, '.plugin-state', 'jobs', id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'job.json'), JSON.stringify({
    id, status: 'done', stage: 'ready', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  }), 'utf8');
  await fsp.writeFile(path.join(dir, 'full.md'), FULL, 'utf8');
  await fsp.writeFile(path.join(dir, 'pages.json'), JSON.stringify(PAGES), 'utf8');
  await fsp.writeFile(path.join(dir, 'paper.extract.json'), JSON.stringify(extractFixture(id)), 'utf8');
  return { id, dir };
}

async function fixture({ papers = 1 } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lit-reg-'));
  const workflowRoot = path.join(root, 'workflow');
  const cardsHome = path.join(root, 'cards');
  const learningRoot = path.join(root, 'learning');
  await fsp.mkdir(path.join(workflowRoot, '.plugin-state', 'jobs'), { recursive: true });
  await fsp.mkdir(path.join(cardsHome, 'cards'), { recursive: true });
  await fsp.writeFile(path.join(cardsHome, 'catalog.json'),
    JSON.stringify({ cards: [{ id: 'A-0001', path: 'cards/A-0001.md' }] }), 'utf8');
  await fsp.writeFile(path.join(cardsHome, 'cards', 'A-0001.md'), CARD_MD, 'utf8');
  const jobs = [];
  for (let i = 1; i <= papers; i += 1) jobs.push(await writeJob(workflowRoot, i));
  const config = normalizeConfig({ workflowRoot, cardsHome, learningRoot });
  return { root, config, workflowRoot, cardsHome, learningRoot, jobs };
}

// ── 清单 01 / 02：证据四维拆分 ──────────────────────────────
test('证据状态机：页号不符降为待核验，正文找不到只算字段级', () => {
  const index = buildEvidenceIndex(extractFixture(), FULL, SEGMENTS, PAGES);
  const [question, strategy, contribution, assumption] = index.entries;

  assert.equal(question.state, 'verified');
  assert.equal(question.pageCheck, 'confirmed');
  assert.equal(question.computedPage, 1);

  // 抽取标 999 页，原文在第 1 页 —— 旧实现会照样算「已核验」
  assert.equal(strategy.match, 'verbatim');
  assert.equal(strategy.pageCheck, 'mismatch');
  assert.equal(strategy.declaredPage, 999);
  assert.equal(strategy.computedPage, 1);
  assert.equal(strategy.state, 'candidate');
  assert.equal(strategy.verified, false);
  assert.match(strategy.reason, /999/);

  // 正文里根本没有这段原文 —— 不能算已核验
  assert.equal(contribution.match, 'none');
  assert.equal(contribution.state, 'candidate');
  assert.equal(contribution.page, null);

  assert.equal(assumption.state, 'verified');
  assert.equal(index.stats.verified, 2);
  assert.equal(index.stats.candidate, 2);
});

test('证据状态机：父字段证据不能冒充子字段已核验', () => {
  const index = buildEvidenceIndex({
    evidence: [{ field: 'design.identification', quote: '我们采用交错双重差分', page: 1 }],
  }, FULL, SEGMENTS, PAGES);

  const refs = index.resolve('design.identification.strategy', '交错双重差分');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].support, 'ancestor');
  assert.equal(refs[0].state, 'candidate');
  assert.equal(refs[0].verified, false);
  assert.match(refs[0].reason, /父字段/);
});

test('书目记录：正文未定位时页码写未知，不伪造第 1 页', () => {
  const index = buildEvidenceIndex(extractFixture(), FULL, SEGMENTS, PAGES);

  const [journal] = index.record('journal', '合成期刊');
  assert.equal(journal.source, 'record');
  assert.equal(journal.state, 'record');
  assert.equal(journal.page, null);
  assert.match(journal.reason, /页码未知/);

  // 正文里确实有的书目信息才允许标已核验
  const [title] = index.record('title', '本文研究宽带接入对企业进入的影响');
  assert.equal(title.state, 'verified');
  assert.equal(title.page, 1);
});

test('证据状态机：page 为空不等于第 0 页，不能判成页号不符', () => {
  const index = buildEvidenceIndex({
    evidence: [
      { field: 'research_questions.0', quote: '本文研究宽带接入对企业进入的影响', page: null },
      { field: 'design.identification.assumption', quote: '平行趋势假设是关键前提' },
    ],
  }, FULL, SEGMENTS, PAGES);

  const [noPage, missingPage] = index.entries;
  assert.equal(noPage.pageCheck, 'unknown', 'Number(null)===0 不能当成第 0 页');
  assert.equal(noPage.state, 'verified');
  assert.equal(noPage.computedPage, 1);
  assert.equal(missingPage.state, 'verified');
});

// ── 清单 07：短英文别名必须按词边界 ─────────────────────────
test('识别策略：短别名按词边界，不误伤 derivative / candidate', () => {
  assert.equal(aliasHit('taking the derivative of the likelihood', 'IV'), false);
  assert.equal(aliasHit('the candidate set is large', 'DID'), false);
  assert.equal(aliasHit('we use an IV strategy', 'IV'), true);
  assert.equal(aliasHit('交错双重差分（staggered DiD）', 'DID'), true);

  const strategies = { canonical: [
    { id: 'DID', label: '双重差分', family: '准实验', aliases: ['DID', 'difference-in-differences'], portable: 3 },
    { id: 'IV', label: '工具变量', family: '准实验', aliases: ['IV', '2SLS'], portable: 2 },
    { id: 'OTHER', label: '其他/未标注', family: '未标注', aliases: [], portable: 0 },
  ] };

  const single = normalizeStrategy('staggered DiD design', strategies);
  assert.equal(single.id, 'DID');
  assert.equal(single.ambiguous, false);

  // 同时出现两种方法时保留歧义，不静默取第一个
  const both = normalizeStrategy('combining DiD with 2SLS', strategies);
  assert.equal(both.ambiguous, true);
  assert.ok(both.alternatives.length >= 1);
});

// ── 清单 05：数值解析只留一套 ───────────────────────────────
test('数值：U+2212 负号、区间、占位符都从同一处解析', () => {
  const minus = parseQuantity('\u22120.12');
  assert.equal(minus.status, 'ok');
  assert.equal(minus.value, -0.12);
  assert.equal(minus.sign, 'negative');

  const range = parseQuantity('0.11\u20130.23');
  assert.equal(range.status, 'range');
  assert.equal(range.value, null);
  assert.equal(range.kind, 'range');

  const placeholder = parseQuantity('【待补】');
  assert.equal(placeholder.status, 'missing');
  assert.equal(placeholder.sign, 'unknown');

  const percent = parseQuantity('4.2%');
  assert.equal(percent.kind, 'percent');
  assert.equal(percent.unit, '%');
  assert.equal(percent.sign, 'positive');
});

// ── 清单 09：威胁与检验按声明用途配对 ───────────────────────
test('威胁与检验：按 what_it_guards 配对，对不上就返回空', () => {
  const robustness = [
    { check: '安慰剂检验：随机分配处理时点', what_it_guards: '安慰剂检验，用于排除随机性导致的伪相关' },
    { check: '替换被解释变量', what_it_guards: '换用专利数，检验结论对指标口径的敏感性' },
  ];

  const paired = guardForThreat('预期效应导致处理前趋势差异', [
    ...robustness,
    { check: '事件研究法', what_it_guards: '预期效应导致处理前趋势差异' },
  ]);
  assert.equal(paired.check, '事件研究法');

  // 顺序打乱不影响配对结果，也不再「按下标硬配」
  assert.equal(guardForThreat('预期效应导致处理前趋势差异', robustness), null);
  assert.equal(guardForThreat('', robustness), null);
});

// ── 排版归一：换行 / 表格管道符 / 强调标记 ─────────────────
test('证据匹配：换行、表格管道符、强调标记不影响逐字命中', () => {
  const text = [
    'Intro paragraph.',
    '',
    'We create the variable _County_ _Establishments_, which is the total',
    'number of establishments in a county-year.',
    '',
    '| Variable | Model 1 |',
    '| --- | --- |',
    '| AfterBit | 0.019*** |',
    '',
  ].join('\n');

  const index = buildEvidenceIndex({
    evidence: [
      { field: 'design.variables', quote: 'We create the variable County Establishments, which is the total number of establishments', page: 1 },
      { field: 'design.key_coefficients', quote: 'AfterBit 0.019***', page: 1 },
      { field: 'design.nothing', quote: '这段文字真的不在正文里', page: 1 },
    ],
  }, text, splitSegments(text), [{ page: 1, startChar: 0, endChar: text.length }]);

  const [variables, coefficient, nothing] = index.entries;

  // PDF→MD 插入的换行与 `_County_ _Establishments_` 不能把真引文挡在门外
  assert.equal(variables.state, 'verified');
  assert.equal(variables.matchedVia, 'layout');
  assert.match(variables.reason, /排版标记/);

  // 表格行被管道符切开，同样要能命中
  assert.equal(coefficient.state, 'verified');

  // 但真的不存在的文字仍然是待核验
  assert.equal(nothing.match, 'none');
  assert.equal(nothing.state, 'candidate');
  assert.equal(nothing.page, null);
});

// ── 清单 13：双向边界 ───────────────────────────────────────
test('边界：学习层包住卡片库同样被拒', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lit-reg-boundary-'));
  const cardsHome = path.join(root, 'cards');
  await fsp.mkdir(path.join(cardsHome, 'cards'), { recursive: true });

  assert.throws(() => normalizeConfig({
    workflowRoot: path.join(root, 'workflow'),
    cardsHome,
    learningRoot: root,
  }), /不能包住知识卡片库/);
});

// ── 清单 17：指纹覆盖正文 ───────────────────────────────────
test('输入指纹：只改正文不改抽取，也必须判定为输入已变化', async () => {
  const { config, jobs } = await fixture();
  const first = await buildLearningLayer(config, { rebuild: true });
  assert.equal(first.ok, true, JSON.stringify(first.checks));

  await fsp.appendFile(path.join(jobs[0].dir, 'full.md'), '\n补充一段正文，抽取不动。\n', 'utf8');

  const second = await buildLearningLayer(config, {});
  assert.notEqual(second.inputsHash, first.inputsHash, '正文变了，输入指纹必须变');

  const report = JSON.parse(await fsp.readFile(path.join(config.learningRoot, 'report', 'validate.json'), 'utf8'));
  const idempotent = report.checks.find(check => check.id === 'idempotent');
  assert.equal(idempotent.status, 'na', '输入变了，幂等判定应为 N/A 而不是失败');
});

// ── 清单 16：只回收上一代列过的文件 ─────────────────────────
test('产物回收：源目录消失后，上一代文件被删除且记在清单里', async () => {
  const { config, jobs } = await fixture({ papers: 2 });
  const first = await buildLearningLayer(config, { rebuild: true });
  assert.equal(first.counts.papers, 2);

  const goneId = jobs[1].id;
  await fsp.rm(jobs[1].dir, { recursive: true, force: true });

  const second = await buildLearningLayer(config, {});
  assert.equal(second.counts.papers, 1);
  assert.ok(second.reclaimed.includes(`papers/${goneId}.json`), `应回收 papers/${goneId}.json，实际 ${second.reclaimed}`);
  await assert.rejects(() => fsp.access(path.join(config.learningRoot, 'papers', `${goneId}.json`)));

  // 复习记录不能被回收逻辑碰掉
  await fsp.access(path.join(config.learningRoot, 'review', 'log.jsonl'));
});

// ── 清单 21：复习写入幂等 ───────────────────────────────────
test('复习写入：评分必须是 0–4 整数，重复 attemptId 只记一次', async () => {
  const { config } = await fixture();
  const service = createService(config);
  await service.invoke('build', { rebuild: true });

  const queue = await service.invoke('review', { limit: 1 });
  const item = queue.queue[0];
  assert.ok(item, '应该有可复习条目');
  assert.ok(item.itemVersion, '提交必须绑定当前内容版本');
  const payload = { itemId: item.id, itemVersion: item.itemVersion, attemptId: 'validation-attempt', grade: 3 };

  await assert.rejects(() => service.invoke('review_record', { ...payload, grade: 2.6 }), /0–4 的整数/);
  await assert.rejects(() => service.invoke('review_record', { ...payload, grade: 9 }), /0–4 的整数/);
  await assert.rejects(() => service.invoke('review_record', { ...payload, grade: '3' }), /0–4 的整数/);
  await assert.rejects(() => service.invoke('review_record', { ...payload, itemId: 'R:不存在' }), /不存在或已失效/);

  const first = await service.invoke('review_record', { ...payload, attemptId: 'attempt-1' });
  assert.equal(first.duplicate, false);

  // 双击 / 重试：同一次尝试不推进两次间隔
  const again = await service.invoke('review_record', { ...payload, attemptId: 'attempt-1' });
  assert.equal(again.duplicate, true);
  assert.equal(again.interval, first.interval);

  const log = await fsp.readFile(path.join(config.learningRoot, 'review', 'log.jsonl'), 'utf8');
  assert.equal(log.trim().split('\n').length, 1, '重复提交不应写第二行');
});

// ── 清单 22：逐项排程 ───────────────────────────────────────
test('排程：新加入的项按自己的纳入日计算，不继承历史逾期', async () => {
  const { config, workflowRoot } = await fixture({ papers: 1 });
  const first = await buildLearningLayer(config, { rebuild: true });
  const oldCount = first.review.total;

  // 隔一天再放一篇新论文进来
  const later = await writeJob(workflowRoot, 2);
  assert.ok(later.id);
  const second = await buildLearningLayer(config, {});
  assert.equal(second.counts.papers, 2);
  assert.ok(second.review.total > oldCount);

  const schedule = JSON.parse(await fsp.readFile(path.join(config.learningRoot, 'review', 'schedule.json'), 'utf8'));
  const fresh = schedule.items.filter(row => row.id.startsWith('R:paper_fx_0002'));
  assert.ok(fresh.length > 0);
  for (const row of fresh) {
    assert.equal(row.reps, 0);
    assert.equal(row.startedOn, schedule.today, '新项从纳入当天开始，不继承历史逾期');
  }
});

// ── 清单 35：空库不冒充 100% ────────────────────────────────
test('空库：定位率给 N/A，不把「没有证据」算成百分之百', async () => {
  const { config } = await fixture({ papers: 0 });
  const result = await buildLearningLayer(config, { rebuild: true });
  assert.equal(result.counts.papers, 0);

  const report = JSON.parse(await fsp.readFile(path.join(config.learningRoot, 'report', 'validate.json'), 'utf8'));
  const locate = report.checks.find(check => check.id === 'evidence-located');
  assert.equal(locate.status, 'na');
  assert.equal(report.summary.evidenceLocateRatio, null);
});

// ── 审计 #16：job.json 声明的绝对路径属于外部输入 ──────────────
test('抽取路径越界：声明指向工作流目录之外时不予采信', async () => {
  const fx = await fixture({ papers: 1 });
  const outside = path.join(fx.root, 'outside', 'evil.extract.json');
  await fsp.mkdir(path.dirname(outside), { recursive: true });
  // 内容故意改成「标题被篡改」，如果被采信，学习层会出现这个标题
  const tampered = { ...extractFixture(fx.jobs[0].id), meta: { title: '被外部文件替换的标题' } };
  await fsp.writeFile(outside, JSON.stringify(tampered), 'utf8');

  const jobPath = path.join(fx.jobs[0].dir, 'job.json');
  const job = JSON.parse(await fsp.readFile(jobPath, 'utf8'));
  await fsp.writeFile(jobPath, JSON.stringify({ ...job, extractPath: outside }), 'utf8');

  await buildLearningLayer(fx.config, { rebuild: true });
  const paper = JSON.parse(await fsp.readFile(
    path.join(fx.learningRoot, 'papers', `${fx.jobs[0].id}.json`), 'utf8'));
  // 越界声明被忽略，回落到 jobDir 下的副本
  assert.equal(paper.title, `合成论文 ${fx.jobs[0].id}`);
});

test('抽取路径在目录内：声明可以作为副本缺失时的回落', async () => {
  const fx = await fixture({ papers: 1 });
  const shared = path.join(fx.workflowRoot, 'shared', 'p_0001.extract.json');
  await fsp.mkdir(path.dirname(shared), { recursive: true });
  await fsp.writeFile(shared, JSON.stringify(extractFixture(fx.jobs[0].id)), 'utf8');
  // 删掉本地副本，逼它走声明路径
  await fsp.rm(path.join(fx.jobs[0].dir, 'paper.extract.json'));

  const jobPath = path.join(fx.jobs[0].dir, 'job.json');
  const job = JSON.parse(await fsp.readFile(jobPath, 'utf8'));
  await fsp.writeFile(jobPath, JSON.stringify({ ...job, extractPath: shared }), 'utf8');

  await buildLearningLayer(fx.config, { rebuild: true });
  const paper = JSON.parse(await fsp.readFile(
    path.join(fx.learningRoot, 'papers', `${fx.jobs[0].id}.json`), 'utf8'));
  assert.equal(paper.title, `合成论文 ${fx.jobs[0].id}`);
});

// ── 评审 P0 #1：0 篇论文却报成功 ────────────────────────────
test('输入退化：上次有论文、这次读到 0 篇 → 结构校验 error 并拒绝发布', async () => {
  const fx = await fixture({ papers: 1 });
  await buildLearningLayer(fx.config, { rebuild: true });

  // 模拟路径指错：jobs 目录还在，但论文被移走
  await fsp.rm(path.join(fx.workflowRoot, '.plugin-state', 'jobs'), { recursive: true, force: true });
  await fsp.mkdir(path.join(fx.workflowRoot, '.plugin-state', 'jobs'), { recursive: true });

  await assert.rejects(
    () => buildLearningLayer(fx.config, {}),
    error => error.code === 'VALIDATION_STRUCTURE' && /输入非空/.test(error.message),
  );
});

test('卡片为 0：只警告不阻断，但 publishable 为 false', async () => {
  const fx = await fixture({ papers: 1 });
  await fsp.rm(path.join(fx.cardsHome, 'cards', 'A-0001.md'));
  await fsp.writeFile(path.join(fx.cardsHome, 'catalog.json'), JSON.stringify({ cards: [] }), 'utf8');

  const result = await buildLearningLayer(fx.config, { rebuild: true });
  assert.equal(result.counts.papers, 1);

  const report = JSON.parse(await fsp.readFile(
    path.join(fx.learningRoot, 'report', 'validate.json'), 'utf8'));
  const nonempty = report.checks.find(check => check.id === 'nonempty');
  assert.equal(nonempty.level, 'warn');
  assert.equal(report.summary.publishable, false);
});
