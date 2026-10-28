import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {LiteratureEngine} from '../lib/engine.mjs';
import {within} from '../lib/store.mjs';

const catalog={groups:[{id:'connected',name:'Connected',models:[{id:'one',name:'One',reasoning:{efforts:[{id:'high',name:'High'}]}},{id:'two',name:'Two'}]}],selection:{provider:'default',model:'default-model'},failures:[]};
async function setup(t, options={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-model-choice-'));
  t.after(async()=>{assert.ok(within(os.tmpdir(),dir)&&path.basename(dir).startsWith('dsh-model-choice-'));await fs.rm(dir,{recursive:true,force:true})});
  const engine=new LiteratureEngine({stateDir:dir,inputDir:path.join(dir,'input'),watchInput:false,autoRun:false},{getModelCatalog:async()=>catalog,...options});
  engine.preferences={};await engine.store.init();return {engine,dir};
}

test('workflow model settings accept only connected models and persist public route fields',async t=>{
  const {engine,dir}=await setup(t);
  await engine.settings({modelSelection:{provider:'connected',model:'one',reasoningEffort:'high',apiKey:'must-not-be-saved'}});
  const text=await fs.readFile(path.join(dir,'preferences.json'),'utf8');
  assert.deepEqual(JSON.parse(text).modelSelection,{provider:'connected',model:'one',reasoningEffort:'high'});
  assert.ok(!text.includes('must-not-be-saved'));
  await assert.rejects(engine.settings({modelSelection:{provider:'unknown',model:'one'}}),/不在 Harness/);
  await assert.rejects(engine.settings({modelSelection:{provider:'connected',model:'two',reasoningEffort:'high'}}),/不支持/);
  assert.equal(await fs.readFile(path.join(dir,'preferences.json'),'utf8'),text,'failed selection preserves the saved choice');
});

test('following the Harness default can be restored even while its catalog is unavailable',async t=>{
  const {engine}=await setup(t,{getModelCatalog:async()=>{throw Error('catalog offline')}});
  engine.config.modelSelection={provider:'old',model:'old-model'};
  await engine.settings({modelSelection:null});
  assert.equal(engine.config.modelSelection,null);
  assert.equal(engine.preferences.modelSelection,null);
});

test('public status follows live agent readiness even when its dispatch callback already exists',async t=>{
  let ready=false;
  const {engine}=await setup(t,{onWork:async()=>({}),getAgentCapability:async()=>ready?{available:true,presetId:'standard'}:{available:false,code:'preset_service_pending',message:'waiting for preset'}});
  engine.zotero={health:async()=>({ok:true})};engine.credentials=async()=>({});
  const before=await engine.status();assert.equal(before.agentAvailable,false);assert.equal(before.agentCapability.code,'preset_service_pending');
  ready=true;
  const after=await engine.status();assert.equal(after.agentAvailable,true);assert.equal(after.agentCapability.presetId,'standard');
});

test('job dispatch records its actual model and keeps it across a settings change',async t=>{
  const observed=[];
  const {engine,dir}=await setup(t,{onWork:async input=>{observed.push(input.modelSelection);return {sessionId:'fixture-session',modelSelection:input.modelSelection}}});
  const extract=path.join(dir,'fixture.extract.json');await fs.writeFile(extract,JSON.stringify({meta:{title:'Fixture'}}));
  await engine.settings({modelSelection:{provider:'connected',model:'one'}});
  const job=await engine.enqueue({extractPath:extract,stages:['import','excel'],autoRun:false});
  await engine.run(job.id);
  assert.deepEqual((await engine.store.get(job.id)).agentModel,{provider:'connected',model:'one'});
  await engine.settings({modelSelection:{provider:'connected',model:'two'}});
  await engine.run(job.id);
  assert.deepEqual(observed,[{provider:'connected',model:'one'},{provider:'connected',model:'one'}]);
});

test('a configured but not yet registered project can be saved again', async t => {
  const projects = [{ id: 'ws-econ', title: '经济学', path: 'C:/projects/econ' }];
  const { engine } = await setup(t, { getProjects: async () => projects });

  await engine.settings({ agentProject: '经济学' });
  assert.equal(engine.config.agentProject, '经济学');

  // 首次派发前项目还没登记：保存设置不能把它当成非法值清掉。
  engine.config.agentProject = '文献积累';
  await engine.settings({ agentProject: '文献积累' });
  assert.equal(engine.config.agentProject, '文献积累');

  await assert.rejects(engine.settings({ agentProject: '另一个不存在的项目' }), /找不到 Harness 项目/);
  assert.equal(engine.config.agentProject, '文献积累', 'a rejected value does not replace the saved one');
});
