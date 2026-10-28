import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {LiteratureEngine} from '../lib/engine.mjs';
import {normalizeStagePrompts,STAGE_PROMPTS} from '../lib/stage-options.mjs';

const quote='The study uses firm-level data and compares treated firms with a control group.';
const evidence=[{field:'data',page:1,quote}];
const plan=title=>({theme:'teal',slides:[{title,bullets:['根据原文解释研究设计'],notes:'讲解识别假设',evidence}]});
async function setup(t,config={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lit-diy-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const engine=new LiteratureEngine({stateDir:path.join(dir,'state'),inputDir:path.join(dir,'input'),watchInput:false,autoRun:false,...config});await engine.store.init();
  const extract=path.join(dir,'fixture.extract.json');await fs.writeFile(extract,JSON.stringify({meta:{title:'Fixture'},evidence}));
  return {engine,extract};
}

test('prompt defaults validate and job dedup snapshots the actual instructions',async t=>{
  assert.deepEqual(normalizeStagePrompts({design:STAGE_PROMPTS.design,read:'  '}),{});
  assert.throws(()=>normalizeStagePrompts({sheet:'delete existing rows'}),/不支持/);
  const {engine,extract}=await setup(t,{stagePrompts:{design:'重点解释识别假设'}});
  const a=await engine.enqueue({extractPath:extract,stages:['import','design'],autoRun:false});
  engine.config.stagePrompts={design:'改成适合初学者的讲义'};
  const b=await engine.enqueue({extractPath:extract,stages:['import','design'],autoRun:false});
  assert.notEqual(a.id,b.id);assert.equal(a.stagePrompts.design,'重点解释识别假设');
});

test('two DIY decks have independent authoring boundaries and pause retains all stages',async t=>{
  const {engine,extract}=await setup(t);const calls=[];
  engine.bridge=async(action,args)=>{calls.push({action,args});return {ok:true,artifacts:[{stage:args.stages[0],path:path.join(args.jobDir,args.stages[0]+'.html')}]}};
  const stages=['import','design','lecture'];
  const job=await engine.enqueue({extractPath:extract,stages,stagePrompts:{design:'只讲识别',lecture:'用故事串起全文'},stopAfter:'design',autoRun:false});
  const first=await engine.finish(job.id);
  assert.equal(first.requires,'design');assert.equal(first.prompt,'只讲识别');assert.equal(calls.length,0);
  await assert.rejects(engine.saveStage({jobId:job.id,stage:'design',plan:plan('识别'),promptHash:'stale'}),/提示词已变化/);
  await assert.rejects(engine.saveStage({jobId:job.id,stage:'lecture',plan:plan('全文'),promptHash:first.promptHash}),/当前等待/);
  await engine.saveStage({jobId:job.id,stage:'design',plan:plan('识别讲解'),promptHash:first.promptHash});
  const paused=await engine.finish(job.id);
  assert.equal(paused.status,'paused');assert.equal(paused.cursor,2);assert.deepEqual(paused.stages,stages);
  assert.equal(calls.length,1);assert.match(calls[0].args.stagePlanPath,/stage-design-/);
  assert.equal((await engine.finish(job.id)).status,'paused');assert.equal(calls.length,1);
  const second=await engine.invoke('retry',{jobId:job.id});assert.equal(second.requires,'lecture');assert.equal(second.prompt,'用故事串起全文');
  await engine.saveStage({jobId:job.id,stage:'lecture',plan:plan('故事汇报'),promptHash:second.promptHash});
  assert.equal((await engine.finish(job.id)).status,'completed');assert.equal(calls.length,2);
  assert.match(calls[1].args.stagePlanPath,/stage-lecture-/);
  assert.equal((await fs.readFile(extract,'utf8')).includes('故事汇报'),false,'shared extract unchanged');
});

test('paused jobs can change only remaining prompts and choose the next stopping point',async t=>{
  const {engine,extract}=await setup(t);
  engine.bridge=async(_a,args)=>({ok:true,artifacts:[{stage:args.stages[0],path:path.join(args.jobDir,args.stages[0]+'.html')}]});
  const job=await engine.enqueue({extractPath:extract,stages:['import','excel','design','lecture'],stopAfter:'import',autoRun:false});
  await engine.finish(job.id);
  await engine.invoke('configure_job',{jobId:job.id,stagePrompts:{lecture:'适合初学者'},stopAfter:'design'},{source:'harness-native-ui'});
  const result=await engine.invoke('retry',{jobId:job.id});
  assert.equal(result.status,'paused');assert.equal(result.cursor,3);assert.equal(result.stopAfter,'design');
  await assert.rejects(engine.invoke('configure_job',{jobId:job.id,stagePrompts:{design:'改已生成内容',lecture:'适合初学者'}},{source:'harness-native-ui'}),/已完成/);
  await assert.rejects(engine.invoke('configure_job',{jobId:job.id,stopAfter:null}),/只能由用户/);
});

test('templates persist prompts and stop points and search children inherit a snapshot',async t=>{
  const {engine,extract}=await setup(t);
  await engine.saveTemplate({name:'组会',stages:['import','design','lecture'],stagePrompts:{design:'详细讲解'},stopAfter:'design'});
  const templates=JSON.parse(await fs.readFile(path.join(engine.config.stateDir,'templates.json'),'utf8'));
  assert.equal(templates.组会.stagePrompts.design,'详细讲解');assert.equal(templates.组会.stopAfter,'design');
  const parent=await engine.startSearch({query:'innovation',stages:['search','download','prepare','read'],stagePrompts:{read:'讲清变量'}});
  const child=await engine.enqueue({extractPath:extract,stages:['import','design'],parentJobId:parent.id,autoRun:false});
  assert.equal(child.stagePrompts.read,'讲清变量');
});

test('search-only stopping point persists candidates and blocks premature downloads',async t=>{
  const {engine}=await setup(t);
  const parent=await engine.startSearch({query:'innovation',stages:['search','download','prepare','read'],stopAfter:'search'});
  await assert.rejects(engine.invoke('download',{parentJobId:parent.id}),/等待用户/);
  const result=await engine.finish(parent.id,{candidates:[{title:'A paper',doi:'10.1234/test'}],notes:'已筛选'});
  assert.equal(result.status,'paused');assert.equal(result.cursor,1);
  assert.match(engine.continuationPrompt(await engine.store.get(parent.id)),/A paper/);
  assert.equal((await engine.invoke('finish',{jobId:parent.id})).status,'paused');
  await engine.invoke('retry',{jobId:parent.id});
  assert.equal((await engine.store.get(parent.id)).stopAfter,undefined);
});

test('scan input carries the selected prompts and stopping point into new jobs',async t=>{
  const {engine}=await setup(t);await fs.mkdir(engine.config.inputDir,{recursive:true});
  await fs.writeFile(path.join(engine.config.inputDir,'example.pdf'),'%PDF-1.4\nscan');
  engine.config.stages=['import','prepare','read'];
  const result=await engine.invoke('scan',{stopAfter:'prepare',stagePrompts:{read:'检查识别假设'}});
  assert.equal(result[0].stopAfter,'prepare');assert.equal(result[0].stagePrompts.read,'检查识别假设');
});

test('a late agent failure cannot erase a user pause or resume the pipeline',async t=>{
  const {engine,extract}=await setup(t);
  const job=await engine.enqueue({extractPath:extract,stages:['import','design'],stopAfter:'import',autoRun:false});
  assert.equal((await engine.finish(job.id)).status,'paused');
  assert.equal((await engine.agentFailed(job.id,Error('late callback'))).status,'paused');
  const again=await engine.finish(job.id);assert.equal(again.status,'paused');assert.equal(again.cursor,1);
});
