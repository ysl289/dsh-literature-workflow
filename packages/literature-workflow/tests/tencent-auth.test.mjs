import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { LiteratureEngine } from '../lib/engine.mjs';

function fixture() {
  const child=new EventEmitter();child.stdout=new PassThrough();child.kill=()=>{child.killed=true};
  const calls=[];
  const engine=new LiteratureEngine({nativeUI:true},{spawnAuth:(...args)=>{calls.push(args);return child}});
  engine.credentials=async()=>({});engine.store.list=async()=>[];engine.zotero={health:async()=>({ok:true})};
  engine.config.stateDir='fixture-not-written';
  return {engine,child,calls,event:value=>child.stdout.write(JSON.stringify(value)+'\n')};
}

test('official authorization progress reaches the native UI and never exposes codes through the agent status',async()=>{
  const {engine,child,calls,event}=fixture();
  try {
    assert.equal((await engine.invoke('connect_tencent')).status,'registering');
    assert.match(calls[0][1][3], /lib[\\/]tencent_auth\.py$/);
    assert.ok(calls[0][1].includes('--save'));
    event({status:'waiting_approval',userCode:'',verificationURI:'https://docs.qq.com/scenario/open-claw.html',verificationURL:'https://docs.qq.com/scenario/open-claw.html?authType=1&code=ABCD1234',browserOpened:false,access_token:'MUST_NOT_APPEAR'});
    const native=await engine.status({includeAuthorization:true});
    assert.equal(native.auth.tencentFlow.browserOpened,false);
    assert.equal(native.auth.tencent,false,'consent preparation is not a connection');
    assert.ok(!JSON.stringify(native).includes('MUST_NOT_APPEAR'));
    const agent=await engine.invoke('status');
    assert.equal(agent.auth.tencentFlow.status,'waiting_approval');
    assert.ok(!JSON.stringify(agent).includes('ABCD1234'));
    event({status:'validating'});
    assert.equal((await engine.status({includeAuthorization:true})).auth.tencentFlow.status,'validating');
    await engine.invoke('connect_tencent');assert.equal(calls.length,1,'repeated clicks share the active authorization');
    event({status:'failed',errorCode:'timeout'});child.emit('close',1);
    assert.equal(engine.tencentAuth.errorCode,'timeout','close preserves the actual failure');
    await engine.invoke('connect_tencent');assert.equal(calls.length,2,'the user can retry after failure');
  }finally{await engine.close()}
});

test('bad helper output, launch failure and premature exit never report a completed flow',async()=>{
  for(const kind of ['bad-url','launch','exit']){
    const {engine,child,event}=fixture();
    try{
      await engine.invoke('connect_tencent');
      if(kind==='bad-url')event({status:'waiting_approval',userCode:'ABCD1234',verificationURI:'https://other.example',verificationURL:'https://other.example'});
      if(kind==='launch')child.emit('error',new Error('fixture detail must be hidden'));
      child.emit('close',kind==='exit'?0:1);
      assert.equal(engine.tencentAuth.status,'failed');
      assert.ok(!JSON.stringify(engine.tencentAuth).includes('fixture detail'));
    }finally{await engine.close()}
  }
});

test('closing the plugin stops its pending authorization helper',async()=>{
  const {engine,child}=fixture();await engine.invoke('connect_tencent');await engine.close();assert.equal(child.killed,true);
});
