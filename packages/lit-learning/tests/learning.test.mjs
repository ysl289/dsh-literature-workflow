import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { normalizeConfig, assertBoundaries } from '../lib/config.mjs';
import { buildLearningLayer } from '../lib/build.mjs';
import { createService } from '../lib/service.mjs';
import { attachLearningPlugin } from '../index.mjs';
import { attachLearningUI } from '../host.mjs';
import { buildSchedule, todayISO, addDays } from '../lib/review.mjs';
import { normalizeStrategy } from '../lib/sources.mjs';

const WORKFLOW = process.env.DSH_LIT_WORKFLOW || path.join(os.homedir(), 'Downloads', '文献积累工作流');
const CARDS = process.env.DSH_LIT_CARDS || path.join(os.homedir(), 'Desktop', '知识卡片库');

async function hasRealData() {
  try {
    await fsp.access(path.join(WORKFLOW, '.plugin-state', 'jobs'));
    await fsp.access(path.join(CARDS, 'catalog.json'));
    return true;
  } catch {
    return false;
  }
}

const REAL = await hasRealData();

async function tempRoot(name) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `lit-learning-${name}-`));
  return dir;
}

function testConfig(learningRoot) {
  return normalizeConfig({ workflowRoot: WORKFLOW, cardsHome: CARDS, learningRoot });
}

test('配置：学习层不允许落在只读目录里', async () => {
  assert.throws(() => normalizeConfig({
    workflowRoot: WORKFLOW, cardsHome: CARDS,
    learningRoot: path.join(WORKFLOW, '.plugin-state', 'learning'),
  }), /学习层目录配置不合法/);

  assert.throws(() => normalizeConfig({
    workflowRoot: WORKFLOW, cardsHome: CARDS,
    learningRoot: path.join(CARDS, 'learning'),
  }), /学习层目录配置不合法/);

  assert.throws(() => assertBoundaries({
    learningRoot: path.parse(WORKFLOW).root, workflowRoot: WORKFLOW, cardsHome: CARDS, stateDir: path.join(WORKFLOW, '.plugin-state'),
  }), /学习层目录配置不合法/);
});

test('识别策略归一：别名落到同一枚举', () => {
  const lexicon = { canonical: [
    { id: 'DID', label: '双重差分', family: '准实验', aliases: ['difference-in-differences', 'DID'], portable: 3 },
    { id: 'IV', label: '工具变量', family: '准实验', aliases: ['two-stage least squares', '2SLS'], portable: 2 },
    { id: 'OTHER', label: '其他/未标注', family: '未标注', aliases: [], portable: 0 },
  ] };
  assert.equal(normalizeStrategy('交错双重差分（staggered DiD）', lexicon).id, 'DID');
  assert.equal(normalizeStrategy('difference-in-differences design', lexicon).id, 'DID');
  assert.equal(normalizeStrategy('two-stage least squares', lexicon).id, 'IV');
  assert.equal(normalizeStrategy('', lexicon).id, 'OTHER');
});

test('复习排程：答对升间隔，答错退回第一档', () => {
  const params = { intervalDays: [1, 3, 7], passScore: 3, dailyLimit: 20 };
  const items = [{ id: 'R:a', kind: 'paper-sentence', label: 'a', prompt: '' }];
  const createdOn = '2026-10-01';

  const fresh = buildSchedule({ items, log: [], params, createdOn, today: createdOn });
  assert.equal(fresh.items[0].dueAt, createdOn);
  assert.equal(fresh.items[0].interval, 1);

  const pass = buildSchedule({
    items,
    log: [{ itemId: 'R:a', grade: 3, at: '2026-10-01T10:00:00Z' }],
    params, createdOn, today: '2026-10-05',
  });
  assert.equal(pass.items[0].interval, 3);
  assert.equal(pass.items[0].dueAt, addDays('2026-10-01', 3));
  assert.equal(pass.counts.overdue, 1);

  const fail = buildSchedule({
    items,
    log: [
      { itemId: 'R:a', grade: 3, at: '2026-10-01T10:00:00Z' },
      { itemId: 'R:a', grade: 1, at: '2026-10-04T10:00:00Z' },
    ],
    params, createdOn, today: '2026-10-05',
  });
  assert.equal(fail.items[0].interval, 1);
  assert.equal(fail.items[0].lapses, 1);
});

test('宿主契约：工具与原生页路由都注册上了', async () => {
  const root = await tempRoot('host');
  const routes = [];
  const tools = [];
  const ctx = {
    tools: {
      register(spec) { tools.push(spec); return () => {}; },
    },
    connection: {
      fetch: {
        register(spec) { routes.push(spec); return () => {}; },
      },
    },
    locale: { register() {}, bind() { return key => key; } },
    slots: { register() {}, inject() {} },
  };

  const handle = await attachLearningPlugin(ctx, {
    workflowRoot: WORKFLOW, cardsHome: CARDS, learningRoot: root, autoBuild: false,
  }, { autoBuildDelayMs: 0 });

  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'lit_learning');
  assert.deepEqual(tools[0].parameters.required, ['action']);
  assert.ok(tools[0].parameters.properties.action.enum.includes('build'));

  const paths = routes.map(route => route.path).sort();
  assert.deepEqual(paths, [
    '/api/litLearning/file',
    '/api/litLearning/invoke',
    '/api/litLearning/ping',
    '/api/litLearning/review',
    '/api/litLearning/status',
  ]);

  // 原生页注册状态要能从 status 里读出来（面板与工具都靠它判断）
  const status = await handle.service.status();
  assert.equal(status.nativeUI.registered, true);
  assert.equal(status.nativeUI.error, '');

  await assert.rejects(() => tools[0].execute({ action: 'nope' }), /不支持的操作/);
  await handle.dispose();
});

test('宿主契约：connection 晚就绪时不拖垮插件，就绪后补挂原生页', async () => {
  const root = await tempRoot('late-connection');
  const routes = [];
  let pendingInject;

  // 关键：apply 时 ctx.connection 还不存在（真实环境里 connection 可能晚于插件就绪）
  const ctx = {
    tools: { register() { return () => {}; } },
    inject(names, callback) {
      assert.deepEqual(names, ['connection']);
      pendingInject = () => callback({
        connection: { fetch: { register(spec) { routes.push(spec); return () => {}; } } },
      });
    },
  };

  const handle = await attachLearningPlugin(ctx, {
    workflowRoot: WORKFLOW, cardsHome: CARDS, learningRoot: root, autoBuild: false,
  }, { autoBuildDelayMs: 0 });

  assert.equal(routes.length, 0, 'connection 未就绪时不应该有路由');
  const before = await handle.service.status();
  assert.equal(before.nativeUI.registered, false);

  pendingInject();
  assert.equal(routes.length, 5, 'connection 就绪后应补挂 5 条路由');
  const after = await handle.service.status();
  assert.equal(after.nativeUI.registered, true);
  assert.equal(after.nativeUI.error, '');

  await handle.dispose();
});

test('原生页：路径越界被拒', async () => {
  const root = await tempRoot('paths');
  await fsp.mkdir(path.join(root, 'papers'), { recursive: true });
  await fsp.writeFile(path.join(root, 'papers', 'ok.json'), '{}', 'utf8');
  await fsp.writeFile(path.join(root, 'secret.txt'), 'x', 'utf8');

  const routes = [];
  const ctx = { connection: { fetch: { register(spec) { routes.push(spec); return () => {}; } } } };
  const config = testConfig(root);
  attachLearningUI(ctx, createService(config), config);

  const fileRoute = routes.find(route => route.path.endsWith('/file'));
  const okResponse = await fileRoute.fetch(new Request('http://x/api/litLearning/file?rel=papers/ok.json'));
  assert.equal(okResponse.status, 200);

  const bad = await fileRoute.fetch(new Request('http://x/api/litLearning/file?rel=../secret.txt'));
  assert.equal(bad.status, 400);
  const body = await bad.json();
  assert.match(body.error, /不合法|越界/);

  const disallowed = await fileRoute.fetch(new Request('http://x/api/litLearning/file?rel=secret.txt'));
  assert.equal(disallowed.status, 400);
});

test('真实数据：构建 → 幂等 → 整层重建', { skip: REAL ? false : '本机没有文献工作流/卡片库数据' }, async () => {
  const root = await tempRoot('build');
  const config = testConfig(root);

  const first = await buildLearningLayer(config, { rebuild: true });
  assert.equal(first.ok, true, JSON.stringify(first.checks));
  assert.ok(first.counts.papers >= 1);
  assert.ok(first.counts.cards >= 1);

  const snapshot = new Map();
  for (const rel of first.written) {
    snapshot.set(rel, await fsp.readFile(path.join(root, rel), 'utf8'));
  }

  // 第二次：内容指纹不变、不产生任何写入
  const second = await buildLearningLayer(config, {});
  assert.equal(second.contentHash, first.contentHash);
  assert.equal(second.written.length, 0, '第二次运行不应该写任何内容文件');
  for (const [rel, text] of snapshot) {
    assert.equal(await fsp.readFile(path.join(root, rel), 'utf8'), text, `${rel} 内容应字节一致`);
  }

  // 复习记录必须跨越重建保留
  await fsp.mkdir(path.join(root, 'review'), { recursive: true });
  const logLine = JSON.stringify({ at: new Date().toISOString(), itemId: 'R:keep', grade: 4 }) + '\n';
  await fsp.appendFile(path.join(root, 'review', 'log.jsonl'), logLine, 'utf8');

  const rebuilt = await buildLearningLayer(config, { rebuild: true });
  assert.equal(rebuilt.contentHash, first.contentHash, '整层重建应得到同一内容指纹');
  const kept = await fsp.readFile(path.join(root, 'review', 'log.jsonl'), 'utf8');
  assert.match(kept, /R:keep/);
});

test('真实数据：评级可复现且每条理由都挂证据', { skip: REAL ? false : '本机没有数据' }, async () => {
  const root = await tempRoot('rating');
  const config = testConfig(root);
  const result = await buildLearningLayer(config, { rebuild: true });

  const manifest = JSON.parse(await fsp.readFile(path.join(root, 'manifest.json'), 'utf8'));
  for (const paperId of manifest.inputs.paperIds) {
    const paper = JSON.parse(await fsp.readFile(path.join(root, 'papers', `${paperId}.json`), 'utf8'));
    assert.ok(['A', 'B', 'C', 'D'].includes(paper.rating.grade));
    for (const key of ['internal', 'external', 'sufficiency']) {
      assert.ok(paper.rating.axes[key].reasons.length > 0, `${paperId} ${key} 应有理由`);
      for (const reason of paper.rating.axes[key].reasons) {
        if (reason.status !== 'ok') continue;
        assert.ok((reason.evidence || []).length > 0, `${paperId} ${key} 的计分理由缺证据`);
      }
    }
    for (const sentence of paper.recital.sentences) {
      if (sentence.status !== 'ok') continue;
      assert.ok((sentence.evidence || []).length > 0, `${paperId} ${sentence.key} 缺证据`);
    }
  }

  const again = await buildLearningLayer(config, {});
  assert.equal(again.contentHash, result.contentHash);
});

test('真实数据：校验九项都过（警告级除外）', { skip: REAL ? false : '本机没有数据' }, async () => {
  const root = await tempRoot('validate');
  const config = testConfig(root);
  await buildLearningLayer(config, { rebuild: true });
  const report = JSON.parse(await fsp.readFile(path.join(root, 'report', 'validate.json'), 'utf8'));

  const byId = Object.fromEntries(report.checks.map(check => [check.id, check]));
  for (const id of ['evidence', 'dangling', 'reasons', 'verbatim', 'boundary', 'abstract', 'anchors']) {
    assert.ok(byId[id], `缺少校验项 ${id}`);
    assert.equal(byId[id].ok, true, `${id} 未通过：${byId[id].detail}`);
  }
  assert.equal(report.summary.ok, true);
});

test('工具输出：status / review 结构稳定', { skip: REAL ? false : '本机没有数据' }, async () => {
  const root = await tempRoot('tool');
  const config = testConfig(root);
  const service = createService(config);
  await service.invoke('build', { rebuild: true });

  const status = await service.invoke('status');
  assert.equal(status.exists, true);
  assert.ok(status.counts.papers >= 1);
  assert.ok(Array.isArray(status.readonly));

  const queue = await service.invoke('review', { limit: 3 });
  assert.ok(queue.queue.length <= 3);
  assert.ok(Array.isArray(queue.params.intervalDays));

  const strategies = await service.invoke('strategies');
  assert.ok(Array.isArray(strategies.strategies));

  const links = await service.invoke('links');
  assert.ok(Array.isArray(links.links));

  const paperId = status.counts.papers ? (await service.invoke('dashboard')).inputs.paperIds[0] : null;
  const paper = await service.invoke('paper', { paperId });
  assert.equal(paper.paperId, paperId);
  assert.ok(paper.rating.grade);
  assert.ok(paper.recital.sentences.length === 4);

  await assert.rejects(() => service.invoke('paper', { paperId: '../etc' }), /不合法/);
});

test('复习记录：写入后间隔按口径推进', { skip: REAL ? false : '本机没有数据' }, async () => {
  const root = await tempRoot('review');
  const config = testConfig(root);
  const service = createService(config);
  await service.invoke('build', { rebuild: true });

  const queue = await service.invoke('review', { limit: 1 });
  const item = queue.queue[0] || queue.items[0];
  assert.ok(item, '应该有可复习条目');

  const recorded = await service.invoke('review_record', { itemId: item.id, itemVersion: item.itemVersion, attemptId: 'learning-test-first', grade: 4 });
  assert.equal(recorded.recorded.grade, 4);
  assert.ok(recorded.dueAt >= todayISO());

  const after = await service.invoke('review', { limit: 50 });
  const updated = after.items.find(row => row.id === item.id);
  assert.equal(updated.interval, config.review.intervalDays[1]);
});
