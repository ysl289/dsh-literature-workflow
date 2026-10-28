import { promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_SEGMENT_CODEPOINTS = 12_000;

/** Decode Markdown without accepting malformed UTF-8 or embedded NUL bytes. */
export function normalizeMarkdownText(markdownText) {
  let text;
  if (typeof markdownText === 'string') {
    text = markdownText;
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = text.charCodeAt(i + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('Markdown 包含无效的 Unicode 字符');
        i++;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        throw new TypeError('Markdown 包含无效的 Unicode 字符');
      }
    }
  } else if (Buffer.isBuffer(markdownText) || markdownText instanceof Uint8Array) {
    try {
      // Keep a leading BOM as source text so the saved Markdown remains faithful.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(markdownText);
    } catch {
      throw new TypeError('Markdown 必须是有效的 UTF-8 文本');
    }
  } else {
    throw new TypeError('Markdown 必须是字符串或 UTF-8 字节');
  }

  if (text.includes('\0')) throw new TypeError('Markdown 不能包含 NUL 字符');
  text = text.replace(/\r\n?/g, '\n');
  if (!text.trim()) throw new TypeError('Markdown 内容不能为空');
  return text;
}

function splitMarkdown(text) {
  const codepoints = Array.from(text);
  const segments = [];
  let start = 0;
  let startLine = 1;

  while (start < codepoints.length) {
    let end = Math.min(start + MAX_SEGMENT_CODEPOINTS, codepoints.length);
    if (end < codepoints.length) {
      // Prefer a complete source line when one fits near the segment boundary.
      for (let i = end - 1; i >= start; i--) {
        if (codepoints[i] === '\n') {
          end = i + 1;
          break;
        }
      }
    }
    // Array.from and these slices operate on Unicode code points, so surrogate
    // pairs are never split even when one source line exceeds the size limit.
    const chars = codepoints.slice(start, end);
    const segmentText = chars.join('');
    const newlineCount = chars.reduce((count, char) => count + (char === '\n' ? 1 : 0), 0);
    const endLine = startLine + newlineCount - (chars.at(-1) === '\n' ? 1 : 0);
    segments.push({
      page: segments.length + 1,
      sourceKind: 'markdown_segment',
      citationUnit: 'segment',
      startLine,
      endLine,
      // Offsets count Unicode code points; endChar is exclusive.
      startChar: start,
      endChar: end,
      text: segmentText,
    });
    start = end;
    startLine += newlineCount;
  }
  return segments;
}

/**
 * Save a validated Markdown source and bounded, line-aware reading segments.
 * All writes use fixed filenames inside the caller-provided protected jobDir;
 * sourceName is metadata only and never becomes a path or executable input.
 */
export async function prepareMarkdown({ markdownText, jobDir, sourceName = 'source.md' } = {}) {
  if (typeof jobDir !== 'string' || !jobDir.trim()) throw new TypeError('需要任务目录');
  const text = normalizeMarkdownText(markdownText);
  const safeJobDir = path.resolve(jobDir);
  const markdownPath = path.join(safeJobDir, 'full.md');
  const pagesPath = path.join(safeJobDir, 'pages.json');
  const pages = splitMarkdown(text);

  await fs.mkdir(safeJobDir, { recursive: true });
  await fs.writeFile(markdownPath, text, 'utf8');
  await fs.writeFile(pagesPath, `${JSON.stringify(pages, null, 2)}\n`, 'utf8');

  return {
    markdownPath,
    mdPath: markdownPath,
    pagesPath,
    pageCount: pages.length,
    scanPages: [],
    sourceFormat: 'markdown',
    sourceKind: 'markdown',
    citationUnit: 'segment',
    sourceName: String(sourceName),
  };
}
