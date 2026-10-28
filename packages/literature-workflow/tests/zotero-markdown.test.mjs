import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  ZoteroClient,
  ZoteroMarkdownAttachmentUnsupportedError,
} from '../lib/zotero.mjs';

const API = 'http://127.0.0.1:23119/api/';
const SERVER_ID = 'markdown-test-server';
const AUTH = { key: 'mock-local-secret-key', remember: true, serverId: SERVER_ID };
const MARKDOWN = Buffer.from('# Markdown-only paper\n\nA local fixture.\n', 'utf8');
const MARKDOWN_MD5 = createHash('md5').update(MARKDOWN).digest('hex');
const MARKDOWN_SHA256 = createHash('sha256').update(MARKDOWN).digest('hex');

function apiResponse(status, body, headers = {}) {
  const responseHeaders = new Headers({
    'Zotero-Server-ID': SERVER_ID,
    'Zotero-API-Version': '3',
    'Last-Modified-Version': '17',
    ...headers,
  });
  const payload = body === null || body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
  return new Response(payload, { status, headers: responseHeaders });
}

async function requestBytes(body) {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function makeFixture(t, { existingMarkdown = false, rejectMarkdownAt = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zotero-markdown-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const markdownPath = path.join(root, 'paper.md');
  const storagePath = path.join(root, 'storage', 'MDATT001', 'paper.md');
  await writeFile(markdownPath, MARKDOWN);
  await mkdir(path.dirname(storagePath), { recursive: true });
  await writeFile(storagePath, MARKDOWN);

  const parentKey = 'PARENT01';
  let attachmentKey = 'MDATT001';
  const parent = {
    key: parentKey,
    version: 1,
    data: {
      key: parentKey,
      version: 1,
      itemType: 'journalArticle',
      title: 'A Markdown-only paper',
      DOI: '10.1234/markdown-only',
      collections: ['OLD22222'],
    },
  };
  let storageFilePath = storagePath;
  const existingAttachment = {
    key: attachmentKey,
    data: {
      key: attachmentKey,
      itemType: 'attachment',
      parentItem: parentKey,
      linkMode: 'imported_file',
      contentType: 'text/markdown',
      filename: 'paper.md',
      md5: MARKDOWN_MD5,
    },
  };
  const items = new Map([[parentKey, parent]]);
  if (existingMarkdown) items.set(attachmentKey, existingAttachment);
  const collections = [
    { key: 'ROOT0001', data: { key: 'ROOT0001', name: 'Research', parentCollection: false } },
    { key: 'CHILD001', data: { key: 'CHILD001', name: 'Innovation', parentCollection: 'ROOT0001' } },
    { key: 'OLD22222', data: { key: 'OLD22222', name: 'Existing', parentCollection: false } },
  ];
  const calls = [];
  let uploadedBytes = null;
  let attachmentCreateCount = 0;
  let uploadAuthorizationCount = 0;
  let uploadRegisterCount = 0;

  const client = new ZoteroClient({
    base: API,
    getAuth: async () => AUTH,
    fetchImpl: async (input, options = {}) => {
      const url = new URL(input);
      const method = options.method ?? 'GET';
      calls.push({ url, method, options });

      if (url.pathname === '/api/') return apiResponse(200, {});
      if (url.pathname === '/api/users/0/collections') return apiResponse(200, collections);
      if (url.pathname === '/api/users/0/items' && method === 'GET') return apiResponse(200, [...items.values()]);
      if (url.pathname === '/api/users/0/items' && method === 'POST') {
        const item = JSON.parse(options.body)[0];
        if (item.itemType === 'attachment') {
          attachmentCreateCount += 1;
          assert.equal(item.contentType, 'text/markdown');
          assert.equal(item.filename, 'paper.md');
          if (rejectMarkdownAt === 'create') return apiResponse(415, { error: 'unsupported content type' });
          attachmentKey = item.key;
          storageFilePath = path.join(root, 'storage', attachmentKey, 'paper.md');
          await mkdir(path.dirname(storageFilePath), { recursive: true });
          await writeFile(storageFilePath, MARKDOWN);
        }
        const saved = { key: item.key, version: 2, data: { ...item, version: 2 } };
        items.set(item.key, saved);
        return apiResponse(200, { successful: { 0: saved } });
      }
      if (url.pathname === `/api/users/0/items/${parentKey}` && method === 'GET') return apiResponse(200, items.get(parentKey));
      if (url.pathname === `/api/users/0/items/${parentKey}` && method === 'PUT') {
        const update = JSON.parse(options.body);
        const saved = { key: parentKey, version: 2, data: { ...update, version: 2 } };
        items.set(parentKey, saved);
        return apiResponse(204, null);
      }
      if (url.pathname === `/api/users/0/items/${parentKey}/children`) {
        return apiResponse(200, [...items.values()].filter((item) => item.data?.parentItem === parentKey));
      }
      if (url.pathname === `/api/users/0/items/${attachmentKey}` && method === 'GET') return apiResponse(200, items.get(attachmentKey));
      if (url.pathname === `/api/users/0/items/${attachmentKey}/file/view/url`) return apiResponse(200, pathToFileURL(storageFilePath).href);
      if (url.pathname === `/api/users/0/items/${attachmentKey}/file` && method === 'POST') {
        const body = String(options.body);
        if (body.startsWith('upload=')) {
          uploadRegisterCount += 1;
          if (rejectMarkdownAt === 'register') return apiResponse(415, { error: 'unsupported content type' });
          const item = items.get(attachmentKey);
          item.data.md5 = MARKDOWN_MD5;
          item.data.contentType = 'text/markdown';
          item.data.mtime = '1000';
          return apiResponse(204, null);
        }
        uploadAuthorizationCount += 1;
        if (rejectMarkdownAt === 'authorize') return apiResponse(415, { error: 'unsupported content type' });
        assert.match(body, new RegExp(`md5=${MARKDOWN_MD5}`));
        assert.match(body, /filename=paper\.md/u);
        return apiResponse(200, {
          url: '/api/local/uploads/markdown-upload-token',
          uploadKey: 'markdown-upload-token',
          contentType: 'application/octet-stream',
        });
      }
      if (url.pathname === '/api/local/uploads/markdown-upload-token') {
        uploadedBytes = await requestBytes(options.body);
        return new Response(null, { status: 201 });
      }
      assert.fail(`Unexpected request ${method} ${url.href}`);
    },
  });

  return {
    client,
    calls,
    items,
    markdownPath,
    get storagePath() { return storageFilePath; },
    parentKey,
    get attachmentKey() { return attachmentKey; },
    get uploadedBytes() { return uploadedBytes; },
    get attachmentCreateCount() { return attachmentCreateCount; },
    get uploadAuthorizationCount() { return uploadAuthorizationCount; },
    get uploadRegisterCount() { return uploadRegisterCount; },
  };
}

test('Markdown import deduplicates the DOI/title parent, preserves old collections, and verifies an imported text/markdown attachment', async (t) => {
  const fixture = await makeFixture(t);
  const receipt = {};
  const snapshots = [];
  const result = await fixture.client.importMarkdown({
    metadata: { title: 'A Markdown-only paper', doi: 'https://doi.org/10.1234/markdown-only' },
    markdownPath: fixture.markdownPath,
    collectionPath: ['Research', 'Innovation'],
    rootName: '',
    receipt,
    saveReceipt: async (value) => snapshots.push(JSON.parse(JSON.stringify(value))),
  });

  assert.equal(result.parentKey, fixture.parentKey);
  assert.equal(result.attachmentKey, fixture.attachmentKey);
  assert.equal(result.storagePath, fixture.storagePath);
  assert.equal(result.reused, true, 'the existing parent is reused while the new Markdown attachment is imported');
  assert.equal(result.md5, MARKDOWN_MD5);
  assert.equal(result.sha256, MARKDOWN_SHA256);
  assert.deepEqual(fixture.items.get(fixture.parentKey).data.collections, ['OLD22222', 'CHILD001']);
  assert.equal(fixture.items.get(fixture.attachmentKey).data.contentType, 'text/markdown');
  assert.deepEqual(fixture.uploadedBytes, MARKDOWN);
  assert.equal(fixture.attachmentCreateCount, 1);
  assert.equal(fixture.uploadAuthorizationCount, 1);
  assert.equal(fixture.uploadRegisterCount, 1);
  assert.equal(receipt.zoteroLocal.import.fileKind, 'markdown');
  assert.doesNotThrow(() => JSON.stringify(receipt));
  assert.ok(snapshots.some((snapshot) => Object.values(snapshot.zoteroLocal.operations).some((operation) => operation.state === 'in_flight')));
  assert.ok(fixture.calls.every((call) => call.url.origin === new URL(API).origin));
});

test('a matching existing Markdown attachment is reused without another upload', async (t) => {
  const fixture = await makeFixture(t, { existingMarkdown: true });
  const result = await fixture.client.importMarkdown({
    metadata: { title: 'A Markdown-only paper', DOI: '10.1234/markdown-only' },
    markdownPath: fixture.markdownPath,
    collectionPath: ['Research', 'Innovation'],
    rootName: '',
  });

  assert.equal(result.parentKey, fixture.parentKey);
  assert.equal(result.attachmentKey, fixture.attachmentKey);
  assert.equal(result.reused, true);
  assert.equal(fixture.attachmentCreateCount, 0);
  assert.equal(fixture.uploadAuthorizationCount, 0);
  assert.equal(fixture.uploadRegisterCount, 0);
});

for (const stage of ['create', 'authorize', 'register']) {
test(`a Local API rejection of text/markdown during ${stage} is explicit and leaves a JSON-safe resumable receipt`, async (t) => {
  const fixture = await makeFixture(t, { rejectMarkdownAt: stage });
  const receipt = {};
  await assert.rejects(
    fixture.client.importMarkdown({
      metadata: { title: 'A Markdown-only paper', DOI: '10.1234/markdown-only' },
      markdownPath: fixture.markdownPath,
      collectionPath: ['Research', 'Innovation'],
      rootName: '',
      receipt,
    }),
    (error) => error instanceof ZoteroMarkdownAttachmentUnsupportedError
      && error.code === 'ZOTERO_MARKDOWN_ATTACHMENT_UNSUPPORTED'
      && error.status === 415,
  );

  assert.equal(receipt.zoteroLocal.import.state, undefined);
  const operationSuffix = stage === 'create' ? 'create-attachment' : `file-${stage}`;
  assert.equal(receipt.zoteroLocal.operations[`${receipt.zoteroLocal.import.id}:${operationSuffix}`].state, 'prepared');
  assert.doesNotThrow(() => JSON.stringify(receipt));
  assert.equal(fixture.uploadAuthorizationCount, stage === 'create' ? 0 : 1);
  assert.equal(fixture.uploadRegisterCount, stage === 'register' ? 1 : 0);
});
}

test('Markdown imports require a Markdown filename and never run the PDF signature check', async (t) => {
  const fixture = await makeFixture(t);
  const wrongExtension = path.join(path.dirname(fixture.markdownPath), 'paper.txt');
  await writeFile(wrongExtension, MARKDOWN);
  await assert.rejects(
    fixture.client.importMarkdown({ markdownPath: wrongExtension }),
    /\.md or \.markdown/u,
  );

  const receipt = {};
  const result = await fixture.client.importMarkdown({
    metadata: { title: 'A Markdown-only paper', DOI: '10.1234/markdown-only' },
    markdownPath: fixture.markdownPath,
    collectionPath: [],
    rootName: '',
    receipt,
  });
  assert.equal(result.sha256, MARKDOWN_SHA256);
  assert.equal(receipt.zoteroLocal.import.fileKind, 'markdown');
});
