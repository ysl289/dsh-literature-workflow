import path from 'node:path';
import {
  asList, existsSync, listDirs, readJson, readText, sha256, splitSegments, walkFiles,
} from './fsx.mjs';
import { resolveInside } from './config.mjs';
import { buildEvidenceIndex } from './evidence.mjs';

export { buildEvidenceIndex };

// ─────────────────────────────────────────────────────────────
// 极简 front matter 解析：够读卡片库现有格式（标量 / 行内数组 /
// 对象列表 / 嵌套对象），不做通用 YAML。
// ─────────────────────────────────────────────────────────────
function scalar(raw) {
  const v = String(raw ?? '').trim();
  if (/^\[.*\]$/.test(v)) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
  }
  return v.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
}

function parseBlock(lines) {
  if (!lines.length) return [];
  if (!lines[0].trim().startsWith('-')) {
    const obj = {};
    for (const line of lines) {
      const kv = /^\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (kv) obj[kv[1]] = scalar(kv[2]);
    }
    return obj;
  }
  const items = [];
  let current = null;
  for (const line of lines) {
    const text = line.trim();
    if (text.startsWith('- ')) {
      const inner = text.slice(2).trim();
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(inner);
      if (kv) {
        current = { [kv[1]]: scalar(kv[2]) };
        items.push(current);
      } else {
        current = null;
        items.push(scalar(inner));
      }
    } else if (current && typeof current === 'object') {
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(text);
      if (kv) current[kv[1]] = scalar(kv[2]);
    }
  }
  return items;
}

export function parseFrontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text || ''));
  if (!match) return { data: {}, body: String(text || '') };
  const lines = match[1].split(/\r?\n/);
  const data = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) { i++; continue; }
    const top = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!top) { i++; continue; }
    const key = top[1];
    const rest = top[2].trim();
    if (rest !== '') { data[key] = scalar(rest); i++; continue; }
    const block = [];
    i++;
    while (i < lines.length && (!lines[i].trim() || /^\s+/.test(lines[i]))) {
      if (lines[i].trim()) block.push(lines[i]);
      i++;
    }
    data[key] = parseBlock(block);
  }
  return { data, body: match[2] || '' };
}

// ─────────────────────────────────────────────────────────────
// 论文（文献工作流的产物）
// ─────────────────────────────────────────────────────────────
/**
 * job.json 里的 extractPath 是绝对路径，属于外部输入（审计 #16）。
 * 旧版直接 existsSync 就读：一份 job.json 就能把构建引到工作流目录之外。
 *
 * 顺序也调过来了：**jobDir 下的副本优先**，声明路径只作 fallback。
 * 副本在受管目录里，不会被别人换掉；声明路径指向哪儿只有写 job.json 的人知道。
 */
function pickExtractPath(job, jobDir, root) {
  const declared = typeof job?.extractPath === 'string' ? job.extractPath : '';
  const local = path.join(jobDir, 'paper.extract.json');
  if (existsSync(local)) return { path: local, rejected: '' };
  if (!declared) return { path: '', rejected: '' };
  try {
    // 越界会抛 PATH_OUTSIDE_ROOT，这里当成「不认这个声明」处理
    return { path: resolveInside(root || jobDir, declared, 'job.json 声明的抽取文件'), rejected: '' };
  } catch {
    // 静默不采信是危险的：论文还在、只是抽取降级成字段级证据，
    // 看起来和「一切正常」几乎一样。把被拒的声明记下来，交给校验去报警。
    return { path: '', rejected: declared };
  }
}

function textOf(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(v => String(v)).join('\n');
  return String(value ?? '');
}

/** 抽取里的列表字段：有的论文写成数组，有的写成整段字符串，统一成数组再往下传。 */
const LIST_FIELDS = [
  'research_questions', 'hypotheses', 'limitations', 'future_research',
  'core_variables', 'economic_concepts', 'economic_theories', 'why_top',
];

function normalizeExtract(extract) {
  if (!extract || typeof extract !== 'object') return extract;
  const out = { ...extract };
  for (const key of LIST_FIELDS) if (key in out) out[key] = asList(out[key]);
  if (out.design && typeof out.design === 'object') {
    const design = { ...out.design };
    if (design.identification && typeof design.identification === 'object') {
      design.identification = { ...design.identification, threats: asList(design.identification.threats) };
    }
    for (const key of ['robustness', 'mechanism', 'heterogeneity', 'key_coefficients']) {
      if (key in design && !Array.isArray(design[key])) design[key] = asList(design[key]);
    }
    out.design = design;
  }
  return out;
}

/**
 * 学习就绪度：不能只看 job.status === completed（清单 11/06）。
 * 阅读抽取完成但后续发布失败，材料仍可学习；只有 extract 缺失/正文不可用
 * 才不能称为正式学习材料。这里只读、不写上游。
 */
export function assessPaperReadiness({ job = {}, extract = null, full = '', pages = [], evidence = null } = {}) {
  const stages = Array.isArray(job.completedStages) ? job.completedStages.map(String) : [];
  const stage = String(job.stage || '');
  // stage='paused' is not evidence that reading finished: pause may happen
  // before reading. Trust completedStages; only explicit post-read stages can
  // stand in when the old job format has no completedStages.
  const readStage = stages.includes('read')
    || (!stages.length && ['done', 'analysis_ready', 'ready_publish'].includes(stage));
  const extractReady = Boolean(extract && typeof extract === 'object' && !Array.isArray(extract));
  const bodyReady = Boolean(String(full || '').trim());
  const pagesReady = Array.isArray(pages) && pages.length > 0;
  const evidenceTotal = Number(evidence?.total || 0);
  const verified = Number(evidence?.verifiedCount || 0);
  let status = 'excluded';
  let reason = '缺少可解析的 paper.extract.json';
  if (extractReady && !bodyReady) {
    status = 'extract-only';
    reason = '抽取存在，但正文不可用；只能作为候选材料，不能当作原文已核对';
  } else if (extractReady && bodyReady && !readStage) {
    status = 'provisional';
    reason = '阅读/抽取阶段尚未确认完成；可显示为暂定材料，不进入可信引用';
  } else if (extractReady && bodyReady && readStage && !pagesReady) {
    status = 'provisional';
    reason = '阅读抽取可用，但页表缺失；证据只能定位到段号，不能确认页码';
  } else if (extractReady && bodyReady && readStage) {
    status = 'ready';
    reason = '阅读抽取完成，正文可用；是否可引用仍取决于证据与主张核验';
  }
  return {
    status,
    reason,
    readStage,
    extractReady,
    bodyReady,
    pagesReady,
    evidenceTotal,
    verified,
    sourceKind: String(job.inputKind || job.source?.kind || job.kind || ''),
    citationUnit: String(extract?.meta?.citation_unit || (job.inputKind === 'markdown' ? 'segment' : pagesReady ? 'page' : 'unknown')),
  };
}

/**
 * 指纹只认内容，不认时间戳与路径（审计 #5）。
 * 旧版把 job.updatedAt、meta.generated_at、meta.md_path 一起算进指纹，
 * 结果是工作流重跑一遍、正文一个字没改，也会被判成「输入变了 → 产物该变」，
 * 于是「不可复现」和「正常重跑」分不开。
 */
const VOLATILE_KEYS = new Set([
  'generated_at', 'generatedAt', 'updatedAt', 'createdAt',
  'md_path', 'mdPath', 'source_pdf', 'sourcePdf', 'prepared', 'extractPath',
]);

export function stableProjection(value, depth = 0) {
  if (depth > 8) return null;
  if (Array.isArray(value)) return value.map(item => stableProjection(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (VOLATILE_KEYS.has(key)) continue;
      out[key] = stableProjection(value[key], depth + 1);
    }
    return out;
  }
  return value;
}

export async function loadPaper(jobDir, { root = '' } = {}) {
  const jobPath = path.join(jobDir, 'job.json');
  const job = await readJson(jobPath, null);
  if (!job?.id) return null;

  const picked = pickExtractPath(job, jobDir, root);
  const extractPath = picked.path;
  const extractRejected = picked.rejected;
  const extract = normalizeExtract(extractPath ? await readJson(extractPath, null) : null);
  // 正文路径同理：本地 full.md 优先，job.json 声明只在受管目录内才认（审计 #16）。
  const localMd = path.join(jobDir, 'full.md');
  let mdPath = localMd;
  if (!existsSync(localMd)) {
    const declaredMd = job.markdownPath || job.prepared?.mdPath || '';
    if (declaredMd) {
      try {
        mdPath = resolveInside(root || jobDir, declaredMd, 'job.json 声明的正文文件');
      } catch {
        mdPath = localMd;
      }
    }
  }
  const full = existsSync(mdPath) ? await readText(mdPath, '') : '';
  const segments = splitSegments(full);
  const pages = await readJson(path.join(jobDir, 'pages.json'), []);
  const evidence = buildEvidenceIndex(extract, full, segments, pages);
  const fullHash = sha256(full);
  const pagesHash = sha256(JSON.stringify(pages ?? []));
  const readiness = assessPaperReadiness({ job, extract, full, pages, evidence });

  return {
    id: String(job.id),
    dir: jobDir,
    job,
    jobPath,
    extract,
    extractPath,
    mdPath: existsSync(mdPath) ? mdPath : '',
    segments,
    evidence,
    readiness,
    jobId: String(job.id),
    status: job.status || '',
    stage: job.stage || '',
    sourceKind: readiness.sourceKind,
    citationUnit: readiness.citationUnit,
    hidden: job.hidden === true,
    title: String(extract?.meta?.title || job.metadata?.title || job.originalName || job.id),
    authors: String(extract?.authors || job.metadata?.authors || ''),
    year: String(extract?.year || extract?.meta?.year || job.metadata?.year || ''),
    journal: String(extract?.meta?.journal || job.metadata?.journal || ''),
    doi: String(extract?.meta?.doi || job.metadata?.doi || ''),
    apa: String(extract?.apa_citation || ''),
    createdAt: job.createdAt || '',
    updatedAt: job.updatedAt || '',
    // 正文与分页也进指纹：只改 md 不改 extract 时，证据核验数会变，指纹必须跟着变（清单 17）。
    // 但 job.updatedAt 这类时间戳不进：它一变指纹就变，等于把「重跑过」当成「内容变了」。
    fingerprint: sha256([
      job.id,
      extractPath ? sha256(JSON.stringify(stableProjection(extract))) : 'no-extract',
      fullHash,
      pagesHash,
    ].join('|')),
    // 记下抽取文件是从哪儿读的：本地副本还是 job.json 声明的外部路径（审计 #16）。
    // 两者优先级不同，出问题时必须一眼看出当时用的是哪一个。
    extractSource: !extractPath ? 'none'
      : (path.resolve(extractPath) === path.resolve(path.join(jobDir, 'paper.extract.json'))
        ? 'local' : 'declared'),
    // 被拒的越界声明：不静默咽下去，交给校验报警（QA #5）。
    extractRejected,
    fullHash,
    pagesHash,
    raw: {
      research_questions: extract?.research_questions,
      hypotheses: extract?.hypotheses,
      abstract: extract?.abstract,
      core_theory: extract?.core_theory,
      contribution: extract?.contribution,
      data: extract?.data,
      limitations: extract?.limitations,
      future_research: extract?.future_research,
      core_variables: extract?.core_variables,
      economic_concepts: extract?.economic_concepts,
      economic_theories: extract?.economic_theories,
      why_top: extract?.why_top,
      design: extract?.design || {},
      text: textOf,
    },
  };
}

export async function loadPapers(config, { includeHidden = false } = {}) {
  const dirs = await listDirs(config.jobsDir);
  const papers = [];
  const skipped = [];
  for (const dir of dirs) {
    const paper = await loadPaper(dir, { root: config.workflowRoot });
    if (!paper) { skipped.push({ dir, reason: '缺少 job.json' }); continue; }
    if (!paper.extract) { skipped.push({ id: paper.id, reason: '缺少 paper.extract.json' }); continue; }
    if (paper.hidden && !includeHidden) { skipped.push({ id: paper.id, hidden: true, reason: '已隐藏' }); continue; }
    papers.push(paper);
  }
  papers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const readiness = papers.reduce((acc, paper) => {
    const status = paper.readiness?.status || 'unknown';
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  return { papers, skipped, readiness };
}

// ─────────────────────────────────────────────────────────────
// 知识卡片库
// ─────────────────────────────────────────────────────────────
/** 卡片库的人工来源覆盖：refs 手工追加，refs_drop 手工剔除（与卡片库 host.mjs 同语义）。 */
export function normalizeRefKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
}

function cardOverrides(data) {
  const refs = Array.isArray(data.refs) ? data.refs.filter(r => r && typeof r === 'object' && r.key) : [];
  const drops = Array.isArray(data.refs_drop) ? data.refs_drop.map(normalizeRefKey).filter(Boolean) : [];
  return {
    manualRefs: refs.map(r => ({
      key: normalizeRefKey(r.key),
      rawKey: String(r.key).trim(),
      role: String(r.role || '').trim() || '引用',
      locator: String(r.locator || '').trim(),
      title: String(r.title || '').trim(),
      citation: String(r.citation || '').trim(),
    })),
    dropRefs: drops,
  };
}

export async function loadCards(config) {
  const catalog = await readJson(path.join(config.cardsHome, 'catalog.json'), null);
  const files = await walkFiles(path.join(config.cardsHome, 'cards'), f => f.endsWith('.md'));
  const byPath = new Map(files.map(f => [f.toLowerCase(), f]));
  const cards = [];

  const rows = Array.isArray(catalog?.cards) ? catalog.cards : [];
  for (const row of rows) {
    const declared = typeof row?.path === 'string' ? row.path : '';
    const file = byPath.get(declared.toLowerCase())
      || files.find(f => path.basename(f).startsWith(String(row?.id || '')) );
    const text = file ? await readText(file, '') : '';
    const { data, body } = text ? parseFrontMatter(text) : { data: {}, body: '' };
    const sources = Array.isArray(data.sources) ? data.sources.filter(s => s && typeof s === 'object') : [];
    const relations = Array.isArray(data.relations) ? data.relations.filter(r => r && typeof r === 'object') : [];
    cards.push({
      id: String(row?.id || data.id || ''),
      type: String(data.type || row?.type || ''),
      shelf: String(data.shelf || row?.shelf || ''),
      title_zh: String(data.title_zh || row?.title_zh || ''),
      title_en: String(data.title_en || row?.title_en || ''),
      aliases: Array.isArray(data.aliases) ? data.aliases.map(String) : (Array.isArray(row?.aliases) ? row.aliases.map(String) : []),
      status: String(data.status || row?.status || ''),
      confidence: String(data.confidence || row?.confidence || ''),
      school: String(data.school || row?.school || ''),
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
      authors: Array.isArray(data.authors) ? data.authors.map(String) : [],
      firstSource: data.first_source && typeof data.first_source === 'object' ? data.first_source : null,
      sources,
      relations,
      ...cardOverrides(data),
      body,
      path: file || '',
    });
  }

  // 目录里没有、但文件存在的卡片也收进来（避免 catalog 过期导致漏卡）
  for (const file of files) {
    const idMatch = /([A-Z]-\d{4})/.exec(path.basename(file));
    const id = idMatch ? idMatch[1] : '';
    if (id && cards.some(c => c.id === id)) continue;
    const { data, body } = parseFrontMatter(await readText(file, ''));
    cards.push({
      id: id || String(data.id || path.basename(file, '.md')),
      type: String(data.type || ''),
      shelf: String(data.shelf || ''),
      title_zh: String(data.title_zh || ''),
      title_en: String(data.title_en || ''),
      aliases: Array.isArray(data.aliases) ? data.aliases.map(String) : [],
      status: String(data.status || ''),
      confidence: String(data.confidence || ''),
      school: String(data.school || ''),
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
      authors: Array.isArray(data.authors) ? data.authors.map(String) : [],
      firstSource: data.first_source && typeof data.first_source === 'object' ? data.first_source : null,
      sources: Array.isArray(data.sources) ? data.sources : [],
      relations: Array.isArray(data.relations) ? data.relations : [],
      ...cardOverrides(data),
      body,
      path: file,
    });
  }

  cards.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    catalog,
    shelves: Array.isArray(catalog?.shelves) ? catalog.shelves : [...new Set(cards.map(c => c.shelf).filter(Boolean))].sort(),
    cards,
    fingerprint: sha256(cards.map(c => [
      c.id, c.status, c.sources.length, c.relations.length, c.title_zh,
      (c.manualRefs || []).map(r => r.key).join(','),
      (c.dropRefs || []).join(','),
    ].join(':')).join('|')),
  };
}

// ─────────────────────────────────────────────────────────────
// 词表与口径
// ─────────────────────────────────────────────────────────────
export async function loadLexicon(config) {
  const read = name => readJson(path.join(config.lexiconDir, name), null);
  const [rubric, strategies, magnitudes, commonsense] = await Promise.all([
    readJson(config.rubricPath, null).then(v => v || read('rating-rubric.json')),
    read('strategies.json'),
    read('magnitudes.json'),
    read('commonsense.json'),
  ]);
  if (!rubric) throw new Error(`评级口径文件缺失或不可解析：${config.rubricPath}`);
  if (!strategies?.canonical?.length) throw new Error(`识别策略词表缺失：${path.join(config.lexiconDir, 'strategies.json')}`);
  return {
    rubric,
    strategies,
    magnitudes: magnitudes || { themes: [] },
    commonsense: commonsense || { entries: [] },
    // 口径与词表的哈希要进输入指纹：改规则必须让学习层显示为「陈旧」（清单 17/18）
    rubricHash: sha256(JSON.stringify(rubric)),
    lexiconHash: sha256(JSON.stringify([strategies, magnitudes || {}, commonsense || {}])),
  };
}

// ─────────────────────────────────────────────────────────────
// 识别策略归一
// ─────────────────────────────────────────────────────────────
const LATIN_ALIAS = /^[\x20-\x7e]+$/;

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 别名命中（清单 07）。
 * 短英文别名必须按词边界匹配，否则 derivative / candidate / tools 会被当成 IV / DID。
 * 中文别名按子串匹配，但要求至少 2 个字。
 */
export function aliasHit(text, alias) {
  const needle = String(alias || '').trim();
  if (!needle) return false;
  if (LATIN_ALIAS.test(needle)) {
    const pattern = new RegExp(`(?<![a-z0-9])${escapeRegExp(needle.toLowerCase())}(?![a-z0-9])`, 'i');
    return pattern.test(text);
  }
  if ([...needle].length < 2) return false;
  return text.includes(needle);
}

export function normalizeStrategy(rawText, strategies) {
  const text = String(rawText || '').toLowerCase();
  if (!text.trim()) return { id: 'OTHER', label: '其他/未标注', matched: '', family: '未标注', portable: 0, ambiguous: false, alternatives: [] };

  const hits = [];
  for (const item of strategies.canonical) {
    let bestAlias = '';
    for (const alias of [item.label, ...(item.aliases || [])]) {
      const needle = String(alias || '').trim();
      if (!aliasHit(text, needle)) continue;
      if (needle.length > bestAlias.length) bestAlias = needle;
    }
    if (bestAlias) hits.push({ item, alias: bestAlias, weight: bestAlias.length });
  }

  if (!hits.length) return { id: 'OTHER', label: '其他/未标注', matched: '', family: '未标注', portable: 0, ambiguous: false, alternatives: [] };

  hits.sort((a, b) => b.weight - a.weight);
  const best = hits[0];
  const alternatives = hits.slice(1).map(hit => hit.item.id);
  return {
    id: best.item.id,
    label: best.item.label,
    family: best.item.family,
    assumption: best.item.assumption,
    threat: best.item.threat,
    portable: best.item.portable,
    matched: best.alias,
    // 一段文字里同时出现多种方法时保留歧义，不静默取第一个（清单 07）
    ambiguous: alternatives.length > 0,
    alternatives,
  };
}
