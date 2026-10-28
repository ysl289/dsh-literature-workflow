import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LiteratureEngine } from '../lib/engine.mjs';

const stages = ['import', 'prepare', 'classify', 'read', 'design'];

test('search continuation reconciles existing child jobs before finishing the search', () => {
  const engine=new LiteratureEngine();
  const prompt=engine.continuationPrompt({id:'search_fixture',kind:'search',query:'spillovers',limit:5,filters:{fromYear:2020},stages:['search','download'],status:'needs_attention',stage:'search',children:['paper_existing']});
  assert.match(prompt,/spillovers/);assert.match(prompt,/paper_existing/);assert.match(prompt,/jobs/);
  assert.match(prompt,/全部处理后才用finish/);
  assert.ok(!prompt.includes('"action":"finish"'),'do not immediately complete an unfinished search');
});

async function setup(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-lit-continuation-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const engine = new LiteratureEngine({
    stateDir: path.join(root, 'state'),
    inputDir: path.join(root, 'input'),
    watchInput: false,
    autoRun: false,
    publishMode: 'local',
  }, options);
  await engine.store.init();
  const pdfPath = path.join(root, 'fixture.pdf');
  await fs.writeFile(pdfPath, '%PDF-1.4\nfixture only\n');
  const job = await engine.enqueue({ pdfPath, stages, autoRun: false });
  return { engine, root, job };
}

async function seedContinuationState(engine, job) {
  const saved = await engine.store.get(job.id);
  Object.assign(saved, {
    status: 'needs_attention',
    stage: 'read',
    cursor: 3,
    completedStages: ['import', 'prepare', 'classify'],
    classificationPath: ['经济学', '创新金融'],
    prepared: { pageCount: 7, pagesPath: path.join(engine.store.dir(job.id), 'pages.json') },
    pagesRead: [1, 2, 4, 5],
    error: 'fixture error: reading page 3 stopped',
    agentSessionId: 'fixture-session-42',
  });
  await engine.store.save(saved);
  return saved;
}

function embeddedSnapshot(prompt) {
  const requiredKeys = ['status', 'stage', 'cursor', 'completedStages', 'classificationPath', 'readPages', 'totalPages', 'unreadPages', 'extractPath', 'previousError'];
  for (let start = prompt.indexOf('{'); start >= 0; start = prompt.indexOf('{', start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < prompt.length; end++) {
      const char = prompt[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        try {
          const value = JSON.parse(prompt.slice(start, end + 1));
          if (requiredKeys.every(key => Object.hasOwn(value, key))) return value;
        } catch {
          // Continue until a complete JSON object is found.
        }
        break;
      }
    }
  }
  assert.fail('continuation prompt must contain a structured checkpoint object');
}

test('continuation prompt records the durable checkpoint and gives safe resume instructions', async t => {
  const { engine, job } = await setup(t);
  const saved = await seedContinuationState(engine, job);

  const prompt = await engine.continuationPrompt(saved);
  const snapshot = embeddedSnapshot(prompt);
  assert.deepEqual(snapshot, {
    status: 'needs_attention',
    stage: 'read',
    cursor: 3,
    completedStages: ['import', 'prepare', 'classify'],
    classificationPath: ['经济学', '创新金融'],
    readPages: [1, 2, 4, 5],
    totalPages: 7,
    unreadPages: [3, 6, 7],
    extractPath: null,
    previousError: 'fixture error: reading page 3 stopped',
  });

  assert.match(prompt, /finish/i, 'the agent should continue through the workflow finish action');
  assert.match(prompt, /(?:同.{0,4}会话|本会话|same session)/i);
  assert.match(prompt, /(?:全文|full text)/i);
  assert.match(prompt, /(?:未读页|缺页|read pages)/i);
  assert.match(prompt, /(?:补读|补充读取|read missing pages)/i);
  assert.match(prompt, /(?:不能|不要|无需|不必).{0,10}(?:机械)?重读(?:全文)?/i, 'the agent should not repeat the full reading without need');
  assert.match(prompt, /extract/i);
  assert.match(prompt, /(?:未保存|尚未保存|not saved)/i, 'an absent extract must not be described as saved');
});

test('continuation prompt identifies an extract only after its file is present', async t => {
  const { engine, job } = await setup(t);
  const saved = await seedContinuationState(engine, job);
  saved.extractPath = path.join(engine.store.dir(job.id), 'paper.extract.json');
  await fs.writeFile(saved.extractPath, JSON.stringify({ meta: { title: 'Fixture only' } }));
  await engine.store.save(saved);

  const snapshot = embeddedSnapshot(await engine.continuationPrompt(await engine.store.get(job.id)));
  assert.equal(snapshot.extractPath, saved.extractPath);
});

test('run preserves the full initial prompt and passes a separate resume prompt and saved session id', async t => {
  const observed = [];
  const { engine, job } = await setup(t, {
    onWork: async input => { observed.push(input); return { sessionId: input.sessionId || 'fixture-new-session' }; },
  });
  const saved = await seedContinuationState(engine, job);
  const originalPrompt = await engine.agentPrompt(saved);
  const expectedResumePrompt = await engine.continuationPrompt(saved);

  await engine.run(job.id);

  assert.equal(observed.length, 1);
  assert.ok(observed[0].prompt.startsWith(originalPrompt), 'the initial task prompt remains complete at the start of the fresh-session fallback');
  assert.ok(observed[0].prompt.includes(expectedResumePrompt), 'a fresh session also receives the current checkpoint');
  assert.equal(observed[0].resumePrompt, expectedResumePrompt, 'continuation context is sent separately');
  assert.equal(observed[0].sessionId, 'fixture-session-42');
  assert.match(observed[0].resumePrompt, /fixture error: reading page 3 stopped/);
  assert.equal((await engine.store.get(job.id)).agentSessionId, 'fixture-session-42');
});

test('concurrent run requests do not dispatch the same job twice', async t => {
  let entered;
  const onEntered = new Promise(resolve => { entered = resolve; });
  let release;
  const dispatchGate = new Promise(resolve => { release = resolve; });
  const observed = [];
  const { engine, job } = await setup(t, {
    onWork: async input => {
      observed.push(input);
      entered();
      await dispatchGate;
      return { sessionId: 'fixture-concurrent-session' };
    },
  });
  await seedContinuationState(engine, job);

  const first = engine.run(job.id);
  await onEntered;
  const duplicate = await engine.run(job.id);
  assert.equal(duplicate.accepted, false);
  assert.equal(observed.length, 1);

  release();
  await first;
  assert.equal(observed.length, 1);
});

test('completed and cancelled jobs are not sent back to the agent', async t => {
  const observed = [];
  const { engine, job } = await setup(t, {
    onWork: async input => { observed.push(input); return { sessionId: 'unexpected-session' }; },
  });

  for (const status of ['completed', 'cancelled']) {
    const saved = await engine.store.get(job.id);
    saved.status = status;
    saved.stage = 'done';
    saved.cursor = saved.stages.length;
    await engine.store.save(saved);
    const result = await engine.run(job.id);
    assert.equal(result.status, status);
  }
  assert.equal(observed.length, 0);
});
