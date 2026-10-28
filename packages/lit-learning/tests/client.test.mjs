// 面板端到端测试：在 jsdom 里真渲染一遍 LearningPage，
// 用 __DSH_TRANSPORT__ 桩把请求接进真实的 service（不经过 HTTP）。
// 这条测试能抓到「接口通了但页面渲染炸了」这类问题。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_DEPS = path.join(HERE, '..', 'node_modules');
const DEPS = fs.existsSync(path.join(LOCAL_DEPS, 'jsdom'))
  ? LOCAL_DEPS
  : path.join(HERE, '..', '..', 'plugin-hub', 'tests', 'node_modules');
const CLIENT = path.join(HERE, '..', 'client.js');
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
const depsReady = fs.existsSync(path.join(DEPS, 'jsdom'));

test('面板：能渲染出真实数据，不是只剩骨架', { skip: REAL && depsReady ? false : '缺少真实数据或 jsdom 依赖' }, async () => {
  const requireDep = createRequire(path.join(DEPS, 'noop.js'));
  const { JSDOM } = requireDep('jsdom');
  const React = requireDep('react');
  const { createRoot } = requireDep('react-dom/client');
  const { act } = requireDep('react-dom/test-utils');

  const dom = new JSDOM('<!doctype html><html lang="zh"><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'https://dsh.local/',
  });
  global.window = dom.window;
  global.document = dom.window.document;
  global.IS_REACT_ACT_ENVIRONMENT = true;

  // ── 用真实 service 做传输桩 ──────────────────────────────
  const { normalizeConfig } = await import('../lib/config.mjs');
  const { createService } = await import('../lib/service.mjs');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lit-learning-ui-'));
  const config = normalizeConfig({ workflowRoot: WORKFLOW, cardsHome: CARDS, learningRoot: root });
  const service = createService(config);
  await service.invoke('build', { rebuild: true });

  const seen = [];
  globalThis.__DSH_TRANSPORT__ = {
    streamBaseUrl: 'http://127.0.0.1:1/',
    async fetch(url, init) {
      const relative = String(url).replace(/^\/+/, '');
      seen.push(relative);
      assert.ok(relative.startsWith('api/litLearning/'), '面板必须走 api/litLearning 前缀，实际：' + relative);
      const [route, query] = relative.slice('api/litLearning'.length).split('?');
      if (route === '/ping') {
        return new Response(JSON.stringify({ ok: true, plugin: 'dsh-lit-learning', pid: process.pid }), { status: 200 });
      }
      if (route === '/status') return new Response(JSON.stringify(await service.status()), { status: 200 });
      if (route === '/invoke') {
        const body = JSON.parse(init.body);
        return new Response(JSON.stringify(await service.invoke(body.action, body.payload || {})), { status: 200 });
      }
      if (route === '/file') {
        const rel = new URLSearchParams(query || '').get('rel');
        const text = await fsp.readFile(path.join(root, rel), 'utf8');
        return new Response(text, { status: 200 });
      }
      if (route === '/review') {
        return new Response(JSON.stringify(await service.recordReview(JSON.parse(init.body))), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unknown' }), { status: 404 });
    },
  };

  // ── 加载客户端 bundle ───────────────────────────────────
  let mod = null;
  dom.window.__ModuleLoader__ = {
    load({ factory }) {
      mod = {
        exports: factory(name => {
          if (name === 'react') return React;
          throw new Error('未知依赖: ' + name);
        }),
      };
    },
  };
  new Function('window', 'document', fs.readFileSync(CLIENT, 'utf8'))(dom.window, dom.window.document);
  assert.ok(mod, '客户端 bundle 未注册');

  const slots = new Map();
  const ctx = {
    effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
    locale: {
      register() {},
      bind: () => key => key,
      subscribe: () => () => {},
      getLocale: () => ({ active: { id: 'zh-CN' } }),
    },
    slots: {
      inject(_name, fn) {
        const out = fn();
        if (out && typeof out.next === 'function') {
          let step = out.next();
          while (!step.done) step = out.next();
          return step.value;
        }
        return out;
      },
      register(opts, component) { slots.set(opts.name + ':' + (opts.id || opts.key), { opts, component }); return () => {}; },
      subscribe: () => () => {},
      entriesOfSlot: () => [],
      entries: () => [],
    },
  };

  mod.exports.apply(ctx);
  const page = slots.get('main:lit-learning');
  assert.ok(page, '未注册 main 面板');
  const side = slots.get('sidebar.panellist:lit-learning');
  assert.ok(side && side.opts.order === 27, '侧边栏面板注册不正确');

  const host = dom.window.document.getElementById('root');
  const reactRoot = createRoot(host);
  await act(async () => { reactRoot.render(React.createElement(page.component, { t: key => key })); });
  // 等状态与论文列表两轮异步都落地。
  // 1200ms 是实测下限：论文从 3 篇涨到 5 篇后，首屏要拉 status + papers 两次，300ms 会读到空状态。
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1200)); });

  const text = host.textContent || '';
  assert.ok(!text.includes('Failed to fetch'), '仍然报 Failed to fetch：' + text.slice(0, 200));
  assert.ok(!text.includes('还没有学习层'), '状态没读出来：' + text.slice(0, 200));
  assert.ok(text.includes('文献学习层'), '缺少面板标题');
  assert.ok(/本库准备度 A\/B/.test(text), '缺少准备度 KPI');
  assert.ok(text.includes('内容指纹'), '缺少指纹区块');
  // 面板统一走 /invoke（status 也是一个 action），不单独打 /status 路由
  assert.ok(seen.some(url => url.endsWith('/invoke')), '没有请求 invoke');

  // ── 切到「论文」页签，应出现真实标题 ─────────────────────
  const tabs = [...host.querySelectorAll('.ll-tab')];
  const paperTab = tabs.find(node => node.textContent === '论文');
  assert.ok(paperTab, '没找到「论文」页签');
  await act(async () => { paperTab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1200)); });
  const paperText = host.textContent || '';
  assert.ok(/BITNET|Wandering|Professor/.test(paperText), '论文列表没有内容：' + paperText.slice(0, 300));
  assert.ok(/双重差分|流动者设计/.test(paperText), '论文列表没有显示识别策略');
  assert.ok(host.querySelectorAll('.ll-pick').length >= 3, '论文条目数不对');

  // ── 切到「地图」页签，iframe 应拿到 srcDoc ──────────────
  const mapTab = [...host.querySelectorAll('.ll-tab')].find(node => node.textContent === '地图');
  await act(async () => { mapTab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1200)); });
  const iframe = host.querySelector('iframe');
  assert.ok(iframe, '地图 iframe 没有渲染');
  assert.ok(String(iframe.getAttribute('srcdoc') || '').includes('领域地图'), 'iframe 没有拿到地图 HTML');

  await act(async () => { reactRoot.unmount(); });
  delete globalThis.__DSH_TRANSPORT__;
  await fsp.rm(root, { recursive: true, force: true });
});
