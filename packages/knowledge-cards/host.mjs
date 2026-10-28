import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

export const NATIVE_API = '/api/knowledgeCards';

// 导出给测试用（buildMap / cardRefs / parseCite 都是纯读，不碰写入路径）
export { buildMap, cardRefs, parseCite, parseFront, rewriteRefs };
const DEFAULT_HOME = path.join(os.homedir(), 'Desktop', '知识卡片库');
// 可变：apply() 里 config.home 通过 setHome() 改这里，而不是去改 process.env。
// 改 env 是全局副作用——同一进程里别的插件会跟着变（审计 #15）。
let HOME = process.env.DSH_CARDS_HOME || DEFAULT_HOME;
let CARDS = path.join(HOME, 'cards');

/** 卡片库路径的唯一写入口：只接受绝对路径，且不碰 process.env。 */
export function setHome(next) {
  const value = String(next ?? '').trim();
  if (!value) return HOME;
  if (!path.isAbsolute(value)) throw Error('卡片库路径必须是绝对路径：' + value);
  HOME = value;
  CARDS = path.join(HOME, 'cards');
  return HOME;
}

// ─────────────────────────────────────────────────────────────
// 卡片 id 与路径安全（审计 #2 / #14）
// id 会被拼进 rendered/*.html 的路径，必须白名单，不能让 ../../ 溜出去。
// ─────────────────────────────────────────────────────────────
const ID_RE = /^[A-Za-z]{1,2}-\d{3,5}$/;

export function assertCardId(raw) {
  const id = String(raw ?? '').trim();
  if (!id) throw Error('缺少卡片编号');
  if (!ID_RE.test(id)) throw Error(`卡片编号不合法：${id}（应形如 T-0001）`);
  return id;
}

/** 同一编号出现在多个书架时不许静默取第一条，否则会改错卡（审计 #14）。 */
function pickCard(cards, rawId) {
  const id = assertCardId(rawId);
  const hits = cards.filter(c => c.id.toLowerCase() === id.toLowerCase());
  if (!hits.length) throw Error('找不到这张卡：' + id);
  if (hits.length > 1) {
    throw Error(`编号 ${id} 对应 ${hits.length} 张卡（${hits.map(h => h.path).join('、')}），先消除重复编号`);
  }
  return hits[0];
}

/** front-matter 字段值：不许带换行与控制字符，否则能注入顶层键改写 id/title（审计 #4）。 */
function fieldValue(v) {
  const text = String(v ?? '');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) throw Error('字段里不能包含换行或控制字符');
  return text;
}

/** 先写同目录临时文件再 rename：写一半断电也不会留下半张卡（审计 #8 / QA P0）。 */
async function atomicWrite(file, text) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, text, 'utf8');
  try {
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

async function backupCard(file, raw) {
  const bak = path.join(HOME, '.kcard', 'backups');
  await fs.mkdir(bak, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(bak, path.basename(file) + '.' + stamp + '.bak');
  await fs.writeFile(target, raw, 'utf8');
  return target;
}

/**
 * 库状态：路径不存在 / 目录在但没卡 / 正常，三种要能分开报（审计 #3）。
 * 绝不在这里建目录——建了就变成「空库也是正常状态」，事故会被伪装成正常。
 */
export async function libraryState(home = HOME) {
  const cardsDir = path.join(home, 'cards');
  const exists = fsSync.existsSync(home);
  if (!exists) return { home, state: 'missing', count: 0, hint: `找不到卡片库：${home}` };
  let count = 0;
  try {
    count = (await walkCards(cardsDir, [])).length;
  } catch {
    return { home, state: 'empty', count: 0, hint: `卡片目录读不出来：${cardsDir}` };
  }
  if (!count) {
    return {
      home, state: 'empty', count: 0,
      hint: `这个目录里一张卡都没有：${cardsDir}。如果是刚搬过库，请把 DSH_CARDS_HOME 指到真正的库，别在这里新建。`,
    };
  }
  return { home, state: 'ok', count, hint: '' };
}

/** 顺带看一眼其它位置有没有库，只用于提示，不自动切换（审计 #1）。 */
export async function otherLibraries(home = HOME) {
  const candidates = [
    process.env.DSH_CARDS_HOME_ALT,
    path.join(os.homedir(), 'Desktop', '知识卡片库'),
    path.join(os.homedir(), 'Documents', '知识卡片库'),
  ].filter(Boolean);
  const out = [];
  for (const candidate of new Set(candidates)) {
    if (path.resolve(candidate) === path.resolve(home)) continue;
    try {
      const count = (await walkCards(path.join(candidate, 'cards'), [])).length;
      if (count) out.push({ home: candidate, count });
    } catch { /* 没有就算了 */ }
  }
  return out;
}

/**
 * 库身份（评审 P0 #3）：用户唯一想知道的三件事——我的卡在哪、还剩几张、是不是这一版。
 * catalog.json 与磁盘实际数量对不上时要明说，因为这正是「以为丢了」的现场。
 */
export async function libraryIdentity(cards, home = HOME) {
  const catalogPath = path.join(home, 'catalog.json');
  let declared = null;
  let catalogError = '';
  try {
    const raw = await fs.readFile(catalogPath, 'utf8');
    const parsed = JSON.parse(raw);
    declared = Array.isArray(parsed?.cards) ? parsed.cards.length
      : (Number.isFinite(Number(parsed?.count)) ? Number(parsed.count) : null);
  } catch (e) {
    catalogError = e?.code === 'ENOENT' ? '没有 catalog.json' : fail(e);
  }
  const onDisk = cards.length;
  // catalog 里记着、磁盘上已经没有的卡——这是「数据看起来丢了」的直接证据
  const dangling = [];
  try {
    const raw = await fs.readFile(catalogPath, 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.cards) ? parsed.cards : [];
    for (const entry of list) {
      const p = entry?.path;
      if (p && !fsSync.existsSync(p)) dangling.push({ id: entry?.id || '', path: p });
    }
  } catch { /* 上面已经报过 catalog 的问题 */ }
  return {
    home,
    cardsOnDisk: onDisk,
    catalogDeclared: declared,
    catalogError,
    dangling: dangling.slice(0, 20),
    danglingCount: dangling.length,
    consistent: declared === null ? onDisk > 0 : declared === onDisk && !dangling.length,
  };
}

const BUILD_ID = `kc-${Date.now().toString(36)}`;

const SKILL = path.join(os.homedir(), '.dsh', 'skills', 'knowledge-card-library', 'scripts');
const PY = process.env.DSH_PYTHON
  || (process.platform === 'win32' ? 'python' : 'python3');

const GRAPH_3D = '关系网-3D.html';
const GRAPH_2D = '关系网.html';

const json = (v, status = 200) => new Response(JSON.stringify(v ?? null),
  { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = e => String(e?.message || e).slice(0, 600);

function scalar(v) {
  v = String(v).trim();
  if (/^\[.*\]$/.test(v)) {
    try { return JSON.parse(v); } catch {
      return v.slice(1, -1).split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
    }
  }
  return v.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
}

// 块状结构：`  - k: v` 是对象列表，`  k: v` 是嵌套对象，`  - v` 是标量列表。
// 老版本只认顶层的 key: value，导致 first_source / sources / refs 整段被丢掉。
function parseBlock(lines) {
  if (!lines.length) return [];
  if (!lines[0].trim().startsWith('-')) {
    const obj = {};
    for (const l of lines) {
      const kv = /^\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(l);
      if (kv) obj[kv[1]] = scalar(kv[2]);
    }
    return obj;
  }
  const items = [];
  let cur = null;
  for (const l of lines) {
    const t = l.trim();
    if (t.startsWith('- ')) {
      const inner = t.slice(2).trim();
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(inner);
      if (kv) { cur = { [kv[1]]: scalar(kv[2]) }; items.push(cur); }
      else { cur = null; items.push(scalar(inner)); }
    } else if (cur && typeof cur === 'object') {
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(t);
      if (kv) cur[kv[1]] = scalar(kv[2]);
    }
  }
  return items;
}

function parseFront(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { fm: {}, body: text };
  const lines = m[1].split(/\r?\n/);
  const fm = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) { i++; continue; }
    const top = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!top) { i++; continue; }
    const key = top[1];
    const rest = top[2].trim();
    if (rest !== '') { fm[key] = scalar(rest); i++; continue; }
    const block = [];
    i++;
    while (i < lines.length && (!lines[i].trim() || /^\s+/.test(lines[i]))) {
      if (lines[i].trim()) block.push(lines[i]);
      i++;
    }
    fm[key] = parseBlock(block);
  }
  return { fm, body: m[2] || '' };
}

// 卡片按书架分目录存放（cards/<书架>/<id>-<slug>.md），所以必须递归找；
// 同时兼容旧的扁平结构（cards/*.md）。
// relations 是块状列表，逐行解析拿不到条数，单独数一遍
function countRelations(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) return 0;
  const at = m[1].search(/^relations:/m);
  if (at < 0) return 0;
  return (m[1].slice(at).match(/^\s*-\s*type:/gm) || []).length;
}

async function walkCards(dir, out, depth = 0) {
  let entries = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < 2) await walkCards(p, out, depth + 1);
    } else if (e.name.endsWith('.md')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 坏文件不再静默跳过：解析失败的 md 要报出来（审计 #3 / #10）。
 * 静默跳过会让「23 张卡里有 3 张读不出来」表现成「只剩 20 张」，看起来像丢数据。
 * @param {Array} broken 传入数组则把坏文件塞进去，供 /list 展示
 */
async function listCards(broken = []) {
  // 这里不再 mkdir：路径不对时应该报错，而不是凭空造一个空库出来（审计 #2）。
  if (!fsSync.existsSync(CARDS)) return [];
  const files = await walkCards(CARDS, []);
  const out = [];
  for (const p of files) {
    try {
      const raw = await fs.readFile(p, 'utf8');
      const { fm } = parseFront(raw);
      if (!fm || typeof fm !== 'object') throw Error('front-matter 解析结果为空');
      const dirShelf = path.dirname(p) === path.resolve(CARDS) ? '' : path.basename(path.dirname(p));
      out.push({
        id: fm.id || path.basename(p, '.md'),
        title_zh: fm.title_zh || '',
        title_en: fm.title_en || '',
        type: fm.type || 'theory',
        shelf: String(fm.shelf || dirShelf || '未归类'),
        status: fm.status || 'draft',
        confidence: fm.confidence || '',
        school: fm.school || '',
        tags: Array.isArray(fm.tags) ? fm.tags : [],
        relations: countRelations(raw),
        path: p,
        mtime: (await fs.stat(p)).mtimeMs,
      });
    } catch (e) {
      broken.push({ path: p, error: fail(e) });
    }
  }
  // 编号重复要在列表层就暴露：编号是写路由的唯一钥匙，重号等于写错卡。
  const seen = new Map();
  for (const card of out) {
    const key = String(card.id).toLowerCase();
    if (!seen.has(key)) { seen.set(key, []); }
    seen.get(key).push(card);
  }
  for (const [, group] of seen) {
    if (group.length > 1) {
      for (const card of group) card.duplicateId = group.length;
    }
  }
  return out.sort((a, b) => String(a.shelf).localeCompare(String(b.shelf), 'zh')
    || String(a.id).localeCompare(String(b.id)));
}

function run(script, args) {
  return new Promise(resolve => {
    // 必须把 HOME 显式传给 Python（审计 #2）。
    // 旧版不传 env，于是面板读 DSH_CARDS_HOME 指向的库，
    // 而 kcard.py 仍按自己的 KCARD_HOME 默认值往 ~/Desktop 写 catalog.json——
    // 两个进程各写各的，用户看到的就是「卡片库分叉了」。
    const env = { ...process.env, KCARD_HOME: HOME, DSH_CARDS_HOME: HOME };
    const p = spawn(PY, [path.join(SKILL, script), ...args], { windowsHide: true, env });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d.toString(); });
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('close', code => resolve({ code, out, err }));
    p.on('error', e => resolve({ code: -1, out, err: String(e) }));
  });
}

async function readIfSmall(p, limit = 3 * 1024 * 1024) {
  try {
    const st = await fs.stat(p);
    if (st.size > limit) return '';
    return await fs.readFile(p, 'utf8');
  } catch { return ''; }
}

// ========== 卡片 ↔ 文献 映射 ==========
// 文献身份不靠标题（同名不同文、同文不同译名都会认错），靠「第一作者姓 + 年份」：
// 这在经济学文献里唯一性足够，而且和用户的目录命名（Arora_2023_阅读成果）天然对齐。
const LIT_HOME = process.env.DSH_LIT_HOME || path.join(os.homedir(), 'Desktop', '文献积累阅读');
const REF_ROLES = ['提出', '引用', '应用', '检验', '反驳', '扩展'];

const tidy = s => String(s || '').replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, '').trim();

function slugify(s) {
  const base = String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return base || 'anon';
}

// 「Cohen, W. M., & Levinthal, D. A. (1990). Absorptive capacity: …」
//   → { key: 'Cohen_1990', author: 'Cohen', year: '1990', title: 'Absorptive capacity: …' }
function citeTitle(s) {
  const m = /[（(]\d{4}[a-z]?[）)]\s*[.．]\s*([\s\S]+)$/.exec(s);
  if (!m) return '';
  let t = m[1];
  const cut = t.search(/[.．]\s+[A-Z]/);      // 标题后面接期刊名/出版社，这里断开
  if (cut > 0) t = t.slice(0, cut);
  t = t.replace(/^\*|\*$/g, '').replace(/[.．]$/, '').trim();
  return t.length > 150 ? t.slice(0, 150) + '…' : t;
}

function parseCite(citation) {
  const s = tidy(citation);
  if (!s) return null;
  const ym = /[（(](\d{4})[a-z]?[）)]/.exec(s);
  if (!ym) return null;
  const year = ym[1];
  const head = s.slice(0, ym.index).replace(/[,，&;；]\s*$/, '').trim();
  let author = head.split(/[,，]/)[0].trim();
  author = author.replace(/\s+et\s+al\.?$/i, '').replace(/[.。]+$/, '').trim();
  if (!author) return null;
  return { key: slugify(author) + '_' + year, author, year, title: citeTitle(s), citation: s };
}

// 一张卡挂了哪些文献：正文里的 sources / first_source 自动认，refs 手工覆盖，refs_drop 手工剔除
function cardRefs(fm) {
  const out = new Map();
  const put = (key, patch) => {
    const prev = out.get(key) || {
      key, role: '引用', locator: '', title: '', citation: '', author: '', year: '', from: 'source',
    };
    out.set(key, { ...prev, ...patch });
  };

  const first = fm.first_source && typeof fm.first_source === 'object' && !Array.isArray(fm.first_source)
    ? fm.first_source : null;
  const sources = Array.isArray(fm.sources) ? fm.sources.filter(s => s && typeof s === 'object') : [];
  const list = (first && first.citation ? [{ ...first, role: first.role || '提出' }] : []).concat(sources);

  for (const s of list) {
    const c = parseCite(s.citation);
    if (!c) continue;
    put(c.key, {
      role: String(s.role || '').trim() || '引用',
      locator: String(s.locator || '').trim(),
      title: c.title, citation: c.citation, author: c.author, year: c.year,
    });
  }

  // 手工剔除：只对自动推断生效（手写的 refs 优先级更高）
  if (Array.isArray(fm.refs_drop)) {
    for (const k of fm.refs_drop.map(String)) out.delete(k);
  }

  if (Array.isArray(fm.refs)) {
    for (const r of fm.refs) {
      if (!r || typeof r !== 'object' || !r.key) continue;
      const key = String(r.key).trim();
      const prev = out.get(key) || {};
      put(key, {
        role: String(r.role || '').trim() || prev.role || '引用',
        locator: String(r.locator || '').trim() || prev.locator || '',
        title: String(r.title || '').trim() || prev.title || '',
        citation: prev.citation || '',
        author: prev.author || key.replace(/_\d{4}$/, '').replace(/-/g, ' '),
        year: prev.year || (key.match(/_(\d{4})$/) || [])[1] || '',
        from: 'manual',
      });
    }
  }

  // 卡自己的出处（提出）排最前，其余按年份倒序
  const rank = r => (r === '提出' || r === '产出' ? 0 : 1);
  return [...out.values()].sort((a, b) => (rank(a.role) - rank(b.role))
    || String(b.year).localeCompare(String(a.year))
    || String(a.key).localeCompare(String(b.key)));
}

// 有阅读成果的文献：桌面/文献积累阅读/<作者>_<年份>_阅读成果/
// 注意：这只说明「有产出目录」，不代表用户读过；所以字段叫 hasReading，不叫 read。
async function scanReadPapers() {
  const out = new Map();
  let entries = [];
  try { entries = await fs.readdir(LIT_HOME, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || !/_阅读成果$/.test(e.name)) continue;
    const dir = path.join(LIT_HOME, e.name);
    const key = e.name.replace(/_阅读成果$/, '');
    const km = /^(.+?)_(\d{4})$/.exec(key);
    const author = km ? km[1].replace(/-/g, ' ') : key;
    const year = km ? km[2] : '';
    let title = '';
    const nav = await readIfSmall(path.join(dir, '00_先读这一页.md'), 200 * 1024);
    const q = /《([^》]{2,160})》/.exec(nav);
    if (q) title = q[1];
    if (!title) {
      const table = await readIfSmall(path.join(dir, '01_文献阅读表_1-15.md'), 600 * 1024);
      const apa = /##\s*3[.．、][^\n]*\n+([^\n]+)/.exec(table);
      if (apa) { const c = parseCite(apa[1]); if (c) title = c.title; }
    }
    const files = (await fs.readdir(dir).catch(() => []))
      .filter(f => /\.(md|html|pdf)$/i.test(f));
    // 制卡报告里点名了哪些卡——这是「本文产出了哪些卡」的权威记录
    const report = await readIfSmall(path.join(dir, '04_知识卡片', '制卡报告.md'), 300 * 1024);
    const made = [...new Set((report.match(/[TME]-\d{4}/g) || []))];
    out.set(key, {
      key, author, year, title, dir, hasReading: true, files, made,
      cards: [], citation: '',
    });
  }
  return out;
}

async function buildMap() {
  const cards = await listCards();
  const detailed = [];
  for (const c of cards) {
    const raw = await readIfSmall(c.path, 600 * 1024);
    const { fm } = parseFront(raw);
    detailed.push({
      id: c.id, title: c.title_zh, title_en: c.title_en, shelf: c.shelf,
      type: c.type, status: c.status, refs: cardRefs(fm),
      drops: Array.isArray(fm.refs_drop) ? fm.refs_drop.map(String) : [],
    });
  }

  const papers = await scanReadPapers();

  // 被引用但还没读过的文献，从卡片的引用里长出来
  for (const c of detailed) {
    for (const r of c.refs) {
      if (!papers.has(r.key)) {
        papers.set(r.key, {
          key: r.key, author: r.author || r.key.replace(/_\d{4}$/, '').replace(/-/g, ' '),
          year: r.year || (r.key.match(/_(\d{4})$/) || [])[1] || '',
          title: r.title || '', dir: '', hasReading: false, files: [], made: [],
          cards: [], citation: r.citation || '',
        });
      }
      const p = papers.get(r.key);
      if (!p.title && r.title) p.title = r.title;
      if (!p.citation && r.citation) p.citation = r.citation;
      p.cards.push({
        id: c.id, title: c.title, shelf: c.shelf, type: c.type,
        role: r.role, locator: r.locator, from: r.from,
      });
    }
  }

  // 制卡报告点名的卡补挂上（即使卡里的 sources 没写这篇）
  for (const p of papers.values()) {
    for (const id of p.made) {
      if (p.cards.some(x => x.id === id)) continue;
      const hit = detailed.find(c => c.id === id);
      if (hit && !hit.drops.includes(p.key)) {
        p.cards.push({
          id, title: hit.title, shelf: hit.shelf, type: hit.type,
          role: '产出', locator: '', from: 'report',
        });
      }
    }
  }

  // 一篇文献被摘空之后就别再占一行了
  for (const [k, p] of papers) {
    if (!p.hasReading && !p.cards.length) papers.delete(k);
  }

  // 只按「被几张卡引用」排：这是唯一有信息量的顺序。
  // 有没有阅读成果不参与排序——那只是「插件看不看得见产出」，不是卡片关系的一部分。
  const list = [...papers.values()].sort((a, b) =>
    (b.cards.length - a.cards.length)
    || String(b.year).localeCompare(String(a.year))
    || String(a.key).localeCompare(String(b.key)));

  const links = detailed.reduce((n, c) => n + c.refs.length, 0);
  const linked = detailed.filter(c => c.refs.length).length;
  return {
    papers: list,
    cards: detailed,
    roles: REF_ROLES,
    litHome: LIT_HOME,
    stats: {
      cards: detailed.length,
      papers: list.length,
      withReading: list.filter(p => p.hasReading).length,
      links,
      linked,
      orphans: detailed.length - linked,
    },
  };
}

// 写回 front-matter：只动 refs / refs_drop 两段，其余原样保留
function refsBlock(refs, drops) {
  // 换行/控制字符会截断这一行、把后面的内容变成新的顶层键（审计 #4），必须挡掉。
  const q = v => '"' + fieldValue(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const out = [];
  if (refs.length) {
    out.push('refs:');
    for (const r of refs) {
      out.push('  - key: ' + q(r.key));
      out.push('    role: ' + q(r.role || '引用'));
      if (r.locator) out.push('    locator: ' + q(r.locator));
    }
  }
  if (drops.length) {
    out.push('refs_drop:');
    for (const k of drops) out.push('  - ' + q(k));
  }
  return out;
}

function rewriteRefs(raw, refs, drops) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) throw Error('这张卡的 front-matter 不完整，先修好再挂文献');
  const body = raw.slice(m[0].length);
  const kept = [];
  let skip = false;
  for (const line of m[1].split(/\r?\n/)) {
    const top = /^([A-Za-z_][\w-]*):/.exec(line);
    if (top) skip = top[1] === 'refs' || top[1] === 'refs_drop';
    if (!skip) kept.push(line);
  }
  const fmText = kept.concat(refsBlock(refs, drops)).join('\n').replace(/\n+$/, '');
  return '---\n' + fmText + '\n---' + body;
}

// 挂 / 摘一条映射。只写 refs 与 refs_drop：
//   - 手工挂上的记在 refs，可以改角色、可以删掉
//   - 自动从 sources 认出来的删不掉（正文里就写着那条引用），只能记进 refs_drop
export function applyRefs(raw, patch = {}) {
  const { fm } = parseFront(raw);
  let manual = (Array.isArray(fm.refs) ? fm.refs : [])
    .filter(r => r && typeof r === 'object' && r.key)
    .map(r => ({
      key: String(r.key).trim(),
      role: String(r.role || '引用').trim() || '引用',
      locator: String(r.locator || '').trim(),
    }));
  const drops = new Set((Array.isArray(fm.refs_drop) ? fm.refs_drop : []).map(String));

  const add = patch.add;
  const remove = patch.remove ? String(patch.remove) : '';
  if (add && add.key) {
    const key = String(add.key).trim();
    drops.delete(key);
    manual = manual.filter(r => r.key !== key);
    manual.push({
      key,
      role: String(add.role || '引用').trim() || '引用',
      locator: String(add.locator || '').trim(),
    });
  }
  if (remove) {
    const wasManual = manual.some(r => r.key === remove);
    manual = manual.filter(r => r.key !== remove);
    if (wasManual) drops.delete(remove);
    else drops.add(remove);
  }

  const next = rewriteRefs(raw, manual, [...drops]);
  return {
    next,
    changed: next !== raw,
    refs: cardRefs(parseFront(next).fm),
    manual,
    drops: [...drops],
  };
}

export function attachCardsUI(ctx) {
  const disposers = [];

  // 请求日志：写进卡片库根目录的 .plugin.log，便于定位「请求到底有没有到 host」
  const LOG = path.join(HOME, '.plugin.log');
  const trace = line => {
    try { fsSync.appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`); } catch { /* 忽略 */ }
  };

  const route = (suffix, method, fn) => {
    const methods = Array.isArray(method) ? method : [method];
    const dispose = ctx.connection.fetch.register({
      path: NATIVE_API + suffix, methods,
      async fetch(request, url) {
        // 路由回调只收到 request；url 需自己从 request.url 解析
        const u = url || new URL(request.url, 'http://dsh.invalid');
        trace(`→ ${request.method} ${u.pathname}${u.search}`);
        try {
          const res = await fn(request, u);
          trace(`← ${u.pathname} ${res.status}`);
          return res;
        } catch (e) {
          trace(`✗ ${u.pathname} ${fail(e)}`);
          return json({ error: fail(e), where: 'handler' }, 500);
        }
      },
    });
    if (typeof dispose === 'function') disposers.push(dispose);
  };

  // 注意：桌面壳转发 dsh-app://app/api/* 时会把 request.body 原样交给 Node fetch，
  // 而 GET 的 body 是空 ReadableStream，Node 会抛 "Request with GET/HEAD method
  // cannot have body"，导致转发失败并返回空 400。所以这里一律用 POST。
  const readJson = async request => {
    const text = await request.text();
    try { return text ? JSON.parse(text) : {}; } catch { return {}; }
  };

  // /ping 不回路径（审计 #13）：这个接口是探活用的，不该顺手把本机目录结构告诉任何人。
  route('/ping', ['POST', 'GET'], async () => json({ ok: true, buildId: BUILD_ID }));

  route('/list', ['POST', 'GET'], async () => {
    const broken = [];
    const cards = await listCards(broken);
    const state = await libraryState();
    const others = await otherLibraries();
    return json({
      cards,
      home: HOME,
      state,
      others,
      broken,
      // 库身份三行字（评审 P0 #3）：本库几张 / catalog 声明几条 / 其中几条 path 已不存在
      identity: await libraryIdentity(cards),
    });
  });

  route('/get', ['POST', 'GET'], async (request, url) => {
    let id = url.searchParams.get('id') || '';
    if (!id && request.method === 'POST') id = String((await readJson(request)).id || '');
    const hit = pickCard(await listCards(), id);
    const raw = await fs.readFile(hit.path, 'utf8');
    const { fm, body } = parseFront(raw);
    return json({ ...hit, fm, body, refs: cardRefs(fm) });
  });

  // 关系网：直接返回两个单文件页面，面板用 iframe srcdoc 内嵌
  // 默认不重跑 Python（审计 #11）：旧版默认 rebuild=true，每开一次面板就起一个 Python，
  // 双击两下就是两个进程同时写同一份 HTML。
  let graphRunning = null;
  route('/graph', ['POST', 'GET'], async request => {
    const input = request.method === 'POST' ? await readJson(request) : {};
    const rebuild = input.rebuild === true;
    let raw = '';
    let stats = null;
    if (rebuild) {
      if (graphRunning) {
        stats = { note: '上一次重建还没结束，这次直接读现成的图' };
      } else {
        graphRunning = run('kcard.py', ['graph']).finally(() => { graphRunning = null; });
        const r = await graphRunning;
        raw = r.out || r.err;
        try { stats = JSON.parse(raw); } catch { stats = null; }
      }
    }
    const p3 = path.join(HOME, GRAPH_3D);
    const p2 = path.join(HOME, GRAPH_2D);
    const html3 = await readIfSmall(p3);
    const html2 = await readIfSmall(p2);
    if (!html3 && !html2) throw Error('关系网还没生成，先运行 kcard.py graph');
    return json({ ok: true, path3d: p3, path2d: p2, html3d: html3, html2d: html2, stats, raw });
  });

  route('/map', ['POST', 'GET'], async () => json(await buildMap()));

  route('/invoke', 'POST', async request => {
    const input = await readJson(request);
    const { action, payload = {} } = input;

    if (action === 'map') {
      return json({ ok: true, ...(await buildMap()) });
    }

    // 挂 / 摘一张卡与一篇文献的映射。只改 refs 与 refs_drop，正文一个字不动。
    if (action === 'refs') {
      const hit = pickCard(await listCards(), payload.id);
      const raw = await fs.readFile(hit.path, 'utf8');
      const r = applyRefs(raw, { add: payload.add, remove: payload.remove });
      if (r.changed) {
        await backupCard(hit.path, raw);
        // 记下原 mtime：refs 只是元数据，正文没动，不该让卡片图被判成「过期」
        const st = await fs.stat(hit.path);
        await atomicWrite(hit.path, r.next);
        await fs.utimes(hit.path, st.atime, st.mtime);
      }
      return json({
        ok: true, id: hit.id, path: hit.path, refs: r.refs,
        manual: r.manual.length, dropped: r.drops,
      });
    }

    if (action === 'check') {
      const args = ['check', '--title', String(payload.title || '')];
      if (payload.en) args.push('--en', String(payload.en));
      const r = await run('kcard.py', args);
      let data = null;
      try { data = JSON.parse(r.out); } catch { /* 忽略 */ }
      return json({ ok: r.code === 0, result: data, raw: r.out || r.err });
    }

    if (action === 'save') {
      const hit = pickCard(await listCards(), payload.id);
      const raw = await fs.readFile(hit.path, 'utf8');
      const { fm } = parseFront(raw);
      const head = raw.slice(0, raw.indexOf('---', 3) + 3);
      // 覆盖前必须留底：这是唯一会毁掉正文的操作（审计 #8）。
      const backup = await backupCard(hit.path, raw);
      const next = head + '\n\n' + String(payload.body || '').trim() + '\n';
      const st = await fs.stat(hit.path);
      await atomicWrite(hit.path, next);
      await fs.utimes(hit.path, st.atime, st.mtime);
      const r = await run('kcard.py', ['reindex']);
      return json({ ok: true, reindexed: r.code === 0, status: fm.status || '', backup });
    }

    if (action === 'delete') {
      const hit = pickCard(await listCards(), payload.id);
      const title = String(hit.title_zh || hit.title_en || '').trim();
      // 删卡要在日志里留下「删的是哪一张」，光有 id 日后对不上（审计 #9）。
      trace(`delete ${hit.id} 「${title}」 ${hit.path}`);
      const trash = path.join(HOME, 'trash');
      await fs.mkdir(trash, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const target = path.join(trash, `${path.basename(hit.path, '.md')}.${stamp}.md`);
      await fs.rename(hit.path, target);
      const r = await run('kcard.py', ['reindex']);
      return json({ ok: true, moved: target, id: hit.id, title });
    }

    // 只读已经出好的卡片图，不重跑 Python：点开一张卡要秒开
    if (action === 'rendered') {
      const id = assertCardId(payload.id);
      const out = path.join(HOME, 'rendered', id + '.html');
      const html = await readIfSmall(out, 1200 * 1024);
      let mtime = 0;
      try { mtime = (await fs.stat(out)).mtimeMs; } catch { /* 没出过图 */ }
      const cards = await listCards();
      const hit = cards.find(c => c.id.toLowerCase() === id.toLowerCase());
      return json({
        ok: !!html,
        path: out,
        html,
        missing: !html,
        // md 比图新，说明正文改过、图已经过期
        stale: !!(html && hit && hit.mtime > mtime + 1500),
      });
    }

    if (action === 'render') {
      const id = assertCardId(payload.id);
      const out = path.join(HOME, 'rendered', id + '.html');
      await fs.mkdir(path.dirname(out), { recursive: true });
      const r = await run('render_card_single.py', [String(payload.id || ''), '-o', out]);
      // 顺带把生成的 HTML 回传，面板可以直接内嵌预览（免去用户去文件夹里找）
      let html = '';
      try {
        const st = await fs.stat(out);
        if (r.code === 0 && st.size < 800 * 1024) html = await fs.readFile(out, 'utf8');
      } catch { /* 文件没生成就不回传 */ }
      return json({ ok: r.code === 0, path: out, html, raw: r.out || r.err });
    }

    if (action === 'graph') {
      const r = await run('kcard.py', ['graph']);
      let stats = null;
      try { stats = JSON.parse(r.out); } catch { /* 忽略 */ }
      const html3d = await readIfSmall(path.join(HOME, GRAPH_3D));
      const html2d = await readIfSmall(path.join(HOME, GRAPH_2D));
      return json({ ok: r.code === 0, html3d, html2d, stats, raw: r.out || r.err });
    }

    if (action === 'reindex') {
      const r = await run('kcard.py', ['reindex']);
      let stats = null;
      try { stats = JSON.parse(r.out); } catch { /* 忽略 */ }
      return json({ ok: r.code === 0, stats, raw: r.out || r.err });
    }

    throw Error('不支持的操作：' + action);
  });

  return () => disposers.forEach(d => { try { d(); } catch { /* 忽略 */ } });
}
