import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicJSON, readJSON, within } from './store.mjs';

const JOB_ID = /^[a-zA-Z0-9_-]{8,80}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const UUID_FILE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:\.[a-z0-9]{1,12})?$/i;
const JOB_FILE_KINDS = new Set(['job_record', 'cloned_source', 'job_output']);

function samePath(a, b) {
  let left = path.resolve(a), right = path.resolve(b);
  if (process.platform === 'win32') { left = left.toLowerCase(); right = right.toLowerCase(); }
  return left === right;
}

function directChild(parent, child) {
  return samePath(path.dirname(path.resolve(child)), path.resolve(parent));
}

function sortPaths(values) {
  return [...new Set(values.map(value => path.resolve(value)))].sort((a, b) => a.localeCompare(b));
}

function isMissing(error) { return error?.code === 'ENOENT'; }

async function checkPath(target, { type, allowMissing = false } = {}) {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  const parts = path.relative(root, absolute).split(path.sep).filter(Boolean);
  let current = root;
  let finalStat;
  if (!parts.length) {
    finalStat = await fs.lstat(root);
  } else {
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      let stat;
      try { stat = await fs.lstat(current); }
      catch (error) {
        if (allowMissing && isMissing(error)) return { path: absolute, exists: false };
        throw error;
      }
      if (stat.isSymbolicLink()) throw new Error(`路径包含符号链接或目录联接，拒绝操作：${current}`);
      if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`路径中间部分不是目录：${current}`);
      if (index === parts.length - 1) finalStat = stat;
    }
  }
  if (type === 'dir' && !finalStat.isDirectory()) throw new Error(`路径不是目录：${absolute}`);
  if (type === 'file' && !finalStat.isFile()) throw new Error(`路径不是普通文件：${absolute}`);
  const realPath = path.resolve(await fs.realpath(absolute));
  if (!samePath(realPath, absolute)) throw new Error(`路径解析后发生变化，拒绝操作：${absolute}`);
  return { path: absolute, exists: true, stat: finalStat, realPath };
}

async function validateStateRoot(stateDir) {
  const stateRoot = path.resolve(stateDir);
  await checkPath(stateRoot, { type: 'dir' });
  return stateRoot;
}

function expectedJobDirs(stateRoot, jobId) {
  return {
    active: path.join(stateRoot, 'jobs', jobId),
    archived: path.join(stateRoot, '.deleted-jobs', jobId),
  };
}

async function validateJobDir(stateRoot, jobId, jobDir, { allowMissing = false } = {}) {
  if (!JOB_ID.test(String(jobId || ''))) throw new Error('Invalid job id');
  const candidates = expectedJobDirs(stateRoot, jobId);
  const absolute = path.resolve(jobDir);
  if (!samePath(absolute, candidates.active) && !samePath(absolute, candidates.archived)) {
    throw new Error('任务目录不在允许的队列或归档目录中');
  }
  const parent = path.dirname(absolute);
  await checkPath(parent, { type: 'dir', allowMissing });
  return checkPath(absolute, { type: 'dir', allowMissing });
}

function remapJobPath(candidate, stateRoot, jobId, actualJobDir) {
  if (typeof candidate !== 'string' || !candidate) return null;
  const resolved = path.resolve(candidate);
  const activeDir = expectedJobDirs(stateRoot, jobId).active;
  if (within(activeDir, resolved)) return path.resolve(actualJobDir, path.relative(activeDir, resolved));
  return resolved;
}

function sourcePathEntries(job, stateRoot, jobDir, { includePdf = false, includeArtifacts = true } = {}) {
  const values = [];
  if (includePdf) values.push(job.pdfPath);
  values.push(job.extractPath, job.prepared?.markdownPath, job.prepared?.mdPath);
  if (includeArtifacts) for (const [key, value] of Object.entries(job.artifacts || {})) {
    if (key !== 'zoteroFolder' && typeof value === 'string') values.push(value);
  }
  return sortPaths(values.filter(value => typeof value === 'string' && value).map(value => remapJobPath(value, stateRoot, job.id, jobDir)).filter(value => value && within(jobDir, value)));
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function fileRecord(file, kind) {
  const info = await checkPath(file, { type: 'file' });
  return { path: info.path, bytes: info.stat.size, sha256: await hashFile(info.path), kind };
}

async function inventoryJobTree(jobDir, job, stateRoot, { allowMissing = false } = {}) {
  const rootCheck = await checkPath(jobDir, { type: 'dir', allowMissing });
  if (!rootCheck.exists) return { files: [], directories: [] };
  const sourcePaths = new Set(sourcePathEntries(job, stateRoot, jobDir, { includePdf: true, includeArtifacts: false }).map(file => path.resolve(file)));
  const files = [], directories = [path.resolve(jobDir)];

  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      const info = await checkPath(full, {});
      if (entry.name === 'operation.lock') {
        if (!info.stat.isFile()) throw new Error(`operation.lock 不是普通文件，拒绝操作：${full}`);
        continue;
      }
      if (info.stat.isDirectory()) {
        directories.push(path.resolve(full));
        await walk(full);
      } else if (info.stat.isFile()) {
        const relative = path.relative(jobDir, full);
        const kind = relative === 'job.json' ? 'job_record' : sourcePaths.has(path.resolve(full)) ? 'cloned_source' : 'job_output';
        files.push(await fileRecord(full, kind));
      } else {
        throw new Error(`任务目录中存在不支持的文件类型：${full}`);
      }
    }
  }
  await walk(jobDir);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, directories: sortPaths(directories) };
}

async function readJobsAtRoot(stateRoot, allJobs = []) {
  const byId = new Map();
  for (const supplied of Array.isArray(allJobs) ? allJobs : []) if (supplied?.id) byId.set(supplied.id, supplied);
  for (const baseName of ['jobs', '.deleted-jobs']) {
    const base = path.join(stateRoot, baseName);
    const baseInfo = await checkPath(base, { type: 'dir', allowMissing: true });
    if (!baseInfo.exists) continue;
    for (const entry of await fs.readdir(base, { withFileTypes: true })) {
      if (!JOB_ID.test(entry.name)) continue;
      const directory = path.join(base, entry.name);
      const info = await checkPath(directory, { type: 'dir' });
      if (!info.exists) continue;
      const file = path.join(directory, 'job.json');
      const jobInfo = await checkPath(file, { type: 'file', allowMissing: true });
      if (!jobInfo.exists) continue;
      const diskJob = await readJSON(file, null);
      if (!diskJob || diskJob.id !== entry.name) throw new Error(`任务记录不一致，拒绝删除：${file}`);
      byId.set(diskJob.id, diskJob);
    }
  }
  return [...byId.values()];
}

function normalizedFolder(job, warnings) {
  const value = job.artifacts?.zoteroFolder;
  if (typeof value !== 'string' || !value) return null;
  if (!SHA256.test(String(job.sha256 || ''))) {
    warnings.push('Zotero 目录缺少有效任务摘要，无法确认目录归属');
    return null;
  }
  const folder = path.resolve(value);
  const expected = `literature-${job.sha256.slice(0, 12)}`;
  if (path.basename(folder) !== expected) {
    warnings.push(`Zotero 目录名称不符合任务归属规则，保留：${folder}`);
    return null;
  }
  return folder;
}

function referencedByOtherJob(file, folder, jobs, targetId, stateRoot) {
  const targetPath = path.resolve(file), targetName = path.basename(targetPath);
  for (const other of jobs) {
    if (!other?.id || other.id === targetId) continue;
    if ((Array.isArray(other.localCopies) ? other.localCopies : []).some(copy => typeof copy?.path === 'string' && samePath(copy.path, targetPath))) return true;
    const otherFolder = other.artifacts?.zoteroFolder;
    if (typeof otherFolder !== 'string' || !samePath(otherFolder, folder)) continue;
    const names = sourcePathEntries(other, stateRoot, path.join(stateRoot, 'jobs', other.id)).map(item => path.basename(item));
    if (names.includes(targetName)) return true;
  }
  return false;
}

async function optionalSafeFile(file) {
  try {
    const info = await checkPath(file, { type: 'file', allowMissing: true });
    return info.exists ? info : null;
  } catch (error) { return { error }; }
}

async function addExternalFile({ files, proofs, warnings, file, kind, root, job, allJobs, stateRoot, ownership, expectedSha }) {
  const absolute = path.resolve(file);
  if (!within(root, absolute) || !directChild(root, absolute)) {
    warnings.push(`外部副本不在允许的目录中，保留：${absolute}`);
    return;
  }
  let rootInfo;
  try { rootInfo = await checkPath(root, { type: 'dir', allowMissing: true }); }
  catch (error) { warnings.push(`外部目录路径不安全，保留副本：${error.message}`); return; }
  if (!rootInfo.exists) { warnings.push(`外部副本目录不存在，保留记录：${absolute}`); return; }
  const info = await optionalSafeFile(absolute);
  if (!info) return;
  if (info.error) { warnings.push(`外部副本路径不安全，保留：${absolute}`); return; }
  if (referencedByOtherJob(absolute, root, allJobs, job.id, stateRoot)) {
    warnings.push(`其他任务仍引用此副本，已保留：${absolute}`);
    return;
  }
  const actualSha = await hashFile(absolute);
  if (ownership === 'local_copy_record' && !SHA256.test(String(expectedSha || ''))) {
    warnings.push(`副本记录中的摘要无效，已保留：${absolute}`);
    return;
  }
  if (expectedSha && actualSha !== expectedSha.toLowerCase()) {
    warnings.push(`副本内容与任务记录不符，已保留：${absolute}`);
    return;
  }
  if (files.has(absolute)) return;
  const record = { path: absolute, bytes: info.stat.size, sha256: actualSha, kind };
  files.set(absolute, record);
  proofs.push({ path: absolute, kind, sha256: actualSha, ownership, createdByJob: job.id, root: path.resolve(root) });
}

async function addTrackedAuxFile({ field, rootName, kind, stateRoot, job, files, proofs, warnings }) {
  const sourcePath = job.source?.[field];
  if (typeof sourcePath !== 'string' || !sourcePath) return;
  const root = path.join(stateRoot, rootName), absolute = path.resolve(sourcePath);
  if (!within(root, absolute) || !directChild(root, absolute) || !UUID_FILE.test(path.basename(absolute))) {
    warnings.push(`来源文件不符合受跟踪的 ${rootName} 路径规则，已保留：${absolute}`);
    return;
  }
  let rootInfo;
  try { rootInfo = await checkPath(root, { type: 'dir', allowMissing: true }); }
  catch (error) { warnings.push(`来源目录路径不安全，已保留：${error.message}`); return; }
  if (!rootInfo.exists) { warnings.push(`来源目录不存在，已保留：${absolute}`); return; }
  const info = await optionalSafeFile(absolute);
  if (!info) return;
  if (info.error) { warnings.push(`来源文件路径不安全，已保留：${absolute}`); return; }
  const actualSha = await hashFile(absolute);
  if (!SHA256.test(String(job.sha256 || '')) || actualSha !== job.sha256.toLowerCase()) {
    warnings.push(`来源文件摘要与任务不一致，已保留：${absolute}`);
    return;
  }
  if (files.has(absolute)) return;
  files.set(absolute, { path: absolute, bytes: info.stat.size, sha256: actualSha, kind });
  proofs.push({ path: absolute, kind, sha256: actualSha, root: path.resolve(root), ownership: 'tracked_source', createdByJob: job.id });
}

function publicationRows(job) {
  const found = new Map();
  const stageFromKey = (key, fallback) => /blog|site|website/i.test(key) ? 'blog' : /sheet|tencent/i.test(key) ? 'sheet' : fallback;
  const add = (stage, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
    const row = { stage, url, status: 'retained', note: '保留网上发布内容' };
    found.set(`${stage}\n${url}`, row);
  };
  const visit = (value, stage = 'publication') => {
    if (typeof value === 'string') { add(stage, value); return; }
    if (Array.isArray(value)) { for (const item of value) visit(item, stage); return; }
    if (value && typeof value === 'object') {
      const ownStage = typeof value.stage === 'string' ? value.stage : stage;
      if (typeof value.url === 'string') add(ownStage, value.url);
      for (const [key, item] of Object.entries(value)) {
        if (key === 'url' || key === 'stage') continue;
        visit(item, stageFromKey(key, ownStage));
      }
    }
  };
  visit(job.publication);
  visit(job.publications);
  visit(job.receipt?.publication);
  visit(job.receipt?.publications);
  visit(job.receipt?.publish);
  visit(job.artifacts?.blog, 'blog');
  visit(job.artifacts?.links, 'blog');
  visit(job.artifacts?.published);
  return [...found.values()].sort((a, b) => a.stage.localeCompare(b.stage) || a.url.localeCompare(b.url));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function tokenPayload(plan) {
  return canonical({
    version: plan.version,
    jobId: plan.jobId,
    stateDir: plan.stateDir,
    jobDir: plan.jobDir,
    files: plan.files,
    directories: plan.directories,
    externalDirectories: plan.externalDirectories,
    totalBytes: plan.totalBytes,
    jobSha256: plan.jobSha256,
    externalPublications: plan.externalPublications,
    warnings: plan.warnings,
    externalRoots: plan.externalRoots,
    externalProofs: plan.externalProofs,
  });
}

function planTokenFor(plan) { return createHash('sha256').update(JSON.stringify(tokenPayload(plan)), 'utf8').digest('hex'); }

async function inspectZoteroCopies({ stateRoot, job, jobDir, allJobs, files, proofs, warnings, externalRoots, externalDirectories }) {
  const folder = normalizedFolder(job, warnings);
  if (!folder) return;
  externalRoots.push({ kind: 'zotero_copy', path: folder });
  let directoryInfo;
  try { directoryInfo = await checkPath(folder, { type: 'dir', allowMissing: true }); }
  catch (error) { warnings.push(`Zotero 目录路径不安全，保留其中所有文件：${error.message}`); return; }
  if (!directoryInfo.exists) return;

  const localCopies = Array.isArray(job.localCopies) ? job.localCopies : [];
  const protectedPaths = new Set();
  for (const copy of localCopies) {
    if (typeof copy?.path !== 'string') continue;
    if (copy.createdByJob !== true && copy.createdByJob !== job.id) {
      protectedPaths.add(path.resolve(copy.path));
      warnings.push(`Zotero 副本没有标记为本任务创建，已保留：${copy.path}`);
      continue;
    }
    if (!directChild(folder, copy.path)) {
      warnings.push(`Zotero 副本不在本任务归档目录中，已保留：${copy.path}`);
      continue;
    }
    if (within(jobDir, path.resolve(copy.path))) continue; // Already covered by the job-folder inventory.
    await addExternalFile({ files, proofs, warnings, file: copy.path, kind: 'zotero_copy', root: folder, job, allJobs, stateRoot, ownership: 'local_copy_record', expectedSha: copy.sha256 });
  }

  const legacySources = sourcePathEntries(job, stateRoot, jobDir);
  const byName = new Map();
  for (const source of legacySources) {
    const name = path.basename(source);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(source);
  }
  for (const [name, sources] of byName) {
    const destination = path.join(folder, name);
    if (within(jobDir, destination)) continue;
    if (protectedPaths.has(path.resolve(destination))) continue;
    const destinationInfo = await optionalSafeFile(destination);
    if (!destinationInfo) continue;
    if (destinationInfo.error) { warnings.push(`旧版 Zotero 副本路径不安全，已保留：${destination}`); continue; }
    let matchingSourceSha = null;
    for (const source of sources) {
      const sourceInfo = await optionalSafeFile(source);
      if (!sourceInfo || sourceInfo.error) continue;
      const sourceSha = await hashFile(source);
      if (sourceSha === await hashFile(destination)) { matchingSourceSha = sourceSha; break; }
    }
    if (!matchingSourceSha) {
      warnings.push(`旧版 Zotero 副本无法与任务源文件核对，或内容已变化，已保留：${destination}`);
      continue;
    }
    await addExternalFile({ files, proofs, warnings, file: destination, kind: 'zotero_copy', root: folder, job, allJobs, stateRoot, ownership: 'legacy_source_match', expectedSha: matchingSourceSha });
  }
  for(const entry of await fs.readdir(folder,{withFileTypes:true})){
    const candidate=path.join(folder,entry.name);
    if(!files.has(path.resolve(candidate)))warnings.push(`未列入删除清单的 Zotero 内容将保留：${candidate}`);
  }
  const folderShared = allJobs.some(other => other?.id !== job.id && typeof other.artifacts?.zoteroFolder === 'string' && samePath(other.artifacts.zoteroFolder, folder));
  if (!folderShared && [...files.values()].some(file => file.kind === 'zotero_copy' && directChild(folder, file.path))) externalDirectories.push(path.resolve(folder));
}

async function buildPlan({ stateDir, job, jobDir, allJobs = [] }) {
  if (!job || !JOB_ID.test(String(job.id || ''))) throw new Error('Invalid job id');
  const stateRoot = await validateStateRoot(stateDir);
  const actualJobDir = path.resolve(jobDir);
  await validateJobDir(stateRoot, job.id, actualJobDir);
  const warnings = [], externalRoots = [], externalProofs = [], externalDirectories = [];
  const tree = await inventoryJobTree(actualJobDir, job, stateRoot);
  const files = new Map(tree.files.map(file => [path.resolve(file.path), file]));
  const jobs = await readJobsAtRoot(stateRoot, allJobs);

  await inspectZoteroCopies({ stateRoot, job, jobDir: actualJobDir, allJobs: jobs, files, proofs: externalProofs, warnings, externalRoots, externalDirectories });
  await addTrackedAuxFile({ field: 'uploadPath', rootName: 'uploads', kind: 'tracked_upload', stateRoot, job, files, proofs: externalProofs, warnings });
  await addTrackedAuxFile({ field: 'cachePath', rootName: 'downloads', kind: 'download_cache', stateRoot, job, files, proofs: externalProofs, warnings });
  for (const kind of ['uploads', 'downloads']) externalRoots.push({ kind: kind === 'uploads' ? 'tracked_upload' : 'download_cache', path: path.join(stateRoot, kind) });

  const sortedFiles = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  const directories = sortPaths(tree.directories);
  const plan = {
    version: 1,
    jobId: job.id,
    stateDir: stateRoot,
    jobDir: actualJobDir,
    jobSha256: String(job.sha256 || ''),
    files: sortedFiles,
    directories,
    totalBytes: sortedFiles.reduce((sum, file) => sum + file.bytes, 0),
    externalPublications: publicationRows(job),
    externalDirectories: sortPaths(externalDirectories),
    warnings: [...new Set(warnings)].sort(),
    externalRoots: externalRoots.sort((a, b) => a.path.localeCompare(b.path)),
    externalProofs: externalProofs.sort((a, b) => a.path.localeCompare(b.path)),
  };
  plan.planToken = planTokenFor(plan);
  return plan;
}

/** Build a reviewable deletion manifest without removing or changing anything. */
export async function previewTaskDeletion({ stateDir, job, jobDir, allJobs = [] } = {}) {
  return buildPlan({ stateDir, job, jobDir, allJobs });
}

function mapJobOwnedPath(filePath, plannedJobDir, actualJobDir) {
  if (samePath(plannedJobDir, actualJobDir) || !within(plannedJobDir, filePath)) return path.resolve(filePath);
  return path.resolve(actualJobDir, path.relative(plannedJobDir, filePath));
}

async function actualJobDirForPlan(stateRoot, plan) {
  const dirs = expectedJobDirs(stateRoot, plan.jobId);
  const planned = path.resolve(plan.jobDir);
  if (!samePath(planned, dirs.active) && !samePath(planned, dirs.archived)) throw new Error('删除计划中的任务目录路径不合法');
  const active = await checkPath(dirs.active, { type: 'dir', allowMissing: true });
  const archived = await checkPath(dirs.archived, { type: 'dir', allowMissing: true });
  if (active.exists && archived.exists) throw new Error('活动目录和归档目录同时存在，拒绝删除');
  if (active.exists && samePath(planned, dirs.active)) return dirs.active;
  if (archived.exists && samePath(planned, dirs.active)) return dirs.archived; // Store tombstone move after preview.
  if (archived.exists && samePath(planned, dirs.archived)) return dirs.archived;
  if (active.exists && samePath(planned, dirs.archived)) throw new Error('任务已从归档目录移回队列，需重新预览删除计划');
  return planned;
}

async function currentInventoryForPurge(actualJobDir, plan, stateRoot) {
  const rootInfo = await checkPath(actualJobDir, { type: 'dir', allowMissing: true });
  if (!rootInfo.exists) return { files: [], directories: [] };
  const jobFile = path.join(actualJobDir, 'job.json');
  const recordInfo = await checkPath(jobFile, { type: 'file', allowMissing: true });
  const record = recordInfo.exists ? await readJSON(jobFile, null) : null;
  const fakeJob = record || { id: plan.jobId };
  return inventoryJobTree(actualJobDir, fakeJob, stateRoot, { allowMissing: true });
}

function normalizePlanFile(file, plan, actualJobDir) {
  if (!file || typeof file.path !== 'string' || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !SHA256.test(String(file.sha256 || ''))) throw new Error('删除计划包含无效文件记录');
  const local = JOB_FILE_KINDS.has(file.kind);
  const resolved = path.resolve(file.path);
  if (local && !within(plan.jobDir, resolved)) throw new Error(`任务文件越界：${resolved}`);
  if (!local && !['zotero_copy', 'tracked_upload', 'download_cache'].includes(file.kind)) throw new Error(`删除计划包含未知文件类型：${file.kind}`);
  return { ...file, path: local ? mapJobOwnedPath(resolved, plan.jobDir, actualJobDir) : resolved };
}

async function verifyExternalProof(file, plan, stateRoot) {
  const proof = plan.externalProofs.find(item => samePath(item.path, file.path));
  if (!proof || proof.kind !== file.kind || proof.sha256 !== file.sha256) throw new Error(`外部副本缺少与计划匹配的所有权记录：${file.path}`);
  let root;
  if (file.kind === 'zotero_copy') {
    root = proof.root;
    const expectedFolder = `literature-${String(plan.jobSha256 || '').slice(0, 12)}`;
    if (proof.createdByJob !== plan.jobId || !SHA256.test(String(plan.jobSha256 || '')) || path.basename(root) !== expectedFolder || !plan.externalRoots.some(item => item.kind === 'zotero_copy' && samePath(item.path, root))) throw new Error(`Zotero 副本目录归属无法确认：${file.path}`);
    if (!directChild(root, file.path)) throw new Error(`Zotero 副本路径越界：${file.path}`);
  } else {
    const expectedRoot = path.join(stateRoot, file.kind === 'tracked_upload' ? 'uploads' : 'downloads');
    if (!samePath(proof.root, expectedRoot) || !directChild(expectedRoot, file.path) || !UUID_FILE.test(path.basename(file.path))) throw new Error(`跟踪来源文件路径越界：${file.path}`);
    root = expectedRoot;
  }
  const info = await checkPath(file.path, { type: 'file', allowMissing: true });
  if (!info.exists) return false;
  const rootInfo = await checkPath(root, { type: 'dir', allowMissing: true });
  if (!rootInfo.exists) throw new Error(`外部副本目录已消失：${root}`);
  if (!within(root, info.realPath) || !directChild(root, info.realPath)) throw new Error(`外部副本解析路径越界：${file.path}`);
  const currentSha = await hashFile(file.path);
  if (currentSha !== file.sha256 || info.stat.size !== file.bytes) throw new Error(`文件内容已变化，删除计划过期：${file.path}`);
  return true;
}

async function planStorage(stateRoot, jobId) {
  const directory = path.join(stateRoot, '.purge-plans');
  let info = await checkPath(directory, { type: 'dir', allowMissing: true });
  if (!info.exists) {
    await fs.mkdir(directory, { recursive: true });
    info = await checkPath(directory, { type: 'dir' });
  }
  return { directory, file: path.join(directory, `${jobId}.json`) };
}

async function assertNoNewJobFiles(plan, actualJobDir, inventory) {
  const expectedFiles = new Map();
  for (const file of plan.files.filter(item => JOB_FILE_KINDS.has(item.kind))) {
    const actualPath = mapJobOwnedPath(file.path, plan.jobDir, actualJobDir);
    expectedFiles.set(path.resolve(actualPath), file);
  }
  for (const current of inventory.files) {
    const expected = expectedFiles.get(path.resolve(current.path));
    if (!expected) throw new Error(`任务目录出现预览后新增的文件，拒绝删除：${current.path}`);
    if (expected.sha256 !== current.sha256 || expected.bytes !== current.bytes) throw new Error(`任务文件内容已变化，删除计划过期：${current.path}`);
  }
  const expectedDirs = new Set(plan.directories.map(dir => path.resolve(mapJobOwnedPath(dir, plan.jobDir, actualJobDir))));
  for (const directory of inventory.directories) if (!expectedDirs.has(path.resolve(directory))) throw new Error(`任务目录出现预览后新增的子目录，拒绝删除：${directory}`);
}

async function ensureNoNewExternalReferences(plan, stateRoot, targetId) {
  const others = await readJobsAtRoot(stateRoot, []);
  for (const file of plan.files.filter(item => item.kind === 'zotero_copy')) {
    const proof = plan.externalProofs.find(item => samePath(item.path, file.path));
    if (proof && referencedByOtherJob(file.path, proof.root, others, targetId, stateRoot)) throw new Error(`Zotero 副本已被其他任务引用，删除计划过期：${file.path}`);
  }
}

async function removeEmptyDirectories(directories, actualJobDir, plannedJobDir) {
  const depth = value => path.resolve(value).split(path.sep).length;
  const sorted = directories.map(directory => mapJobOwnedPath(directory, plannedJobDir, actualJobDir))
    .sort((a, b) => depth(b) - depth(a) || b.length - a.length);
  const removed = [], failures = [];
  for (const directory of sorted) {
    const info = await checkPath(directory, { type: 'dir', allowMissing: true });
    if (!info.exists) continue;
    try { await fs.rmdir(directory); removed.push(directory); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') failures.push({ path: directory, reason: '目录仍包含未列入计划的内容' });
      else failures.push({ path: directory, reason: error.message });
    }
  }
  return { removed, failures };
}

async function removeGeneratedEmptyDirectories(plan, stateRoot) {
  const removed = [], preserved = [], failures = [], warnings = [];
  const jobs = await readJobsAtRoot(stateRoot, []);
  for (const directory of plan.externalDirectories || []) {
    const expectedName = `literature-${String(plan.jobSha256 || '').slice(0, 12)}`;
    if (path.basename(directory) !== expectedName || !plan.externalRoots.some(item => item.kind === 'zotero_copy' && samePath(item.path, directory))) {
      failures.push({ path: directory, reason: '生成目录归属无法确认' });
      continue;
    }
    if (jobs.some(other => other.id !== plan.jobId && typeof other.artifacts?.zoteroFolder === 'string' && samePath(other.artifacts.zoteroFolder, directory))) {
      preserved.push(directory);
      warnings.push(`其他任务使用此 Zotero 目录，已保留空目录：${directory}`);
      continue;
    }
    const info = await checkPath(directory, { type: 'dir', allowMissing: true });
    if (!info.exists) continue;
    try { await fs.rmdir(directory); removed.push(directory); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') {
        preserved.push(directory);
        warnings.push(`Zotero 目录仍包含其他文件，已保留：${directory}`);
      }
      else failures.push({ path: directory, reason: error.message });
    }
  }
  return { removed, preserved, failures, warnings };
}

/** Load a previously approved incomplete plan for a repeat delete action. */
export async function loadTaskDeletionPlan({ stateDir, jobId } = {}) {
  if (!JOB_ID.test(String(jobId || ''))) throw new Error('Invalid job id');
  const stateRoot = await validateStateRoot(stateDir);
  const directory = path.join(stateRoot, '.purge-plans');
  const directoryInfo = await checkPath(directory, { type: 'dir', allowMissing: true });
  if (!directoryInfo.exists) return null;
  const storage = { file: path.join(directory, `${jobId}.json`) };
  const info = await checkPath(storage.file, { type: 'file', allowMissing: true });
  if (!info.exists) return null;
  const plan = await readJSON(storage.file, null);
  if (!plan || plan.jobId !== jobId || !plan.planToken || planTokenFor(plan) !== plan.planToken) throw new Error('已保存的删除计划校验失败');
  return plan;
}

/** Verify a reviewed plan completely before unlinking any file, then purge it. */
export async function purgeTaskDeletion({ stateDir, plan, planToken } = {}) {
  if (!plan || !JOB_ID.test(String(plan.jobId || ''))) throw new Error('缺少有效的删除计划');
  if (typeof planToken !== 'string' || planToken !== plan.planToken || planTokenFor(plan) !== planToken) throw new Error('删除计划校验失败');
  const stateRoot = await validateStateRoot(stateDir);
  if (!samePath(plan.stateDir, stateRoot)) throw new Error('删除计划不属于当前任务目录');
  const actualJobDir = await actualJobDirForPlan(stateRoot, plan);
  if (!samePath(actualJobDir, plan.jobDir) && !within(expectedJobDirs(stateRoot, plan.jobId).archived, actualJobDir)) throw new Error('归档路径越界');
  const lockPath = path.join(actualJobDir, 'operation.lock');
  const lockInfo = await checkPath(lockPath, { type: 'file', allowMissing: true });
  if (lockInfo.exists) throw new Error('任务锁仍存在，暂不清理本地文件');

  const inventory = await currentInventoryForPurge(actualJobDir, plan, stateRoot);
  await assertNoNewJobFiles(plan, actualJobDir, inventory);
  const normalizedFiles = plan.files.map(file => normalizePlanFile(file, plan, actualJobDir));
  await ensureNoNewExternalReferences({ ...plan, files: normalizedFiles }, stateRoot, plan.jobId);

  const present = new Set();
  for (const file of normalizedFiles) {
    if (JOB_FILE_KINDS.has(file.kind)) {
      const info = await checkPath(file.path, { type: 'file', allowMissing: true });
      if (!info.exists) continue;
      if (!within(actualJobDir, info.realPath)) throw new Error(`任务文件解析路径越界：${file.path}`);
      const current = await hashFile(file.path);
      if (current !== file.sha256 || info.stat.size !== file.bytes) throw new Error(`任务文件内容已变化，删除计划过期：${file.path}`);
      present.add(path.resolve(file.path));
    } else if (await verifyExternalProof(file, plan, stateRoot)) present.add(path.resolve(file.path));
  }

  const storage = await planStorage(stateRoot, plan.jobId);
  const savedInfo = await checkPath(storage.file, { type: 'file', allowMissing: true });
  const saved = savedInfo.exists ? await readJSON(storage.file, null) : null;
  if (saved) {
    if (saved.planToken !== planToken) throw new Error('存在另一份未完成的删除计划，拒绝覆盖');
  } else {
    const existing = await checkPath(storage.file, { type: 'file', allowMissing: true });
    if (existing.exists) throw new Error('删除计划存储文件已存在且无法读取');
    await atomicJSON(storage.file, plan);
  }

  const deleted = [], missing = [], errors = [];
  const ordered = [...normalizedFiles].sort((a, b) => {
    const rank = file => file.kind === 'job_record' ? 2 : JOB_FILE_KINDS.has(file.kind) ? 1 : 0;
    return rank(a) - rank(b) || a.path.localeCompare(b.path);
  });
  for (const file of ordered) {
    if (!present.has(path.resolve(file.path))) { missing.push(file.path); continue; }
    try {
      const info = await checkPath(file.path, { type: 'file', allowMissing: true });
      if (!info.exists) { missing.push(file.path); continue; }
      const current = await hashFile(file.path);
      if (current !== file.sha256 || info.stat.size !== file.bytes) throw new Error(`文件在清理前发生变化：${file.path}`);
      await fs.unlink(file.path);
      deleted.push(file.path);
    } catch (error) { errors.push({ path: file.path, reason: error.message }); break; }
  }

  let removedDirectories = [], directoryFailures = [];
  let preservedDirectories = [], warnings = [];
  if (!errors.length) {
    const dirs = await removeEmptyDirectories(plan.directories, actualJobDir, plan.jobDir);
    removedDirectories = dirs.removed;
    directoryFailures = dirs.failures;
    const externalDirs = await removeGeneratedEmptyDirectories(plan, stateRoot);
    removedDirectories.push(...externalDirs.removed);
    preservedDirectories = externalDirs.preserved;
    directoryFailures.push(...externalDirs.failures);
    warnings = externalDirs.warnings;
  }
  const complete = errors.length === 0 && directoryFailures.length === 0;
  if (complete) {
    await fs.unlink(storage.file).catch(error => { if (!isMissing(error)) throw error; });
    await fs.rmdir(storage.directory).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
  }
  return { jobId: plan.jobId, planToken, complete, deleted, missing, removedDirectories, preservedDirectories, warnings, errors, directoryFailures, planFile: complete ? null : storage.file };
}
