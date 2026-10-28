import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { LiteratureEngine } from '../lib/engine.mjs';
import { ZoteroClient } from '../lib/zotero.mjs';

const SERVER_ID = 'existing-paper-fixture';
const DOI = '10.1234/example.5';
const TITLE = 'The Effects of University Research';

function apiResponse(status, body) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Zotero-Server-ID': SERVER_ID,
      'Zotero-API-Version': '3',
      'Last-Modified-Version': '17',
    },
  });
}

test('findClassifiedPaper returns the existing item and full collection paths using GET only', async () => {
  const calls = [];
  const client = new ZoteroClient({
    base: 'http://127.0.0.1:23119/api',
    getAuth: async () => assert.fail('read-only lookup must not request credentials'),
    fetchImpl: async (input, options = {}) => {
      const url = new URL(input);
      const method = options.method || 'GET';
      calls.push({ method, pathname: url.pathname });
      assert.equal(method, 'GET');
      if (url.pathname === '/api/users/0/items') {
        return apiResponse(200, [{
          key: 'PARENT01',
          data: {
            key: 'PARENT01', itemType: 'journalArticle', title: TITLE, DOI,
            collections: ['CHILD001'],
          },
        }]);
      }
      if (url.pathname === '/api/users/0/collections') {
        return apiResponse(200, [
          { key: 'ROOT001', data: { key: 'ROOT001', name: 'Research', parentCollection: false } },
          { key: 'CHILD001', data: { key: 'CHILD001', name: 'Innovation', parentCollection: 'ROOT001' } },
        ]);
      }
      assert.fail(`Unexpected read-only lookup ${method} ${url.pathname}`);
    },
  });

  const found = await client.findClassifiedPaper({ doi: DOI, title: TITLE });

  assert.deepEqual(found, {
    parentKey: 'PARENT01',
    title: TITLE,
    doi: DOI,
    collectionKeys: ['CHILD001'],
    collectionPaths: [['Research', 'Innovation']],
    matchBasis: 'doi',
    reused: true,
    preserved: true,
  });
  assert.equal(Object.hasOwn(found, 'storagePath'), false);
  assert.deepEqual(calls, [
    { method: 'GET', pathname: '/api/users/0/items' },
    { method: 'GET', pathname: '/api/users/0/collections' },
  ]);
});

test('findClassifiedPaper returns null for an existing item without collections', async () => {
  const paths = [];
  const client = new ZoteroClient({
    base: 'http://127.0.0.1:23119/api',
    fetchImpl: async input => {
      const url = new URL(input);
      paths.push(url.pathname);
      if (url.pathname === '/api/users/0/items') {
        return apiResponse(200, [{ key: 'PARENT02', data: {
          key: 'PARENT02', itemType: 'journalArticle', title: TITLE, DOI, collections: [],
        } }]);
      }
      assert.fail(`Unclassified item lookup should not need ${url.pathname}`);
    },
  });

  assert.equal(await client.findClassifiedPaper({ doi: DOI }), null);
  assert.deepEqual(paths, ['/api/users/0/items']);
});

test('findClassifiedPaper can match by PDF MD5 without requesting an attachment file', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-zotero-md5-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pdfPath = path.join(root, 'source.pdf');
  const pdf = Buffer.from('%PDF-1.7\nMD5-only local fixture\n%%EOF\n');
  const md5 = createHash('md5').update(pdf).digest('hex');
  await fs.writeFile(pdfPath, pdf);

  const calls = [];
  const client = new ZoteroClient({
    base: 'http://127.0.0.1:23119/api',
    fetchImpl: async (input, options = {}) => {
      const url = new URL(input);
      const method = options.method || 'GET';
      calls.push({ method, pathname: url.pathname });
      assert.equal(method, 'GET');
      assert.equal(/\/file(?:\/|$)/i.test(url.pathname), false, 'lookup must not access attachment file bytes');
      if (url.pathname === '/api/users/0/items') {
        return apiResponse(200, [
          { key: 'PARENT03', data: {
            key: 'PARENT03', itemType: 'journalArticle', title: TITLE, DOI: '', collections: ['CHILD001'],
          } },
          { key: 'ATTACH03', data: {
            key: 'ATTACH03', itemType: 'attachment', parentItem: 'PARENT03',
            linkMode: 'imported_file', md5,
          } },
        ]);
      }
      if (url.pathname === '/api/users/0/collections') {
        return apiResponse(200, [
          { key: 'ROOT001', data: { key: 'ROOT001', name: 'Research', parentCollection: false } },
          { key: 'CHILD001', data: { key: 'CHILD001', name: 'Innovation', parentCollection: 'ROOT001' } },
        ]);
      }
      assert.fail(`Unexpected metadata lookup ${method} ${url.pathname}`);
    },
  });

  const found = await client.findClassifiedPaper({ pdfPath });
  assert.equal(found.parentKey, 'PARENT03');
  assert.equal(found.matchBasis, 'pdf_md5');
  assert.equal(found.reused, true);
  assert.equal(found.preserved, true);
  assert.deepEqual(found.collectionPaths, [['Research', 'Innovation']]);
  assert.equal(Object.hasOwn(found, 'storagePath'), false);
  assert.ok(calls.length > 0);
  assert.ok(calls.every(call => call.method === 'GET'));
});

async function makeEngineJob(t, {
  stages = ['import', 'prepare', 'classify', 'zotero', 'read'],
  pageText = `DOI: ${DOI}. ${TITLE}.`,
  prepared = true,
  pdfBytes = Buffer.from('%PDF-1.7\nfixture\n%%EOF\n'),
  metadata = {},
  classificationPath,
  receipt = {},
  zotero,
  findClassifiedPaper = async () => null,
  importPaper = async () => ({ parentKey: 'IMPORTED1', reused: true }),
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-zotero-existing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const engine = new LiteratureEngine({
    stateDir: root,
    inputDir: path.join(root, 'input'),
    rootCollection: '',
    watchInput: false,
    autoRun: false,
  });
  await engine.store.init();

  const id = 'existing_paper_fixture';
  const jobDir = engine.store.dir(id);
  await fs.mkdir(jobDir, { recursive: true });
  const pdfPath = path.join(jobDir, 'source.pdf');
  const pagesPath = path.join(jobDir, 'pages.json');
  await fs.writeFile(pdfPath, pdfBytes);
  await fs.writeFile(pagesPath, JSON.stringify([
    { page: 1, text: pageText },
    { page: 2, text: 'Second fixture page.' },
  ]));

  const classifyIndex = stages.indexOf('classify');
  const job = {
    id,
    kind: 'paper',
    createdAt: new Date().toISOString(),
    status: 'queued',
    stage: 'classify',
    sha256: 'fixture-sha256',
    stages,
    cursor: classifyIndex,
    completedStages: stages.slice(0, classifyIndex),
    metadata,
    pdfPath,
    ...(prepared ? { prepared: { pagesPath, pageCount: 2, scanPages: [] } } : {}),
    receipt,
    artifacts: {},
    ...(classificationPath ? { classificationPath } : {}),
    ...(zotero ? { zotero } : {}),
  };
  await engine.store.save(job);

  const calls = { find: [], imports: [], copies: 0 };
  engine.zotero = {
    findClassifiedPaper: async identity => {
      calls.find.push(identity);
      return findClassifiedPaper(identity);
    },
    importPaper: async args => {
      calls.imports.push(args);
      return importPaper(args);
    },
  };
  engine.copyToStorage = async () => { calls.copies += 1; };
  return { engine, calls, id, job, pdfPath };
}

const classifiedResult = {
  parentKey: 'PARENT01',
  title: TITLE,
  doi: DOI,
  collectionKeys: ['CHILD001'],
  collectionPaths: [['Research', 'Innovation']],
  reused: true,
  preserved: true,
};

test('homepage DOI with empty metadata skips classify and Zotero while preserving the saved classification', async t => {
  const { engine, calls, id, pdfPath } = await makeEngineJob(t, {
    pageText: `DOI: https://doi.org/${DOI.toUpperCase()}. ${TITLE.replace('University Research', 'University-Research')}.`,
    metadata: {},
    classificationPath: ['Existing model classification'],
    findClassifiedPaper: async () => classifiedResult,
  });

  const result = await engine.finish(id);
  const saved = await engine.store.get(id);

  assert.equal(result.requires, 'read');
  assert.equal(calls.find.length, 1);
  assert.equal(calls.find[0].doi, DOI);
  assert.equal(calls.find[0].title, undefined);
  assert.equal(calls.find[0].pdfPath, pdfPath);
  assert.deepEqual(calls.imports, []);
  assert.equal(calls.copies, 0);
  assert.equal(saved.classificationPath[0], 'Existing model classification');
  assert.deepEqual(saved.zoteroExisting, classifiedResult);
  assert.equal(Object.hasOwn(saved.zoteroExisting, 'storagePath'), false);
  assert.deepEqual(saved.skippedStages, {
    classify: { reason: 'existing_zotero_classified', parentKey: 'PARENT01' },
    zotero: { reason: 'existing_zotero_classified', parentKey: 'PARENT01' },
  });
  assert.deepEqual(result.completedStages, ['import', 'prepare', 'classify', 'zotero']);
  assert.equal(result.cursor, 4);
});

test('metadata DOI is used for lookup and must agree with any DOI found on page one', async t => {
  const { engine, calls, id, pdfPath } = await makeEngineJob(t, {
    pageText: `DOI ${DOI}; related work DOI 10.9999/related. ${TITLE}.`,
    metadata: { doi: `https://doi.org/${DOI.toUpperCase()}` },
    findClassifiedPaper: async () => classifiedResult,
  });

  const result = await engine.finish(id);
  assert.equal(result.requires, 'read');
  assert.equal(calls.find.length, 1);
  assert.equal(calls.find[0].doi, DOI);
  assert.equal(calls.find[0].title, undefined);
  assert.equal(calls.find[0].pdfPath, pdfPath);
  assert.deepEqual(calls.imports, []);
});

test('metadata and homepage DOI conflict pauses the job before querying Zotero', async t => {
  const { engine, calls, id } = await makeEngineJob(t, {
    metadata: { doi: '10.9999/different' },
    findClassifiedPaper: async () => classifiedResult,
  });

  await assert.rejects(engine.finish(id), /首页DOI与元数据不一致/);
  const saved = await engine.store.get(id);
  assert.deepEqual(calls.find, []);
  assert.deepEqual(calls.imports, []);
  assert.equal(saved.status, 'needs_attention');
  assert.equal(saved.cursor, 2);
  assert.deepEqual(saved.completedStages, ['import', 'prepare']);
});

test('a DOI hit without the matched full title on page one still requires classification', async t => {
  const { engine, calls, id } = await makeEngineJob(t, {
    pageText: `DOI ${DOI}. Paper about university research and effects.`,
    metadata: {},
    findClassifiedPaper: async () => ({ ...classifiedResult, title: 'University Research Effects' }),
  });

  const result = await engine.finish(id);
  assert.equal(result.requires, 'classify');
  assert.equal(calls.find.length, 1);
  assert.deepEqual(calls.imports, []);
  assert.equal(result.zoteroExisting, undefined);
});

test('PDF MD5 match can skip both cards when DOI and title are unavailable to OCR', async t => {
  const { engine, calls, id, pdfPath } = await makeEngineJob(t, {
    pageText: '[OCR unavailable on first page]',
    metadata: {},
    findClassifiedPaper: async () => ({ ...classifiedResult, matchBasis: 'pdf_md5' }),
  });

  const result = await engine.finish(id);
  const saved = await engine.store.get(id);
  assert.equal(result.requires, 'read');
  assert.equal(calls.find.length, 1);
  assert.equal(calls.find[0].doi, '');
  assert.equal(calls.find[0].title, undefined);
  assert.equal(calls.find[0].pdfPath, pdfPath);
  assert.deepEqual(calls.imports, []);
  assert.equal(calls.copies, 0);
  assert.equal(saved.zoteroExisting.matchBasis, 'pdf_md5');
  assert.ok(saved.completedStages.includes('classify'));
  assert.ok(saved.completedStages.includes('zotero'));
});

test('PDF MD5 match still pauses when supplied metadata title conflicts with the Zotero title', async t => {
  const { engine, calls, id, pdfPath } = await makeEngineJob(t, {
    pageText: '[OCR unavailable on first page]',
    metadata: { title: 'A different paper title' },
    findClassifiedPaper: async () => ({ ...classifiedResult, matchBasis: 'pdf_md5' }),
  });

  await assert.rejects(engine.finish(id));
  const saved = await engine.store.get(id);
  assert.equal(calls.find.length, 1);
  assert.equal(calls.find[0].pdfPath, pdfPath);
  assert.deepEqual(calls.imports, []);
  assert.equal(saved.status, 'needs_attention');
  assert.equal(saved.cursor, 2);
  assert.deepEqual(saved.completedStages, ['import', 'prepare']);
  assert.equal(saved.skippedStages, undefined);
});

test('no match or an unclassified item returns to the normal classify boundary', async t => {
  const { engine, calls, id, pdfPath } = await makeEngineJob(t, {
    metadata: {},
    findClassifiedPaper: async () => null,
  });

  const result = await engine.finish(id);
  assert.equal(result.requires, 'classify');
  assert.equal(calls.find.length, 1);
  assert.equal(calls.find[0].doi, DOI);
  assert.equal(calls.find[0].title, undefined);
  assert.equal(calls.find[0].pdfPath, pdfPath);
  assert.deepEqual(calls.imports, []);
});

test('a previously preserved item that disappears pauses rather than silently recreating it', async t => {
  const {engine,id,calls}=await makeEngineJob(t,{metadata:{},findClassifiedPaper:async()=>null});
  const job=await engine.store.get(id);job.zoteroExisting={...classifiedResult};job.zotero={...classifiedResult};await engine.store.save(job);
  await assert.rejects(engine.finish(id),/条目或分类已变化/);
  const saved=await engine.store.get(id);assert.equal(saved.status,'needs_attention');assert.equal(saved.cursor,2);
  assert.equal(calls.imports.length,0);assert.equal(calls.copies,0);
});

test('PDF without metadata DOI or title still searches by hash and falls back to classify on no match', async t => {
  const { engine, calls, id, pdfPath } = await makeEngineJob(t, {
    pageText: '[OCR unavailable on first page]',
    metadata: {},
    findClassifiedPaper: async () => null,
  });

  const result = await engine.finish(id);
  assert.equal(result.requires, 'classify');
  assert.equal(calls.find.length, 1);
  assert.equal(calls.find[0].doi, '');
  assert.equal(calls.find[0].title, undefined);
  assert.equal(calls.find[0].pdfPath, pdfPath);
  assert.deepEqual(calls.imports, []);
});

test('without prepared pages the engine does not query Zotero even when PDF is present', async t => {
  const { engine, calls, id } = await makeEngineJob(t, {
    prepared: false,
    metadata: {},
    findClassifiedPaper: async () => classifiedResult,
  });

  const result = await engine.finish(id);
  assert.equal(result.requires, 'classify');
  assert.deepEqual(calls.find, []);
  assert.deepEqual(calls.imports, []);
});

test('without a selected Zotero card the engine does not query the library', async t => {
  const { engine, calls, id } = await makeEngineJob(t, {
    stages: ['import', 'prepare', 'classify', 'read'],
    metadata: {},
    findClassifiedPaper: async () => classifiedResult,
  });

  const result = await engine.finish(id);
  assert.equal(result.requires, 'classify');
  assert.deepEqual(calls.find, []);
  assert.deepEqual(calls.imports, []);
});

test('Zotero lookup errors pause at the same cursor instead of being treated as no match', async t => {
  const { engine, calls, id } = await makeEngineJob(t, {
    findClassifiedPaper: async () => { throw new Error('fixture Zotero read failed'); },
  });

  await assert.rejects(engine.finish(id), /fixture Zotero read failed/);
  const saved = await engine.store.get(id);
  assert.equal(calls.find.length, 1);
  assert.deepEqual(calls.imports, []);
  assert.equal(saved.status, 'needs_attention');
  assert.equal(saved.cursor, 2);
  assert.deepEqual(saved.completedStages, ['import', 'prepare']);
});

for (const state of ['prepared', 'inflight', 'unknown', 'complete']) {
  test(`receipt operation in ${state} state bypasses the shortcut and uses import reconciliation`, async t => {
    const { engine, calls, id } = await makeEngineJob(t, {
      classificationPath: ['Research', 'Innovation'],
      metadata: { title: TITLE, doi: DOI },
      receipt: { zoteroLocal: { operations: { 'fixture:import': { state } } } },
      findClassifiedPaper: async () => classifiedResult,
    });

    const result = await engine.finish(id);
    assert.equal(result.requires, 'read');
    assert.deepEqual(calls.find, []);
    assert.equal(calls.imports.length, 1);
    assert.equal(calls.imports[0].receipt.zoteroLocal.operations['fixture:import'].state, state);
    assert.ok(result.completedStages.includes('zotero'));
  });
}

test('an unpreserved prior Zotero result also goes through import reconciliation', async t => {
  const { engine, calls, id } = await makeEngineJob(t, {
    classificationPath: ['Research', 'Innovation'],
    metadata: { title: TITLE, doi: DOI },
    zotero: { parentKey: 'PARENT01', reused: true, preserved: false },
    findClassifiedPaper: async () => classifiedResult,
  });

  const result = await engine.finish(id);
  assert.equal(result.requires, 'read');
  assert.deepEqual(calls.find, []);
  assert.equal(calls.imports.length, 1);
  assert.ok(result.completedStages.includes('zotero'));
});

test('resolvePdfFolder returns the stored PDF folder for a single imported attachment', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-zotero-folder-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storageDir = path.join(root, 'storage', 'ATTACH01');
  await fs.mkdir(storageDir, { recursive: true });
  const pdfPath = path.join(storageDir, 'paper.pdf');
  await fs.writeFile(pdfPath, Buffer.from('%PDF-1.7\nfixture\n%%EOF\n'));

  const client = new ZoteroClient({
    base: 'http://127.0.0.1:23119/api',
    fetchImpl: async (input, options = {}) => {
      const url = new URL(input);
      assert.equal(options.method || 'GET', 'GET');
      if (url.pathname === '/api/users/0/items') {
        return apiResponse(200, [
          { key: 'PARENT01', data: { key: 'PARENT01', itemType: 'journalArticle', title: TITLE, DOI } },
          { key: 'ATTACH01', data: {
            key: 'ATTACH01', itemType: 'attachment', parentItem: 'PARENT01',
            linkMode: 'imported_file', contentType: 'application/pdf', filename: 'paper.pdf',
          } },
        ]);
      }
      if (url.pathname === '/api/users/0/items/ATTACH01/file/view/url') {
        return new Response(pathToFileURL(pdfPath).href, { status: 200 });
      }
      assert.fail(`Unexpected lookup ${url.pathname}`);
    },
  });

  assert.equal(await client.resolvePdfFolder('PARENT01'), storageDir);
});

test('resolvePdfFolder refuses to guess when the item has several or no stored PDFs', async t => {
  const make = (attachments) => new ZoteroClient({
    base: 'http://127.0.0.1:23119/api',
    fetchImpl: async (input) => {
      const url = new URL(input);
      if (url.pathname === '/api/users/0/items') return apiResponse(200, attachments);
      assert.fail(`Unexpected lookup ${url.pathname}`);
    },
  });
  const parent = { key: 'PARENT02', data: { key: 'PARENT02', itemType: 'journalArticle', title: TITLE } };
  const pdf = (key) => ({ key, data: {
    key, itemType: 'attachment', parentItem: 'PARENT02', linkMode: 'imported_file',
    contentType: 'application/pdf', filename: `${key}.pdf`,
  } });
  assert.equal(await make([parent]).resolvePdfFolder('PARENT02'), null);
  assert.equal(await make([parent, pdf('A1'), pdf('A2')]).resolvePdfFolder('PARENT02'), null);
  assert.equal(await make([parent, { key: 'L1', data: {
    key: 'L1', itemType: 'attachment', parentItem: 'PARENT02', linkMode: 'linked_file',
    contentType: 'application/pdf', filename: 'linked.pdf',
  } }]).resolvePdfFolder('PARENT02'), null);
});

test('a reused Zotero item still receives the workflow artifacts beside its PDF', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-zotero-preserved-copy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storageDir = path.join(root, 'storage', 'ATTACH01');
  await fs.mkdir(storageDir, { recursive: true });
  await fs.writeFile(path.join(storageDir, 'paper.pdf'), Buffer.from('%PDF-1.7\nfixture\n%%EOF\n'));

  const engine = new LiteratureEngine({ stateDir: root, inputDir: path.join(root, 'input'), watchInput: false, autoRun: false });
  await engine.store.init();
  const id = 'preserved_copy_fixture';
  const dir = engine.store.dir(id);
  await fs.mkdir(dir, { recursive: true });
  const markdownPath = path.join(dir, 'paper.md');
  await fs.writeFile(markdownPath, '# 论文\n');
  const sha256 = 'a'.repeat(64);
  const job = {
    id, sha256, status: 'publishing', stage: 'zotero', stages: ['zotero'], cursor: 0,
    completedStages: [], artifacts: {}, extractPath: markdownPath,
    prepared: { markdownPath }, pdfPath: path.join(storageDir, 'paper.pdf'),
    zotero: { parentKey: 'ATTACH01PARENT', preserved: true, reused: true },
  };
  let asked = null;
  engine.zotero = { resolvePdfFolder: async (key) => { asked = key; return storageDir; } };

  await engine.copyToStorage(job);

  assert.equal(asked, 'ATTACH01PARENT');
  assert.equal(job.artifacts.zoteroFolder, path.join(storageDir, `literature-${sha256.slice(0, 12)}`));
  assert.equal(await fs.readFile(path.join(job.artifacts.zoteroFolder, 'paper.md'), 'utf8'), '# 论文\n');
  assert.equal(await fs.readFile(path.join(storageDir, 'paper.pdf'), 'utf8'), '%PDF-1.7\nfixture\n%%EOF\n', 'the stored PDF itself must stay untouched');
});

test('a reused item without a resolvable PDF folder is left alone instead of guessing', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-zotero-preserved-skip-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const engine = new LiteratureEngine({ stateDir: root, inputDir: path.join(root, 'input'), watchInput: false, autoRun: false });
  await engine.store.init();
  const id = 'preserved_skip_fixture';
  const dir = engine.store.dir(id);
  await fs.mkdir(dir, { recursive: true });
  const markdownPath = path.join(dir, 'paper.md');
  await fs.writeFile(markdownPath, '# 论文\n');
  const job = { id, sha256: 'b'.repeat(64), artifacts: {}, extractPath: markdownPath,
    prepared: { markdownPath }, zotero: { parentKey: 'P', preserved: true } };
  engine.zotero = { resolvePdfFolder: async () => null };

  await engine.copyToStorage(job);

  assert.equal(job.artifacts.zoteroFolder, undefined);
});
