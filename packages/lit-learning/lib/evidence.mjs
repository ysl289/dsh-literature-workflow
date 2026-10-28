import { truncate } from './fsx.mjs';

/**
 * 证据状态机（清单 01 / 02）。
 *
 * 一个布尔 verified 把四件不同的事混成一件：来源是抽取还是现场定位、原文是否真能命中、
 * 页码段号是否核对过、这条证据是否真的支持当前这条主张。于是「引文在第 1 页却传了
 * page=999」也会被标成已核验。这里把四件事分开：
 *
 *   source    'extract'（抽取标注）| 'located'（现场定位）| 'record'（书目记录）
 *   match     'verbatim'（原文逐字命中）| 'none'
 *   pageCheck 'confirmed' | 'mismatch' | 'unknown'
 *   support   'direct'（证据就是这条主张）| 'ancestor'（只有父字段的证据）| 'none'
 *   state     'verified' | 'candidate' | 'unsupported' | 'record'
 *
 * 计分只认 verified 全分；candidate 半分；unsupported 不计分。
 */

const STATE_LABEL = {
  verified: '已核验',
  candidate: '待核验',
  unsupported: '无正文支持',
  record: '书目记录',
};

export function stateLabel(state) {
  return STATE_LABEL[state] || '未知';
}

function needlesOf(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const out = [];
  if (text.length >= 6 && text.length <= 160) out.push(text);
  const parts = text
    .split(/[；;。，,、\n（）()【】\[\]“”"'：:]/)
    .map(part => part.trim())
    .filter(part => part.length >= 6);
  out.push(...parts.slice(0, 6));
  const latin = text.match(/[A-Za-z][A-Za-z\-\s]{5,}/g) || [];
  out.push(...latin.map(s => s.trim()).filter(s => s.length >= 6).slice(0, 4));
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}

/**
 * 排版归一：把「同一段文字的不同排法」抹平。
 *
 * PDF→Markdown 会插入换行、表格管道符、以及 `_County_ _Establishments_` 这种强调标记。
 * 逐字比对会被这些排版噪声挡掉，于是真实存在的引文被误判成「抽取改写了原文」。
 * 这里只去掉排版字符（空白 / | / _ / *），不动任何实义字符 —— 命中仍要求文字连续且顺序一致。
 */
const LAYOUT_CHARS = /[\s|_*]/;

function buildNormalized(text) {
  const source = String(text || '');
  const chars = [];
  const map = [];
  for (let i = 0; i < source.length; i += 1) {
    if (LAYOUT_CHARS.test(source[i])) continue;
    chars.push(source[i]);
    map.push(i);
  }
  return { text: chars.join(''), map };
}

export function buildEvidenceIndex(extract, full, segments, pages) {
  const raw = Array.isArray(extract?.evidence) ? extract.evidence : [];
  const normalized = buildNormalized(full);
  const pageRows = (Array.isArray(pages) ? pages : [])
    .filter(page => Number.isFinite(Number(page?.startChar)) && Number(page?.page) > 0)
    .sort((a, b) => Number(a.startChar) - Number(b.startChar));
  const pageStarts = pageRows
    .map((page, index, list) => {
      const start = Number(page.startChar);
      const declaredEnd = Number(page.endChar);
      // Some Markdown/page manifests only carry startChar. Use the next page
      // start as the range end instead of treating the page as absent.
      const nextStart = Number(list[index + 1]?.startChar);
      const end = Number.isFinite(declaredEnd) && declaredEnd > start
        ? declaredEnd
        : (Number.isFinite(nextStart) && nextStart > start ? nextStart : full.length);
      return { page: Number(page.page), start, end };
    });

  const pageAt = offset => {
    if (!Number.isFinite(offset) || offset < 0) return null;
    const hit = pageStarts.find(row => offset >= row.start && offset < row.end);
    return hit ? hit.page : null;
  };
  const segmentAt = offset => {
    if (!Number.isFinite(offset) || offset < 0) return null;
    return (full.slice(0, offset).match(/\n{2,}/g) || []).length + 1;
  };
  const windowAround = (offset, length) => {
    const start = Math.max(0, offset - 40);
    const end = Math.min(full.length, offset + length + 40);
    return full.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 200);
  };

  /**
   * 在正文里找引文：先精确，再退到「排版归一」比对。
   * 归一命中会把偏移映射回原文位置，页码与段号仍然按原文算。
   */
  function findQuote(quote) {
    const needle = String(quote || '').trim();
    if (!needle) return null;
    const exact = full.indexOf(needle);
    if (exact >= 0) return { at: exact, match: 'verbatim', via: 'exact' };

    const squashed = buildNormalized(needle).text;
    if (squashed.length >= 12) {
      const at = normalized.text.indexOf(squashed);
      if (at >= 0) {
        return { at: normalized.map[at], match: 'verbatim', via: 'layout' };
      }
    }
    return null;
  }

  const entries = raw.map(item => {
    const quote = String(item?.quote ?? '').trim();
    // 注意 Number(null) === 0：page 为空时不能当成「第 0 页」，否则会被判成页号不符。
    const rawPage = item?.page;
    const declaredPage = rawPage === null || rawPage === undefined || String(rawPage).trim() === ''
      ? null
      : (Number.isFinite(Number(rawPage)) && Number(rawPage) > 0 ? Number(rawPage) : null);
    const hit = quote ? findQuote(quote) : null;
    const at = hit?.at ?? -1;
    const computedPage = at >= 0 ? pageAt(at) : null;
    const segment = at >= 0 ? segmentAt(at) : null;

    const match = hit ? 'verbatim' : 'none';
    const pageCheck = !hit ? 'unknown'
      : (declaredPage == null || computedPage == null) ? 'unknown'
        : declaredPage === computedPage ? 'confirmed' : 'mismatch';

    let state = 'candidate';
    let reason = '';
    if (!hit) {
      reason = '抽取给了引文，但正文里找不到这段原文，只能算字段级证据';
    } else if (pageCheck === 'mismatch') {
      state = 'candidate';
      reason = `抽取标的是第 ${declaredPage} 页，原文实际在第 ${computedPage} 页`;
    } else {
      state = 'verified';
      const where = pageCheck === 'confirmed' ? `第 ${computedPage} 页，页码已核对` : '原文命中，页码未知';
      reason = hit.via === 'layout' ? `${where}（忽略换行与排版标记后逐字命中）` : where;
    }

    return {
      field: String(item?.field ?? ''),
      quote,
      // 只有真的在正文里定位到，才允许对外报页码；否则声明页码只留作审计，
      // 不能让它把「正文找不到」的引文算成「带页码可定位」（清单 01/02）。
      page: hit ? computedPage : null,
      declaredPage,
      computedPage,
      segment,
      source: 'extract',
      match,
      matchedVia: hit?.via || '',
      pageCheck,
      // Position/match is not semantic support. Keep this explicitly unassessed;
      // fieldRelation says whether this is the exact field or an ancestor.
      support: 'unknown',
      supportStatus: 'unassessed',
      fieldRelation: 'exact',
      state,
      reason,
      verified: state === 'verified',
    };
  });

  const byField = new Map();
  for (const entry of entries) {
    if (!entry.field) continue;
    if (!byField.has(entry.field)) byField.set(entry.field, []);
    byField.get(entry.field).push(entry);
  }

  /** 现场定位：拿字段值当锚点，在正文里找到它，页码与段号都是算出来的。 */
  function locate(value) {
    for (const needle of needlesOf(value)) {
      const hit = findQuote(needle);
      if (!hit) continue;
      const at = hit.at;
      const page = pageAt(at);
      const segment = segmentAt(at);
      const pageCheck = page === null ? 'unknown' : 'confirmed';
      return {
        field: '',
        quote: windowAround(at, needle.length),
        page,
        declaredPage: null,
        computedPage: page,
        segment,
        source: 'located',
        match: 'verbatim',
        matchedVia: hit.via,
        pageCheck,
        support: 'unknown',
        supportStatus: 'unassessed',
        fieldRelation: 'exact',
        state: 'verified',
        reason: pageCheck === 'confirmed'
          ? '按字段值在正文中定位，页码由字符偏移算出并核对'
          : '按字段值在正文中定位；页表未提供可核对页码',
        verified: true,
        anchor: needle.slice(0, 40),
      };
    }
    return null;
  }

  function resolve(field, value) {
    if (!field) return [];
    const exact = byField.get(field);
    if (exact?.length) return exact;

    const prefix = `${field}.`;
    const children = [];
    for (const [key, list] of byField) if (key.startsWith(prefix)) children.push(...list);
    if (children.length) return children;

    // 祖先字段：抽取只标到 design.identification 时，子字段只能算「候选」，
    // 不能拿父字段的证据冒充这一条主张已被核验（清单 01）。
    const parts = field.split('.');
    for (let cut = parts.length - 1; cut >= 1; cut--) {
      const ancestor = parts.slice(0, cut).join('.');
      const hit = byField.get(ancestor);
      if (hit?.length) {
        return hit.map(entry => ({
          ...entry,
          requestedField: field,
          support: 'ancestor',
          supportStatus: 'unassessed',
          fieldRelation: 'ancestor',
          state: entry.state === 'unsupported' ? 'unsupported' : 'candidate',
          reason: `${entry.reason}；但这条证据标在父字段 ${ancestor} 上，未直接支持 ${field}`,
          verified: false,
        }));
      }
    }

    if (value !== undefined && value !== null && String(value).trim()) {
      const located = locate(value);
      if (located) return [{ ...located, field }];
      // 字段级证据：只留一个短指针，不整段复制原值。
      // 摘要尤其不能抄 —— 学习层的产物里出现摘要原文，等于凭空多出一份摘要（清单 10）。
      const isAbstract = field === 'abstract';
      return [{
        field,
        quote: isAbstract ? '' : truncate(String(value).replace(/\s+/g, ' ').trim(), 40),
        page: null,
        declaredPage: null,
        computedPage: null,
        segment: null,
        source: 'extract',
        match: 'none',
        pageCheck: 'unknown',
        support: 'none',
        supportStatus: 'unassessed',
        fieldRelation: 'none',
        state: 'candidate',
        reason: isAbstract
          ? '取自摘要：摘要不是正文，只能当线索，需回原文核对；这里只记来源，不复制摘要原文'
          : '正文里定位不到这个字段值（通常是抽取改写了原文），只能算字段级证据',
        verified: false,
      }];
    }
    return [];
  }

  /** 书目记录：期刊名这类事实来自抽取记录本身，页码未知就写未知，不伪造第 1 页。 */
  function record(field, value) {
    const text = String(value ?? '').trim();
    if (!text) return [];
    const located = locate(text);
    if (located) {
      const pageConfirmed = located.pageCheck === 'confirmed';
      return [{
        ...located,
        field,
        source: 'record',
        state: pageConfirmed ? 'verified' : 'record',
        reason: pageConfirmed
          ? '书目信息在正文中找到，页码已核对'
          : '书目信息在正文中找到，但页表没有可核对页码',
      }];
    }
    return [{
      field,
      quote: truncate(text, 180),
      page: null,
      declaredPage: null,
      computedPage: null,
      segment: null,
      source: 'record',
      match: 'none',
      pageCheck: 'unknown',
      support: 'unknown',
      supportStatus: 'unassessed',
      fieldRelation: 'none',
      state: 'record',
      reason: '书目记录，正文未定位，页码未知',
      verified: false,
    }];
  }

  const stats = entries.reduce((acc, entry) => {
    acc[entry.state] = (acc[entry.state] || 0) + 1;
    return acc;
  }, { verified: 0, candidate: 0, unsupported: 0, record: 0 });

  return {
    entries,
    byField,
    resolve,
    record,
    locate,
    stats,
    verifiedCount: stats.verified,
    candidateCount: stats.candidate,
    unsupportedCount: stats.unsupported,
    total: entries.length,
  };
}
