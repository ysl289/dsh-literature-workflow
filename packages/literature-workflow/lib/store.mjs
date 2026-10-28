import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function atomicJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await fs.rename(temp, file);
}
export async function readJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export function within(root, file) {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
export class JobStore {
  constructor(root) { this.root = root; this.locks = new Map(); }
  async init() { await fs.mkdir(path.join(this.root, 'jobs'), { recursive: true }); }
  dir(id) { if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id)) throw Error('Invalid job id'); return path.join(this.root, 'jobs', id); }
  deletionFile(id){this.dir(id);return path.join(this.root,'.deleted-jobs',id+'.json');}
  async assertNotDeleted(id){if(await readJSON(this.deletionFile(id),null))throw Error('任务已删除，不能继续执行');}
  visibilityFile(id){this.dir(id);return path.join(this.root,'.job-visibility',id+'.json');}
  async applyVisibility(job){const view=await readJSON(this.visibilityFile(job.id),null);return {...job,hidden:view?.hidden??job.hidden??false};}
  async get(id) { await this.assertNotDeleted(id);const j = await readJSON(path.join(this.dir(id), 'job.json'), null); if (!j) throw Error('任务不存在');await this.assertNotDeleted(id); return this.applyVisibility(j); }
  async deletionCandidate(id){
    const original=this.dir(id),archived=path.join(this.root,'.deleted-jobs',id),marker=await readJSON(this.deletionFile(id),null);
    const dirs=marker?[archived,original]:[original];
    for(const dir of dirs){const job=await readJSON(path.join(dir,'job.json'),null);if(job){if(job.id!==id)throw Error('任务标识不一致');return {job:await this.applyVisibility(job),jobDir:dir,archived:!!marker};}}
    throw Error('任务不存在或已彻底删除');
  }
  async setHidden(id,hidden){
    if(typeof hidden!=='boolean')throw Error('hidden必须为布尔值');
    const candidate=await this.deletionCandidate(id);
    if(candidate.archived&&!hidden){
      const marker=await readJSON(this.deletionFile(id),null);
      if(marker?.purgedAt||marker?.purgeRequested||await readJSON(path.join(this.root,'.purge-plans',id+'.json'),null))throw Error('已彻底删除或正在删除的任务不能恢复');
      const base=await fs.realpath(this.root),source=await fs.realpath(candidate.jobDir),target=this.dir(id);
      if((await fs.lstat(candidate.jobDir)).isSymbolicLink()||!within(base,source)||source===base)throw Error('恢复目录越界');
      if(path.resolve(candidate.jobDir)!==path.resolve(target)){
        if(await fs.lstat(target).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e}))throw Error('原任务目录已存在，拒绝覆盖');
        await fs.rename(candidate.jobDir,target);
      }
      await fs.unlink(this.deletionFile(id));
    }
    await atomicJSON(this.visibilityFile(id),{hidden,updatedAt:new Date().toISOString()});
    return {id,hidden};
  }
  async list({includeHidden=true,includeArchived=false}={}) {
    await this.init(); const rows = [];
    for (const e of await fs.readdir(path.join(this.root, 'jobs'), { withFileTypes: true })) {
      if (e.isDirectory() && /^[a-zA-Z0-9_-]{8,80}$/.test(e.name)) {
        const marker=await readJSON(this.deletionFile(e.name),null);if(marker&&!includeArchived)continue;
        const j=await readJSON(path.join(this.root,'jobs',e.name,'job.json'),null);
        if(j)rows.push(marker?{...j,hidden:true,archived:true}:await this.applyVisibility(j));
      }
    }
    if(includeArchived){
      const dir=path.join(this.root,'.deleted-jobs');
      for(const entry of await fs.readdir(dir,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e})){
        if(!entry.isDirectory()||!/^[a-zA-Z0-9_-]{8,80}$/.test(entry.name))continue;
        const j=await readJSON(path.join(dir,entry.name,'job.json'),null);
        if(j)rows.push({...j,hidden:true,archived:true});
      }
      // Interrupted purges remain visible in the hidden list even if job.json
      // was already removed; only the approved cleanup plan can be retried.
      const plans=path.join(this.root,'.purge-plans');
      for(const entry of await fs.readdir(plans,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e})){
        if(!entry.isFile()||!/^[a-zA-Z0-9_-]{8,80}\.json$/.test(entry.name))continue;
        const plan=await readJSON(path.join(plans,entry.name),null),id=entry.name.slice(0,-5);
        if(!plan||plan.jobId!==id||rows.some(job=>job.id===id))continue;
        rows.push({id,hidden:true,archived:true,status:'needs_attention',stage:'delete',stages:[],createdAt:'',error:'本地产物清理未完成，请重试删除'});
      }
    }
    return rows.filter(job=>includeHidden||!job.hidden).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async save(job) { await this.assertNotDeleted(job.id);job.updatedAt = new Date().toISOString(); await atomicJSON(path.join(this.dir(job.id), 'job.json'), job); return job; }
  async remove(id,check){
    const source=this.dir(id),markerPath=this.deletionFile(id),backup=path.join(this.root,'.deleted-jobs',id);
    const stateReal=await fs.realpath(this.root),jobsReal=await fs.realpath(path.join(this.root,'jobs'));
    if(!within(stateReal,jobsReal)||jobsReal===stateReal)throw Error('任务根目录越界，拒绝删除');
    const archiveDir=path.dirname(markerPath);
    await fs.mkdir(archiveDir,{recursive:true});
    const [archiveStat,archiveReal]=await Promise.all([fs.lstat(archiveDir),fs.realpath(archiveDir)]);
    if(archiveStat.isSymbolicLink()||!within(stateReal,archiveReal)||archiveReal===stateReal||!within(archiveReal,path.join(archiveReal,id)))throw Error('恢复备份目录越界，拒绝删除');
    let marker=await readJSON(markerPath,null);
    if(!marker){
      await this.locked(id,async()=>{
        const job=await this.get(id);if(job.id!==id)throw Error('任务标识不一致，拒绝删除');await check(job);
        const [stat,real,base]=await Promise.all([fs.lstat(source),fs.realpath(source),fs.realpath(path.join(this.root,'jobs'))]);
        if(stat.isSymbolicLink()||!stat.isDirectory()||!within(base,real)||real===base)throw Error('任务目录不属于插件队列，拒绝删除');
        marker={id,deletedAt:new Date().toISOString(),previousStatus:job.status,title:job.metadata?.title||job.originalName||job.query||id};
        // Persist the tombstone before releasing the job lock. Late callbacks
        // and pending tool calls cannot recreate or execute this task.
        await atomicJSON(markerPath,marker);
      });
    }
    // The operation.lock handle is closed before moving on Windows. Retain the
    // complete recovery copy, including receipts; never follow artifact paths.
    try{
      const stat=await fs.lstat(source);
      const base=await fs.realpath(path.join(this.root,'jobs')),real=await fs.realpath(source);
      if(stat.isSymbolicLink()||!stat.isDirectory()||!within(base,real)||real===base)throw Error('任务目录越界，拒绝移动');
      if(await fs.lstat(backup).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e}))throw Error('恢复备份已存在，拒绝覆盖');
      await fs.rename(source,backup);
    }catch(error){if(error.code!=='ENOENT')throw Error('任务已从新队列隐藏，但本地恢复备份移动未完成，请重试删除');}
    return {deleted:true,id,deletedAt:marker.deletedAt};
  }
  async locked(id, fn) {
    await this.assertNotDeleted(id);
    if (this.locks.has(id)) throw Error('该任务正在处理，请等待当前步骤完成');
    this.locks.set(id, true);
    const lock = path.join(this.dir(id), 'operation.lock'); let fd;
    try {
      await fs.mkdir(this.dir(id), { recursive: true });
      try { fd = await fs.open(lock, 'wx'); }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const priorText=await fs.readFile(lock,'utf8');let prior;try{prior=JSON.parse(priorText)}catch{}
        let dead=false;if(Number.isInteger(prior?.pid)&&prior.pid>0){try{process.kill(prior.pid,0)}catch(err){dead=err.code==='ESRCH'}}
        if(!dead)throw Error('任务有未确认的处理中操作；请等待原进程完成，不能重复写入');
        if(await fs.readFile(lock,'utf8')!==priorText)throw Error('任务锁发生变化，请稍后重试');
        // Only our own dead-process lock is removed; write receipts still govern uncertain side effects.
        await fs.unlink(lock);fd=await fs.open(lock,'wx');
      }
      await fd.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      return await fn();
    } finally { if (fd) { await fd.close(); await fs.unlink(lock).catch(() => {}); } this.locks.delete(id); }
  }
}
