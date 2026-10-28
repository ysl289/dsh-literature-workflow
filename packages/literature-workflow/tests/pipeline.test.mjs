import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {LiteratureEngine} from '../lib/engine.mjs';
import {validatePipeline,DEFAULT_PIPELINE} from '../lib/pipeline.mjs';
import {atomicJSON} from '../lib/store.mjs';

test('dependency validation follows actual order and permits imported extraction results',()=>{
  assert.equal(validatePipeline(DEFAULT_PIPELINE).valid,true);
  assert.equal(validatePipeline(['import','prepare','excel','read']).valid,false);
  assert.equal(validatePipeline(['import','excel','design','blog','sheet'],{inputKind:'extract'}).valid,true);
  assert.equal(validatePipeline(['search','download','prepare','read','lecture']).valid,true);
  assert.equal(validatePipeline(['import','search','download']).valid,false);
  assert.equal(validatePipeline(['search']).valid,true);
  assert.equal(validatePipeline(['import','prepare','read','design','blog','lecture','sheet']).valid,false);
});
async function setup(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-lit-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const e=new LiteratureEngine({stateDir:root,inputDir:path.join(root,'input'),watchInput:false,autoRun:false});await e.store.init();
  const extract=path.join(root,'fixture.extract.json');await fs.writeFile(extract,JSON.stringify({meta:{title:'A test paper'}}));
  return {e,root,extract};
}
test('execution obeys reordered cards and does not execute omitted stages',async t=>{
  const {e,extract}=await setup(t);const calls=[];
  e.bridge=async(action,a)=>{calls.push([action,a.stages?.[0]]);return action==='render'?{ok:true,artifacts:[{stage:a.stages[0],path:path.join(a.jobDir,'artifact.'+a.stages[0])}]}:{ok:true,status:'completed'}};
  const j=await e.enqueue({extractPath:extract,stages:['import','lecture','excel','design'],autoRun:false});
  const result=await e.finish(j.id);
  assert.equal(result.status,'completed');assert.deepEqual(calls,[['render','lecture'],['render','excel'],['render','design']]);
  assert.equal(result.artifacts.lecture.endsWith('artifact.lecture'),true);
  assert.equal(result.completedStages.includes('blog'),false);
});
test('different order is a different job, same input and same order does not duplicate',async t=>{
  const {e,extract}=await setup(t);
  const a=await e.enqueue({extractPath:extract,stages:['import','excel','design'],autoRun:false});
  const b=await e.enqueue({extractPath:extract,stages:['import','excel','design'],autoRun:false});
  const c=await e.enqueue({extractPath:extract,stages:['import','design','excel'],autoRun:false});
  assert.equal(a.id,b.id);assert.notEqual(a.id,c.id);
});
test('missing credentials pause at publication and retry does not re-render preceding cards',async t=>{
  const {e,extract}=await setup(t);let renderCount=0,publishCount=0;
  e.credentials=async()=>({});e.bridge=async(action,a)=>{if(action==='render'){renderCount++;return {ok:true,artifacts:[{stage:'design',path:path.join(a.jobDir,'design.html')}]}}if(action==='publish'){publishCount++;return publishCount===1?{ok:false,status:'needs_auth',message:'缺少凭证'}:{ok:true,status:'completed'}}return {ok:true}};
  const j=await e.enqueue({extractPath:extract,stages:['import','design','blog'],autoRun:false});
  assert.equal((await e.finish(j.id)).status,'needs_auth');assert.equal((await e.finish(j.id)).status,'completed');
  assert.equal(renderCount,1);assert.equal(publishCount,2);
});
test('classification and reading stop at separate ordered model boundaries',async t=>{
  const {e,root}=await setup(t);const pdf=path.join(root,'paper.pdf');await fs.writeFile(pdf,'%PDF-1.4\n');
  e.bridge=async()=>({pageCount:1,pagesPath:path.join(root,'pages.json'),scanPages:[]});
  const j=await e.enqueue({pdfPath:pdf,stages:['import','prepare','classify','read'],autoRun:false});
  const first=await e.finish(j.id);assert.equal(first.requires,'classify');assert.deepEqual(first.completedStages,['import','prepare']);
  const saved=await e.store.get(j.id);saved.classificationPath=['Economics'];await e.store.save(saved);
  const second=await e.finish(j.id);assert.equal(second.requires,'read');assert.deepEqual(second.completedStages,['import','prepare','classify']);
});
test('failed or idle model callbacks preserve unfinished task as needing attention',async t=>{
  const {e,extract}=await setup(t);const j=await e.enqueue({extractPath:extract,stages:['import','excel'],autoRun:false});
  j.status='awaiting_agent';await e.store.save(j);assert.equal((await e.agentIdle(j.id)).status,'needs_attention');
  assert.equal((await e.agentFailed(j.id,new Error('failed'))).status,'needs_attention');
});
test('preview publication finishes remaining selected cards and can later publish without rendering again',async t=>{
  const {e,extract}=await setup(t);e.config.publishMode='preview';e.credentials=async()=>({});const calls=[];
  e.bridge=async(action,a)=>{calls.push([action,a.stages?.[0]]);if(action==='render')return {ok:true,artifacts:[{stage:a.stages[0],path:path.join(a.jobDir,a.stages[0]+'.html')}]};return {ok:true,status:action==='publish-preview'?'preview_ready':'completed'}};
  const j=await e.enqueue({extractPath:extract,stages:['import','design','blog','sheet'],autoRun:false});
  assert.equal((await e.finish(j.id)).status,'ready_publish');assert.deepEqual(calls.map(x=>x.join(':')),['render:design','publish-preview:blog','publish-preview:sheet']);
  e.config.publishMode='auto';assert.equal((await e.invoke('retry',{jobId:j.id})).status,'completed');
  assert.deepEqual(calls.slice(-2).map(x=>x.join(':')),['publish:blog','publish:sheet']);
});
test('quotes must match the actual cited page and all pages must have been read',async t=>{
  const {e,root}=await setup(t);const pdf=path.join(root,'paper.pdf');await fs.writeFile(pdf,'%PDF-1.4\n');
  const j=await e.enqueue({pdfPath:pdf,stages:['import','prepare','read'],autoRun:false});const pagesPath=path.join(e.store.dir(j.id),'pages.json');await atomicJSON(pagesPath,[{page:1,text:'The experiment identifies a causal treatment effect.'},{page:2,text:'The result is robust across specification choices.'}]);
  j.prepared={pagesPath,pageCount:2};j.stage='read';await e.store.save(j);
  await assert.rejects(e.saveAnalysis({jobId:j.id,extract:{},evidence:[{field:'result',page:1,quote:'The experiment identifies a causal treatment effect.'}]}),/还未读完/);
  await assert.rejects(e.verifyQuotes(j,[{field:'result',page:2,quote:'The experiment identifies a causal treatment effect.'}]),/原文证据未核对/);
});

test('blocked final sheet exposes manual bundle and retries only that card',async t=>{
  const {e,extract}=await setup(t);e.credentials=async()=>({});const calls=[];
  e.bridge=async(action,a)=>{
    calls.push([action,a.stages?.[0]]);
    if(action==='render')return {ok:true,artifacts:[{stage:a.stages[0],path:path.join(a.jobDir,'design.html')}]};
    if(a.stages?.[0]==='sheet')return {ok:false,status:'needs_setup',message:'atomic append unavailable',tsvPath:path.join(a.jobDir,'row.tsv'),registrationPath:path.join(a.jobDir,'registration.json')};
    return {ok:true,status:'completed'};
  };
  const j=await e.enqueue({extractPath:extract,stages:['import','design','blog','sheet'],autoRun:false});
  const first=await e.finish(j.id);
  assert.equal(first.status,'needs_setup');assert.equal(first.stage,'sheet');
  assert.deepEqual(first.completedStages,['import','design','blog']);
  assert.equal(first.artifacts.tsvPath.endsWith('row.tsv'),true);
  const stored=await e.store.get(j.id);assert.equal(stored.cursor,3);
  await e.finish(j.id);
  assert.deepEqual(calls,[['render','design'],['publish','blog'],['publish','sheet'],['publish','sheet']]);
});
