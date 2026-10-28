import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {LiteratureEngine} from '../lib/engine.mjs';
import {ZoteroClient} from '../lib/zotero.mjs';

test('disk-backed importing job survives a Zotero read failure and resumes at read without recreating existing items', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'dsh-zotero-resume-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const id='paper_resume_fixture', serverId='fixture-server', parentKey='PAPER222', attachmentKey='FILE2222';
  const title='A paper about knowledge spillovers';
  const pdf=Buffer.from('%PDF-1.7\nIsolated persistence fixture\n%%EOF\n');
  const pdfPath=path.join(root,'paper.pdf'), md5=createHash('md5').update(pdf).digest('hex');
  await fs.writeFile(pdfPath,pdf);
  const config={stateDir:root,inputDir:path.join(root,'input'),rootCollection:'',watchInput:false,autoRun:false};
  const parent={key:parentKey,data:{key:parentKey,itemType:'journalArticle',title,DOI:'10.1234/fixture',collections:['OLD22222','CHILD222']}};
  const attachment={key:attachmentKey,data:{key:attachmentKey,itemType:'attachment',parentItem:parentKey,linkMode:'imported_file',md5}};
  const collections=[
    {key:'ROOT2222',data:{key:'ROOT2222',name:'Research',parentCollection:false}},
    {key:'CHILD222',data:{key:'CHILD222',name:'Spillovers',parentCollection:'ROOT2222'}},
    {key:'OLD22222',data:{key:'OLD22222',name:'Existing',parentCollection:false}},
  ];
  let failChildren=true, writes=0, copyCalls=0;
  const reply=(status,body)=>new Response(typeof body==='string'?body:JSON.stringify(body),{status,headers:{'Zotero-Server-ID':serverId,'Zotero-API-Version':'3','Last-Modified-Version':'17'}});
  const client=()=>new ZoteroClient({getAuth:async()=>({key:'fixture-key',serverId}),fetchImpl:async(input,options)=>{
    const url=new URL(input),method=options.method||'GET';
    if(method!=='GET'){writes++;assert.fail(`Unexpected write ${method} ${url.pathname}`)}
    if(url.pathname==='/api/')return reply(200,{});
    if(url.pathname==='/api/users/0/collections')return reply(200,collections);
    if(url.pathname==='/api/users/0/items')return reply(200,[parent]);
    if(url.pathname===`/api/users/0/items/${parentKey}`)return reply(200,parent);
    if(url.pathname===`/api/users/0/items/${parentKey}/children`)return failChildren?reply(500,{error:'fixture read failure'}):reply(200,[attachment]);
    if(url.pathname===`/api/users/0/items/${attachmentKey}`)return reply(200,attachment);
    if(url.pathname===`/api/users/0/items/${attachmentKey}/file/view/url`)return reply(200,pathToFileURL(path.join(root,'storage',attachmentKey,'paper.pdf')).href);
    assert.fail(`Unexpected fixture request ${url.pathname}`);
  }});
  const makeEngine=()=>{
    const e=new LiteratureEngine(config);e.zotero=client();
    e.copyToStorage=async()=>{copyCalls++};
    e.bridge=async()=>assert.fail('read must pause before rendering or publishing');
    return e;
  };
  const e=makeEngine();await e.store.init();
  const pagesPath=path.join(e.store.dir(id),'pages.json');await fs.mkdir(path.dirname(pagesPath),{recursive:true});
  await fs.writeFile(pagesPath,JSON.stringify(Array.from({length:13},(_,i)=>({page:i+1,text:i===0?title:'Fixture page'}))));
  await e.store.save({id,kind:'paper',createdAt:new Date().toISOString(),status:'importing',stage:'zotero',cursor:3,
    stages:['import','prepare','classify','zotero','read','excel','design','lecture','blog','sheet'],
    completedStages:['import','prepare','classify'],pagesRead:Array.from({length:13},(_,i)=>i+1),
    metadata:{title,doi:'10.1234/fixture'},classificationPath:['Research','Spillovers'],pdfPath,
    prepared:{pagesPath,pageCount:13,scanPages:[]},receipt:{zoteroLocal:{serverId,operations:{'prior-fixture-operation':{state:'prepared'}}}},artifacts:{}});
  await assert.rejects(e.finish(id),/500/);
  const failed=await e.store.get(id);
  assert.equal(failed.status,'needs_attention');assert.equal(failed.cursor,3);
  assert.deepEqual(failed.completedStages,['import','prepare','classify']);assert.equal(failed.pagesRead.length,13);
  assert.doesNotThrow(()=>JSON.stringify(failed));assert.equal(writes,0);
  failChildren=false;
  // Fresh engine models process reload: resume using only durable JSON state.
  const resumed=makeEngine(),result=await resumed.finish(id);
  assert.equal(result.requires,'read');assert.equal(result.cursor,4);
  assert.equal(result.readPages.length,13);assert.deepEqual(result.unreadPages,[]);
  assert.deepEqual(result.completedStages,['import','prepare','classify','zotero']);
  const saved=await resumed.store.get(id);
  assert.equal(saved.pagesRead.length,13);assert.equal(saved.zotero.parentKey,parentKey);
  assert.equal(saved.zotero.attachmentKey,attachmentKey);assert.equal(saved.zotero.reused,true);
  assert.equal(Object.hasOwn(saved.receipt.zoteroLocal,'__receipt'),false);
  assert.deepEqual(parent.data.collections,['OLD22222','CHILD222']);
  assert.equal(copyCalls,1);assert.equal(writes,0);
});
