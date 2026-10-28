import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { apply, attachLearningPlugin } from '../index.mjs';

const installRoot = process.env.DSH_TEST_INSTALL_ROOT
  || path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'DeepSeek Harness');
const electronRuntime = Boolean(process.versions.electron || process.env.ELECTRON_RUN_AS_NODE === '1');
const cordisEntry = path.join(
  installRoot,
  'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js',
);
const cordisAvailable = electronRuntime && await fs.access(cordisEntry).then(() => true).catch(() => false);
let Context;
let Service;
if (cordisAvailable) {
  ({ Context, Service } = await import(pathToFileURL(cordisEntry).href));
}

async function temporaryRoot(t, name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `dsh-lit-cordis-${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function testConfig(root) {
  return {
    workflowRoot: path.join(root, 'workflow'),
    cardsHome: path.join(root, 'cards'),
    learningRoot: path.join(root, 'learning'),
    autoBuild: false,
    nativeUI: true,
  };
}

function createHost() {
  const root = new Context();
  const routes = new Map();
  const tools = new Map();

  class Tools extends Service {
    constructor(ctx) {
      super(ctx, 'tools');
    }

    register(spec) {
      const owner = this.ctx;
      return owner.effect(() => {
        tools.set(spec.name, spec);
        return () => tools.delete(spec.name);
      }, `test tools: ${spec.name}`);
    }
  }

  class Connection extends Service {
    constructor(ctx) {
      super(ctx, 'connection');
    }

    get fetch() {
      const owner = this.ctx;
      return {
        register(route) {
          return owner.effect(() => {
            routes.set(route.path, route);
            return () => routes.delete(route.path);
          }, `test Fetch route: ${route.path}`);
        },
      };
    }
  }

  new Tools(root);
  new Connection(root);
  return { root, routes, tools };
}

function pluginDefinition(applyMethod, name) {
  return { name, inject: ['tools', 'connection'], apply: applyMethod };
}

async function verifyActivePlugin(t) {
  const temp = await temporaryRoot(t, 'active');
  const { root, routes, tools } = createHost();
  const fiber = root.plugin(
    pluginDefinition(apply, 'lit-learning-fixed-return'),
    testConfig(temp),
  );

  await fiber;
  assert.equal(fiber.state, 2, 'Cordis FiberState.ACTIVE');
  assert.equal(fiber._error, undefined);
  assert.equal(tools.size, 1);
  assert.deepEqual([...routes.keys()].sort(), [
    '/api/litLearning/file',
    '/api/litLearning/invoke',
    '/api/litLearning/ping',
    '/api/litLearning/review',
    '/api/litLearning/status',
  ]);

  const ping = await routes.get('/api/litLearning/ping').fetch(
    new Request('http://dsh.internal/api/litLearning/ping'),
  );
  assert.equal(ping.status, 200);
  assert.equal((await ping.json()).ok, true);

  const status = await routes.get('/api/litLearning/status').fetch(
    new Request('http://dsh.internal/api/litLearning/status'),
  );
  assert.equal(status.status, 200);
  assert.equal((await status.json()).nativeUI.registered, true);

  const badPath = await routes.get('/api/litLearning/file').fetch(
    new Request('http://dsh.internal/api/litLearning/file?rel=../outside.json'),
  );
  assert.equal(badPath.status, 400);

  await fiber.dispose();
  assert.equal(routes.size, 0, 'Cordis unload removes all Fetch routes');
  assert.equal(tools.size, 0, 'Cordis unload removes the tool');
}

async function verifyLegacyInvalidEffect(t) {
  const temp = await temporaryRoot(t, 'legacy');
  const { root, routes, tools } = createHost();

  async function legacyApply(ctx, config) {
    const handle = await attachLearningPlugin(ctx, config);
    ctx.on('dispose', () => { void handle.dispose(); });
    return handle;
  }

  const fiber = root.plugin(
    pluginDefinition(legacyApply, 'lit-learning-legacy-return'),
    testConfig(temp),
  );

  await assert.rejects(Promise.resolve(fiber), /Invalid effect/);
  assert.equal(routes.size, 0, 'failed Fiber unload removes routes registered before apply resolved');
  assert.equal(tools.size, 0, 'failed Fiber unload removes the tool');
}

if (!electronRuntime) {
  test.skip('real Cordis keeps the learning routes until plugin unload', 'requires Electron runtime for installed app.asar access', () => {});
  test.skip('legacy async apply returning a handle object reproduces Cordis Invalid effect and unload', 'requires Electron runtime for installed app.asar access', () => {});
} else if (!cordisAvailable) {
  test.skip('real Cordis keeps the learning routes until plugin unload', `installed Cordis package not found under ${installRoot}`, () => {});
  test.skip('legacy async apply returning a handle object reproduces Cordis Invalid effect and unload', `installed Cordis package not found under ${installRoot}`, () => {});
} else {
  test('real Cordis keeps the learning routes until plugin unload', verifyActivePlugin);
  test('legacy async apply returning a handle object reproduces Cordis Invalid effect and unload', verifyLegacyInvalidEffect);
}
