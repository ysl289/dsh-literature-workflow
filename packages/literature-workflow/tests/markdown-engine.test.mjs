import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {LiteratureEngine} from '../lib/engine.mjs';
const title='A study of innovation';
const quote='The study uses firm-level data and compares treated firms with a control group.';
async function setup(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'lit-md-engine-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const engine=new LiteratureEngine({stateDir:path.join(root,'state'),inputDir:path.join(root,'input'),autoRun:false,watchInput:false});await engine.store.init();
 const markdownPath=path.join(root,'paper.md');const body='# '+title+'\n\n'+quote+'\n';await fs.writeFile(markdownPath,body);
 const calls=[];engine.bridge=async(action,args)=>{calls.push({action,args});if(action==='prepare')throw Error('PDF conversion must never be called');return {ok:true,artifacts:[{stage:args.stages?.[0],path:path.join(args.jobDir,'out.xlsx')}]}};
 return {engine,root,markdownPath,body,calls};
}
async function classify(engine,job){
 await engine.readPages(job.id,[1]);
 await engine.saveAnalysis({jobId:job.id,metadata:{title},classificationPath:['Innovation'],confidence:.8,classificationEvidence:{page:1,quote}});
}
test('Markdown starts classification and reading directly with no conversion card or PDF',async t=>{
 const {engine,markdownPath,body,calls}=await setup(t);
 const job=await engine.enqueue({markdownPath,stages:['import','prepare','classify','read','excel'],autoRun:false});
 assert.equal(job.pdfPath,undefined);assert.deepEqual(job.stages,['import','classify','read','excel']);assert.equal(job.prepared.citationUnit,'segment');
 assert.equal((await engine.finish(job.id)).requires,'classify');
 const read=await engine.readPages(job.id,[1]);assert.equal(read.citationUnit,'segment');assert.equal(read.pages[0].startLine,1);
 await classify(engine,job);assert.equal((await engine.finish(job.id)).requires,'read');
 await engine.saveAnalysis({jobId:job.id,extract:{meta:{title}},evidence:[{field:'data',page:1,quote}]});
 assert.equal((await engine.finish(job.id)).status,'completed');assert.ok(calls.every(c=>c.action!=='prepare'));
 const stored=await engine.store.get(job.id),extract=JSON.parse(await fs.readFile(stored.extractPath,'utf8'));
 assert.equal(extract.meta.source_format,'markdown');assert.equal(extract.meta.citation_unit,'segment');assert.equal(await fs.readFile(markdownPath,'utf8'),body);
});
test('MD Zotero stage imports Markdown attachment and does not ask for or upload a PDF',async t=>{
 const {engine,markdownPath,calls}=await setup(t);let imported;
 engine.zotero={findClassifiedPaper:async()=>null,importMarkdown:async args=>{imported=args;return {parentKey:'EXISTING',attachmentKey:'MARKDOWN'}}};
 const job=await engine.enqueue({markdownPath,stages:['import','prepare','classify','zotero','read'],autoRun:false});
 await engine.finish(job.id);await classify(engine,job);
 assert.equal((await engine.finish(job.id)).requires,'read');assert.ok(imported.markdownPath.endsWith('full.md'));assert.equal(imported.pdfPath,undefined);
 assert.equal(calls.length,0);
});
test('legacy conversion pause points map to ready Markdown import rather than running a conversion',async t=>{
 const {engine,markdownPath,calls}=await setup(t);
 const job=await engine.enqueue({markdownPath,stages:['import','prepare','read'],stopAfter:'prepare',autoRun:false});
 const result=await engine.finish(job.id);assert.equal(result.status,'paused');assert.deepEqual(result.completedStages,['import']);assert.equal(result.cursor,1);assert.equal(calls.length,0);
});

test('input folder scanning imports Markdown directly and preserves its original',async t=>{
 const {engine,markdownPath,body,calls}=await setup(t);await fs.mkdir(engine.config.inputDir,{recursive:true});
 const input=path.join(engine.config.inputDir,'直接导入.markdown');await fs.copyFile(markdownPath,input);
 engine.config.stages=['import','prepare','read'];
 const jobs=await engine.scanInput(true);assert.equal(jobs.length,1);assert.deepEqual(jobs[0].stages,['import','read']);
 assert.equal((await engine.finish(jobs[0].id)).requires,'read');assert.equal(await fs.readFile(input,'utf8'),body);assert.equal(calls.length,0);
});

test('Markdown also preserves the classification of an existing Zotero paper without importing again',async t=>{
 const {engine,markdownPath,calls}=await setup(t);let lookup;
 engine.zotero={findClassifiedPaper:async args=>{lookup=args;return {title,parentKey:'EXISTING',preserved:true,matchBasis:'title',collectionPaths:[['已存分类']]};},importMarkdown:async()=>{throw Error('must preserve existing paper')}};
 const job=await engine.enqueue({markdownPath,metadata:{title},stages:['import','prepare','classify','zotero','read'],autoRun:false});
 const result=await engine.finish(job.id);assert.equal(result.requires,'read');assert.equal(lookup.pdfPath,undefined);
 assert.equal(result.skippedStages.classify.reason,'existing_zotero_classified');assert.equal(result.skippedStages.zotero.reason,'existing_zotero_classified');assert.equal(calls.length,0);
});
