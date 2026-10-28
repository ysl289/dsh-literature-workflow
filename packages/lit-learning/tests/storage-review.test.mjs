import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig } from '../lib/config.mjs';
import { createService, readLayerFile } from '../lib/service.mjs';
import { currentRoot } from '../lib/storage.mjs';

const FULL = [
  '本研究考察合成政策与结果的关系。',
  '',
  '使用县级面板数据，采用双重差分方法。',
  '',
  '平行趋势是假设，安慰剂检验排除随机相关。',
  '',
  '基准系数为 −0.25，估计结果单位为对数点。',
  '',
  '样本只有两个地区，外推需谨慎。',
].join('\n');

function extract(id) {
  return {
    meta: { title: `合成论文 ${id}`, year: '2020', doi: `10.0000/${id}` },
    authors: 'Audit, A.',
    year: '2020',
    research_questions: ['合成政策与结果有何关系'],
    data: '县级面板数据',
    core_theory: '配置效率',
    limitations: ['样本只有两个地区，外推需谨慎'],
    design: {
      identification: { strategy: '双重差分', assumption: '平行趋势是假设', threats: ['随机相关'] },
      robustness: [{ check: '安慰剂检验', what_it_guards: '随机相关', result: '通过' }],
    },
    coefficients: [{ name: '基准系数', value: '−0.25', unit: '对数点' }],
    evidence: [
      { field: 'data', quote: '使用县级面板数据', page: 1 },
      { field: 'design.identification.strategy', quote: '采用双重差分方法', page: 1 },
      { field: 'limitations.0', quote: '样本只有两个地区，外推需谨慎', page: 1 },
    ],
  };
}

async function fixture(count = 1) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lit-storage-'));
  const workflowRoot = path.join(root, 'workflow');
  const cardsHome = path.join(root, 'cards');
  const learningRoot = path.join(root, 'learning');
  await fsp.mkdir(path.join(cardsHome, 'cards'), { recursive: true });
  await fsp.writeFile(path.join(cardsHome, 'catalog.json'), '{"cards":[]}', 'utf8');
  const jobs = [];
  for (let i = 1; i <= count; i += 1) {
    const id = `p_${String(i).padStart(2, '0')}`;
    const dir = path.join(workflowRoot, '.plugin-state', 'jobs', id);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'job.json'), JSON.stringify({ id, status: 'done', stage: 'ready' }), 'utf8');
    await fsp.writeFile(path.join(dir, 'full.md'), FULL, 'utf8');
    await fsp.writeFile(path.join(dir, 'pages.json'), JSON.stringify([{ page: 1, startChar: 0, endChar: FULL.length }]), 'utf8');
    await fsp.writeFile(path.join(dir, 'paper.extract.json'), JSON.stringify(extract(id)), 'utf8');
    jobs.push({ id, dir });
  }
  const config = normalizeConfig({ workflowRoot, cardsHome, learningRoot });
  return { root, config, workflowRoot, cardsHome, learningRoot, jobs };
}

test('代际发布：失败构建保留上一代和旧论文读取', async () => {
  const fx = await fixture();
  const service = createService(fx.config);
  const first = await service.build({ rebuild: true });
  assert.ok(first.generation);
  const oldRoot = await currentRoot(fx.learningRoot);
  assert.notEqual(oldRoot, fx.learningRoot);
  const before = await service.status();
  assert.equal(before.generation, first.generation);

  await fsp.writeFile(path.join(fx.jobs[0].dir, 'paper.extract.json'), '{broken', 'utf8');
  await assert.rejects(() => service.build({ rebuild: true }), /JSON 损坏/);
  const after = await service.status();
  assert.equal(after.contentHash, before.contentHash);
  assert.equal(after.generation, before.generation);
  assert.equal((await service.invoke('paper', { paperId: 'p_01' })).title, '合成论文 p_01');
  assert.ok(readLayerFile(fx.config, 'papers/p_01.json').includes('.generations'));
});

test('陈旧产物：当前清单收不回的文件不再可读', async () => {
  const fx = await fixture(2);
  const service = createService(fx.config);
  await service.build({ rebuild: true });
  await fsp.rm(fx.jobs[1].dir, { recursive: true, force: true });
  await service.build({});
  assert.equal((await service.invoke('paper', { paperId: 'p_02' }).catch(error => error.message)).includes('不在当前学习层'), true);
  assert.throws(() => readLayerFile(fx.config, 'papers/p_02.json'), /不在当前学习层清单/);
});

test('复习：题面/答案分离、严格版本与 attempt 幂等', async () => {
  const fx = await fixture();
  const service = createService(fx.config);
  await service.build({ rebuild: true });
  const queue = await service.invoke('review', { limit: 1 });
  const item = queue.queue[0];
  assert.ok(item);
  assert.ok(item.itemVersion);
  assert.ok(item.answer);
  assert.notEqual(item.prompt, item.answer);
  assert.doesNotMatch(item.prompt, /双重差分|−0\.25/);

  await assert.rejects(() => service.invoke('review_record', { itemId: item.id, itemVersion: item.itemVersion, attemptId: 'a1', grade: '3' }), /0–4 的整数/);
  await assert.rejects(() => service.invoke('review_record', { itemId: item.id, itemVersion: 'stale', attemptId: 'a2', grade: 3 }), /内容已变化/);
  await assert.rejects(() => service.invoke('review_record', { itemId: item.id, itemVersion: item.itemVersion, grade: 3 }), /attemptId/);

  const first = await service.invoke('review_record', { itemId: item.id, itemVersion: item.itemVersion, attemptId: 'a3', grade: 3 });
  assert.equal(first.duplicate, false);
  const again = await service.invoke('review_record', { itemId: item.id, itemVersion: item.itemVersion, attemptId: 'a3', grade: 3 });
  assert.equal(again.duplicate, true);
  await assert.rejects(() => service.invoke('review_record', { itemId: item.id, itemVersion: item.itemVersion, attemptId: 'a3', grade: 1 }), /参数不一致/);

  const status = await service.status();
  assert.equal(status.review.reviewed, 1);
});

test('发布失败：根目录写失败时指针仍指旧代', async () => {
  const fx = await fixture();
  const service = createService(fx.config);
  await service.build({ rebuild: true });
  const before = await service.status();
  await fsp.rm(path.join(fx.learningRoot, 'dashboard.json'), { force: true });
  await fsp.mkdir(path.join(fx.learningRoot, 'dashboard.json'));
  await assert.rejects(() => service.build({}));
  const after = await service.status();
  assert.equal(after.contentHash, before.contentHash);
  assert.equal(after.generation, before.generation);
  assert.equal((await service.invoke('paper', { paperId: 'p_01' })).title, '合成论文 p_01');
});

test('新鲜度：正文变化显示 stale，重建后 fresh', async () => {
  const fx = await fixture();
  const service = createService(fx.config);
  await service.build({ rebuild: true });
  assert.equal((await service.status()).freshness.state, 'fresh');
  await fsp.appendFile(path.join(fx.jobs[0].dir, 'full.md'), '\n补充正文。\n', 'utf8');
  assert.equal((await service.status()).freshness.state, 'stale');
  await service.build({});
  assert.equal((await service.status()).freshness.state, 'fresh');
});

test('配置：不存在末端目录也做双向真实路径边界', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lit-bound-'));
  const learning = path.join(root, 'learning');
  const cards = path.join(learning, 'cards');
  await fsp.mkdir(path.join(cards, 'cards'), { recursive: true });
  assert.throws(() => normalizeConfig({
    workflowRoot: path.join(root, 'workflow'),
    cardsHome: cards,
    learningRoot: learning,
  }), /学习层目录不能包住知识卡片库/);
});
