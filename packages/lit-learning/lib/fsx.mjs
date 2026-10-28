import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const LF = '\n';

/**
 * 抽取文件里的列表字段并不总是数组：有的论文写成了整段字符串。
 * 这里统一成数组，避免下游 `for...of` 把字符串按字符拆开、或 `.map` 直接崩。
 */
export function asList(value) {
  if (Array.isArray(value)) return value.filter(item => item !== null && item !== undefined && item !== '');
  const text = String(value ?? '').trim();
  if (!text) return [];
  const parts = text.split(/\r?\n|[；;]/).map(item => item.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [text];
}


export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function readText(file, fallback = '') {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return fallback;
  }
}

function ioFailure(file, error, code) {
  const detail = error?.code ? `（${error.code}）` : '';
  // 错误信息里只放文件名：这些文案会进日志、进面板、被截图发给别人，
  // 没必要把完整目录结构一起带出去（安全审计 #18）。完整路径留在 error.path 里给程序用。
  return Object.assign(new Error(`无法读取 ${path.basename(file)}${detail}`), {
    code: code || error?.code || 'IO_ERROR',
    path: file,
    cause: error,
  });
}

/**
 * 严格读取：只有「文件不存在」可以按 optional 回落；JSON 损坏、权限、IO 错误必须抛出。
 * 旧 readJson 保留给上游兼容适配，但学习层自己的状态/清单/输入预检走这里。
 */
export async function readJsonStrict(file, { optional = false } = {}) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    throw ioFailure(file, error);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw Object.assign(new Error(`JSON 损坏：${path.basename(file)}`),
      { code: 'JSON_INVALID', path: file, cause: error });
  }
}

export async function readTextStrict(file, { optional = false } = {}) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    throw ioFailure(file, error);
  }
}

export function existsSync(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

export function serialize(value) {
  return JSON.stringify(value, null, 2).replace(/\r\n/g, '\n') + LF;
}

/**
 * 原子写：先写同目录临时文件再 rename。
 * 内容相同则完全不落盘，返回 changed=false —— 这是「重复运行不产生重复内容」的实现点。
 */
export async function writeIfChanged(file, text) {
  const normalized = String(text).replace(/\r\n/g, '\n');
  const previous = await readTextStrict(file, { optional: true });
  if (previous === normalized) return { file, changed: false, bytes: Buffer.byteLength(normalized) };
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fsp.writeFile(temp, normalized, 'utf8');
    await fsp.rename(temp, file);
  } catch (error) {
    try { await fsp.rm(temp, { force: true }); } catch { /* 保留原始错误 */ }
    throw error;
  }
  return { file, changed: true, bytes: Buffer.byteLength(normalized) };
}

export async function writeJson(file, value) {
  return writeIfChanged(file, serialize(value));
}

export async function removeIfExists(target) {
  await fsp.rm(target, { recursive: true, force: true });
}

export async function listDirs(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => path.join(dir, e.name)).sort();
  } catch {
    return [];
  }
}

/** 输入预检用：目录不存在可以是空库，权限/IO 错误不能伪装成空库。 */
export async function listDirsStrict(dir, { optional = true } = {}) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => path.join(dir, e.name)).sort();
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return [];
    throw ioFailure(dir, error);
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

/**
 * 跨进程文件锁。只有确认锁里的进程已不存在才回收；不按时间擅自删除活跃锁。
 * 锁内容写 pid 与 token，释放时核对 token，避免删掉后来者的锁。
 */
export async function withFileLock(file, fn, { timeoutMs = 30000, pollMs = 20, samePid = 'wait' } = {}) {
  const lock = `${file}.lock`;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await fsp.mkdir(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + Math.max(100, Number(timeoutMs) || 30000);
  let handle;
  while (!handle) {
    try {
      handle = await fsp.open(lock, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }), 'utf8');
    } catch (error) {
      if (handle) {
        try { await handle.close(); } catch { /* 关闭失败不覆盖原始错误 */ }
        handle = null;
      }
      if (error?.code !== 'EEXIST') throw error;
      let owner = null;
      try {
        owner = JSON.parse(await fsp.readFile(lock, 'utf8'));
      } catch {
        owner = null;
      }
      if (owner && !pidAlive(Number(owner.pid))) {
        // 不自动回收：两个回收者可能读同一个死 pid，其中一个删除另一方刚建的新锁。
        // 明确报错，让用户确认没有活跃构建后手动移除锁。
        throw Object.assign(new Error(`锁的持有进程已不存在：${lock}（pid ${owner.pid}）。请确认没有活跃构建后手动删除该锁再重试。`), {
          code: 'LOCK_OWNER_DEAD',
          owner,
          lock,
        });
      }
      if (owner && Number(owner.pid) === process.pid && samePid === 'fail') {
        throw Object.assign(new Error(`同一进程已有构建/写入持锁：${lock}`), { code: 'BUILD_LOCKED', owner });
      }
      if (!owner) {
        // 锁文件可能正在被创建。只等待，不按时间删除它。
        if (Date.now() >= deadline) throw Object.assign(new Error(`构建锁不可读且等待超时：${lock}`), { code: 'LOCK_UNREADABLE' });
      } else if (Date.now() >= deadline) {
        throw Object.assign(new Error(`另一个进程正在构建（pid ${owner.pid}）：${lock}`), { code: 'BUILD_LOCKED', owner });
      }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  }
  try {
    return await fn();
  } finally {
    try { await handle.close(); } catch { /* 已关闭 */ }
    try {
      const current = JSON.parse(await fsp.readFile(lock, 'utf8'));
      if (current?.token === token) await fsp.rm(lock, { force: true });
    } catch { /* 锁已被回收或损坏；不误删他锁 */ }
  }
}

export async function walkFiles(dir, accept = () => true, depth = 0) {
  const out = [];
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < 4) out.push(...(await walkFiles(full, accept, depth + 1)));
    } else if (accept(full)) {
      out.push(full);
    }
  }
  return out;
}

/** 段落切分：空行分段。用于把证据原文定位到「第几段」。 */
export function splitSegments(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map(s => s.trim())
    .filter(Boolean);
}

/** 在正文里找引用原文，返回段号（1 起）与偏移；找不到返回 null。 */
export function locateQuote(segments, quote) {
  const needle = String(quote || '').trim();
  if (!needle) return null;
  const compact = s => s.replace(/\s+/g, '');
  const target = compact(needle);
  for (let i = 0; i < segments.length; i++) {
    if (compact(segments[i]).includes(target)) {
      return { segment: i + 1, offset: compact(segments[i]).indexOf(target) };
    }
  }
  return null;
}

export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

/** 中文字数友好的截断：按码点，不切半个字。 */
export function truncate(text, max) {
  const chars = [...String(text || '')];
  if (chars.length <= max) return String(text || '');
  return chars.slice(0, max).join('') + '…';
}

export function oneLine(text, max = 120) {
  return truncate(String(text || '').replace(/\s+/g, ' ').trim(), max);
}
