import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { within } from './lib/store.mjs';

export const NATIVE_API = '/api/literatureWorkflow';
export const UI_ACTIONS = new Set(['settings', 'scan', 'enqueue', 'search_start', 'retry', 'run', 'finish', 'configure_job', 'hide_job', 'preview_delete_job', 'delete_job', 'authorize_zotero', 'save_credentials', 'connect_tencent', 'save_template', 'validate_pipeline']);
const asset = fileURLToPath(new URL('./web/card-atlas.png', import.meta.url));
const mime = {'.pdf':'application/pdf', '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.html':'text/html; charset=utf-8', '.json':'application/json; charset=utf-8', '.md':'text/plain; charset=utf-8', '.tsv':'text/tab-separated-values; charset=utf-8'};
const headers = {'cache-control':'no-store', 'x-content-type-options':'nosniff', 'referrer-policy':'no-referrer'};
const json = (value, status = 200) => new Response(JSON.stringify(value ?? null), {status, headers:{...headers, 'content-type':'application/json; charset=utf-8'}});
const failure = error => String(error?.message || error).replace(/Bearer\s+\S+/gi, 'Bearer [隐藏]').replace(/sk-[\w-]+/g, '[隐藏]').slice(0,1200);

async function readLimited(request, maximum) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) throw Error('文件超过允许大小');
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      request.signal.throwIfAborted();
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw Error('文件超过允许大小'); }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally { reader.releaseLock(); }
}

/** Routes live on Harness Connection's authenticated, owner-only Fetch registry.
 * UI settings and credentials never become a session command or model message.
 */
export function attachNativeUI(ctx, engine) {
  if (typeof ctx.connection?.fetch?.register !== 'function') throw Error('Harness Connection Fetch registry is required for the native literature page.');
  const disposers = [];
  function route(suffix, method, fn, requestBody = 'buffered') {
    const dispose = ctx.connection.fetch.register({
      path: NATIVE_API + suffix, methods:[method], requestBody,
      async fetch(request) {
        if (request.method !== method) return json({error:'请求方法不支持'},405);
        try { return await fn(request, new URL(request.url)); }
        catch (error) { return json({error:failure(error),...(error?.name==='TimeoutError'?{code:'REQUEST_TIMEOUT'}:{})},400); }
      },
    });
    if (typeof dispose === 'function') disposers.push(dispose);
  }
  try {
    route('/status', 'GET', async () => {
      const status = await engine.status({includeAuthorization:true});
      // The native Client receives no capability URL for the retired standalone UI.
      const {panelURL, ...nativeStatus} = status;
      return json({...nativeStatus, nativePage:'文献工作流'});
    });
    route('/models', 'GET', async (_request,url) => json(await engine.modelCatalog({force:url.searchParams.get('refresh')==='1'})));
    route('/invoke', 'POST', async request => {
      const input = JSON.parse((await readLimited(request,1024*1024)).toString('utf8'));
      if (!input || !UI_ACTIONS.has(input.action)) throw Error('界面不支持此操作');
      if (input.payload != null && (typeof input.payload !== 'object' || Array.isArray(input.payload))) throw Error('操作参数必须为对象');
      return json(await engine.invoke(input.action,input.payload || {},{source:'harness-native-ui'}));
    });
    route('/upload','POST', async (request,url) => {
      let name=url.searchParams.get('name')||'paper.pdf',options={},data;
      if((request.headers.get('content-type')||'').startsWith('multipart/form-data')){
        const buffer=await readLimited(request,65*1024*1024);
        const form=await new Response(buffer,{headers:{'content-type':request.headers.get('content-type')}}).formData();
        const file=form.get('file'),raw=form.get('options');
        if(!file||typeof file.arrayBuffer!=='function'||typeof raw!=='string'||raw.length>128000)throw Error('上传文件或流程配置格式错误');
        options=JSON.parse(raw);if(!options||typeof options!=='object'||Array.isArray(options))throw Error('流程配置必须为对象');
        name=file.name||name;data=Buffer.from(await file.arrayBuffer());if(data.length>64*1024*1024)throw Error('文件超过允许大小');
      }else data=await readLimited(request,64*1024*1024);
      const ext = path.extname(name).toLowerCase();
      if (!['.pdf','.json','.md','.markdown'].includes(ext)) throw Error('支持PDF、Markdown或extract.json');
      if (ext === '.pdf' && !data.subarray(0,1024).includes(Buffer.from('%PDF-'))) throw Error('文件不是PDF');
      if (ext === '.json') JSON.parse(data.toString('utf8'));
      const stages = options.stages??JSON.parse(url.searchParams.get('stages') || '[]');
      if (!Array.isArray(stages) || stages.some(stage => typeof stage !== 'string')) throw Error('流程顺序格式错误');
      const stopAfter = options.stopAfter??url.searchParams.get('stopAfter')??'';
      const dest = path.join(engine.config.stateDir,'uploads',randomUUID()+ext);
      await fs.mkdir(path.dirname(dest),{recursive:true});
      await fs.writeFile(dest,data,{flag:'wx'});
      let job;
      try{job=await engine.enqueue({[ext === '.pdf' ? 'pdfPath' : ['.md','.markdown'].includes(ext)?'markdownPath':'extractPath']:dest, stages, stopAfter: stopAfter || undefined, stagePrompts:options.stagePrompts, source:{kind:'drop',name,uploadPath:dest}, autoRun:true});}
      catch(error){await fs.unlink(dest).catch(()=>{});throw error;}
      if(job.source&&job.source.uploadPath!==dest)await fs.unlink(dest);
      return json(engine.summary(job));
    },'streaming');
    route('/artifact','GET', async (_request,url) => {
      const job = await engine.store.get(url.searchParams.get('jobId'));
      const file = job.artifacts?.[url.searchParams.get('key')];
      const dir = engine.store.dir(job.id);
      if (typeof file !== 'string' || !within(dir,file)) throw Error('产物不存在');
      const [real,base] = await Promise.all([fs.realpath(file),fs.realpath(dir)]);
      if (!within(base,real) || !(await fs.stat(real)).isFile()) throw Error('产物路径越界');
      const ext = path.extname(real).toLowerCase();
      const extra = ext === '.html' ? {'content-security-policy':"sandbox allow-scripts allow-downloads; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:"} : {};
      return new Response(await fs.readFile(real),{headers:{...headers,...extra,'content-type':mime[ext] || 'application/octet-stream'}});
    });
    route('/atlas','GET', async () => new Response(await fs.readFile(asset),{headers:{...headers,'content-type':'image/png'}}));
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }
  return () => { for (const dispose of disposers.splice(0).reverse()) dispose(); };
}
