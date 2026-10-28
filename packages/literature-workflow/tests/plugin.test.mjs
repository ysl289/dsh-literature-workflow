import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { attachLiteraturePlugin } from '../index.mjs';
import { buildBundlePatch, installPlan, prepareBundle } from '../install.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function makeHost({ hasRead = true, hasPresets = false, mountProvidesRead = true } = {}) {
  const registrations = new Map();
  const restrictions = [];
  const created = [];
  const createdAgents = [];
  const setupContexts = [];
  const gates = [];
  const agentEventListeners = [];
  let disposeCount = 0;
  const tools = {
    get(toolName, scope) {
      if (toolName === 'read' && (hasRead || scope?.presetHasRead)) return { name: 'read' };
      return registrations.get(toolName);
    },
    register(definition) {
      assert.ok(definition.parameters && typeof definition.parameters === 'object');
      registrations.set(definition.name, definition);
      return () => registrations.delete(definition.name);
    },
  };
  const ctx = {
    tools,
    currentAgent: { id: 'unrelated-current-agent' },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model', reasoningEffort: 'high' }) },
    agents: {
      async create(options) {
        created.push(options);
        const agent = {
          id: `literature-agent-${created.length}`,
          session: { id: options.sessionId },
          status: 'idle',
          followup(message) {
            const gate = deferred();
            gates.push(gate);
            this.currentGate = gate;
            this.status = 'running';
            this.lastMessage = message;
          },
          whenIdle() {
            const gate = this.currentGate;
            if (!gate) return Promise.resolve();
            return gate.promise.then(
              value => { this.status = 'idle'; return value; },
              error => { this.status = 'idle'; throw error; },
            );
          },
        };
        const agentCtx = {
          on(event, listener) {
            agentEventListeners.push({ agent, event, listener });
            return () => {};
          },
          tools: {
            get: (name, scope) => tools.get(name, scope),
            restrict: filter => restrictions.push(filter),
          },
        };
        agentCtx.ownerAgent = agent;
        createdAgents.push(agent);
        setupContexts.push(agentCtx);
        await options.setup(agentCtx, agent);
        return {
          agent,
          async dispose() { disposeCount++; agent.status = 'disposed'; },
        };
      },
    },
  };
  if (hasPresets) ctx.agentPresets = {
    async resolve() { return {id:'standard'}; },
    async mount(agentCtx, id) { assert.equal(id,'standard'); agentCtx.ownerAgent.presetHasRead = mountProvidesRead; },
  };
  return {
    ctx,
    registrations,
    restrictions,
    created,
    createdAgents,
    setupContexts,
    gates,
    emitAgentEvent(agentIndex, event, payload) {
      const agent = createdAgents[agentIndex];
      for (const entry of agentEventListeners) {
        if (entry.agent === agent && entry.event === event) entry.listener(payload);
      }
    },
    disposeCount: () => disposeCount,
  };
}

class StubEngine {
  static last;
  constructor(config, { onWork, getModelCatalog, getAgentCapability }) {
    this.config = { workflowRoot: 'C:/workflow', ...config };
    this.onWork = onWork;
    this.getModelCatalog = getModelCatalog;
    this.getAgentCapability = getAgentCapability;
    this.toolSpecs = [{
      name: 'literature_workflow',
      description: 'Test literature workflow tool.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'run'] },
          payload: { type: 'object' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    }];
    this.invocations = [];
    this.idleResults = [];
    this.failedResults = [];
    this.lifecycle = [];
    StubEngine.last = this;
  }
  async start() { this.lifecycle.push('start'); }
  async close() { this.lifecycle.push('close'); }
  async invoke(action, payload, context) {
    this.invocations.push({ action, payload, context });
    return { action, ok: true };
  }
  async agentIdle(jobId) {
    this.lifecycle.push(['idle', jobId]);
    return this.idleResults.shift();
  }
  async agentFailed(jobId, error) {
    this.lifecycle.push(['failed', jobId, error]);
    return this.failedResults.shift();
  }
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

test('registers the raw JSON Schema tool and passes Harness execution context', async () => {
  const host = makeHost();
  const dispose = await attachLiteraturePlugin(host.ctx, {}, { Engine: StubEngine });
  const engine = StubEngine.last;
  const tool = host.registrations.get('literature_workflow');
  assert.deepEqual(tool.parameters, engine.toolSpecs[0].parameters);
  assert.deepEqual(tool.output.render({}, { ok: true }), [{ type: 'text', text: '{\n  "ok": true\n}' }]);

  const caller = { id: 'caller-agent', session: { id: 'caller-session' } };
  await tool.execute({ action: 'status', payload: { source: 'test' } }, { agent: caller, signal: 'test-signal' });
  assert.deepEqual(engine.invocations[0], {
    action: 'status',
    payload: { source: 'test' },
    context: { agentId: 'caller-agent', sessionId: 'caller-session', signal: 'test-signal' },
  });
  await dispose();
  assert.deepEqual(engine.lifecycle, ['start', 'close']);
  assert.equal(host.registrations.has('literature_workflow'), false);
});

test('dispatches each job to an independent restricted agent and observes idle and failure', async () => {
  const host = makeHost();
  const dispose = await attachLiteraturePlugin(host.ctx, {}, { Engine: StubEngine });
  const engine = StubEngine.last;

  const receipt = await engine.onWork({ jobId: 'job-1', prompt: 'Read this paper.' });
  assert.equal(receipt.agentId, 'literature-agent-1');
  assert.equal(receipt.sessionId, host.created[0].sessionId);
  assert.match(receipt.sessionId, /^dsh-literature-/);
  assert.equal(Object.hasOwn(host.created[0], 'parentAgent'), false);
  assert.deepEqual(host.created[0].agentOptions, { provider: 'test-provider', model: 'test-model', reasoningEffort: 'high' });
  assert.deepEqual(host.created[0].meta, { cwd: 'C:/workflow' });
  assert.deepEqual(host.restrictions, [{ allow: ['literature_workflow', 'read'] }]);
  assert.equal(host.created[0].sessionId.includes(host.ctx.currentAgent.id), false);
  assert.deepEqual(host.setupContexts[0].tools.get('literature_workflow'), host.registrations.get('literature_workflow'));
  assert.deepEqual(host.setupContexts[0].tools.get('read'), { name: 'read' });
  assert.deepEqual(host.created.length, 1);
  assert.equal(host.created[0].sessionId, receipt.sessionId);

  engine.idleResults.push({ status: 'needs_attention' });
  host.gates[0].resolve();
  await flush();
  assert.deepEqual(engine.lifecycle.find(x => Array.isArray(x) && x[0] === 'idle'), ['idle', 'job-1']);
  assert.equal(host.disposeCount(), 0, 'nonterminal human-attention state retains the dedicated session');

  engine.failedResults.push({ status: 'needs_auth' });
  const retryReceipt = await engine.onWork({ jobId: 'job-1', prompt: 'Continue after the required authorization.' });
  assert.deepEqual(retryReceipt, receipt, 'an explicit retry reuses the same dedicated session');
  assert.deepEqual(host.createdAgents[0].lastMessage.content, [{ type: 'text', text: 'Continue after the required authorization.' }]);
  assert.equal(host.createdAgents[0].lastMessage.role, 'user', 'a dispatched message must carry the role the LLM request builder requires');
  host.gates[1].reject(new Error('authorization required'));
  await flush();
  assert.ok(engine.lifecycle.some(x => Array.isArray(x) && x[0] === 'failed' && x[1] === 'job-1'));
  assert.equal(host.disposeCount(), 0, 'authorization state is retained and is not automatically redriven');

  engine.idleResults.push({ status: 'completed' });
  await engine.onWork({ jobId: 'job-1', prompt: 'Complete the authorized work.' });
  host.gates[2].resolve();
  await flush();
  assert.equal(host.disposeCount(), 1, 'a terminal job releases its idle agent handle');
  await dispose();
  assert.equal(host.disposeCount(), 1);
});

test('routes scoped agent errors before idle and clears them for the next followup', async () => {
  const host = makeHost();
  const dispose = await attachLiteraturePlugin(host.ctx, {}, { Engine: StubEngine });
  const engine = StubEngine.last;

  await engine.onWork({ jobId: 'job-scoped-error', prompt: 'First turn.' });
  const firstAgent = host.createdAgents[0];
  const unrelatedError = new Error('unrelated agent failure');
  host.emitAgentEvent(0, 'agent/error', {
    agent: { id: 'another-agent' }, error: unrelatedError, turn: 1, step: 1,
  });
  engine.idleResults.push({ status: 'needs_attention' });
  host.gates[0].resolve();
  await flush();
  assert.ok(engine.lifecycle.some(x => Array.isArray(x) && x[0] === 'idle' && x[1] === 'job-scoped-error'));
  assert.equal(engine.lifecycle.some(x => Array.isArray(x) && x[0] === 'failed' && x[2] === unrelatedError), false);

  const transportError = Object.assign(new Error('DeepSeek Messages transport failed'), { code: 'TRANSPORT' });
  await engine.onWork({ jobId: 'job-scoped-error', prompt: 'Retry after transport failure.' });
  host.emitAgentEvent(0, 'agent/error', {
    agent: firstAgent, error: transportError, turn: 2, step: 1,
  });
  engine.failedResults.push({ status: 'needs_attention' });
  host.gates[1].resolve();
  await flush();
  assert.ok(engine.lifecycle.some(x => Array.isArray(x) && x[0] === 'failed' && x[1] === 'job-scoped-error' && x[2] === transportError));

  await engine.onWork({ jobId: 'job-scoped-error', prompt: 'Retry without a new failure.' });
  engine.idleResults.push({ status: 'completed' });
  host.gates[2].resolve();
  await flush();
  assert.ok(engine.lifecycle.some(x => Array.isArray(x) && x[0] === 'idle' && x[1] === 'job-scoped-error'));
  assert.equal(engine.lifecycle.filter(x => Array.isArray(x) && x[0] === 'failed' && x[1] === 'job-scoped-error').length, 1);
  await dispose();
});

test('continuing an owned session sends only its checkpoint and ignores clicks while busy', async () => {
  const host=makeHost(),dispose=await attachLiteraturePlugin(host.ctx,{}, {Engine:StubEngine});
  try{
    const engine=StubEngine.last;
    await engine.onWork({jobId:'checkpoint-job',prompt:'Full initial rules.',resumePrompt:'Checkpoint one.'});
    assert.equal(host.createdAgents[0].lastMessage.content[0].text,'Full initial rules.');
    await engine.onWork({jobId:'checkpoint-job',prompt:'Full initial rules.',resumePrompt:'Do not queue this.'});
    assert.equal(host.gates.length,1);
    host.gates[0].resolve();await flush();
    await engine.onWork({jobId:'checkpoint-job',prompt:'Full initial rules.',resumePrompt:'Continue at Zotero; pages 1-13 read.'});
    assert.equal(host.created.length,1);
    assert.equal(host.createdAgents[0].lastMessage.content[0].text,'Continue at Zotero; pages 1-13 read.');
  }finally{await dispose()}
});

test('persisted literature session is resumed with checkpoint instead of creating a new conversation', async () => {
  const host=makeHost(),resumes=[],factory=host.ctx.agents.create;
  host.ctx.agents.create=async()=>assert.fail('must not create another conversation');
  host.ctx.agents.resume=async options=>{resumes.push(options);return factory({...options,sessionId:options.resumeSessionId})};
  const dispose=await attachLiteraturePlugin(host.ctx,{}, {Engine:StubEngine});
  try{
    const receipt=await StubEngine.last.onWork({jobId:'saved-job',sessionId:'dsh-literature-saved-session',prompt:'Full initial rules.',resumePrompt:'Continue at read.'});
    assert.equal(resumes.length,1);assert.equal(resumes[0].resumeSessionId,'dsh-literature-saved-session');
    assert.equal(receipt.sessionId,'dsh-literature-saved-session');
    assert.equal(host.createdAgents[0].lastMessage.content[0].text,'Continue at read.');
  }finally{await dispose()}
});

test('resume failure preserves the existing session and never falls back to fresh creation', async () => {
  const host=makeHost();host.ctx.agents.resume=async()=>{throw Error('persisted session is locked')};
  const dispose=await attachLiteraturePlugin(host.ctx,{}, {Engine:StubEngine});
  try{
    await assert.rejects(StubEngine.last.onWork({jobId:'locked-job',sessionId:'dsh-literature-locked',prompt:'full',resumePrompt:'continue'}),/locked/);
    assert.equal(host.created.length,0);
  }finally{await dispose()}
});

test('already live restored sessions are borrowed without duplicate loops or disposal', async () => {
  const host=makeHost(),listeners=[];
  let sent=0;
  const live={id:'dsh-literature-live',session:{id:'dsh-literature-live'},status:'running',followup(){sent++;this.status='running'},whenIdle:async()=>{live.status='idle'}};
  host.ctx.on=(event,callback)=>{const entry={event,callback};listeners.push(entry);return()=>{const index=listeners.indexOf(entry);if(index>=0)listeners.splice(index,1)}};
  host.ctx.agents.get=id=>id===live.id?live:undefined;
  const dispose=await attachLiteraturePlugin(host.ctx,{}, {Engine:StubEngine});
  try{
    await StubEngine.last.onWork({jobId:'live-job',sessionId:live.id,prompt:'full',resumePrompt:'continue'});
    assert.equal(sent,0,'running work receives no extra followup');
    await flush();
    await StubEngine.last.onWork({jobId:'live-job',sessionId:live.id,prompt:'full',resumePrompt:'continue'});
    assert.equal(sent,1);assert.equal(host.created.length,0);
  }finally{await dispose()}
  assert.notEqual(live.status,'disposed');assert.equal(listeners.filter(x=>x.event==='agent/error').length,0);
});

test('keeps the workflow tool available when neither a preset nor file-read support exists', async () => {
  const host = makeHost({ hasRead: false });
  const dispose = await attachLiteraturePlugin(host.ctx, {}, { Engine: StubEngine });
  assert.equal(typeof StubEngine.last.onWork, 'function');
  assert.equal((await StubEngine.last.getAgentCapability()).code,'preset_service_pending');
  await assert.rejects(StubEngine.last.onWork({jobId:'job-no-preset',prompt:'Read.'}),/工具预设/);
  assert.equal(host.created.length,0,'do not create an unprepared agent');
  assert.ok(host.registrations.has('literature_workflow'));
  await dispose();
});

test('late preset activation recovers without remounting the plugin or losing the dispatch callback', async () => {
  const host=makeHost({hasRead:false});
  const dispose=await attachLiteraturePlugin(host.ctx,{}, {Engine:StubEngine});
  try{
    const engine=StubEngine.last,dispatch=engine.onWork;
    assert.equal((await engine.getAgentCapability()).available,false);
    host.ctx.agentPresets={resolve:async()=>({id:'late-standard'}),mount:async(agentCtx,id)=>{assert.equal(id,'late-standard');agentCtx.ownerAgent.presetHasRead=true}};
    assert.deepEqual(await engine.getAgentCapability(),{available:true,presetId:'late-standard'});
    assert.equal(engine.onWork,dispatch);
    const result=await dispatch({jobId:'job-after-ready',prompt:'Read.'});
    assert.equal(result.agentId,'literature-agent-1');
    assert.equal(host.created[0].meta.agentPreset,'late-standard');
    assert.ok(host.createdAgents[0].lastMessage);
  }finally{await dispose()}
});

test('missing factory, missing model and broken preset report separate actionable reasons', async () => {
  const host=makeHost({hasRead:false,hasPresets:true});
  const dispose=await attachLiteraturePlugin(host.ctx,{}, {Engine:StubEngine});
  try{
    host.ctx.agents.requireFactory=()=>{throw Error('factory not ready')};
    assert.equal((await StubEngine.last.getAgentCapability()).code,'agent_runtime_not_ready');
    delete host.ctx.agents.requireFactory;
    host.ctx.agentDefaultModel.currentSelection=()=>({});
    assert.equal((await StubEngine.last.getAgentCapability()).code,'model_not_selected');
    host.ctx.agentDefaultModel.currentSelection=()=>({provider:'fixture',model:'fixture'});
    host.ctx.agentPresets.resolve=async()=>({id:'standard',broken:{code:'fixture-broken'}});
    assert.equal((await StubEngine.last.getAgentCapability()).code,'preset_unavailable');
    await assert.rejects(StubEngine.last.onWork({jobId:'job-broken',prompt:'read'}),/预设加载失败/);
    assert.equal(host.created.length,0);
  }finally{await dispose()}
});

test('Desktop agent startup mounts the default preset and checks read in the agent scope', async () => {
  const host = makeHost({hasRead:false,hasPresets:true});
  assert.equal(host.ctx.tools.get('read'),undefined);
  const dispose = await attachLiteraturePlugin(host.ctx,{}, {Engine:StubEngine});
  const engine = StubEngine.last;
  assert.equal(typeof engine.onWork,'function','lack of Host read must not disable Desktop agents');
  const result = await engine.onWork({jobId:'job-scoped',prompt:'Read only this paper.'});
  assert.equal(result.agentId,'literature-agent-1');
  assert.equal(host.created[0].meta.agentPreset,'standard');
  assert.equal(host.ctx.tools.get('read'),undefined,'read remains absent from the Host');
  assert.equal(host.ctx.tools.get('read',host.createdAgents[0]).name,'read');
  assert.deepEqual(host.restrictions,[{allow:['literature_workflow','read']}]);
  await dispose();
});

test('a preset lacking read produces an explicit startup error instead of dispatching an unprepared agent', async () => {
  const host = makeHost({hasRead:false,hasPresets:true,mountProvidesRead:false});
  const dispose = await attachLiteraturePlugin(host.ctx,{}, {Engine:StubEngine});
  await assert.rejects(StubEngine.last.onWork({jobId:'job-no-read',prompt:'read'}),/requires the read tool/);
  assert.equal(host.createdAgents[0].lastMessage,undefined);
  await dispose();
});

test('workflow model override is isolated and a retained job keeps its original model', async () => {
  const host = makeHost({hasRead:false,hasPresets:true});
  const selected = {provider:'connected-provider',model:'chosen-model'};
  const dispose = await attachLiteraturePlugin(host.ctx,{modelSelection:selected},{Engine:StubEngine});
  const engine = StubEngine.last;
  const first = await engine.onWork({jobId:'job-model',prompt:'Read.'});
  assert.deepEqual(host.created[0].agentOptions,selected);
  assert.deepEqual(first.modelSelection,selected);
  assert.equal(host.ctx.agentDefaultModel.currentSelection().model,'test-model');
  host.gates[0].resolve();await flush();
  engine.config.modelSelection={provider:'connected-provider',model:'other-model'};
  const retry=await engine.onWork({jobId:'job-model',prompt:'Continue.'});
  assert.deepEqual(retry.modelSelection,selected);
  await engine.onWork({jobId:'job-new-model',prompt:'New task.'});
  assert.equal(host.created[1].agentOptions.model,'other-model');
  await dispose();
});

test('native model catalog projects public fields and coalesces repeated reads', async () => {
  const host=makeHost();let calls=0;
  host.ctx.sessionController={async modelCatalog(){calls++;return {groups:[{id:'connected',name:'Connected',apiKey:'private',models:[{id:'model',name:'Model',credentials:'private',reasoning:{efforts:[{id:'high',name:'High'}],defaultEffort:'high'}}]}],failures:[]}}};
  const dispose=await attachLiteraturePlugin(host.ctx,{}, {Engine:StubEngine});
  const engine=StubEngine.last;
  const first=await engine.getModelCatalog();await engine.getModelCatalog();
  assert.equal(calls,1);assert.ok(!JSON.stringify(first).includes('private'));
  assert.equal(first.groups[0].models[0].reasoning.efforts[0].id,'high');
  await engine.getModelCatalog({force:true});assert.equal(calls,2);
  await dispose();
});

test('builds a native manager install plan and prepares a bundle patch idempotently with compare-before-write', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-literature-plugin-'));
  try {
    const modulePath = path.join(tempRoot, 'index.mjs');
    await fs.writeFile(modulePath, 'export {};', 'utf8');
    await fs.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({
      name: 'dsh-literature-workflow',
      dsh: { bundle: { patch: './bundle.patch.yml' } },
    }), 'utf8');
    const expectedUrl = pathToFileURL(modulePath).href;
    const patchText = buildBundlePatch({ directory: tempRoot, home: 'C:/Users/test-user' });
    assert.ok(patchText.includes("name: 'dsh-literature-workflow'"));
    assert.ok(!patchText.includes('file:///'), 'native Client metadata must resolve from the installed package');
    assert.ok(patchText.includes("rootCollection: ''"));
    assert.ok(patchText.includes("publishMode: 'preview'"));

    const first = await prepareBundle({ directory: tempRoot });
    assert.equal(first.created, true);
    assert.equal(await fs.readFile(first.path, 'utf8'), buildBundlePatch({ directory: tempRoot }));
    const second = await prepareBundle({ directory: tempRoot });
    assert.equal(second.unchanged, true);

    const externalEdit = 'externally changed patch\n';
    await fs.writeFile(first.path, externalEdit, 'utf8');
    await assert.rejects(prepareBundle({ directory: tempRoot }), /Refusing to replace a different bundle patch/);
    assert.equal(await fs.readFile(first.path, 'utf8'), externalEdit, 'a concurrent bundle-patch change is preserved');

    const plan = installPlan({ directory: tempRoot });
    assert.deepEqual(plan.managerCall, { action: 'install_bundle', target: tempRoot, enabled: true });
    assert.equal(plan.pluginModule, expectedUrl);
    assert.match(plan.note, /never writes a profile/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('session titles are cleaned and shortened for the Harness sidebar', async () => {
  const { sessionTitleFor } = await import('../index.mjs');
  assert.equal(sessionTitleFor('Digital finance: evidence? from China'), 'Digital finance evidence from China');
  assert.equal(sessionTitleFor('  多空格\t与\n换行  '), '多空格 与 换行');
  assert.equal(sessionTitleFor(''), '');
  assert.equal(sessionTitleFor(null), '');

  const long = '数字金融与企业创新：来自中国上市公司的经验证据以及更多后续说明文字'.repeat(3);
  const title = sessionTitleFor(long);
  assert.ok([...title].length <= 60, 'titles stay within 60 characters');
  assert.ok(Buffer.byteLength(title, 'utf8') <= 80, 'titles stay within the byte budget the title service accepts');
});

test('a new literature session is created inside the configured project and named after the paper', async () => {
  const host = makeHost();
  const renamed = [];
  const attached = [];
  host.ctx.workspaceRegistry = {
    list: () => [{ id: 'ws-econ', title: '经济学', path: 'C:/projects/econ' }],
    get: id => id === 'ws-econ' ? { id, title: '经济学', path: 'C:/projects/econ', attachSession: async sessionId => { attached.push(sessionId); } } : undefined,
  };
  host.ctx.sessionTitle = { rename: (session, title) => renamed.push({ id: session.id, title }) };
  const dispose = await attachLiteraturePlugin(host.ctx, { agentProject: '经济学' }, { Engine: StubEngine });
  try {
    const engine = StubEngine.last;
    const receipt = await engine.onWork({
      jobId: 'job-project', title: 'Digital finance: evidence? from China', prompt: 'Read this paper.',
    });
    assert.deepEqual(host.created[0].meta, { cwd: 'C:/projects/econ' }, 'the session cwd puts it in that project');
    assert.deepEqual(attached, [receipt.sessionId], 'the session is registered in the project, not just given its cwd');
    assert.deepEqual(renamed, [{ id: receipt.sessionId, title: 'Digital finance evidence from China' }]);

    // Resuming an owned session must not try to re-create, re-attach or re-title it.
    host.gates[0].resolve();
    await flush();
    await engine.onWork({ jobId: 'job-project', prompt: 'Continue.', resumePrompt: 'Continue.' });
    assert.equal(host.created.length, 1);
    assert.equal(attached.length, 1);
    assert.equal(renamed.length, 1);
  } finally { await dispose(); }
});

test('a failed project attach disposes the orphan session and reports the project', async () => {
  const host = makeHost();
  host.ctx.workspaceRegistry = {
    list: () => [{ id: 'ws-econ', title: '经济学', path: 'C:/projects/econ' }],
    get: id => id === 'ws-econ' ? { id, title: '经济学', path: 'C:/projects/econ', attachSession: async () => { throw new Error('cwd does not resolve'); } } : undefined,
  };
  const dispose = await attachLiteraturePlugin(host.ctx, { agentProject: '经济学' }, { Engine: StubEngine });
  try {
    const engine = StubEngine.last;
    await assert.rejects(
      () => engine.onWork({ jobId: 'job-attach-fails', title: 'Paper', prompt: 'Read.' }),
      /无法归入项目「经济学」.*cwd does not resolve/,
    );
    assert.equal(host.disposeCount(), 1, 'the created session is not left orphaned');
  } finally { await dispose(); }
});

test('an unknown project fails before any session is created', async () => {
  const host = makeHost();
  host.ctx.workspaceRegistry = { list: () => [{ id: 'ws-econ', title: '经济学', path: 'C:/projects/econ' }] };
  const dispose = await attachLiteraturePlugin(host.ctx, { agentProject: '不存在的项目' }, { Engine: StubEngine });
  try {
    const engine = StubEngine.last;
    await assert.rejects(
      () => engine.onWork({ jobId: 'job-missing-project', prompt: 'Read.' }),
      /找不到文献会话目标项目「不存在的项目」.*经济学/,
    );
    assert.equal(host.created.length, 0, 'no session is created for a misconfigured project');
  } finally { await dispose(); }
});

test('a configured project is registered from the configured directory on first use', async () => {
  const host = makeHost();
  const projects = [];
  const attached = [];
  host.ctx.workspaceRegistry = {
    list: () => projects.map(project => ({ id: project.id, title: project.title, path: project.path })),
    create: async dir => {
      const project = {
        id: 'ws-literature', title: '文献积累工作流', path: dir,
        setTitle: async title => { project.title = title; },
        attachSession: async sessionId => { attached.push(sessionId); },
      };
      projects.push(project);
      return project;
    },
    get: id => projects.find(project => project.id === id),
  };
  const dispose = await attachLiteraturePlugin(host.ctx, { agentProject: '文献积累', agentProjectDir: 'C:/workflow' }, { Engine: StubEngine });
  try {
    const engine = StubEngine.last;
    const receipt = await engine.onWork({ jobId: 'job-provision', title: 'Paper', prompt: 'Read.' });
    assert.equal(projects.length, 1, 'the project is registered once');
    assert.equal(projects[0].title, '文献积累', 'the registered project carries the configured name');
    assert.deepEqual(host.created[0].meta, { cwd: 'C:/workflow' });
    assert.deepEqual(attached, [receipt.sessionId]);

    await engine.onWork({ jobId: 'job-provision-2', title: 'Another paper', prompt: 'Read.' });
    assert.equal(projects.length, 1, 'the existing project is reused instead of registered again');
  } finally { await dispose(); }
});
