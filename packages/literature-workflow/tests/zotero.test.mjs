import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ZoteroAmbiguousMatchError,
  ZoteroApiError,
  ZoteroClient,
  ZoteroUnknownWriteError,
} from '../lib/zotero.mjs';

const API = 'http://127.0.0.1:23119/api/';
const SERVER_ID = 'test-server-id';
const AUTH = { key: 'mock-local-secret-key', remember: true, serverId: SERVER_ID };
const PDF = Buffer.from('%PDF-1.7\nmock Zotero adapter PDF\n%%EOF\n', 'utf8');
const PDF_MD5 = createHash('md5').update(PDF).digest('hex');

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

function makeClient(fetchImpl, { getAuth = async () => AUTH, setAuth = async () => {} } = {}) {
  return new ZoteroClient({ base: API, fetchImpl, getAuth, setAuth });
}

async function withPdf(callback) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zotero-adapter-'));
  const pdfPath = path.join(dir, 'paper.pdf');
  await writeFile(pdfPath, PDF);
  try {
    await callback(pdfPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function bodyBytes(body) {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function expectWriteHeaders(options, { apiKey = true, serverId = true } = {}) {
  const headers = new Headers(options.headers);
  assert.equal(headers.get('Zotero-Server-ID'), serverId ? SERVER_ID : null);
  if (apiKey) assert.equal(headers.get('Zotero-API-Key'), AUTH.key);
  else assert.equal(headers.get('Zotero-API-Key'), null);
}

test('health and explicit authorization store the key without returning it', async () => {
  let stored;
  const calls = [];
  const client = makeClient(async (input, options) => {
    const url = new URL(input);
    calls.push({ url, options });
    if (url.pathname === '/api/') return apiResponse(200, {});
    assert.equal(url.pathname, '/api/local/authorize');
    assert.equal(options.method, 'POST');
    const headers = new Headers(options.headers);
    assert.equal(headers.get('Zotero-Server-ID'), SERVER_ID);
    assert.equal(headers.get('Zotero-API-Key'), null);
    assert.deepEqual(JSON.parse(options.body), { appName: '文献积累工作流' });
    return apiResponse(200, { key: 'authorization-secret-1234567890', remember: true });
  }, {
    getAuth: async () => undefined,
    setAuth: async (key, metadata) => { stored = { key, metadata }; },
  });

  const health = await client.health();
  assert.deepEqual(health, { version: '3', serverId: SERVER_ID, writeAuthorized: false });
  const result = await client.authorize();
  assert.deepEqual(result, { authorized: true, remember: true, serverId: SERVER_ID });
  assert.equal(stored.key, 'authorization-secret-1234567890');
  assert.deepEqual(stored.metadata, { serverId: SERVER_ID, remember: true });
  assert.equal(JSON.stringify(result).includes(stored.key), false);
  assert.equal(calls.length, 3);
});

test('Zotero health and authorization time out instead of holding the settings page indefinitely', async () => {
  const keepAlive=setInterval(()=>{},1000);
  const hang=options=>new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
  try{
    const offline=makeClient(async(_url,options)=>hang(options));
    await assert.rejects(offline.health({timeoutMs:15}),{name:'TimeoutError'});
    let stored=false;
    const waiting=makeClient(async(url,options)=>new URL(url).pathname==='/api/'?apiResponse(200,{}):hang(options),{setAuth:async()=>{stored=true}});
    await assert.rejects(waiting.authorize({timeoutMs:15}),{name:'TimeoutError'});
    assert.equal(stored,false,'an incomplete authorization never stores a key');
  }finally{clearInterval(keepAlive)}
});

test('collections are fully paged, expose parent paths, and reuse case-normalized hierarchy', async () => {
  const calls = [];
  const parent = { key: 'AAAA2222', name: '研究方向', parentCollection: false };
  const child = { key: 'BBBB2222', name: '创新金融', parentCollection: parent.key };
  const client = makeClient(async (input, options) => {
    const url = new URL(input);
    calls.push({ url, options });
    if (url.pathname === '/api/') return apiResponse(200, {});
    if (url.pathname === '/api/users/0/collections' && url.searchParams.get('start') === '0') {
      return apiResponse(200, [{ key: parent.key, data: parent }], {
        Link: `</api/users/0/collections?limit=100&start=1>; rel="next"`,
      });
    }
    if (url.pathname === '/api/users/0/collections' && url.searchParams.get('start') === '1') {
      return apiResponse(200, [{ key: child.key, data: child }]);
    }
    assert.fail(`Unexpected request ${options.method} ${url.href}`);
  });

  const listed = await client.collections();
  assert.deepEqual(listed.map((item) => item.path), [['研究方向'], ['研究方向', '创新金融']]);
  const reused = await client.ensureCollection([' 研究方向 ', '創新金融'.replace('創', '创')], '');
  assert.equal(reused.key, child.key);
  assert.equal(calls.filter((call) => call.options.method === 'POST').length, 0);
  assert.equal(calls.filter((call) => call.url.searchParams.has('start')).length, 4);
});

test('concurrent calls in one client create a missing collection only once', async () => {
  let created;
  let creates = 0;
  const client = makeClient(async (input, options) => {
    const url = new URL(input);
    if (url.pathname === '/api/') return apiResponse(200, {});
    if (url.pathname === '/api/users/0/collections' && (options.method ?? 'GET') === 'GET') {
      return apiResponse(200, created ? [created] : []);
    }
    if (url.pathname === '/api/users/0/collections' && options.method === 'POST') {
      creates += 1;
      expectWriteHeaders(options);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const data = JSON.parse(options.body)[0];
      created = { key: data.key, data };
      return apiResponse(200, { successful: { 0: created } });
    }
    assert.fail(`Unexpected request ${options.method} ${url.href}`);
  });

  const [first, second] = await Promise.all([
    client.ensureCollection(['新方向'], ''),
    client.ensureCollection(['新方向'], ''),
  ]);
  assert.equal(creates, 1);
  assert.equal(first.key, second.key);
});

test('exact duplicate import adds a collection while preserving prior classifications and reuses matching PDF', async () => {
  await withPdf(async (pdfPath) => {
    const oldCollectionKey = 'OLDD2222';
    const targetRootKey = 'ROOT2222';
    const targetChildKey = 'CHLD2222';
    const parentKey = 'PAPR2222';
    const attachmentKey = 'FILE2222';
    const library = new Map();
    const parent = {
      key: parentKey,
      version: 8,
      data: {
        key: parentKey,
        version: 8,
        itemType: 'journalArticle',
        title: 'A Precise Paper Title',
        DOI: '10.1234/example.7',
        collections: [oldCollectionKey],
        creators: [],
      },
    };
    const attachment = {
      key: attachmentKey,
      version: 4,
      data: {
        key: attachmentKey,
        version: 4,
        itemType: 'attachment',
        parentItem: parentKey,
        linkMode: 'imported_file',
        filename: 'paper.pdf',
        md5: PDF_MD5,
        contentType: 'application/pdf',
      },
    };
    library.set(parentKey, parent);
    library.set(attachmentKey, attachment);
    const collections = [
      { key: oldCollectionKey, data: { key: oldCollectionKey, name: '旧分类', parentCollection: false } },
      { key: targetRootKey, data: { key: targetRootKey, name: '研究方向', parentCollection: false } },
      { key: targetChildKey, data: { key: targetChildKey, name: '创新金融', parentCollection: targetRootKey } },
    ];
    const calls = [];
    let updateBody;
    const client = makeClient(async (input, options) => {
      const url = new URL(input);
      calls.push({ url, options });
      const method = options.method ?? 'GET';
      if (url.pathname === '/api/') return apiResponse(200, {});
      if (url.pathname === '/api/users/0/collections') return apiResponse(200, collections);
      if (url.pathname === '/api/users/0/items' && method === 'GET') return apiResponse(200, [parent]);
      if (url.pathname === `/api/users/0/items/${parentKey}` && method === 'GET') return apiResponse(200, library.get(parentKey));
      if (url.pathname === `/api/users/0/items/${parentKey}` && method === 'PUT') {
        expectWriteHeaders(options);
        assert.equal(new Headers(options.headers).get('If-Unmodified-Since-Version'), '17');
        updateBody = JSON.parse(options.body);
        library.set(parentKey, { key: parentKey, data: updateBody });
        return apiResponse(200, { successful: { 0: parentKey } });
      }
      if (url.pathname === `/api/users/0/items/${parentKey}/children`) return apiResponse(200, [attachment]);
      if (url.pathname === `/api/users/0/items/${attachmentKey}` && method === 'GET') return apiResponse(200, library.get(attachmentKey));
      if (url.pathname === `/api/users/0/items/${parentKey}/file/view/url`) return apiResponse(200, 'file:///C:/zotero/storage/FILE2222/paper.pdf');
      assert.fail(`Unexpected request ${method} ${url.href}`);
    });

    const receipt = {};
    const result = await client.importPaper({
      metadata: { title: 'A Precise Paper Title', doi: 'https://doi.org/10.1234/example.7' },
      pdfPath,
      collectionPath: ['研究方向', '创新金融'],
      rootName: '',
      receipt,
    });

    assert.deepEqual(updateBody.collections, [oldCollectionKey, targetChildKey]);
    assert.equal(result.parentKey, parentKey);
    assert.equal(result.attachmentKey, attachmentKey);
    assert.equal(result.md5, PDF_MD5);
    assert.equal(result.reused, true);
    assert.equal(receipt.zoteroLocal.serverId, SERVER_ID);
    assert.equal(calls.filter((call) => call.options.method === 'POST').length, 0);
    assert.equal(calls.filter((call) => call.options.method === 'PUT').length, 1);
  });
});

test('nested engine job receipt survives a failed duplicate import and resumes without duplicate items', async () => {
  await withPdf(async (pdfPath) => {
    const oldCollectionKey = 'OLDD3333';
    const targetCollectionKey = 'TARG3333';
    const parentKey = 'PAPR3333';
    const attachmentKey = 'FILE3333';
    let parent = {
      key: parentKey,
      version: 8,
      data: {
        key: parentKey,
        version: 8,
        itemType: 'journalArticle',
        title: 'Persisted Duplicate Paper',
        DOI: '10.3333/persisted.1',
        collections: [oldCollectionKey],
        creators: [],
      },
    };
    const attachment = {
      key: attachmentKey,
      version: 4,
      data: {
        key: attachmentKey,
        version: 4,
        itemType: 'attachment',
        parentItem: parentKey,
        linkMode: 'imported_file',
        filename: 'paper.pdf',
        md5: PDF_MD5,
        contentType: 'application/pdf',
      },
    };
    const collections = [
      { key: oldCollectionKey, data: { key: oldCollectionKey, name: '旧分类', parentCollection: false } },
      { key: targetCollectionKey, data: { key: targetCollectionKey, name: '新分类', parentCollection: false } },
    ];
    const calls = [];
    let putAttempts = 0;
    let itemCreateCalls = 0;
    let engineJob = { engine: { job: { id: 'job-persisted-duplicate', receipt: {} } } };
    const saveReceipt = async (value) => {
      engineJob = JSON.parse(JSON.stringify({
        engine: {
          job: {
            id: 'job-persisted-duplicate',
            receipt: value,
          },
        },
      }));
    };
    const client = makeClient(async (input, options) => {
      const url = new URL(input);
      calls.push({ url, options });
      const method = options.method ?? 'GET';
      if (url.pathname === '/api/') return apiResponse(200, {});
      if (url.pathname === '/api/users/0/collections') return apiResponse(200, collections);
      if (url.pathname === '/api/users/0/items' && method === 'GET') return apiResponse(200, [parent]);
      if (url.pathname === `/api/users/0/items/${parentKey}` && method === 'GET') return apiResponse(200, parent);
      if (url.pathname === `/api/users/0/items/${parentKey}` && method === 'PUT') {
        putAttempts += 1;
        expectWriteHeaders(options);
        if (putAttempts === 1) return apiResponse(401, { error: 'authorization required' });
        parent = { key: parentKey, version: 9, data: { ...JSON.parse(options.body), version: 9 } };
        return apiResponse(200, { successful: { 0: parentKey } });
      }
      if (url.pathname === `/api/users/0/items/${parentKey}/children`) return apiResponse(200, [attachment]);
      if (url.pathname === `/api/users/0/items/${attachmentKey}` && method === 'GET') return apiResponse(200, attachment);
      if (url.pathname === `/api/users/0/items/${parentKey}/file/view/url`) return apiResponse(200, 'file:///C:/zotero/storage/FILE3333/paper.pdf');
      if (url.pathname === '/api/users/0/items' && method === 'POST') itemCreateCalls += 1;
      assert.fail(`Unexpected request ${method} ${url.href}`);
    });

    await assert.rejects(
      client.importPaper({
        metadata: { title: 'Persisted Duplicate Paper', doi: '10.3333/persisted.1' },
        pdfPath,
        collectionPath: ['新分类'],
        rootName: '',
        receipt: engineJob.engine.job.receipt,
        saveReceipt,
      }),
      (error) => error instanceof ZoteroApiError && error.status === 401,
    );

    const failedSnapshot = engineJob.engine.job.receipt;
    const importId = failedSnapshot.zoteroLocal.import.id;
    assert.equal(engineJob.engine.job.id, 'job-persisted-duplicate');
    assert.equal(failedSnapshot.zoteroLocal.operations[`${importId}:merge-collections`].state, 'prepared');
    assert.equal(Object.hasOwn(failedSnapshot.zoteroLocal, '__receipt'), false);

    const result = await client.importPaper({
      metadata: { title: 'Persisted Duplicate Paper', doi: '10.3333/persisted.1' },
      pdfPath,
      collectionPath: ['新分类'],
      rootName: '',
      receipt: engineJob.engine.job.receipt,
      saveReceipt,
    });

    const completedSnapshot = engineJob.engine.job.receipt;
    assert.equal(engineJob.engine.job.id, 'job-persisted-duplicate');
    assert.equal(completedSnapshot.zoteroLocal.import.id, importId);
    assert.equal(completedSnapshot.zoteroLocal.import.state, 'complete');
    assert.equal(completedSnapshot.zoteroLocal.operations[`${importId}:merge-collections`].state, 'complete');
    assert.deepEqual(parent.data.collections, [oldCollectionKey, targetCollectionKey]);
    assert.equal(result.parentKey, parentKey);
    assert.equal(result.attachmentKey, attachmentKey);
    assert.equal(result.reused, true);
    assert.equal(putAttempts, 2);
    assert.equal(itemCreateCalls, 0);
    assert.equal(calls.filter((call) => call.options.method === 'POST').length, 0);
  });
});

test('new journal article and PDF use local three-phase upload with loopback-only authorization headers', async () => {
  await withPdf(async (pdfPath) => {
    const items = new Map();
    const calls = [];
    const collectionKey = 'COLL2222';
    const collections = [{ key: collectionKey, data: { key: collectionKey, name: '文献积累', parentCollection: false } }];
    let parentKey;
    let attachmentKey;
    let uploadBytes;
    let uploadAuthorizationBody;
    const client = makeClient(async (input, options) => {
      const url = new URL(input);
      calls.push({ url, options });
      const method = options.method ?? 'GET';
      if (url.pathname === '/api/') return apiResponse(200, {});
      if (url.pathname === '/api/users/0/collections') return apiResponse(200, collections);
      if (url.pathname === '/api/users/0/items' && method === 'GET') return apiResponse(200, [...items.values()]);
      if (url.pathname === '/api/users/0/items' && method === 'POST') {
        expectWriteHeaders(options);
        const inputItems = JSON.parse(options.body);
        const data = inputItems[0];
        if (data.itemType === 'journalArticle') parentKey = data.key;
        else {
          assert.equal(data.itemType, 'attachment');
          assert.equal(data.linkMode, 'imported_file');
          assert.equal(data.parentItem, parentKey);
          attachmentKey = data.key;
        }
        const saved = { key: data.key, version: 1, data: { ...data, version: 1 } };
        items.set(data.key, saved);
        return apiResponse(200, { successful: { 0: saved } });
      }
      if (url.pathname === `/api/users/0/items/${parentKey}` && method === 'GET') return apiResponse(200, items.get(parentKey));
      if (url.pathname === `/api/users/0/items/${attachmentKey}` && method === 'GET') return apiResponse(200, items.get(attachmentKey));
      if (url.pathname === `/api/users/0/items/${parentKey}/children`) return apiResponse(200, []);
      if (url.pathname === `/api/users/0/items/${attachmentKey}/file` && method === 'POST') {
        expectWriteHeaders(options);
        const headers = new Headers(options.headers);
        assert.equal(headers.get('If-None-Match'), '*');
        assert.equal(headers.get('Content-Type'), 'application/x-www-form-urlencoded');
        const formBody = String(options.body);
        if (formBody.startsWith('upload=')) {
          assert.match(formBody, /upload=mock-upload-token/u);
          const current = items.get(attachmentKey);
          current.data.md5 = PDF_MD5;
          current.data.mtime = '1000';
          return apiResponse(204, null);
        }
        uploadAuthorizationBody = formBody;
        assert.match(uploadAuthorizationBody, new RegExp(`md5=${PDF_MD5}`));
        return apiResponse(200, {
          url: '/api/local/uploads/mock-upload-token',
          uploadKey: 'mock-upload-token',
          contentType: 'application/octet-stream',
          prefix: 'BEGIN:',
          suffix: ':END',
        });
      }
      if (url.pathname === '/api/local/uploads/mock-upload-token') {
        expectWriteHeaders(options, { apiKey: false, serverId: false });
        const headers = new Headers(options.headers);
        assert.equal(headers.get('Zotero-Server-ID'), null);
        uploadBytes = await bodyBytes(options.body);
        assert.equal(uploadBytes.subarray(0, 6).toString(), 'BEGIN:');
        assert.equal(uploadBytes.subarray(uploadBytes.length - 4).toString(), ':END');
        return new Response(null, { status: 201 });
      }
      if (url.pathname === `/api/users/0/items/${parentKey}/file/view/url`) return apiResponse(200, 'file:///C:/zotero/storage/mock/paper.pdf');
      assert.fail(`Unexpected request ${method} ${url.href}`);
    });

    const receipt = {};
    const savedSnapshots = [];
    const result = await client.importPaper({
      metadata: {
        title: 'New Journal Paper',
        DOI: '10.5678/new-paper',
        publicationTitle: 'Journal of Useful Tests',
        creators: [{ creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' }],
      },
      pdfPath,
      collectionPath: [],
      rootName: '文献积累',
      receipt,
      saveReceipt: async (value) => savedSnapshots.push(JSON.parse(JSON.stringify(value))),
    });

    assert.ok(parentKey);
    assert.ok(attachmentKey);
    assert.equal(result.parentKey, parentKey);
    assert.equal(result.attachmentKey, attachmentKey);
    assert.equal(result.md5, PDF_MD5);
    assert.equal(result.reused, false);
    assert.equal(result.collectionKeys.includes(collectionKey), true);
    assert.ok(uploadAuthorizationBody.includes('filesize='));
    assert.ok(uploadBytes.subarray(6, 6 + PDF.length).equals(PDF));
    assert.equal(receipt.zoteroLocal.operations[`${receipt.zoteroLocal.import.id}:file-authorize`].state, 'complete');
    assert.equal(receipt.zoteroLocal.operations[`${receipt.zoteroLocal.import.id}:file-upload`].state, 'complete');
    assert.equal(receipt.zoteroLocal.operations[`${receipt.zoteroLocal.import.id}:file-register`].state, 'complete');
    assert.ok(savedSnapshots.some((snapshot) => Object.values(snapshot.zoteroLocal.operations).some((operation) => operation.state === 'in_flight')));
    assert.equal(calls.filter((call) => call.url.hostname !== '127.0.0.1').length, 0);
    for (const call of calls.filter((entry) => entry.options.method === 'POST' || entry.options.method === 'PUT')) {
      if (call.url.pathname === '/api/local/uploads/mock-upload-token') continue;
      expectWriteHeaders(call.options);
    }
  });
});

test('unknown parent create is read-only reconciled and never automatically posted twice', async () => {
  await withPdf(async (pdfPath) => {
    let itemCreateCalls = 0;
    const client = makeClient(async (input, options) => {
      const url = new URL(input);
      const method = options.method ?? 'GET';
      if (url.pathname === '/api/') return apiResponse(200, {});
      if (url.pathname === '/api/users/0/items' && method === 'GET') return apiResponse(200, []);
      if (url.pathname === '/api/users/0/items' && method === 'POST') {
        itemCreateCalls += 1;
        throw new TypeError('connection closed before the outcome could be confirmed');
      }
      if (url.pathname.startsWith('/api/users/0/items/')) {
        return apiResponse(404, { error: 'not found' });
      }
      assert.fail(`Unexpected request ${method} ${url.href}`);
    });
    const receipt = {};
    const persistedStates = [];
    const saveReceipt = async (value) => persistedStates.push(JSON.parse(JSON.stringify(value)));

    await assert.rejects(client.importPaper({ metadata: { title: 'Timeout Paper' }, pdfPath, collectionPath: [], rootName: '', receipt, saveReceipt }));
    assert.equal(itemCreateCalls, 1);
    assert.ok(persistedStates.some((snapshot) => Object.values(snapshot.zoteroLocal.operations).some((operation) => operation.state === 'in_flight')));
    await assert.rejects(
      client.importPaper({ metadata: { title: 'Timeout Paper' }, pdfPath, collectionPath: [], rootName: '', receipt, saveReceipt }),
      ZoteroUnknownWriteError,
    );
    assert.equal(itemCreateCalls, 1);
  });
});

test('an uncertain parent create is recovered by its assigned key without another create request', async () => {
  await withPdf(async (pdfPath) => {
    let itemCreateCalls = 0;
    let parent;
    const client = makeClient(async (input, options) => {
      const url = new URL(input);
      const method = options.method ?? 'GET';
      if (url.pathname === '/api/') return apiResponse(200, {});
      if (url.pathname === '/api/users/0/items' && method === 'GET') return apiResponse(200, parent ? [parent] : []);
      if (url.pathname === '/api/users/0/items' && method === 'POST') {
        itemCreateCalls += 1;
        const data = JSON.parse(options.body)[0];
        parent = { key: data.key, version: 1, data: { ...data, version: 1 } };
        throw new TypeError('connection closed after Zotero saved the item');
      }
      if (url.pathname.startsWith('/api/users/0/items/') && url.pathname.endsWith('/children')) {
        return apiResponse(500, { error: 'stop after parent reconciliation' });
      }
      if (url.pathname.startsWith('/api/users/0/items/')) {
        const key = url.pathname.split('/').at(-1);
        if (parent?.key === key) return apiResponse(200, parent);
        return apiResponse(404, { error: 'not found' });
      }
      assert.fail(`Unexpected request ${method} ${url.href}`);
    });
    const receipt = {};

    await assert.rejects(client.importPaper({ metadata: { title: 'Saved Despite Timeout' }, pdfPath, collectionPath: [], rootName: '', receipt }));
    await assert.rejects(
      client.importPaper({ metadata: { title: 'Saved Despite Timeout' }, pdfPath, collectionPath: [], rootName: '', receipt }),
      (error) => error instanceof ZoteroApiError && error.status === 500,
    );
    assert.equal(itemCreateCalls, 1);
    assert.equal(receipt.zoteroLocal.operations[`${receipt.zoteroLocal.import.id}:create-parent`].state, 'complete');
    assert.equal(receipt.zoteroLocal.operations[`${receipt.zoteroLocal.import.id}:create-parent`].result.recovered, true);
  });
});

test('an upload URL outside the configured local endpoint is rejected before any request to it', async () => {
  await withPdf(async (pdfPath) => {
    const items = new Map();
    const urls = [];
    let parentKey;
    let attachmentKey;
    const client = makeClient(async (input, options) => {
      const url = new URL(input);
      urls.push(url.href);
      const method = options.method ?? 'GET';
      if (url.pathname === '/api/') return apiResponse(200, {});
      if (url.pathname === '/api/users/0/items' && method === 'GET') return apiResponse(200, [...items.values()]);
      if (url.pathname === '/api/users/0/items' && method === 'POST') {
        const data = JSON.parse(options.body)[0];
        if (data.itemType === 'journalArticle') parentKey = data.key;
        else attachmentKey = data.key;
        const value = { key: data.key, data };
        items.set(data.key, value);
        return apiResponse(200, { successful: { 0: value } });
      }
      if (url.pathname === `/api/users/0/items/${parentKey}`) return apiResponse(200, items.get(parentKey));
      if (url.pathname === `/api/users/0/items/${attachmentKey}`) return apiResponse(200, items.get(attachmentKey));
      if (url.pathname === `/api/users/0/items/${parentKey}/children`) return apiResponse(200, []);
      if (url.pathname === `/api/users/0/items/${attachmentKey}/file`) {
        return apiResponse(200, { url: 'https://outside.example/upload/token', uploadKey: 'upload-token', contentType: 'application/octet-stream' });
      }
      if (url.pathname === `/api/users/0/collections`) return apiResponse(200, []);
      assert.fail(`Unexpected request ${method} ${url.href}`);
    });

    await assert.rejects(
      client.importPaper({ metadata: { title: 'Unsafe Upload URL' }, pdfPath, collectionPath: [], rootName: '', receipt: {} }),
      (error) => error instanceof ZoteroApiError && /outside the configured local upload endpoint/u.test(error.message),
    );
    assert.equal(urls.some((url) => url.startsWith('https://outside.example/')), false);
  });
});

test('exact title matching rejects ambiguity instead of choosing an arbitrary item', async () => {
  const matches = [
    { key: 'AAAACCCC', data: { key: 'AAAACCCC', itemType: 'journalArticle', title: 'Same title' } },
    { key: 'BBBBDDDD', data: { key: 'BBBBDDDD', itemType: 'journalArticle', title: 'Same   title' } },
  ];
  const client = makeClient(async (input) => {
    const url = new URL(input);
    if (url.pathname === '/api/') return apiResponse(200, {});
    if (url.pathname === '/api/users/0/items') return apiResponse(200, matches);
    assert.fail(`Unexpected request ${url.href}`);
  });
  await assert.rejects(client.findPaper({ title: 'Same title' }), ZoteroAmbiguousMatchError);
});
