import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalizeMarkdownText, prepareMarkdown } from '../lib/markdown.mjs';
import { DEFAULT_PIPELINE, validatePipeline } from '../lib/pipeline.mjs';

async function temporaryDir(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-markdown-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('Markdown import stores normalized complete text as bounded line-aware segments', async t => {
  const root = await temporaryDir(t);
  const markdownText = `# 题目\r\n\r\n${Array.from({ length: 850 }, (_, i) => `第${i + 1}行：创新融资与大学专利🙂。`).join('\r\n')}\r\n`;
  const prepared = await prepareMarkdown({ markdownText: Buffer.from(markdownText, 'utf8'), jobDir: path.join(root, 'job'), sourceName: '../../outside.md' });
  const normalized = normalizeMarkdownText(markdownText);
  const saved = await fs.readFile(prepared.markdownPath, 'utf8');
  const pages = JSON.parse(await fs.readFile(prepared.pagesPath, 'utf8'));

  assert.equal(saved, normalized);
  assert.equal(prepared.mdPath, prepared.markdownPath);
  assert.equal(prepared.sourceFormat, 'markdown');
  assert.equal(prepared.sourceKind, 'markdown');
  assert.equal(prepared.citationUnit, 'segment');
  assert.deepEqual(prepared.scanPages, []);
  assert.equal(prepared.pageCount, pages.length);
  assert.equal(pages.map(page => page.text).join(''), normalized);
  assert.ok(pages.length > 1);
  assert.deepEqual(pages.map(page => page.page), pages.map((_, i) => i + 1));
  assert.ok(pages.every(page => page.sourceKind === 'markdown_segment' && page.citationUnit === 'segment'));
  assert.ok(pages.every(page => page.startLine >= 1 && page.endLine >= page.startLine));
  assert.ok(pages.every(page => Array.from(page.text).length <= 12_000));
  assert.deepEqual(pages.map(({ startChar, endChar }) => [startChar, endChar]), pages.map((page, i) => [i ? pages[i - 1].endChar : 0, (i ? pages[i - 1].endChar : 0) + Array.from(page.text).length]));
  assert.equal(path.dirname(prepared.markdownPath), path.resolve(root, 'job'));
  assert.equal(prepared.sourceName, '../../outside.md');
  await assert.rejects(fs.access(path.resolve(root, 'outside.md')));
  assert.ok(pages.every(page => !Object.hasOwn(page, 'pdfPage')));
});

test('long single lines split on Unicode boundaries and preserve their source line range', async t => {
  const root = await temporaryDir(t);
  const markdownText = `${'🙂'.repeat(12_050)}\n${'字'.repeat(12_010)}`;
  const prepared = await prepareMarkdown({ markdownText, jobDir: path.join(root, 'job') });
  const pages = JSON.parse(await fs.readFile(prepared.pagesPath, 'utf8'));

  assert.equal(pages.map(page => page.text).join(''), markdownText);
  assert.ok(pages.every(page => Array.from(page.text).length <= 12_000));
  assert.ok(pages.slice(0, 2).every(page => page.startLine === 1 && page.endLine === 1));
  assert.ok(pages.slice(2).every(page => page.startLine === 2 && page.endLine === 2));
});

test('Markdown validation rejects empty input, invalid UTF-8, NUL, and lone surrogates', async t => {
  const root = await temporaryDir(t);
  assert.throws(() => normalizeMarkdownText(' \r\n\t'), /不能为空/);
  assert.throws(() => normalizeMarkdownText(Buffer.from([0xc3, 0x28])), /有效的 UTF-8/);
  assert.throws(() => normalizeMarkdownText('a\0b'), /NUL/);
  assert.throws(() => normalizeMarkdownText('\ud800'), /Unicode/);
  await assert.rejects(prepareMarkdown({ markdownText: '', jobDir: path.join(root, 'job') }), /不能为空/);
});

test('Markdown input can classify and read without being treated as a PDF', () => {
  assert.equal(validatePipeline(DEFAULT_PIPELINE, { inputKind: 'markdown' }).valid, true);
  assert.equal(validatePipeline(['import', 'prepare', 'read'], { inputKind: 'md' }).valid, true);
  assert.equal(validatePipeline(['import', 'zotero'], { inputKind: 'markdown' }).valid, false, 'metadata is still required');
  assert.equal(validatePipeline(['import', 'zotero'], { inputKind: 'markdown', hasMetadata: true }).valid, true);
  assert.equal(validatePipeline(['import', 'prepare', 'read']).valid, true, 'PDF import behavior remains available');
});
