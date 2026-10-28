import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {LiteratureEngine} from '../lib/engine.mjs';

async function setup(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-cards-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const e=new LiteratureEngine({stateDir:root,inputDir:path.join(root,'input'),watchInput:false,autoRun:false,cardsHome:path.join(root,'cards')});
  await e.store.init();
  const extract=path.join(root,'fixture.extract.json');
  await fs.writeFile(extract,JSON.stringify({meta:{title:'A test paper'},economic_theories:['商业潜力（Commercial Potential）']}));
  return {e,extract,root};
}

test('cards 是代理阶段：先出任务书，再验收，通过后才算完成',async t=>{
  const {e,extract,root}=await setup(t);
  const calls=[];
  e.bridge=async(action,a)=>{
    calls.push([action,a.libraryHome]);
    if(action==='card-sheet')return {ok:true,status:'ready',path:path.join(a.jobDir,'artifacts','制卡任务书.md'),libraryHome:a.libraryHome};
    if(action==='cards-verify')return {ok:true,status:'rendered',path:path.join(a.jobDir,'artifacts','制卡报告.md'),libraryHome:a.libraryHome};
    return {ok:true,status:'completed'};
  };
  const j=await e.enqueue({extractPath:extract,stages:['import','cards'],autoRun:false});
  const first=await e.finish(j.id);
  assert.equal(first.requires,'cards');
  assert.equal(first.completedStages.includes('cards'),false);
  assert.equal(first.taskSheetPath.endsWith('制卡任务书.md'),true);
  assert.equal(first.libraryHome,path.join(root,'cards'));
  assert.deepEqual(calls.map(c=>c[0]),['card-sheet']);

  const second=await e.finish(j.id);
  assert.equal(second.status,'completed');
  assert.deepEqual(calls.map(c=>c[0]),['card-sheet','cards-verify']);
  assert.equal(second.artifacts.cards.endsWith('制卡报告.md'),true);
  assert.equal(second.completedStages.includes('cards'),true);
});

test('验收不通过时停在 needs_attention，不假装完成',async t=>{
  const {e,extract}=await setup(t);
  e.bridge=async(action,a)=>action==='card-sheet'
    ?{ok:true,status:'ready',path:path.join(a.jobDir,'artifacts','制卡任务书.md')}
    :{ok:false,status:'invalid',error:'未入库：商业潜力',message:'未入库：商业潜力'};
  const j=await e.enqueue({extractPath:extract,stages:['import','cards'],autoRun:false});
  await e.finish(j.id);
  const second=await e.finish(j.id);
  assert.equal(second.status,'needs_attention');
  assert.match(second.error,/未入库/);
  assert.equal(second.completedStages.includes('cards'),false);
});

test('cards 阶段产物会进 artifacts，且不会被当成脚本渲染阶段',async t=>{
  const {e,extract}=await setup(t);
  const seen=[];
  e.bridge=async(action,a)=>{
    seen.push(action);
    if(action==='render')throw new Error('cards 不应该走 render 脚本通道');
    if(action==='card-sheet')return {ok:true,status:'ready',path:path.join(a.jobDir,'artifacts','制卡任务书.md')};
    return {ok:true,status:'rendered',path:path.join(a.jobDir,'artifacts','制卡报告.md')};
  };
  const j=await e.enqueue({extractPath:extract,stages:['import','cards'],autoRun:false});
  await e.finish(j.id);
  const done=await e.finish(j.id);
  assert.equal(seen.includes('render'),false);
  assert.equal(done.artifacts.cards.endsWith('制卡报告.md'),true);
});
