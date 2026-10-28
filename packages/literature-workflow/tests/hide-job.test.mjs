import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LiteratureEngine } from '../lib/engine.mjs';
import { JobStore, within } from '../lib/store.mjs';

const fixedStages = ['import', 'classify', 'zotero', 'read'];

async function setup(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lit-hide-job-'));
  t.after(async () => {
    assert.ok(within(os.tmpdir(), root) && path.basename(root).startsWith('lit-hide-job-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const stateDir = path.join(root, 'state');
  const engineConfig = {
    stateDir,
    inputDir: path.join(root, 'input'),
    watchInput: false,
    autoRun: false,
  };
  const engine = new LiteratureEngine(engineConfig, options);
  await engine.store.init();

  const id = 'paper_hide_fixture_01';
  await fs.mkdir(engine.store.dir(id), { recursive: true });
  const job = {
    id,
    kind: 'import',
    inputKind: 'markdown',
    originalName: 'source.md',
    metadata: { title: 'Hide fixture paper' },
    status: 'paused',
    stage: 'read',
    stages: [...fixedStages],
    cursor: 3,
    completedStages: ['import', 'classify', 'zotero'],
    artifacts: { source: 'source.md', read: 'read.json', design: 'design.html' },
    createdAt: '2026-10-21T00:00:00.000Z',
    hidden: false,
  };
  await engine.store.save(job);
  return { root, stateDir, engineConfig, engine, job, id };
}

function workflowState(job) {
  return {
    status: job.status,
    stage: job.stage,
    cursor: job.cursor,
    stages: job.stages,
    completedStages: job.completedStages,
    artifacts: job.artifacts,
  };
}

test('hide state survives engine and store restarts, then persists when unhidden', async t => {
  const { stateDir, engineConfig, engine, id } = await setup(t);

  assert.deepEqual(await engine.hideJob({ jobId: id, hidden: true }), { id, hidden: true });
  const restartedStore = new JobStore(stateDir);
  await restartedStore.init();
  assert.equal((await restartedStore.get(id)).hidden, true, 'the separate visibility record is loaded after restart');

  const restartedEngine = new LiteratureEngine(engineConfig);
  assert.equal((await restartedEngine.store.get(id)).hidden, true, 'a new engine instance sees the hidden state');
  await restartedEngine.store.setHidden(id, false);
  const finalStore = new JobStore(stateDir);
  await finalStore.init();
  assert.equal((await finalStore.get(id)).hidden, false, 'the unhidden state also survives restart');
});

test('a stale job save cannot overwrite visibility stored separately', async t => {
  const { engine, id } = await setup(t);
  const staleJob = await engine.store.get(id);
  assert.equal(staleJob.hidden, false);

  await engine.hideJob({ jobId: id, hidden: true });
  staleJob.hidden = false;
  staleJob.status = 'needs_attention';
  await engine.store.save(staleJob);

  const saved = await engine.store.get(id);
  assert.equal(saved.hidden, true, 'the visibility overlay wins over a stale job.json value');
  assert.equal(saved.status, 'needs_attention', 'the stale save still persists ordinary job changes');
});

test('hiding and unhiding do not change workflow progress or artifacts', async t => {
  const { engine, job, id } = await setup(t);
  const before = workflowState(await engine.store.get(id));

  await engine.hideJob({ jobId: id, hidden: true });
  const hidden = await engine.store.get(id);
  assert.equal(hidden.hidden, true);
  assert.deepEqual(workflowState(hidden), before);

  await engine.hideJob({ jobId: id, hidden: false });
  const visible = await engine.store.get(id);
  assert.equal(visible.hidden, false);
  assert.deepEqual(workflowState(visible), before);
  assert.deepEqual(job.stages, fixedStages, 'the fixture progress remains independent of visibility actions');
});

test('unhiding a legacy archived job restores it without starting the workflow', async t => {
  let onWorkCalls = 0;
  const { engine, id, stateDir } = await setup(t, { onWork: async () => { onWorkCalls += 1; } });
  const before = workflowState(await engine.store.get(id));
  const result = await engine.store.remove(id, async () => {});
  assert.equal(result.deleted, true);
  assert.equal((await engine.store.list()).length, 0, 'legacy remove archives the task out of the active queue');

  const archived = await engine.store.list({ includeArchived: true });
  assert.equal(archived.length, 1);
  assert.equal(archived[0].archived, true);
  assert.equal(archived[0].hidden, true);

  await engine.hideJob({ jobId: id, hidden: false });
  const restored = await engine.store.get(id);
  assert.equal(restored.hidden, false);
  assert.deepEqual(workflowState(restored), before);
  assert.equal(engine.active.has(id), false, 'restoration does not mark the job as running');
  assert.equal(onWorkCalls, 0, 'restoration never dispatches the literature worker');
  assert.ok(await fs.stat(path.join(stateDir, 'jobs', id, 'job.json')));
  assert.equal(await fs.stat(path.join(stateDir, '.deleted-jobs', id)).then(() => true, () => false), false);
  assert.equal(await fs.stat(path.join(stateDir, '.deleted-jobs', `${id}.json`)).then(() => true, () => false), false);
});

test('a pending purge plan prevents restoring an archived task', async t => {
  const { engine, id, stateDir } = await setup(t);
  await engine.store.remove(id, async () => {});
  const purgeDir = path.join(stateDir, '.purge-plans');
  await fs.mkdir(purgeDir, { recursive: true });
  await fs.writeFile(path.join(purgeDir, `${id}.json`), JSON.stringify({ jobId: id, planToken: 'pending-fixture' }));

  await assert.rejects(engine.hideJob({ jobId: id, hidden: false }), /不能恢复/);
  assert.equal(await fs.stat(path.join(stateDir, 'jobs', id)).then(() => true, () => false), false, 'the pending archive is not moved back into the active queue');
  assert.ok(await fs.stat(path.join(stateDir, '.deleted-jobs', id, 'job.json')));
  assert.ok(await fs.stat(path.join(stateDir, '.deleted-jobs', `${id}.json`)));
  const archived = await engine.store.list({ includeArchived: true });
  assert.equal(archived.length, 1);
  assert.equal(archived[0].archived, true);
});
