import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readJsonStrict, serialize, sha256, writeIfChanged } from './fsx.mjs';

export const CURRENT_FILE = '.current.json';
export const GENERATIONS_DIR = '.generations';
export const STAGING_PREFIX = '.staging-';

const CURRENT_RE = /^[A-Za-z0-9_.-]{1,120}$/;

function pointerError(message, code = 'GENERATION_POINTER_INVALID') {
  return Object.assign(new Error(message), { code });
}

function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realSync(target) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target);
  } catch {
    return target;
  }
}

function nearestReal(target) {
  let probe = path.resolve(target);
  const tail = [];
  for (;;) {
    try { return path.resolve(fs.realpathSync(probe), ...tail); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      tail.unshift(path.basename(probe)); probe = parent;
    }
  }
}

/** 读写均核对真实目录祖先，不能通过根内子目录联接越出学习根。 */
export function layerPath(root, rel) {
  const base = path.resolve(root), target = path.resolve(base, rel);
  if (!inside(base, target)) throw pointerError('学习层路径越界', 'GENERATION_PATH_ESCAPE');
  const realRoot = nearestReal(base), realTarget = nearestReal(target);
  if (!inside(realRoot, realTarget)) throw pointerError('学习层文件或子目录联接越界', 'GENERATION_PATH_ESCAPE');
  return realTarget;
}

export function generationPath(root, generation) {
  const id = String(generation || '');
  if (!CURRENT_RE.test(id) || id === '.' || id === '..') throw pointerError(`代际标识不合法：${generation}`);
  const base = path.resolve(root, GENERATIONS_DIR);
  const target = path.resolve(base, id);
  if (!inside(base, target) || path.dirname(target) !== base) {
    throw pointerError(`代际标识越界：${generation}`, 'GENERATION_PATH_ESCAPE');
  }
  // 已存在的代际目录必须解析后仍在学习根内，防止 .generations/foo 被目录联接指到外部。
  const realRoot = realSync(path.resolve(root));
  const realBase = realSync(base);
  let baseExists = false;
  try { fs.accessSync(base); baseExists = true; } catch { /* 首次构建 */ }
  if (baseExists && !inside(realRoot, realBase)) {
    throw pointerError(`代际根目录越过学习根：${base}`, 'GENERATION_PATH_ESCAPE');
  }
  let targetExists = false;
  try { fs.accessSync(target); targetExists = true; } catch { /* 尚未发布 */ }
  if (targetExists && !inside(realRoot, realSync(target))) {
    throw pointerError(`代际目录越过学习根：${target}`, 'GENERATION_PATH_ESCAPE');
  }
  return target;
}

function parsePointer(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw pointerError(`当前代指针损坏：${CURRENT_FILE}`);
  }
  if (!value || value.version !== 1 || !CURRENT_RE.test(String(value.generation || ''))) {
    throw pointerError(`当前代指针格式不合法：${CURRENT_FILE}`);
  }
  return value.generation;
}

/** 同步读取当前代指针；不存在返回 null（兼容旧版直接在根目录发布的布局）。 */
export function currentGenerationSync(root) {
  const file = layerPath(root, CURRENT_FILE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw pointerError(`无法读取当前代指针：${path.basename(file)}`, 'GENERATION_POINTER_IO');
  }
  return parsePointer(text);
}

export async function currentGeneration(root) {
  const file = layerPath(root, CURRENT_FILE);
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw pointerError(`无法读取当前代指针：${path.basename(file)}`, 'GENERATION_POINTER_IO');
  }
  return parsePointer(text);
}

/** 读端优先认指针；指针存在但目标缺失时明确失败，不能静默退回旧根目录。 */
export async function currentRoot(root) {
  const generation = await currentGeneration(root);
  if (!generation) return root;
  const dir = generationPath(root, generation);
  try {
    await fsp.access(layerPath(dir, 'manifest.json'));
  } catch {
    throw pointerError(`当前代目录缺少 manifest：${dir}`, 'GENERATION_MISSING');
  }
  return dir;
}

export function currentRootSync(root) {
  const generation = currentGenerationSync(root);
  if (!generation) return root;
  const dir = generationPath(root, generation);
  try {
    fs.accessSync(layerPath(dir, 'manifest.json'));
  } catch {
    throw pointerError(`当前代目录缺少 manifest：${dir}`, 'GENERATION_MISSING');
  }
  return dir;
}

/**
 * 读当前代清单。
 * 指针存在、但那一代没有 manifest，是**损坏**而不是「还没有构建」（审计 P2）。
 * 旧版这里用 optional 读，于是返回 null，build 就把 previousManifest 当成不存在，
 * 幂等检查静默退化成 N/A —— 写侧看不见问题，只有开面板的人才撞到 GENERATION_MISSING，
 * 而面板报错通常被当成面板自己的毛病。写侧应当先失败。
 */
export async function currentManifest(root) {
  const generation = await currentGeneration(root);
  const dir = generation ? generationPath(root, generation) : path.resolve(root);
  const manifest = await readJsonStrict(layerPath(dir, 'manifest.json'), { optional: true });
  if (generation && !manifest) {
    throw pointerError(`当前代目录缺少 manifest：${path.basename(dir)}`, 'GENERATION_MISSING');
  }
  return manifest;
}

export async function currentSnapshot(root) {
  const generation = await currentGeneration(root);
  const dir = generation ? generationPath(root, generation) : path.resolve(root);
  const manifest = await readJsonStrict(layerPath(dir, 'manifest.json'), { optional: true });
  if (generation && !manifest) {
    throw pointerError(`当前代目录缺少 manifest：${dir}`, 'GENERATION_MISSING');
  }
  return { generation: generation || '', root: dir, manifest };
}

export function currentManifestSync(root) {
  const dir = currentRootSync(root);
  try {
    return JSON.parse(fs.readFileSync(layerPath(dir, 'manifest.json'), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw pointerError(`当前代 manifest 损坏：${path.join(dir, 'manifest.json')}`);
  }
}

/** 只读一次指针，随后用同一 root 读取清单，避免指针在两次读取之间切换。 */
export function currentSnapshotSync(root) {
  const generation = currentGenerationSync(root);
  const dir = generation ? generationPath(root, generation) : path.resolve(root);
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(layerPath(dir, 'manifest.json'), 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw pointerError(`当前代 manifest 损坏：${path.join(dir, 'manifest.json')}`);
    }
  }
  if (generation && !manifest) {
    throw pointerError(`当前代目录缺少 manifest：${dir}`, 'GENERATION_MISSING');
  }
  return { generation: generation || '', root: dir, manifest };
}

export async function createStaging(root) {
  await fsp.mkdir(root, { recursive: true });
  return fsp.mkdtemp(path.join(root, STAGING_PREFIX));
}

function safeRel(rel) {
  const clean = String(rel || '').replace(/\\/g, '/');
  return clean && !clean.includes('..') && !clean.startsWith('/') && !path.isAbsolute(clean) ? clean : '';
}

/**
 * 首次从旧版根目录迁移：先把旧清单列出的完整结果复制成固定代，写指针，之后才允许覆盖根目录。
 * 如果旧清单缺文件，明确报 LEGACY_INCOMPLETE，不能假装旧结果完整。
 */
export async function ensureLegacySnapshot(root) {
  const existing = await currentGeneration(root);
  if (existing) return { created: false, generation: existing };
  const manifest = await readJsonStrict(path.join(root, 'manifest.json'), { optional: true });
  if (!manifest) return { created: false, generation: null };
  const rows = [...(manifest.outputs?.content || []), ...(manifest.outputs?.state || []), 'manifest.json'];
  const files = [...new Set(rows.map(safeRel).filter(Boolean))];
  const missing = [];
  for (const rel of files) {
    const source = layerPath(root, rel);
    try { await fsp.access(source); } catch { missing.push(rel); }
  }
  if (missing.length) {
    throw pointerError(`旧版学习层清单不完整，拒绝原地迁移；缺少：${missing.slice(0, 8).join(', ')}`, 'LEGACY_INCOMPLETE');
  }
  const generation = `legacy-${sha256(`${manifest.contentHash || ''}|${manifest.generatedAt || ''}|${files.join(',')}`).slice(0, 16)}`;
  const target = generationPath(root, generation);
  await fsp.mkdir(target, { recursive: true });
  for (const rel of files) {
    const source = layerPath(root, rel);
    const dest = path.join(target, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(source, dest);
  }
  await writeIfChanged(layerPath(root, CURRENT_FILE), serialize({ version: 1, generation }));
  return { created: true, generation, target };
}

export async function hasLegacyContent(root) {
  const manifest = await readJsonStrict(path.join(root, 'manifest.json'), { optional: true });
  if (manifest) return true;
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    return entries.some(entry => ['papers', 'indices', 'map', 'exam', 'gaps', 'commonsense', 'dashboard.json', 'index.html'].includes(entry.name));
  } catch {
    return false;
  }
}

/**
 * 把已完整写入 staging 的一代移动到 generations/<id>，然后逐文件发布到根目录兼容视图，
 * 最后原子替换 .current.json。指针写成功之前，读端仍只看上一代。
 * staging 必须与学习根同一磁盘，rename 才是原子的。
 */
export async function publishGeneration(root, staging, { generation, files }) {
  if (!CURRENT_RE.test(String(generation || ''))) throw pointerError(`代际标识不合法：${generation}`);
  const target = generationPath(root, generation);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.rename(staging, target);
  const written = [];
  const unchanged = [];
  try {
    for (const rel of [...files, CURRENT_FILE]) layerPath(root, rel);
    for (const rel of files) {
      const text = await fsp.readFile(path.join(target, rel), 'utf8');
      const result = await writeIfChanged(layerPath(root, rel), text);
      (result.changed ? written : unchanged).push(rel);
    }
    // 指针文件也要过 layerPath：它同样在根目录，同样可能被目录联接带到根外（审计 #18）。
    await writeIfChanged(layerPath(root, CURRENT_FILE), serialize({ version: 1, generation }));
  } catch (error) {
    error.generation = generation;
    error.generationDir = target;
    throw error;
  }
  return { target, written: written.sort(), unchanged: unchanged.sort() };
}

/** 清理失败留下的 staging；已发布代不在这里删。 */
export async function discardStaging(staging) {
  if (!staging) return;
  try { await fsp.rm(staging, { recursive: true, force: true }); } catch { /* 下次启动再清 */ }
}

async function dirSize(target) {
  let total = 0;
  let entries = [];
  try { entries = await fsp.readdir(target, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    try {
      if (entry.isDirectory()) total += await dirSize(full);
      else total += (await fsp.stat(full)).size;
    } catch { /* 读不到就不计 */ }
  }
  return total;
}

/** 从 `g-<epochMs>-<rand>` 里取时间戳；取不到就退到 0（排最后，不会被优先保留）。 */
function epochOf(name) {
  const m = /^g-(\d{10,16})-/.exec(name);
  return m ? Number(m[1]) : 0;
}

/**
 * 代际回收（审计 #7）。
 *
 * 每次重建都多一代，旧代只在回滚时有用；留太多纯占磁盘
 * （实测 15 代 17MB，且每开一次面板都在涨）。
 * 规则：保留当前代 + 最近 keep 代，其余删除。当前代永远不删。
 * 只在 build 的写锁内调用，避免和别的构建抢同一批目录。
 *
 * 两条不可越过的豁免（QA 拦截，必须先于任何真实构建修好）：
 *   1. `legacy-*` 是代际系统重写之前的原始快照，是唯一的回滚目标，永久保留。
 *      它匹配 CURRENT_RE，旧实现会把它当普通旧代删掉——不可逆。
 *   2. 排序按 id 里的 epoch，不按 mtime：备份工具、杀软、同步盘随便 touch 一下，
 *      mtime 顺序就翻，保留下来的会变成「随机两代」而不是「最近两代」。
 */
export async function reclaimGenerations(root, { keep = 2 } = {}) {
  const dir = path.join(root, GENERATIONS_DIR);
  const current = await currentGeneration(root);
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch {
    return { removed: [], kept: 0, freedBytes: 0 };
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!CURRENT_RE.test(entry.name)) continue;
    if (entry.name === current) continue;
    // 永久豁免：代际系统之前的原始快照，删了就没有回滚目标了。
    if (entry.name.startsWith('legacy-')) continue;
    const full = path.join(dir, entry.name);
    try {
      candidates.push({ name: entry.name, full, epoch: epochOf(entry.name), size: await dirSize(full) });
    } catch { /* 已经没了 */ }
  }
  // 按名字里的 epoch 排，mtime 只作兜底：目录被 touch 过也不影响「哪一代更新」。
  candidates.sort((a, b) => b.epoch - a.epoch);
  const removed = [];
  let freedBytes = 0;
  for (const item of candidates.slice(keep)) {
    // 删之前再核一遍：必须仍在 generations 之内，且不是当前代/legacy
    if (!inside(dir, item.full) || item.name === current) continue;
    if (item.name.startsWith('legacy-')) continue;
    try {
      await fsp.rm(item.full, { recursive: true, force: true });
      removed.push(item.name);
      freedBytes += item.size;
    } catch { /* 下次再清 */ }
  }
  return { removed, kept: Math.min(candidates.length, keep) + (current ? 1 : 0), freedBytes };
}
