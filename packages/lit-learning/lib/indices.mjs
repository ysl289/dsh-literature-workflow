import { oneLine, round, truncate } from './fsx.mjs';
import { isComparable, parseQuantity, signLabel } from './number.mjs';
import { normalizeRefKey } from './sources.mjs';

const SURNAME_STOP = new Set(['The', 'This', 'That', 'In', 'As', 'For', 'We', 'Our', 'It', 'A', 'An', 'And', 'But', 'By', 'On', 'At', 'From', 'See', 'Also']);

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function surnamesOf(paper) {
  const parts = String(paper.authors || '').split(/[;；、]/).map(part => part.trim()).filter(Boolean);
  const out = [];
  for (const part of parts) {
    const head = part.split(',')[0].trim();
    if (!head) continue;
    const words = head.split(/\s+/)
      .filter(token => !/^[A-Z]\.?$/.test(token))
      .map(token => token.replace(/[^A-Za-zÀ-ÿ'’\-]/g, ''))
      .filter(token => token.length >= 2);
    if (words.length) out.push(words[words.length - 1]);
  }
  return [...new Set(out)];
}

/** 引用键：Surname_Year，与卡片库 refs / refs_drop 的键格式一致；统一小写。 */
function refKey(citation) {
  const text = String(citation || '');
  const year = (text.match(/\((\d{4})[a-z]?\)/) || [])[1] || '';
  const head = text.split(/[,(]/)[0].trim();
  const tokens = head.split(/\s+/).filter(Boolean);
  const surname = tokens.length ? tokens[tokens.length - 1].replace(/[^A-Za-zÀ-ÿ'’\-]/g, '') : '';
  return surname && year ? normalizeRefKey(`${surname}_${year}`) : '';
}

// ─────────────────────────────────────────────────────────────
// 跨篇识别策略索引
// ─────────────────────────────────────────────────────────────
export function buildStrategyIndex(papers, lexicon, ratings) {
  const rows = new Map();
  for (const paper of papers) {
    const id = paper.strategy?.id || 'OTHER';
    if (!rows.has(id)) {
      const canonical = lexicon.strategies.canonical.find(item => item.id === id) || {};
      rows.set(id, {
        id,
        label: canonical.label || paper.strategy?.label || '其他/未标注',
        family: canonical.family || '未标注',
        assumption: canonical.assumption || '',
        threat: canonical.threat || '',
        portable: canonical.portable ?? 0,
        papers: [],
      });
    }
    rows.get(id).papers.push({
      paperId: paper.id,
      title: paper.title,
      year: paper.year,
      grade: ratings.get(paper.id)?.grade || '',
      variant: paper.strategy?.matched || '',
      assumptionUsed: oneLine(paper.extract?.design?.identification?.assumption, 80),
    });
  }

  const strategies = [...rows.values()]
    .map(row => ({
      ...row,
      count: row.papers.length,
      crossNote: row.count > 1
        ? `本批有 ${row.count} 篇用此法，可直接比较同一策略在不同数据上的稳定性。`
        : `本批只有 1 篇用此法；跨篇比较时要另找同类文献。`,
    }))
    .sort((a, b) => (b.count - a.count) || (a.id < b.id ? -1 : 1));

  const paperIds = papers.map(p => p.id);
  const matrix = {};
  for (const paper of papers) {
    matrix[paper.id] = Object.fromEntries(strategies.map(s => [s.id, s.papers.some(p => p.paperId === paper.id)]));
  }

  return {
    version: 1,
    papers: paperIds,
    strategies,
    matrix,
    gaps: strategies.filter(s => s.count === 0).map(s => s.id),
  };
}

// ─────────────────────────────────────────────────────────────
// 跨篇量级索引
// ─────────────────────────────────────────────────────────────
function themeFor(text, themes) {
  const haystack = String(text || '').toLowerCase();
  let best = null;
  for (const theme of themes) {
    for (const keyword of theme.keywords || []) {
      const needle = String(keyword).toLowerCase();
      if (!needle) continue;
      if (!haystack.includes(needle)) continue;
      if (!best || needle.length > best.needle.length) best = { theme, needle };
    }
  }
  return best?.theme || themes.find(t => t.id === 'OTHER') || { id: 'OTHER', label: '其他', unit: '未归类' };
}

export function buildMagnitudeIndex(papers, lexicon, ratings) {
  const themes = new Map();
  const ensure = theme => {
    if (!themes.has(theme.id)) {
      themes.set(theme.id, { id: theme.id, label: theme.label, unit: theme.unit, rows: [] });
    }
    return themes.get(theme.id);
  };

  for (const paper of papers) {
    const coefs = Array.isArray(paper.extract?.design?.key_coefficients) ? paper.extract.design.key_coefficients : [];
    coefs.forEach((coef, index) => {
      const raw = String(coef?.coef ?? '').trim();
      if (!raw) return;
      const parsed = parseQuantity(raw);
      const theme = themeFor(`${coef.term || ''} ${(paper.extract?.economic_concepts || []).join(' ')}`, lexicon.magnitudes.themes);
      const explicitUnit = String(coef?.unit || coef?.unitText || coef?.scale || '').trim();
      const comparisonBasis = {
        unit: explicitUnit,
        estimate: oneLine(coef.estimate || coef.estimand || '', 60),
        model: oneLine(coef.model || '', 60),
        sample: oneLine(coef.sample || '', 60),
        transformation: oneLine(coef.transformation || '', 40),
        group: oneLine(coef.comparisonGroup || coef.group || '', 60),
      };
      // A unit alone is not a comparison group. Require an explicit estimand
      // and model, plus sample or transformation (or an explicit group ID).
      const basisComplete = Boolean(comparisonBasis.group)
        || Boolean(comparisonBasis.estimate && comparisonBasis.model && (comparisonBasis.sample || comparisonBasis.transformation));
      const comparable = parsed.status === 'ok' && Boolean(explicitUnit) && basisComplete && isComparable(parsed, explicitUnit);
      ensure(theme).rows.push({
        paperId: paper.id,
        paperTitle: truncate(paper.title, 60),
        year: paper.year,
        grade: ratings.get(paper.id)?.grade || '',
        term: oneLine(coef.term, 60),
        raw,
        value: parsed.value,
        parseStatus: parsed.status,
        parseKind: parsed.kind,
        parseNote: parsed.note,
        unit: parsed.unit || explicitUnit || '',
        // 可解析 ≠ 可比（清单 06）：主题单位只用于分组，跨篇比较还必须
        // 有已声明估计对象、模型以及样本/变换（或已确认比较组）。
        numericCandidate: parsed.status === 'ok',
        comparisonGroup: theme.id,
        comparisonBasis,
        comparisonStatus: comparable ? 'candidate' : (parsed.status === 'ok' && explicitUnit ? 'candidate' : 'insufficient'),
        comparisonReason: parsed.status !== 'ok'
          ? '数值不可解析，不参与比较'
          : !explicitUnit
            ? '缺少显式单位/估计口径；主题归类不等于可跨篇比较'
            : !basisComplete
              ? '只有单位，缺少估计对象、样本、模型或变换；没有已确认比较组，不能跨篇直接比较'
              : '有单位与估计口径；仍需核对估计对象、样本和模型是否一致',
        comparable,
        direction: signLabel(parsed.sign),
        stars: String(coef.stars || ''),
        se: oneLine(coef.se, 24),
        evidence: paper.evidence.resolve(`design.key_coefficients.${index}.coef`, raw).slice(0, 1).map(e => ({
          field: e.field || `design.key_coefficients.${index}.coef`,
          page: e.page,
          segment: e.segment,
          quote: truncate(e.quote, 160),
          source: e.source,
          match: e.match,
          pageCheck: e.pageCheck,
          support: e.support,
          supportStatus: e.supportStatus || 'unassessed',
          fieldRelation: e.fieldRelation || 'unknown',
          state: e.state,
          reason: e.reason || '',
          verified: e.state === 'verified',
        })),
      });
    });
  }

  const list = [...themes.values()]
    .map(theme => ({
      ...theme,
      count: theme.rows.length,
      comparableCount: theme.rows.filter(row => row.comparable).length,
      missingCount: theme.rows.filter(row => row.parseStatus !== 'ok').length,
      rows: theme.rows.sort((a, b) => (a.year < b.year ? -1 : a.year > b.year ? 1 : a.paperId < b.paperId ? -1 : 1)),
      span: theme.rows.length
        ? `${Math.min(...theme.rows.map(r => Number(r.year) || 0))}–${Math.max(...theme.rows.map(r => Number(r.year) || 0))}`
        : '',
    }))
    .sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1));

  return {
    version: 2,
    note: 'numericCandidate 表示可解析；comparable 还要求已声明比较口径。即使字段齐全，也须核对两行是否属于同一估计对象、样本和模型，不能按同主题直接排名。',
    themes: list,
    total: list.reduce((sum, t) => sum + t.count, 0),
    comparable: list.reduce((sum, t) => sum + t.comparableCount, 0),
    unparsed: list.reduce((sum, t) => sum + t.missingCount, 0),
  };
}

// ─────────────────────────────────────────────────────────────
// 论文 ↔ 卡片 稳定关联
// ─────────────────────────────────────────────────────────────
function citationYear(citation) {
  const match = /\((\d{4})\)/.exec(String(citation || ''));
  return match ? match[1] : '';
}

function titleTokens(title) {
  return new Set(String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 3 && !SURNAME_STOP.has(word)));
}

function titleOverlap(a, b) {
  const left = titleTokens(a);
  const right = titleTokens(b);
  if (!left.size || !right.size) return 0;
  let hit = 0;
  for (const token of left) if (right.has(token)) hit += 1;
  return hit / Math.min(left.size, right.size);
}

export function buildLinks(papers, cards) {
  const links = [];
  const byCard = new Map();
  const dropped = [];
  const manual = [];

  for (const paper of papers) {
    const surnames = surnamesOf(paper).map(name => name.toLowerCase());
    const paperKey = surnames.length ? normalizeRefKey(`${surnames[0]}_${paper.year}`) : '';

    for (const card of cards) {
      const basis = [];
      // 卡片库的人工决定优先：refs_drop 剔掉的来源不再连回来（清单 08）
      const drops = new Set((card.dropRefs || []).map(normalizeRefKey));
      const manualKeys = new Set((card.manualRefs || []).map(ref => normalizeRefKey(ref.key)));

      const consider = (citation, role) => {
        const text = String(citation || '');
        if (!text) return;
        const key = refKey(text);
        if (key && drops.has(key)) {
          dropped.push({ paperId: paper.id, cardId: card.id, key, role });
          return;
        }
        const year = (text.match(/\((\d{4})[a-z]?\)/) || [])[1] || '';
        const lower = text.toLowerCase();
        const surnameHit = surnames.find(name => {
          if (!name) return false;
          if (/^[a-z][a-z'’\-]+$/i.test(name)) {
            return new RegExp(`(?:^|[^a-z])${escapeRegExp(name)}(?:[^a-z]|$)`).test(lower);
          }
          return lower.includes(name);
        });
        const titleHit = titleOverlap(paper.title, text);
        if (surnameHit && year && year === String(paper.year)) {
          basis.push({ role, kind: 'citation', detail: `作者姓氏 + 年份命中：${surnameHit} ${year}` });
        } else if (titleHit >= 0.6) {
          basis.push({ role, kind: 'title', detail: `标题词重合 ${round(titleHit, 2)}` });
        }
      };

      if (card.firstSource) consider(card.firstSource.citation, 'first_source');
      for (const source of card.sources || []) consider(source.citation, source.role || 'source');

      // 手工登记的来源：即使正文没写 citation 也认
      for (const ref of card.manualRefs || []) {
        const key = normalizeRefKey(ref.key);
        if (drops.has(key)) continue;
        if (paperKey && key === paperKey) {
          basis.push({ role: ref.role || 'manual', kind: 'manual', detail: `卡片手工登记来源 ${key}` });
          manual.push({ paperId: paper.id, cardId: card.id, key });
        }
      }

      // 概念命中只作弱候选，不升级为 strong（清单 07）
      const concepts = [
        ...(paper.extract?.economic_concepts || []),
        ...(paper.extract?.economic_theories || []),
        ...(paper.extract?.core_variables || []),
      ].map(String);
      const names = [card.title_zh, card.title_en, ...(card.aliases || [])].filter(Boolean);
      const conceptHit = names.find(name => concepts.some(concept => concept && (concept.includes(name) || name.includes(concept))));
      if (conceptHit) basis.push({ role: 'concept', kind: 'concept', detail: `概念命中：${conceptHit}` });

      if (!basis.length) continue;
      const strong = basis.some(item => item.kind === 'citation' || item.kind === 'manual' || item.kind === 'title');
      const link = {
        id: `${paper.id}::${card.id}`,
        paperId: paper.id,
        cardId: card.id,
        cardTitle: card.title_zh || card.id,
        shelf: card.shelf,
        basis,
        strength: strong ? 'strong' : 'weak',
      };
      links.push(link);
      if (!byCard.has(card.id)) byCard.set(card.id, []);
      byCard.get(card.id).push(link);
    }
  }

  links.sort((a, b) => (a.paperId < b.paperId ? -1 : a.paperId > b.paperId ? 1 : a.cardId < b.cardId ? -1 : 1));
  return {
    version: 2,
    links,
    byPaper: Object.fromEntries(papers.map(p => [p.id, links.filter(l => l.paperId === p.id).map(l => l.cardId)])),
    byCard: Object.fromEntries([...byCard.entries()].sort().map(([id, list]) => [id, list.map(l => l.paperId)])),
    orphanCards: cards.filter(c => !byCard.has(c.id)).map(c => c.id),
    uncoveredPapers: papers.filter(p => !links.some(l => l.paperId === p.id)).map(p => p.id),
    // 人工决定的留痕：被剔除的、被手工补上的，都能对账（清单 08）
    droppedByCardDecision: dropped,
    addedByCardManual: manual,
  };
}

// ─────────────────────────────────────────────────────────────
// 引用与对话：从贡献/理论段里抽「作者 (年份)」
// ─────────────────────────────────────────────────────────────
export function extractCitedWorks(paper) {
  const text = [paper.extract?.contribution, paper.extract?.core_theory, paper.extract?.why_top].filter(Boolean).join('\n');
  const found = new Map();
  const re = /([A-Z][A-Za-zÀ-ÿ'’\-]{1,20})(?:\s*(?:,|and|&)\s*([A-Z][A-Za-zÀ-ÿ'’\-]{1,20}))?(?:\s*et al\.?)?\s*\((\d{4})[a-z]?\)/g;
  let match;
  while ((match = re.exec(text))) {
    const surname = match[1];
    if (SURNAME_STOP.has(surname)) continue;
    const year = match[3];
    const key = `${surname}${match[2] ? ` & ${match[2]}` : ''} (${year})`;
    if (!found.has(key)) found.set(key, { key, surname, second: match[2] || '', year, mentions: 0 });
    found.get(key).mentions += 1;
  }
  return [...found.values()].sort((a, b) => b.mentions - a.mentions || (a.key < b.key ? -1 : 1));
}

export function buildDialogues(papers) {
  const intra = [];
  const external = [];
  for (const paper of papers) {
    const works = extractCitedWorks(paper);
    for (const work of works) {
      const target = papers.find(other => other.id !== paper.id
        && String(other.year) === work.year
        && surnamesOf(other).some(s => s.toLowerCase() === work.surname.toLowerCase()));
      if (target) {
        intra.push({
          from: paper.id,
          to: target.id,
          label: work.key,
          mentions: work.mentions,
          kind: 'intra-batch',
          note: `${paper.year} 的这篇在正文里点了 ${target.year} 的这篇 ${work.mentions} 次。`,
        });
      } else {
        external.push({ from: paper.id, work: work.key, mentions: work.mentions, kind: 'external' });
      }
    }
  }
  return { intra, external };
}

// ─────────────────────────────────────────────────────────────
// 领域地图
// ─────────────────────────────────────────────────────────────
export function buildDomainMap(papers, cards, links, lexicon, ratings) {
  const nodes = new Map();
  const edges = [];
  const addNode = (node) => {
    if (!node?.id) return;
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  };
  const addEdge = (from, to, kind, label = '') => {
    if (!from || !to || from === to) return;
    const id = `${kind}:${from}->${to}`;
    if (edges.some(e => e.id === id)) return;
    edges.push({ id, from, to, kind, label });
  };

  for (const paper of papers) {
    addNode({
      id: paper.id, kind: 'paper', label: truncate(paper.title, 48),
      meta: { year: paper.year, grade: ratings.get(paper.id)?.grade || '', strategy: paper.strategy?.label || '', authors: paper.authors },
    });
  }
  for (const card of cards) {
    addNode({ id: card.id, kind: 'card', label: card.title_zh || card.id, meta: { shelf: card.shelf, status: card.status, confidence: card.confidence } });
  }
  for (const paper of papers) {
    for (const concept of paper.extract?.economic_concepts || []) {
      const id = `C:${concept}`;
      addNode({ id, kind: 'concept', label: String(concept) });
      addEdge(paper.id, id, 'uses-concept');
    }
    for (const theory of paper.extract?.economic_theories || []) {
      const id = `T:${theory}`;
      addNode({ id, kind: 'theory', label: String(theory) });
      addEdge(paper.id, id, 'grounds-on');
    }
    const methodId = `M:${paper.strategy?.id || 'OTHER'}`;
    addNode({ id: methodId, kind: 'method', label: paper.strategy?.label || '未标注', meta: { family: paper.strategy?.family, portable: paper.strategy?.portable } });
    addEdge(paper.id, methodId, 'uses-method');
  }
  for (const link of links.links) addEdge(link.paperId, link.cardId, `card-${link.strength}`);
  for (const card of cards) {
    for (const relation of card.relations || []) {
      if (!relation?.target) continue;
      addEdge(card.id, String(relation.target), 'card-relation', String(relation.type || ''));
    }
  }
  const dialogues = buildDialogues(papers);
  for (const edge of dialogues.intra) addEdge(edge.from, edge.to, 'cites', edge.label);

  const years = papers.map(p => Number(p.year) || 0).filter(Boolean);
  const eras = [];
  for (const paper of [...papers].sort((a, b) => (Number(a.year) || 0) - (Number(b.year) || 0))) {
    const year = String(paper.year || '未标注');
    let era = eras.find(e => e.year === year);
    if (!era) { era = { year, papers: [], concepts: [], theories: [] }; eras.push(era); }
    era.papers.push({ id: paper.id, title: truncate(paper.title, 40), grade: ratings.get(paper.id)?.grade || '' });
    era.concepts.push(...(paper.extract?.economic_concepts || []).map(String));
    era.theories.push(...(paper.extract?.economic_theories || []).map(String));
  }
  for (const era of eras) {
    era.concepts = [...new Set(era.concepts)].sort();
    era.theories = [...new Set(era.theories)].sort();
  }

  const dangling = edges.filter(e => !nodes.has(e.from) || !nodes.has(e.to));

  return {
    version: 1,
    generatedFrom: { papers: papers.map(p => p.id), cards: cards.length, lexicon: lexicon.strategies.version },
    nodes: [...nodes.values()].sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : 1)),
    edges,
    eras,
    timeline: { min: years.length ? Math.min(...years) : null, max: years.length ? Math.max(...years) : null, count: papers.length },
    dialogues: { intra: dialogues.intra, externalCount: dialogues.external.length },
    stats: {
      papers: papers.length,
      cards: cards.length,
      concepts: [...nodes.values()].filter(n => n.kind === 'concept').length,
      theories: [...nodes.values()].filter(n => n.kind === 'theory').length,
      methods: [...nodes.values()].filter(n => n.kind === 'method').length,
      edges: edges.length,
      danglingEdges: dangling.length,
    },
    dangling,
  };
}
