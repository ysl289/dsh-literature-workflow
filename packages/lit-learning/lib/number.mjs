/**
 * 数值语义：解析、方向、缺失。
 *
 * 清单 05 的根因是「各处自己判符号」：indices 用正则看首字符，derive 用另一套，
 * 于是 U+2212 负号、全角负号、区间、占位符、零各有各的结论。
 * 这里只留一套解析，所有模块都从 status / sign / kind 取结论。
 */

const PLACEHOLDER = /^(?:【待补】|【待核对[^】]*】|—|–|-|－|n\.s\.?|n\/a|na|null|none|nil|待补|未知|未报告|未给出)$/i;

const NUMBER_BODY = '(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
const SIGNED_NUMBER = `[+-]?${NUMBER_BODY}`;

/** 只去掉合法的千分位；1,2 / 12,34 这类非法逗号留给 invalid，不能变成十倍量级。 */
function stripLegalThousands(text) {
  if (!text.includes(',')) return { ok: true, text };
  const legal = /[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:e[+-]?\d+)?%?/gi;
  const stripped = text.replace(legal, match => match.replace(/,/g, ''));
  return stripped.includes(',') ? { ok: false, text } : { ok: true, text: stripped };
}

/** 把各种负号统一成 ASCII 减号。U+2212 是最常见的坑。 */
export function normalizeSigns(text) {
  return String(text ?? '')
    .replace(/[\u2212\u2013\u2014\u2015\uFF0D\uFE63]/g, '-')
    .replace(/\u00A0/g, ' ');
}

function signOfValue(value) {
  if (!Number.isFinite(value)) return 'unknown';
  if (value > 0) return 'positive';
  if (value < 0) return 'negative';
  return 'zero';
}

/**
 * 解析一个量。
 * @returns {{
 *   raw: string, text: string, value: number|null, status: 'ok'|'missing'|'invalid'|'range',
 *   sign: 'positive'|'negative'|'zero'|'unknown', kind: 'number'|'percent'|'scientific'|'range',
 *   unit: string, note: string
 * }}
 */
export function parseQuantity(raw) {
  const original = String(raw ?? '').trim();
  const base = {
    raw: original,
    text: original,
    value: null,
    status: 'invalid',
    sign: 'unknown',
    kind: 'number',
    unit: '',
    note: '',
  };

  if (!original) return { ...base, status: 'missing', note: '空值' };

  const text = normalizeSigns(original).replace(/\s+/g, ' ').trim();
  if (!text) return { ...base, status: 'missing', note: '空值' };
  if (PLACEHOLDER.test(text)) return { ...base, text, status: 'missing', note: '占位符，不是数值' };

  // 去掉显著性星号、括注；千分位只认合法分组（1,234.50），1,2 保持 invalid。
  const withoutNoise = text
    .replace(/\*+/g, '')
    .replace(/[（(]\s*(?:标准误|se|s\.e\.)[^）)]*[）)]/gi, '')
    .trim();
  const commaCheck = stripLegalThousands(withoutNoise);
  if (!commaCheck.ok) {
    return { ...base, text, status: 'invalid', note: '逗号不是合法千分位（如 1,234.50），不参与比较' };
  }
  const cleaned = commaCheck.text.trim();

  // 区间：0.11–0.23 / 11% 至 23%；允许 -.25 / +0.25 与省略整数位
  const range = new RegExp(`^(${SIGNED_NUMBER})\\s*%?\\s*(?:-|~|～|至|到|—)\\s*(${SIGNED_NUMBER})\\s*%?$`).exec(cleaned);
  if (range) {
    const low = Number(range[1]);
    const high = Number(range[2]);
    const sameSign = signOfValue(low) === signOfValue(high) ? signOfValue(low) : 'unknown';
    return {
      ...base,
      text,
      value: null,
      status: 'range',
      sign: sameSign,
      kind: 'range',
      note: `区间 ${range[1]}–${range[2]}，不能当点估计比较`,
    };
  }

  const percent = new RegExp(`^(${SIGNED_NUMBER})\\s*%$`).exec(cleaned);
  if (percent) {
    const value = Number(percent[1]);
    return { ...base, text, value, status: 'ok', sign: signOfValue(value), kind: 'percent', unit: '%' };
  }

  const scientific = new RegExp(`^${SIGNED_NUMBER}e[+-]?\\d+$`, 'i').test(cleaned);
  const numeric = new RegExp(`^${SIGNED_NUMBER}$`).test(cleaned) || scientific;
  if (!numeric) {
    return { ...base, text, status: 'invalid', note: '无法解析为数值（保留原文，不参与比较）' };
  }

  const value = Number(cleaned);
  if (!Number.isFinite(value)) return { ...base, text, status: 'invalid', note: '数值溢出或非法' };
  return {
    ...base,
    text,
    value,
    status: 'ok',
    sign: signOfValue(value),
    kind: scientific ? 'scientific' : 'number',
  };
}

export function signLabel(sign) {
  return { positive: '正向', negative: '负向', zero: '零效应', unknown: '未标注' }[sign] || '未标注';
}

/** 量级能否进入跨篇比较：必须是点估计，且主题单位已声明。 */
export function isComparable(parsed, themeUnit) {
  if (!parsed || parsed.status !== 'ok') return false;
  if (parsed.kind === 'range') return false;
  if (!themeUnit || themeUnit === '未归类') return false;
  return true;
}
