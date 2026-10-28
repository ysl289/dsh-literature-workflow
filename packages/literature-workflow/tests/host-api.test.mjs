import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { attachNativeUI, NATIVE_API, UI_ACTIONS } from '../host-api.mjs';
import { LiteratureEngine } from '../lib/engine.mjs';
import { within } from '../lib/store.mjs';

function harness(engine) {
  const routes = new Map();
  const dispose = attachNativeUI({connection:{fetch:{register(route){
    assert.ok(!routes.has(route.path)); routes.set(route.path,route);
    return () => routes.delete(route.path);
  }}}},engine);
  const call = (suffix, init={}) => {
    const [pathname] = suffix.split('?');
    return routes.get(NATIVE_API+pathname).fetch(new Request('http://localhost'+NATIVE_API+suffix,init));
  };
  return {call,routes,dispose};
}
async function scratch() {return fs.mkdtemp(path.join(os.tmpdir(),'dsh-native-api-'));}
async function cleanup(dir) {
  assert.ok(within(os.tmpdir(),dir) && path.basename(dir).startsWith('dsh-native-api-'));
  await fs.rm(dir,{recursive:true,force:true});
}

test('native routes share the engine operations, hide retired URL, and are disposable',async()=>{
  const calls=[];
  const h=harness({status:async()=>({plugin:'literature',panelURL:'http://retired/#secret'}),invoke:async(...args)=>{calls.push(args);return {saved:true}}});
  const status=await (await h.call('/status')).json();
  assert.equal(status.nativePage,'文献工作流'); assert.ok(!('panelURL' in status));
  assert.equal(h.routes.size,6);
  const result=await h.call('/invoke',{method:'POST',body:JSON.stringify({action:'save_credentials',payload:{blogPassword:'test-only-value'}})});
  assert.deepEqual(await result.json(),{saved:true});
  assert.deepEqual(calls,[['save_credentials',{blogPassword:'test-only-value'},{source:'harness-native-ui'}]]);
  assert.equal((await h.call('/invoke',{method:'POST',body:JSON.stringify({action:'save_analysis'})})).status,400);
  assert.equal((await h.call('/invoke',{method:'POST',body:JSON.stringify({action:'settings',payload:[]})})).status,400);
  assert.equal(calls.length,1);
  h.dispose(); assert.equal(h.routes.size,0);
});

test('native upload preserves bytes and card order and rejects invalid files before enqueue',async()=>{
  const dir=await scratch();const calls=[];
  const h=harness({config:{stateDir:dir},enqueue:async input=>{calls.push(input);return {id:'test-job'}},summary:j=>j});
  try {
    const stages=['import','prepare','read'];
    const response=await h.call('/upload?'+new URLSearchParams({name:'论文.pdf',stages:JSON.stringify(stages)}),{method:'POST',body:'%PDF-1.7\nfixture'});
    assert.equal(response.status,200);
    assert.deepEqual(calls[0].stages,stages);
    assert.equal(await fs.readFile(calls[0].pdfPath,'utf8'),'%PDF-1.7\nfixture');
    assert.equal(calls[0].source.name,'论文.pdf');
    assert.equal(h.routes.get(NATIVE_API+'/upload').requestBody,'streaming');
    assert.equal((await h.call('/upload?name=bad.pdf',{method:'POST',body:'not pdf'})).status,400);
    assert.equal((await h.call('/upload?name=bad.exe',{method:'POST',body:'%PDF-1.7'})).status,400);
    assert.equal((await h.call('/upload?name=huge.pdf',{method:'POST',headers:{'content-length':String(65*1024*1024)},body:'%PDF-1.7'})).status,400);
    assert.equal(calls.length,1);
  } finally {h.dispose();await cleanup(dir)}
});

test('authorization errors preserve a safe timeout code for the native button feedback',async()=>{
  const h=harness({invoke:async()=>{const error=new Error('Local authorization timed out');error.name='TimeoutError';throw error}});
  try{
    for(const action of ['authorize_zotero','connect_tencent']){
      const response=await h.call('/invoke',{method:'POST',body:JSON.stringify({action,payload:{}})});
      assert.equal(response.status,400);
      assert.equal((await response.json()).code,'REQUEST_TIMEOUT');
    }
  }finally{h.dispose()}
});

test('native raw and multipart Markdown uploads create direct downstream jobs without PDF conversion',async()=>{
  const dir=await scratch(),engine=new LiteratureEngine({stateDir:path.join(dir,'state'),inputDir:path.join(dir,'input'),autoRun:false,watchInput:false});
  await engine.store.init();const h=harness(engine);
  try{
    for(const multipart of [false,true]){
      const name=multipart?'论文.markdown':'论文.md',body='# 研究标题\n\n直接使用 Markdown 正文。'+multipart;
      let suffix='/upload',init;
      if(multipart){const form=new FormData();form.append('file',new Blob([body]),name);form.append('options',JSON.stringify({stages:['import','prepare','read'],stopAfter:'import'}));init={method:'POST',body:form};}
      else{suffix+='?'+new URLSearchParams({name,stages:JSON.stringify(['import','prepare','read']),stopAfter:'import'});init={method:'POST',body};}
      const response=await h.call(suffix,init);assert.equal(response.status,200);const summary=await response.json(),job=await engine.store.get(summary.id);
      assert.deepEqual(job.stages,['import','read']);assert.equal(job.pdfPath,undefined);assert.equal(job.prepared.citationUnit,'segment');
      assert.equal(job.originalName,name);assert.equal(await fs.readFile(job.prepared.markdownPath,'utf8'),body);
      assert.equal(await fs.readFile(job.source.uploadPath,'utf8'),body);
    }
  }finally{h.dispose();await cleanup(dir)}
});

test('multipart uploads preserve long Chinese prompts and the full pipeline with a stop point',async()=>{
  const dir=await scratch();const calls=[];
  const h=harness({config:{stateDir:dir},enqueue:async input=>{calls.push(input);return {id:'test-job'}},summary:j=>j});
  try{
    const prompts={design:'详细解释识别假设与变量。'.repeat(800)};
    const form=new FormData();form.append('file',new Blob(['%PDF-1.7\nfixture']),'论文.pdf');
    form.append('options',JSON.stringify({stages:['import','design','lecture'],stopAfter:'design',stagePrompts:prompts}));
    const response=await h.call('/upload',{method:'POST',body:form});
    assert.equal(response.status,200);assert.equal(calls.length,1);
    assert.equal(calls[0].source.name,'论文.pdf');assert.equal(calls[0].stopAfter,'design');
    assert.deepEqual(calls[0].stagePrompts,prompts);assert.deepEqual(calls[0].stages,['import','design','lecture']);
  }finally{h.dispose();await cleanup(dir)}
});

test('native artifacts must stay inside their job and HTML has a sandbox',async()=>{
  const dir=await scratch();const jobDir=path.join(dir,'job');await fs.mkdir(jobDir);
  const html=path.join(jobDir,'deck.html');await fs.writeFile(html,'<h1>Fixture</h1>');
  const outside=path.join(dir,'private.json');await fs.writeFile(outside,'private');
  const h=harness({store:{dir:()=>jobDir,get:async()=>({id:'test-job',artifacts:{html,outside}})}});
  try {
    const good=await h.call('/artifact?jobId=test-job&key=html');
    assert.equal(good.status,200);assert.match(good.headers.get('content-security-policy'),/^sandbox/);
    assert.equal(await good.text(),'<h1>Fixture</h1>');
    const bad=await h.call('/artifact?jobId=test-job&key=outside');
    assert.equal(bad.status,400);assert.ok(!(await bad.text()).includes('private'));
  } finally {h.dispose();await cleanup(dir)}
});

test('native mode starts no standalone panel and user authorization is absent from agent tool schema',async()=>{
  const dir=await scratch();
  const engine=new LiteratureEngine({workflowRoot:dir,stateDir:path.join(dir,'state'),inputDir:path.join(dir,'input'),nativeUI:true,watchInput:false});
  try {
    await engine.start(); assert.equal(engine.panel,undefined);
    const actions=engine.toolSpecs[0].parameters.properties.action.enum;
    for(const action of ['save_credentials','authorize_zotero','connect_tencent'])assert.ok(!actions.includes(action));
    for(const action of UI_ACTIONS)if(!['save_credentials','authorize_zotero','connect_tencent','configure_job','delete_job','hide_job','preview_delete_job'].includes(action))assert.ok(actions.includes(action), 'application operation is also exposed to tools: '+action);
    assert.ok(!actions.includes('configure_job'),'agents cannot edit the user pause configuration');
    assert.ok(!actions.includes('delete_job'),'agents cannot delete tasks');
    assert.ok(!actions.includes('hide_job'),'agents cannot hide tasks');
    assert.ok(!actions.includes('preview_delete_job'),'deletion previews are user-only');
    assert.equal(await fs.stat(path.join(dir,'state','panel.json')).then(()=>true,()=>false),false);
  } finally {await engine.close();await cleanup(dir)}
});
