import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {LiteratureEngine} from '../lib/engine.mjs';
import {JobStore,within,atomicJSON} from '../lib/store.mjs';

const ui={source:'harness-native-ui'};
async function deleteTask(e,id){const plan=await e.invoke('preview_delete_job',{jobId:id},ui);return e.invoke('delete_job',{jobId:id,planToken:plan.planToken},ui);}
async function setup(t,options={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'lit-delete-'));
  t.after(async()=>{assert.ok(within(os.tmpdir(),root)&&path.basename(root).startsWith('lit-delete-'));await fs.rm(root,{recursive:true,force:true});});
  const e=new LiteratureEngine({stateDir:path.join(root,'state'),inputDir:path.join(root,'input'),watchInput:false,autoRun:false},options);await e.store.init();
  const extract=path.join(root,'original.extract.json');await fs.writeFile(extract,'{"meta":{"title":"An example"}}');
  const job=await e.enqueue({extractPath:extract,stages:['import'],autoRun:false});
  job.status='cancelled';await e.store.save(job);return {e,root,job,extract};
}

test('permanent deletion removes local outputs without backups and preserves original papers and online records',async t=>{
  const {e,root,job,extract}=await setup(t);
  const external=path.join(root,'zotero-output.html');await fs.writeFile(external,'published artifact');
  job.artifacts={design:external};await e.store.save(job);
  await fs.writeFile(path.join(e.store.dir(job.id),'publish-receipt.json'),'{"entries":{"blog":{"status":"verified"}}}');
  const other={...job,id:'paper_other_fixture',status:'completed'};await e.store.save(other);
  const result=await deleteTask(e,job.id);
  assert.equal(result.deleted,true);assert.deepEqual((await e.store.list()).map(j=>j.id),[other.id]);
  assert.equal(await fs.stat(e.store.dir(job.id)).then(()=>true,()=>false),false);
  assert.equal(await fs.readFile(external,'utf8'),'published artifact');
  assert.equal(await fs.readFile(extract,'utf8'),'{"meta":{"title":"An example"}}');
  const backup=path.join(e.config.stateDir,'.deleted-jobs',job.id);
  assert.equal(await fs.stat(backup).then(()=>true,()=>false),false,'no recoverable task backup remains');
  const tombstone=JSON.parse(await fs.readFile(e.store.deletionFile(job.id),'utf8'));assert.ok(tombstone.purgedAt);assert.ok(!('title' in tombstone));
  assert.equal((await new JobStore(e.config.stateDir).list()).length,1);
  await assert.rejects(e.store.get(job.id),/已删除/);
  assert.equal((await e.invoke('delete_job',{jobId:job.id,planToken:JSON.parse(await fs.readFile(e.store.deletionFile(job.id),'utf8')).planToken},ui)).deleted,true,'repeated clicks are idempotent');
});

test('late saves, tool calls and agent callbacks cannot resurrect a deleted task',async t=>{
  const {e,job}=await setup(t);await deleteTask(e,job.id);
  await assert.rejects(e.store.save({...job,status:'needs_attention'}),/已删除/);
  await assert.rejects(e.finish(job.id),/已删除/);
  await assert.rejects(e.run(job.id),/已删除/);
  await assert.rejects(e.agentFailed(job.id,Error('late error')),/已删除/);
  assert.equal((await e.store.list()).length,0);
  assert.equal(await fs.stat(e.store.dir(job.id)).then(()=>true,()=>false),false);
});

test('running jobs, active agents and held operation locks block deletion',async t=>{
  const {e,job}=await setup(t);
  for(const status of ['queued','awaiting_agent','preparing','rendering','importing','publishing']){
    job.status=status;await e.store.save(job);await assert.rejects(e.invoke('preview_delete_job',{jobId:job.id},ui),/运行/);
  }
  job.status='needs_attention';await e.store.save(job);e.getJobActivity=async()=>true;
  await assert.rejects(e.invoke('preview_delete_job',{jobId:job.id},ui),/代理仍在运行/);
  e.getJobActivity=async()=>false;
  await e.store.locked(job.id,()=>assert.rejects(e.invoke('delete_job',{jobId:job.id},ui),/正在处理/));
  assert.equal((await e.store.list()).length,1);
});

test('task deletion is user-only and rejects invalid ids and directory junctions',async t=>{
  const {e,root,job}=await setup(t);
  await assert.rejects(e.invoke('delete_job',{jobId:job.id}),/只能由用户/);
  await assert.rejects(e.invoke('delete_job',{jobId:'../outside'},ui),/Invalid job id/);
  const target=path.join(root,'outside-job');await fs.mkdir(target);
  const id='paper_junction_fixture';await fs.writeFile(path.join(target,'job.json'),JSON.stringify({...job,id}));
  await fs.symlink(target,e.store.dir(id),'junction');
  await assert.rejects(e.invoke('delete_job',{jobId:id},ui),/联接|队列/);
  assert.ok((await fs.readFile(path.join(target,'job.json'),'utf8')).includes(id));
});


test('delete requires the reviewed token and changed local files invalidate approval',async t=>{
  const {e,job}=await setup(t);
  await assert.rejects(e.invoke('delete_job',{jobId:job.id},ui),/预览|清单/);
  const plan=await e.invoke('preview_delete_job',{jobId:job.id},ui);
  const output=path.join(e.store.dir(job.id),'new-output.txt');await fs.writeFile(output,'new');
  await assert.rejects(e.invoke('delete_job',{jobId:job.id,planToken:plan.planToken},ui),/清单已变化/);
  assert.equal((await e.store.get(job.id)).status,'cancelled');
  assert.equal(await fs.readFile(output,'utf8'),'new');
  assert.equal((await deleteTask(e,job.id)).deleted,true);
});

test('legacy soft-deleted task can be permanently purged without restoring it',async t=>{
  const {e,job,extract}=await setup(t);await e.store.remove(job.id,async()=>{});
  const plan=await e.invoke('preview_delete_job',{jobId:job.id},ui);
  assert.ok(plan.files.some(file=>file.path.includes('.deleted-jobs')));
  assert.equal((await e.invoke('delete_job',{jobId:job.id,planToken:plan.planToken},ui)).deleted,true);
  assert.equal((await e.store.list({includeArchived:true})).length,0);
  assert.ok(await fs.stat(extract));
});

test('a crash after tombstoning remains visible for cleanup without allowing restoration',async t=>{
  const {e,job}=await setup(t),plan=await e.invoke('preview_delete_job',{jobId:job.id},ui);
  await atomicJSON(e.store.deletionFile(job.id),{id:job.id,purgeRequested:true});
  assert.equal((await e.store.list({includeArchived:true}))[0].archived,true);
  await assert.rejects(e.hideJob({jobId:job.id,hidden:false}),/不能恢复/);
  assert.equal((await e.invoke('delete_job',{jobId:job.id,planToken:plan.planToken},ui)).deleted,true);
});

test('a partially purged task without job.json can resume only the approved cleanup plan',async t=>{
  const {e,job}=await setup(t),plan=await e.invoke('preview_delete_job',{jobId:job.id},ui);
  await atomicJSON(e.store.deletionFile(job.id),{id:job.id,purgeRequested:true});
  await atomicJSON(path.join(e.config.stateDir,'.purge-plans',job.id+'.json'),plan);
  await fs.unlink(path.join(e.store.dir(job.id),'job.json'));
  assert.equal((await e.store.list({includeArchived:true}))[0].stage,'delete');
  assert.equal((await e.invoke('preview_delete_job',{jobId:job.id},ui)).planToken,plan.planToken);
  assert.equal((await e.invoke('delete_job',{jobId:job.id,planToken:plan.planToken},ui)).deleted,true);
  assert.equal((await e.store.list({includeArchived:true})).length,0);
});
