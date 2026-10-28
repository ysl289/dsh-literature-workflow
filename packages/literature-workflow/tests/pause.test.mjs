import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LiteratureEngine } from '../lib/engine.mjs';

const stages = ['import', 'prepare', 'classify'];

async function setup(t, options = {}, config = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-lit-pause-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const engine = new LiteratureEngine({
    stateDir: path.join(root, 'state'),
    inputDir: path.join(root, 'input'),
    watchInput: false,
    autoRun: false,
    publishMode: 'local',
    ...config,
  }, options);
  await engine.store.init();
  const pdf = async name => {
    const file = path.join(root, name);
    await fs.writeFile(file, `%PDF-1.4\n${name}\n`);
    return file;
  };
  return { engine, root, pdf, pdfPath: await pdf('fixture.pdf') };
}

async function pausedJob(engine, pdfPath) {
  const job = await engine.enqueue({ pdfPath, stages, stopAfter: 'prepare', autoRun: false });
  const saved = await engine.store.get(job.id);
  // prepare is deterministic once its artifacts exist, so the pause is observable without Python.
  saved.prepared = { pageCount: 2, pagesPath: path.join(engine.store.dir(job.id), 'pages.json') };
  await engine.store.save(saved);
  return job;
}

test('enqueue keeps the complete stage list and only records a usable pause point', async t => {
  const { engine, pdfPath, pdf } = await setup(t);

  const job = await engine.enqueue({ pdfPath, stages, stopAfter: 'prepare', autoRun: false });
  assert.deepEqual(job.stages, stages, 'the full pipeline stays in the job');
  assert.equal(job.stopAfter, 'prepare');

  await assert.rejects(
    () => engine.enqueue({ pdfPath, stages, stopAfter: 'sheet', autoRun: false }),
    /暂停步骤不在所选流程内/,
  );

  const tail = await engine.enqueue({ pdfPath: await pdf('tail.pdf'), stages, stopAfter: 'classify', autoRun: false });
  assert.equal(tail.stopAfter, null, 'pausing after the last stage is just completion');
  assert.deepEqual(tail.stages, stages);
});

test('finish pauses after the requested stage without skipping the remaining ones', async t => {
  const { engine, pdfPath } = await setup(t);
  const job = await pausedJob(engine, pdfPath);

  const result = await engine.finish(job.id);
  assert.equal(result.status, 'paused');
  assert.equal(result.pausedAfter, 'prepare');
  assert.equal(result.cursor, 2, 'the cursor advanced past the completed stage');
  assert.deepEqual(result.completedStages, ['import', 'prepare']);
  assert.deepEqual(result.stages, stages, 'remaining stages are preserved, not dropped');
  assert.deepEqual(result.skippedStages, {}, 'a pause never marks later stages as skipped');
  assert.equal(result.stopAfter, 'prepare');
  assert.match(result.instruction, /暂停/);

  const stored = await engine.store.get(job.id);
  assert.equal(stored.status, 'paused');
  assert.equal(stored.stage, 'prepare');
  assert.equal(stored.cursor, 2);
});

test('retry clears the pause point and hands the job back to the agent at the cursor', async t => {
  const observed = [];
  const { engine, pdfPath } = await setup(t, {
    onWork: async input => { observed.push(input); return { sessionId: 'fixture-session' }; },
  });
  const job = await pausedJob(engine, pdfPath);
  await engine.finish(job.id);

  const resumed = await engine.invoke('retry', { jobId: job.id });
  assert.equal(resumed.status, 'awaiting_agent');
  assert.equal(observed.length, 1);
  assert.equal(observed[0].sessionId, undefined, 'the paused job had no agent session yet');

  const stored = await engine.store.get(job.id);
  assert.equal(stored.stopAfter, undefined, 'the pause point is cleared once the user continues');
  assert.equal(stored.cursor, 2);

  const next = await engine.finish(job.id);
  assert.equal(next.requires, 'classify', 'the pipeline continues from where it paused');
  assert.equal(next.cursor, 2);
});

test('retry finishes deterministically when the paused job already has an extract', async t => {
  const { engine, pdfPath } = await setup(t);
  const job = await engine.enqueue({ pdfPath, stages, stopAfter: 'prepare', autoRun: false });
  const extract = path.join(engine.store.dir(job.id), 'paper.extract.json');
  await fs.writeFile(extract, JSON.stringify({ meta: { title: 'Fixture' } }));
  const saved = await engine.store.get(job.id);
  Object.assign(saved, {
    status: 'paused', cursor: 2, stage: 'prepare', completedStages: ['import', 'prepare'],
    extractPath: extract, prepared: { pageCount: 2, pagesPath: path.join(engine.store.dir(job.id), 'pages.json') },
  });
  await engine.store.save(saved);

  // No onWork is configured: reaching awaiting_analysis proves the deterministic path ran.
  const resumed = await engine.invoke('retry', { jobId: job.id });
  assert.equal(resumed.status, 'awaiting_analysis');
  assert.equal(resumed.requires, 'classify');
  assert.equal((await engine.store.get(job.id)).stopAfter, undefined);
});

test('run on a paused job clears the pause point before dispatching the agent', async t => {
  const observed = [];
  const { engine, pdfPath } = await setup(t, {
    onWork: async input => { observed.push(input); return { sessionId: 'fixture-session' }; },
  });
  const job = await engine.enqueue({ pdfPath, stages, stopAfter: 'import', autoRun: false });
  const saved = await engine.store.get(job.id);
  Object.assign(saved, { status: 'paused', cursor: 1, stage: 'import', completedStages: ['import'] });
  await engine.store.save(saved);

  const result = await engine.run(job.id);
  assert.equal(result.status, 'awaiting_agent');
  assert.equal(observed.length, 1);
  assert.equal((await engine.store.get(job.id)).stopAfter, undefined);
});

test('search children inherit the parent pause point unless they set their own', async t => {
  const { engine, pdfPath, pdf } = await setup(t);
  const childStages = ['download', 'prepare', 'classify'];
  const parent = await engine.startSearch({ query: 'spillovers', stages: ['search', 'download', 'prepare'], stopAfter: 'download' });
  assert.equal(parent.stopAfter, 'download');

  const inherited = await engine.enqueue({
    pdfPath, stages: childStages, parentJobId: parent.id, source: { kind: 'download' }, autoRun: false,
  });
  assert.equal(inherited.stopAfter, 'download', 'the parent pause point is carried into the child flow');

  const explicit = await engine.enqueue({
    pdfPath: await pdf('own.pdf'), stages: childStages, parentJobId: parent.id, stopAfter: 'prepare', source: { kind: 'download' }, autoRun: false,
  });
  assert.equal(explicit.stopAfter, 'prepare', 'a child may choose a different pause point');

  const unrelated = await engine.enqueue({
    pdfPath: await pdf('plain.pdf'), stages, parentJobId: parent.id, autoRun: false,
  });
  assert.equal(unrelated.stopAfter, null, 'a pause point outside the child flow is ignored instead of failing');
});

test('a paused job ignores an agent finish until the user continues', async t => {
  const { engine, pdfPath } = await setup(t);
  const job = await pausedJob(engine, pdfPath);
  await engine.finish(job.id);

  // The tool path (no resume flag) must not walk past the pause point.
  const again = await engine.invoke('finish', { jobId: job.id, resume: true });
  assert.equal(again.status, 'paused');
  assert.equal(again.paused, true);
  assert.match(again.instruction, /等待用户/);
  const stored = await engine.store.get(job.id);
  assert.equal(stored.cursor, 2, 'the cursor does not move while paused');
  assert.equal(stored.stopAfter, 'prepare');

  // Only the user's continue resumes it.
  const resumed = await engine.finish(job.id, { resume: true });
  assert.equal(resumed.requires, 'classify');
});
