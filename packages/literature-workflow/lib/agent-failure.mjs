// Persist diagnostics, never request objects, headers, bodies or raw server replies.
const redact = value => String(value)
  .replace(/Bearer\s+\S+/gi, 'Bearer [隐藏]')
  .replace(/sk-[\w-]+/g, '[隐藏]')
  .replace(/https?:\/\/[^\s"'<>]+/gi, '[请求地址]')
  .replace(/\b(?:token|secret|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, '[凭证已隐藏]');
const codeOf = error => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : '';

export function describeAgentFailure(error) {
  const parts = [], seen = new Set();
  for (let current = error; current && parts.length < 5 && !seen.has(current); current = current.cause) {
    seen.add(current);
    const code = codeOf(current);
    // The outer provider message is already public. Nested provider response
    // bodies may contain private data; expose only codes and local TypeErrors.
    const message = parts.length === 0
      ? redact(current.message || current).slice(0, 600)
      : current instanceof TypeError
        ? redact(current.message).slice(0, 250)
        : code ? '' : String(current.name || 'Error');
    parts.push([code && `[${code}]`, message].filter(Boolean).join(' '));
  }
  return parts.filter(Boolean).join(' → ').slice(0, 1200);
}
