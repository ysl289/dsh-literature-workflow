import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {LiteratureEngine} from '../lib/engine.mjs';

/**
 * 收尾阶段（Zotero 落盘之后）把产物从任务目录搬进该论文的 Zotero 文件夹。
 * 这些用例锁定三件事：只搬已确认复制的文件、卡片类文件不搬、任何不确定都保留原件。
 */
async function setup(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'lit-rehome-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const engine=new LiteratureEngine({stateDir:path.join(root,'state'),inputDir:path.join(root,'input'),autoRun:false,watchInput:false});
  await engine.store.init();
  const id='paper_testrehome01';
  const dir=engine.store.dir(id);
  await fs.mkdir(dir,{recursive:true});
  const zotero=path.join(root,'zotero');
  await fs.mkdir(zotero,{recursive:true});
  return {engine,root,id,dir,zotero};
}
async function write(file,body){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,body);return file;}
async function exists(file){try{await fs.access(file);return true}catch{return false}}

test('收尾时把已复制到 Zotero 的产物从任务目录删掉，并把路径改指向 Zotero',async t=>{
  const {engine,id,dir,zotero}=await setup(t);
  const xlsx=await write(path.join(dir,'paper.xlsx'),'xlsx-bytes');
  const extract=await write(path.join(dir,'paper.extract.json'),'{"meta":{}}');
  const md=await write(path.join(dir,'full.md'),'# 正文');
  for(const f of [xlsx,extract,md])await fs.copyFile(f,path.join(zotero,path.basename(f)));

  const job={id,artifacts:{zoteroFolder:zotero,excel:xlsx},extractPath:extract,prepared:{markdownPath:md}};
  const moved=await engine.rehomeArtifacts(job);

  assert.equal(moved,3);
  assert.equal(job.artifacts.excel,path.join(zotero,'paper.xlsx'));
  assert.equal(job.extractPath,path.join(zotero,'paper.extract.json'));
  assert.equal(job.prepared.markdownPath,path.join(zotero,'full.md'));
  assert.equal(await exists(xlsx),false);
  assert.equal(await exists(extract),false);
  assert.equal(await exists(md),false);
  assert.equal(await fs.readFile(job.artifacts.excel,'utf8'),'xlsx-bytes');
});

test('卡片类文件留在插件目录：卡片正文在卡片库里，不跟着论文产物搬',async t=>{
  const {engine,id,dir,zotero}=await setup(t);
  const card=await write(path.join(dir,'card_theory.md'),'# 理论卡');
  const brief=await write(path.join(dir,'制卡任务书.json'),'{}');
  const xlsx=await write(path.join(dir,'paper.xlsx'),'xlsx-bytes');
  for(const f of [card,brief,xlsx])await fs.copyFile(f,path.join(zotero,path.basename(f)));

  const job={id,artifacts:{zoteroFolder:zotero,card,制卡:brief,excel:xlsx}};
  const moved=await engine.rehomeArtifacts(job);

  assert.equal(moved,1);
  assert.equal(job.artifacts.card,card);
  assert.equal(job.artifacts.制卡,brief);
  assert.equal(await exists(card),true);
  assert.equal(await exists(brief),true);
  assert.equal(job.artifacts.excel,path.join(zotero,'paper.xlsx'));
  assert.equal(await exists(xlsx),false);
});

test('Zotero 里没有副本、或同名内容不一致时保留原件，不删任何东西',async t=>{
  const {engine,id,dir,zotero}=await setup(t);
  const missing=await write(path.join(dir,'paper.xlsx'),'xlsx-bytes');
  const differing=await write(path.join(dir,'summary.md'),'本地版本');
  await write(path.join(zotero,'summary.md'),'另一份内容');

  const job={id,artifacts:{zoteroFolder:zotero,excel:missing,summary:differing}};
  const moved=await engine.rehomeArtifacts(job);

  assert.equal(moved,0);
  assert.equal(job.artifacts.excel,missing);
  assert.equal(job.artifacts.summary,differing);
  assert.equal(await exists(missing),true);
  assert.equal(await exists(differing),true);
  assert.equal(await fs.readFile(differing,'utf8'),'本地版本');
});

test('没有 zoteroFolder 或文件夹不存在时什么都不做',async t=>{
  const {engine,id,dir}=await setup(t);
  const xlsx=await write(path.join(dir,'paper.xlsx'),'xlsx-bytes');
  assert.equal(await engine.rehomeArtifacts({id,artifacts:{excel:xlsx}}),0);
  assert.equal(await engine.rehomeArtifacts({id,artifacts:{zoteroFolder:path.join(dir,'nope'),excel:xlsx}}),0);
  assert.equal(await exists(xlsx),true);
});
