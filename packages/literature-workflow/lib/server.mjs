import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { within, atomicJSON } from './store.mjs';

const ui = fileURLToPath(new URL('../web/index.html',import.meta.url));
const mime = {'.html':'text/html; charset=utf-8','.json':'application/json; charset=utf-8','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.md':'text/plain; charset=utf-8','.tsv':'text/tab-separated-values; charset=utf-8','.pdf':'application/pdf'};
async function body(req,max=1024*1024){let n=0,a=[];for await(const b of req){n+=b.length;if(n>max)throw Error('文件超过允许大小');a.push(b)}return Buffer.concat(a);}
export async function startControlPanel(engine){
  const token=randomBytes(32).toString('hex');let origin;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    try{
      if(req.headers.host!==new URL(origin).host){res.writeHead(403);res.end('Host rejected');return;}
      if(req.headers.origin&&req.headers.origin!==origin){res.writeHead(403);res.end('Origin rejected');return;}
      const u=new URL(req.url,origin);
      if(u.pathname==='/'&&req.method==='GET'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await fs.readFile(ui));return;}
      const supplied=String(req.headers['x-workflow-token']||u.searchParams.get('token')||'');
      if(supplied.length!==token.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(token))){res.writeHead(401);res.end('请从插件提供的入口打开');return;}
      const respond=v=>{res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(v))};
      if(req.method==='GET'&&u.pathname==='/api/status')return respond(await engine.status());
      if(req.method==='POST'&&u.pathname==='/api/invoke'){
        const x=JSON.parse((await body(req)).toString('utf8'));
        const actions=new Set(['settings','scan','enqueue','search_start','retry','run','finish','configure_job','hide_job','preview_delete_job','delete_job','authorize_zotero','save_credentials','connect_tencent','save_template','validate_pipeline']);
        if(!actions.has(x.action))throw Error('界面不支持此操作');return respond(await engine.invoke(x.action,x.payload||{}, {source:'panel'}));
      }
      if(req.method==='POST'&&u.pathname==='/api/upload'){
        const name=u.searchParams.get('name')||'paper.pdf',ext=path.extname(name).toLowerCase();if(!['.pdf','.json','.md','.markdown'].includes(ext))throw Error('支持PDF、Markdown或extract.json');
        const b=await body(req,64*1024*1024);if(ext==='.pdf'&&!b.subarray(0,1024).includes(Buffer.from('%PDF-')))throw Error('文件不是PDF');if(ext==='.json')JSON.parse(b.toString('utf8'));
        const dest=path.join(engine.config.stateDir,'uploads',`${randomUUID()}${ext}`);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,b,{flag:'wx'});
        const stages=JSON.parse(u.searchParams.get('stages')||'[]');const job=await engine.enqueue({[ext==='.pdf'?'pdfPath':['.md','.markdown'].includes(ext)?'markdownPath':'extractPath']:dest,stages,source:{kind:'drop',name,uploadPath:dest},autoRun:true});return respond(engine.summary(job));
      }
      if(req.method==='GET'&&u.pathname==='/api/artifact'){
        const j=await engine.store.get(u.searchParams.get('jobId'));const key=u.searchParams.get('key');let f=j.artifacts?.[key];
        if(!f||typeof f!=='string'||!within(engine.store.dir(j.id),f))throw Error('产物不存在');
        const real=await fs.realpath(f),base=await fs.realpath(engine.store.dir(j.id));if(!within(base,real))throw Error('产物路径越界');
        const st=await fs.stat(real);if(!st.isFile())throw Error('不是文件');
        // HTML decks have local scripts; sandbox prevents their accessing the control panel's origin.
        if(path.extname(real)==='.html')res.setHeader('Content-Security-Policy',"sandbox allow-scripts allow-downloads; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:");
        res.setHeader('Content-Type',mime[path.extname(real)]||'application/octet-stream');res.end(await fs.readFile(real));return;
      }
      if(req.method==='GET'&&u.pathname==='/assets/card-atlas.png'){
        res.setHeader('Content-Type','image/png');res.end(await fs.readFile(fileURLToPath(new URL('../web/card-atlas.png',import.meta.url))));return;
      }
      res.writeHead(404);res.end('Not found');
    }catch(e){res.statusCode=400;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify({error:String(e.message||e).replace(/sk-[\w-]+/g,'[隐藏]').replace(/Bearer\s+\S+/gi,'Bearer [隐藏]').slice(0,1200)}));}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});origin=`http://127.0.0.1:${server.address().port}`;server.unref();
  const url=`${origin}/#${token}`;await atomicJSON(path.join(engine.config.stateDir,'panel.json'),{url,pid:process.pid,startedAt:new Date().toISOString()});
  return {url,origin,close:()=>new Promise(resolve=>server.close(resolve))};
}
