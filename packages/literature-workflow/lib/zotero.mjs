import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const API_VERSION = '3';
const LIBRARY = '/users/0';
const ZOTERO_KEY_ALPHABET = '23456789ABCDEFGHIJKLMNPQRSTUVWXYZ';
const SAFE_PATH_SEGMENT = /^[^\u0000-\u001f/\\]+$/u;

export class ZoteroApiError extends Error {
  constructor(message, { status, url, body } = {}) {
    super(message);
    this.name = 'ZoteroApiError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export class ZoteroAuthorizationRequiredError extends ZoteroApiError {
  constructor(url) {
    super('Zotero write authorization is required; call authorize() explicitly', { url });
    this.name = 'ZoteroAuthorizationRequiredError';
  }
}

export class ZoteroServerChangedError extends Error {
  constructor(expected, actual) {
    super(`Zotero server changed (expected ${expected}, received ${actual ?? 'no server ID'})`);
    this.name = 'ZoteroServerChangedError';
    this.expectedServerId = expected;
    this.actualServerId = actual;
  }
}

export class ZoteroUnknownWriteError extends Error {
  constructor(operationId, key) {
    super(`The Zotero write outcome is unknown for ${operationId} (${key}); it was not retried. Reconcile this receipt before continuing.`);
    this.name = 'ZoteroUnknownWriteError';
    this.operationId = operationId;
    this.key = key;
  }
}

export class ZoteroMarkdownAttachmentUnsupportedError extends ZoteroApiError {
  constructor(error) {
    super('Zotero Local API did not accept a Markdown attachment; configure a Zotero version/API that supports text/markdown attachments, then resume from the saved receipt', {
      status: error?.status,
      url: error?.url,
      body: error?.body,
    });
    this.name = 'ZoteroMarkdownAttachmentUnsupportedError';
    this.code = 'ZOTERO_MARKDOWN_ATTACHMENT_UNSUPPORTED';
    this.cause = error;
  }
}

export class ZoteroAmbiguousMatchError extends Error {
  constructor(count, criterion) {
    super(`More than one Zotero item exactly matches ${criterion} (${count} candidates)`);
    this.name = 'ZoteroAmbiguousMatchError';
    this.count = count;
    this.criterion = criterion;
  }
}

function assertLoopbackBase(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(host) || url.username || url.password || url.search || url.hash) {
    throw new TypeError('Zotero base must be an unauthenticated HTTP loopback URL');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

function normalizeDoi(value) {
  let doi = String(value ?? '').normalize('NFKC').trim();
  doi = doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, '').replace(/^doi\s*:\s*/iu, '').trim();
  doi = doi.replace(/[\s<>"']/gu, '').replace(/[.,;:)\]}]+$/gu, '');
  return doi.toLowerCase();
}

function itemData(item) {
  return item?.data && typeof item.data === 'object' ? item.data : item;
}

function responseHeader(headers, ...names) {
  for (const name of names) {
    const value = headers?.get?.(name);
    if (value !== null && value !== undefined && value !== '') return String(value);
  }
  return null;
}

function parseLinkNext(linkHeader, currentUrl) {
  if (!linkHeader) return null;
  for (const piece of linkHeader.split(',')) {
    const match = piece.match(/<([^>]+)>\s*;\s*rel="?([^";]+)"?/iu);
    if (match && match[2].split(/\s+/u).includes('next')) return new URL(match[1], currentUrl);
  }
  return null;
}

function makeZoteroKey() {
  const bytes = randomBytes(8);
  let result = '';
  for (const byte of bytes) result += ZOTERO_KEY_ALPHABET[byte % ZOTERO_KEY_ALPHABET.length];
  return result;
}

function stableZoteroKey(seed) {
  const digest = createHash('sha256').update(String(seed)).digest();
  let result = '';
  for (let index = 0; index < 8; index += 1) result += ZOTERO_KEY_ALPHABET[digest[index] % ZOTERO_KEY_ALPHABET.length];
  return result;
}

function safeFilename(value, fallback = 'paper.pdf') {
  const basename = path.basename(String(value ?? fallback)).replace(/[\u0000-\u001f<>:"/\\|?*]/gu, '_').trim();
  return basename || fallback;
}

function unwrapCreated(body, index = '0') {
  const value = body?.successful?.[index] ?? body?.successful?.[Number(index)];
  if (typeof value === 'string') return { key: value };
  return value?.data ? { ...value, ...value.data } : value ?? null;
}

function verifyPdfHeader(buffer) {
  return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
}

async function hashFile(filePath, { verifyPdf = true } = {}) {
  const info = await stat(filePath);
  if (!info.isFile()) throw new TypeError('filePath must point to a regular file');
  if (info.size >= 4 * 1024 ** 3) throw new RangeError('Zotero Local API file uploads must be smaller than 4 GB');

  const md5 = createHash('md5');
  const sha256 = createHash('sha256');
  let first = Buffer.alloc(0);
  for await (const chunk of createReadStream(filePath)) {
    if (first.length < 5) first = Buffer.concat([first, chunk.subarray(0, 5 - first.length)]);
    md5.update(chunk);
    sha256.update(chunk);
  }
  if (verifyPdf && !verifyPdfHeader(first)) throw new TypeError('The selected file does not begin with a PDF header');
  return {
    size: info.size,
    mtime: Math.trunc(info.mtimeMs),
    md5: md5.digest('hex'),
    sha256: sha256.digest('hex'),
  };
}

function fieldValue(metadata, ...names) {
  for (const name of names) {
    if (metadata?.[name] !== undefined && metadata[name] !== null) return metadata[name];
  }
  return undefined;
}

function journalArticleData(metadata, collectionKeys, key) {
  const fields = {
    itemType: 'journalArticle',
    key,
    title: fieldValue(metadata, 'title') ?? '',
    creators: fieldValue(metadata, 'creators', 'authors') ?? [],
    abstractNote: fieldValue(metadata, 'abstractNote', 'abstract') ?? '',
    publicationTitle: fieldValue(metadata, 'publicationTitle', 'journal', 'containerTitle') ?? '',
    volume: fieldValue(metadata, 'volume') ?? '',
    issue: fieldValue(metadata, 'issue', 'number') ?? '',
    pages: fieldValue(metadata, 'pages', 'page') ?? '',
    date: fieldValue(metadata, 'date', 'year') === undefined ? '' : String(fieldValue(metadata, 'date', 'year')),
    DOI: fieldValue(metadata, 'DOI', 'doi') ?? '',
    url: fieldValue(metadata, 'url') ?? '',
    language: fieldValue(metadata, 'language') ?? '',
    ISSN: fieldValue(metadata, 'ISSN', 'issn') ?? '',
    rights: fieldValue(metadata, 'rights') ?? '',
    extra: fieldValue(metadata, 'extra') ?? '',
    collections: [...new Set(collectionKeys)],
    tags: Array.isArray(metadata?.tags) ? metadata.tags : [],
    relations: metadata?.relations && typeof metadata.relations === 'object' ? metadata.relations : {},
  };
  return fields;
}

function collectionEntries(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

export class ZoteroClient {
  constructor({ base = 'http://127.0.0.1:23119/api', fetchImpl = fetch, getAuth, setAuth } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    if (getAuth !== undefined && typeof getAuth !== 'function') throw new TypeError('getAuth must be a function');
    if (setAuth !== undefined && typeof setAuth !== 'function') throw new TypeError('setAuth must be a function');
    this.base = assertLoopbackBase(base);
    this.fetchImpl = fetchImpl;
    this.getAuth = getAuth ?? (async () => undefined);
    this.setAuth = setAuth ?? (async () => undefined);
    this.serverId = null;
    this.apiVersion = null;
    this.libraryVersion = null;
    this.collectionFlight = new Map();
  }

  _url(pathname) {
    const raw = pathname instanceof URL ? pathname.href : String(pathname);
    const url = /^[a-z][a-z\d+.-]*:\/\//iu.test(raw)
      ? new URL(raw)
      : new URL(raw.replace(/^\/+/, ''), this.base);
    if (url.origin !== this.base.origin || !url.pathname.startsWith(this.base.pathname)) {
      throw new TypeError('Zotero API request escaped the configured loopback base');
    }
    return url;
  }

  async _request(pathname, options = {}, { write = false, auth = true, acceptServerChange = false } = {}) {
    const url = this._url(pathname);
    const headers = new Headers(options.headers ?? {});
    headers.set('Zotero-API-Version', API_VERSION);
    if (this.serverId && !acceptServerChange) headers.set('Zotero-Server-ID', this.serverId);

    let authInfo;
    if (write && auth) {
      authInfo = await this._authInfo();
      if (!authInfo?.key) throw new ZoteroAuthorizationRequiredError(url.href);
      headers.set('Zotero-API-Key', authInfo.key);
    }
    if (write) {
      if (!this.serverId) throw new ZoteroApiError('Zotero-Server-ID is not known; call health() before writing', { url: url.href });
      headers.set('Zotero-Server-ID', this.serverId);
    }

    let response;
    try {
      response = await this.fetchImpl(url, { ...options, headers, redirect: 'manual' });
    } catch (cause) {
      if (write && authInfo && authInfo.remember === false) {
        // A transport failure cannot tell us whether the one-use key was consumed.
        await this._clearOneUseAuth(authInfo);
      }
      throw cause;
    }

    const responseServerId = responseHeader(response.headers, 'Zotero-Server-ID');
    if (acceptServerChange) {
      if (responseServerId) this.serverId = responseServerId;
      this.apiVersion = responseHeader(response.headers, 'Zotero-API-Version') ?? this.apiVersion;
    } else if (this.serverId && responseServerId !== this.serverId) {
      throw new ZoteroServerChangedError(this.serverId, responseServerId);
    }
    const libraryVersion = responseHeader(response.headers, 'Last-Modified-Version', 'Zotero-Library-Version');
    if (libraryVersion !== null && /^\d+$/u.test(libraryVersion)) this.libraryVersion = libraryVersion;

    if (response.status >= 300 && response.status < 400) {
      throw new ZoteroApiError('Unexpected redirect from Zotero Local API', { status: response.status, url: url.href });
    }
    if (write && authInfo && authInfo.remember === false && response.status !== 401 && response.status !== 403 && response.status !== 428) {
      await this._clearOneUseAuth(authInfo);
    }
    return { response, url };
  }

  async _authInfo() {
    const value = await this.getAuth();
    if (typeof value === 'string') return value ? { key: value, remember: undefined, serverId: undefined } : null;
    if (!value || typeof value !== 'object') return null;
    if (value.serverId && this.serverId && value.serverId !== this.serverId) {
      throw new ZoteroServerChangedError(value.serverId, this.serverId);
    }
    const key = typeof value.key === 'string' ? value.key : (typeof value.apiKey === 'string' ? value.apiKey : '');
    return key ? { ...value, key } : null;
  }

  async _clearOneUseAuth(authInfo) {
    try {
      await this.setAuth(null, { serverId: this.serverId, remember: false, consumed: true });
    } catch {
      // The key is still kept out of errors and return values if persistence cleanup fails.
    }
    authInfo.key = '';
  }

  async _readJson(pathname, options = {}) {
    const { response, url } = await this._request(pathname, options);
    if (!response.ok) throw await this._apiError(response, url);
    const text = await response.text();
    if (!text) return { body: null, response, url };
    try {
      return { body: JSON.parse(text), response, url };
    } catch {
      throw new ZoteroApiError('Zotero Local API returned invalid JSON', { status: response.status, url: url.href });
    }
  }

  async _apiError(response, url) {
    const message = response.status === 401
      ? 'Zotero rejected the local API key; call authorize() and resume from the saved receipt'
      : `Zotero Local API request failed with HTTP ${response.status}`;
    return new ZoteroApiError(message, { status: response.status, url: url.href });
  }

  async _getServerId() {
    if (!this.serverId) await this.health();
    if (!this.serverId) throw new ZoteroApiError('Zotero Local API did not provide Zotero-Server-ID');
    return this.serverId;
  }

  async health({timeoutMs=8000}={}) {
    const { response, url } = await this._request('', { method: 'GET', signal: AbortSignal.timeout(timeoutMs) }, { acceptServerChange: true });
    if (!response.ok) throw await this._apiError(response, url);
    const version = responseHeader(response.headers, 'Zotero-API-Version') ?? this.apiVersion ?? null;
    const serverId = responseHeader(response.headers, 'Zotero-Server-ID') ?? this.serverId;
    if (serverId) this.serverId = serverId;
    this.apiVersion = version;
    let auth;
    try { auth = await this._authInfo(); } catch (error) {
      if (!(error instanceof ZoteroServerChangedError)) throw error;
    }
    const clientVersion = responseHeader(response.headers, 'X-Zotero-Version');
    return { version, ...(clientVersion ? { clientVersion } : {}), serverId, writeAuthorized: Boolean(auth?.key) };
  }

  async authorize({timeoutMs=120000}={}) {
    const { serverId } = await this.health();
    if (!serverId) throw new ZoteroApiError('Cannot authorize without Zotero-Server-ID');
    const { response, url } = await this._request('local/authorize', {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appName: '文献积累工作流' }),
    }, { write: true, auth: false });
    if (!response.ok) {
      if (response.status === 403) return { authorized: false, denied: true, serverId };
      throw await this._apiError(response, url);
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new ZoteroApiError('Zotero authorization response was invalid JSON', { status: response.status, url: url.href });
    }
    if (body?.denied || typeof body?.key !== 'string' || body.key.length === 0) {
      return { authorized: false, denied: Boolean(body?.denied), serverId };
    }
    const remember = Boolean(body.remember);
    await this.setAuth(body.key, { serverId, remember });
    return { authorized: true, remember, serverId };
  }

  async _allPages(endpoint) {
    const items = [];
    const seen = new Set();
    let nextUrl = this._url(`${endpoint}${endpoint.includes('?') ? '&' : '?'}limit=100&start=0`);
    while (nextUrl) {
      if (seen.has(nextUrl.href)) throw new ZoteroApiError('Zotero pagination repeated a page URL', { url: nextUrl.href });
      seen.add(nextUrl.href);
      const { body, response } = await this._readJson(nextUrl.href);
      const page = collectionEntries(body);
      items.push(...page);
      const linked = parseLinkNext(response.headers.get('Link'), nextUrl);
      if (linked) {
        if (linked.origin !== this.base.origin || !linked.pathname.startsWith(this.base.pathname)) {
          throw new ZoteroApiError('Zotero pagination link escaped the configured local API base', { url: linked.href });
        }
        nextUrl = linked;
      } else if (page.length >= 100) {
        const start = Number(nextUrl.searchParams.get('start') ?? 0) + page.length;
        nextUrl.searchParams.set('start', String(start));
      } else {
        nextUrl = null;
      }
    }
    return items;
  }

  async collections() {
    const raw = await this._allPages(`${LIBRARY}/collections`);
    const byKey = new Map();
    for (const item of raw) {
      const data = itemData(item);
      if (data?.key) byKey.set(data.key, { ...item, ...data, key: data.key });
    }
    const cache = new Map();
    const fullPath = (key, stack = new Set()) => {
      if (cache.has(key)) return cache.get(key);
      const item = byKey.get(key);
      if (!item) return [];
      if (stack.has(key)) throw new ZoteroApiError(`Collection parent cycle detected at ${key}`);
      const parent = item.parentCollection;
      const nextStack = new Set(stack).add(key);
      const result = [...(parent ? fullPath(parent, nextStack) : []), item.name];
      cache.set(key, result);
      return result;
    };
    return [...byKey.values()].map((item) => {
      const pathParts = fullPath(item.key);
      return { ...item, parentCollection: item.parentCollection || false, path: pathParts, fullPath: pathParts.join('/') };
    });
  }

  async _allItems() {
    return this._allPages(`${LIBRARY}/items`);
  }

  async findPaper({ doi, title } = {}) {
    const wantedDoi = normalizeDoi(doi);
    const wantedTitle = normalizeText(title);
    if (!wantedDoi && !wantedTitle) throw new TypeError('findPaper requires a DOI or a title');
    const items = await this._allItems();
    const matches = items.filter((item) => {
      const data = itemData(item);
      if (!data || data.itemType === 'attachment' || data.parentItem) return false;
      if (wantedDoi) return normalizeDoi(data.DOI ?? data.doi) === wantedDoi;
      return normalizeText(data.title) === wantedTitle;
    });
    if (matches.length > 1) throw new ZoteroAmbiguousMatchError(matches.length, wantedDoi ? `DOI ${wantedDoi}` : `title ${String(title)}`);
    return matches[0] ?? null;
  }

  _collectionMatch(collections, name, parentKey) {
    const target = normalizeText(name);
    return collections.filter((entry) => {
      const parent = entry.parentCollection || false;
      return normalizeText(entry.name) === target && parent === (parentKey || false);
    });
  }

  async findClassifiedPaper(identity = {}) {
    let item = identity.doi || identity.title ? await this.findPaper(identity) : null;
    let matchBasis = identity.doi ? 'doi' : 'title';
    if (!item && identity.pdfPath) {
      const {md5} = await hashFile(identity.pdfPath);
      const items = await this._allItems();
      const parentKeys = new Set(items.filter(entry => {
        const data = itemData(entry);
        return data?.itemType==='attachment' && data.parentItem && String(data.md5||'').toLowerCase()===md5;
      }).map(entry => itemData(entry).parentItem));
      const parents = items.filter(entry => {
        const data = itemData(entry);
        return data && data.itemType!=='attachment' && !data.parentItem && parentKeys.has(data.key || entry.key);
      });
      if(parents.length>1)throw new ZoteroAmbiguousMatchError(parents.length,'matching PDF attachment');
      item=parents[0]||null;matchBasis='pdf_md5';
      const storedDoi=normalizeDoi(itemData(item)?.DOI || itemData(item)?.doi);
      if(item && identity.doi && storedDoi && storedDoi!==normalizeDoi(identity.doi))throw new ZoteroApiError('同一PDF对应条目的DOI与当前论文不一致，未改变原条目');
    }
    if (!item) return null;
    const data = itemData(item);
    const keys = [...new Set(data.collections || [])];
    if (!keys.length) return null;
    const byKey = new Map((await this.collections()).map(entry => [entry.key, entry.path]));
    if (!keys.every(key => byKey.get(key)?.length)) throw new ZoteroApiError('已有条目的分类未能完整核对，未改变原分类');
    // Deliberately omit storagePath: preserving an existing entry also means
    // later render stages must not copy files into its attachment directory.
    return {parentKey:data.key || item.key,title:data.title,doi:normalizeDoi(data.DOI || data.doi),
      collectionKeys:keys,collectionPaths:keys.map(key => byKey.get(key)),matchBasis,reused:true,preserved:true};
  }

  /**
   * Resolve the folder holding this item's stored PDF so later stages can put
   * their artifacts beside the paper itself. Returns null when the item has no
   * single imported PDF (none, a linked file, or several candidates) — callers
   * must skip the copy rather than guess a directory.
   */
  async resolvePdfFolder(parentKey) {
    if (typeof parentKey !== 'string' || !parentKey) return null;
    const items = await this._allItems();
    const candidates = items.filter((entry) => {
      const data = itemData(entry);
      if (!data || data.itemType !== 'attachment' || data.parentItem !== parentKey) return false;
      if (data.linkMode && data.linkMode !== 'imported_file') return false;
      const type = String(data.contentType || '').toLowerCase();
      const name = String(data.filename || data.path || '');
      return type === 'application/pdf' || /\.pdf$/i.test(name);
    });
    if (candidates.length !== 1) return null;
    const attachmentKey = itemData(candidates[0])?.key ?? candidates[0].key;
    const filePath = await this._getStoragePath(attachmentKey);
    return filePath ? path.dirname(filePath) : null;
  }

  async _receiptRoot(receipt, serverId, saveReceipt) {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new TypeError('receipt must be a mutable object');
    receipt.zoteroLocal ??= { serverId, operations: {} };
    const local = receipt.zoteroLocal;
    if (local.serverId && local.serverId !== serverId) throw new ZoteroServerChangedError(local.serverId, serverId);
    local.serverId = serverId;
    local.operations ??= {};
    await saveReceipt(receipt);
    return local;
  }

  async _saveReceipt(local, receipt, saveReceipt) {
    // local is already receipt.zoteroLocal; a back-reference makes the job cyclic.
    await saveReceipt(receipt);
  }

  async _lookupCollection(key) {
    const { body } = await this._readJson(`${LIBRARY}/collections/${encodeURIComponent(key)}`);
    return body;
  }

  async _lookupItem(key) {
    const { body } = await this._readJson(`${LIBRARY}/items/${encodeURIComponent(key)}`);
    return body;
  }

  async _reconcileReceiptWrite(record, lookup, verify, receipt, local, saveReceipt, operationId) {
    if (record.state === 'complete' || record.state === 'in_flight' || record.state === 'unknown') {
      let found = null;
      try {
        found = await lookup(record.key);
      } catch (error) {
        if (!(error instanceof ZoteroApiError && error.status === 404)) throw error;
      }
      if (found && verify(found)) {
        const recovered = record.state !== 'complete';
        record.state = 'complete';
        record.result = { key: record.key, recovered };
        if (recovered) await this._saveReceipt(local, receipt, saveReceipt);
        return { recovered, value: found };
      }
      if (record.state === 'complete') throw new ZoteroApiError(`Receipt says Zotero operation ${operationId} completed, but its assigned key is missing`);
      record.state = 'unknown';
      await this._saveReceipt(local, receipt, saveReceipt);
      throw new ZoteroUnknownWriteError(operationId, record.key);
    }
    if (record.state === 'failed') throw new ZoteroApiError(`Previous Zotero operation ${operationId} failed and requires review`, { status: record.status });
    return null;
  }

  async _startRecordedWrite({ receipt, local, operationId, kind, key, saveReceipt, lookup, verify, method, pathname, body, headers = {}, retry412 = false }) {
    let record = local.operations[operationId];
    if (record && (record.kind !== kind || record.key !== key)) throw new ZoteroApiError(`Receipt operation identity changed for ${operationId}`);
    if (!record) {
      record = local.operations[operationId] = { kind, key, state: 'prepared' };
      await this._saveReceipt(local, receipt, saveReceipt);
    }
    const reconciled = await this._reconcileReceiptWrite(record, lookup, verify, receipt, local, saveReceipt, operationId);
    if (reconciled) return reconciled.value;

    record.state = 'in_flight';
    record.attempts = (record.attempts ?? 0) + 1;
    await this._saveReceipt(local, receipt, saveReceipt);
    const requestOptions = {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    };
    let result;
    try {
      const request = await this._request(pathname, requestOptions, { write: true });
      if (!request.response.ok) {
        if (request.response.status === 401) {
          record.state = 'prepared';
          await this._saveReceipt(local, receipt, saveReceipt);
        } else if (retry412 && request.response.status === 412) {
          record.state = 'prepared';
          await this._saveReceipt(local, receipt, saveReceipt);
          throw await this._apiError(request.response, request.url);
        } else {
          record.state = 'failed';
          record.status = request.response.status;
          await this._saveReceipt(local, receipt, saveReceipt);
          throw await this._apiError(request.response, request.url);
        }
      } else {
        const raw = await request.response.text();
        result = raw ? JSON.parse(raw) : null;
      }
    } catch (error) {
      if (error instanceof ZoteroAuthorizationRequiredError) {
        record.state = 'prepared';
        await this._saveReceipt(local, receipt, saveReceipt);
        throw error;
      }
      if (error instanceof ZoteroApiError && [401, 412].includes(error.status)) throw error;
      // The write may have reached Zotero. Leave it in-flight so the next call performs only a keyed read.
      if (record.state === 'in_flight') {
        record.state = 'unknown';
        await this._saveReceipt(local, receipt, saveReceipt);
      }
      throw error;
    }
    const created = unwrapCreated(result);
    const failed = result?.failed?.['0'] ?? result?.failed?.[0];
    if (failed) {
      record.state = 'failed';
      record.status = failed.code ?? 'item-write-failed';
      await this._saveReceipt(local, receipt, saveReceipt);
      throw new ZoteroApiError(`Zotero rejected operation ${operationId}`, { status: failed.code });
    }
    let found = null;
    if (created?.key === key) found = created;
    if (!found) {
      try {
        found = await lookup(key);
      } catch {
        found = null;
      }
    }
    if (!found || !verify(found)) {
      record.state = 'unknown';
      await this._saveReceipt(local, receipt, saveReceipt);
      throw new ZoteroUnknownWriteError(operationId, key);
    }
    record.state = 'complete';
    record.result = { key, recovered: false };
    await this._saveReceipt(local, receipt, saveReceipt);
    return found;
  }

  async _createCollection(name, parentKey, receipt, local, saveReceipt, operationPrefix) {
    const operationId = `${operationPrefix}:create:${normalizeText(name)}:${parentKey || 'top'}`;
    const key = local.operations[operationId]?.key ?? stableZoteroKey(`${local.serverId}\u001f${parentKey || ''}\u001f${normalizeText(name)}`);
    const body = { name, parentCollection: parentKey || false, key };
    const libraryVersion = this.libraryVersion;
    const headers = libraryVersion !== null
      ? { 'If-Unmodified-Since-Version': libraryVersion }
      : { 'Zotero-Write-Token': randomBytes(16).toString('hex') };
    try {
      const created = await this._startRecordedWrite({
        receipt, local, operationId, kind: 'collection', key, saveReceipt,
        lookup: (candidateKey) => this._lookupCollection(candidateKey),
        verify: (value) => {
          const data = itemData(value);
          return data?.key === key && normalizeText(data.name) === normalizeText(name) && (data.parentCollection || false) === (parentKey || false);
        },
        method: 'POST', pathname: `${LIBRARY}/collections`, body: [body], headers,
      });
      const data = itemData(created);
      return { ...created, ...data, key: data?.key ?? key, name: data?.name ?? name, parentCollection: data?.parentCollection || false };
    } catch (error) {
      if (error instanceof ZoteroApiError && [409, 412].includes(error.status)) {
        const fresh = await this.collections();
        const match = this._collectionMatch(fresh, name, parentKey);
        if (match.length === 1) return match[0];
        if (match.length > 1) throw new ZoteroAmbiguousMatchError(match.length, `collection ${name}`);
        const operation = local.operations[operationId];
        if (operation) {
          operation.state = 'prepared';
          await this._saveReceipt(local, receipt, saveReceipt);
        }
      }
      throw error;
    }
  }

  async ensureCollection(pathParts, rootName = '文献积累', { receipt, saveReceipt = async () => {} } = {}) {
    if (!Array.isArray(pathParts)) throw new TypeError('pathParts must be an array');
    const cleanParts = pathParts.map((part) => String(part ?? '').trim()).filter(Boolean);
    const cleanRoot = String(rootName ?? '').trim();
    for (const part of [...(cleanRoot ? [cleanRoot] : []), ...cleanParts]) {
      if (!SAFE_PATH_SEGMENT.test(part) || part === '.' || part === '..') throw new TypeError(`Invalid collection path segment: ${part}`);
    }
    const path = [...(cleanRoot ? [cleanRoot] : []), ...cleanParts];
    if (path.length === 0) return null;
    const flightKey = path.map(normalizeText).join('\u001f');
    if (this.collectionFlight.has(flightKey)) return this.collectionFlight.get(flightKey);
    const promise = (async () => {
      const serverId = await this._getServerId();
      let local = null;
      if (receipt) local = await this._receiptRoot(receipt, serverId, saveReceipt);
      const opPrefix = receipt ? (receipt.zoteroLocal.import?.id ?? 'collections') : `collection:${flightKey}`;
      let current = false;
      let collections = await this.collections();
      let selected = null;
      for (const name of path) {
        let matches = this._collectionMatch(collections, name, current);
        if (matches.length > 1) throw new ZoteroAmbiguousMatchError(matches.length, `collection ${name}`);
        if (matches.length === 0) {
          if (!receipt) {
            const ephemeral = { zoteroLocal: { serverId, operations: {} } };
            ephemeral.zoteroLocal.import = { id: opPrefix };
            local = await this._receiptRoot(ephemeral, serverId, async () => {});
            selected = await this._createCollection(name, current, ephemeral, local, async () => {}, opPrefix);
          } else {
            selected = await this._createCollection(name, current, receipt, local, saveReceipt, opPrefix);
          }
          collections = await this.collections();
          const resolved = this._collectionMatch(collections, name, current);
          if (resolved.length !== 1) throw new ZoteroApiError(`Collection ${name} was not uniquely visible after creation`);
          selected = resolved[0];
        } else {
          selected = matches[0];
        }
        current = selected.key;
      }
      return selected;
    })();
    this.collectionFlight.set(flightKey, promise);
    try {
      return await promise;
    } finally {
      this.collectionFlight.delete(flightKey);
    }
  }

  async _ensureCollectionKeys(collectionPath, rootName, receipt, saveReceipt) {
    const paths = Array.isArray(collectionPath) ? collectionPath : (collectionPath ? String(collectionPath).split('/').filter(Boolean) : []);
    if (!paths.length && !String(rootName ?? '').trim()) return [];
    const collection = await this.ensureCollection(paths, rootName, { receipt, saveReceipt });
    return collection ? [collection.key] : [];
  }

  async _children(parentKey) {
    return this._allPages(`${LIBRARY}/items/${encodeURIComponent(parentKey)}/children`);
  }

  async _updateParentCollections(parentKey, addCollectionKeys, receipt, local, saveReceipt, operationId) {
    const wanted = new Set(addCollectionKeys);
    if (wanted.size === 0) return this._lookupItem(parentKey);
    let attempts = 0;
    while (attempts < 3) {
      attempts += 1;
      const { body: existing, response } = await this._readJson(`${LIBRARY}/items/${encodeURIComponent(parentKey)}`);
      const current = itemData(existing);
      if (!current || current.itemType === 'attachment') throw new ZoteroApiError(`Parent item ${parentKey} was not found`);
      const currentCollections = new Set(current.collections ?? []);
      const merged = [...new Set([...currentCollections, ...wanted])];
      if ([...wanted].every((key) => currentCollections.has(key))) {
        const alreadyRecorded = local.operations[operationId];
        if (alreadyRecorded && alreadyRecorded.state !== 'complete') {
          alreadyRecorded.state = 'complete';
          alreadyRecorded.result = { key: parentKey, recovered: true };
          await this._saveReceipt(local, receipt, saveReceipt);
        }
        return existing;
      }
      const version = current.version ?? existing.version;
      const libraryVersion = responseHeader(response.headers, 'Last-Modified-Version', 'Zotero-Library-Version') ?? this.libraryVersion;
      const operation = local.operations[operationId];
      if (operation?.state === 'in_flight' || operation?.state === 'unknown') {
        if (wanted.size > 0 && [...wanted].every((key) => currentCollections.has(key))) {
          operation.state = 'complete';
          operation.result = { key: parentKey, recovered: true };
          await this._saveReceipt(local, receipt, saveReceipt);
          return existing;
        }
        operation.state = 'unknown';
        await this._saveReceipt(local, receipt, saveReceipt);
        throw new ZoteroUnknownWriteError(operationId, parentKey);
      }
      if (!operation) {
        local.operations[operationId] = { kind: 'item-update', key: parentKey, state: 'prepared' };
        await this._saveReceipt(local, receipt, saveReceipt);
      }
      const record = local.operations[operationId];
      record.state = 'in_flight';
      record.attempts = (record.attempts ?? 0) + 1;
      record.version = version;
      await this._saveReceipt(local, receipt, saveReceipt);
      const updateData = { ...current, collections: merged };
      const headers = { 'Content-Type': 'application/json' };
      if (libraryVersion !== null) headers['If-Unmodified-Since-Version'] = String(libraryVersion);
      else headers['Zotero-Write-Token'] = randomBytes(16).toString('hex');
      let request;
      try {
        request = await this._request(`${LIBRARY}/items/${encodeURIComponent(parentKey)}`, {
          method: 'PUT', headers, body: JSON.stringify(updateData),
        }, { write: true });
      } catch (error) {
        if (error instanceof ZoteroAuthorizationRequiredError) {
          record.state = 'prepared';
          await this._saveReceipt(local, receipt, saveReceipt);
          throw error;
        }
        record.state = 'unknown';
        await this._saveReceipt(local, receipt, saveReceipt);
        throw error;
      }
      if (request.response.status === 412) {
        record.state = 'prepared';
        await this._saveReceipt(local, receipt, saveReceipt);
        if (attempts < 3) continue;
        throw await this._apiError(request.response, request.url);
      }
      if (!request.response.ok) {
        if (request.response.status === 401) record.state = 'prepared';
        else record.state = 'failed';
        record.status = request.response.status;
        await this._saveReceipt(local, receipt, saveReceipt);
        throw await this._apiError(request.response, request.url);
      }
      const after = await this._lookupItem(parentKey);
      const afterData = itemData(after);
      if (![...wanted].every((key) => (afterData?.collections ?? []).includes(key))) {
        record.state = 'unknown';
        await this._saveReceipt(local, receipt, saveReceipt);
        throw new ZoteroUnknownWriteError(operationId, parentKey);
      }
      record.state = 'complete';
      record.result = { key: parentKey, recovered: false };
      await this._saveReceipt(local, receipt, saveReceipt);
      return after;
    }
    throw new ZoteroApiError(`Could not update Zotero item ${parentKey} after version conflicts`);
  }

  async _writeItemCreate({ receipt, local, operationId, key, body, saveReceipt, verify }) {
    return this._startRecordedWrite({
      receipt, local, operationId, kind: 'item-create', key, saveReceipt,
      lookup: (candidateKey) => this._lookupItem(candidateKey), verify,
      method: 'POST', pathname: `${LIBRARY}/items`, body: [body],
      headers: this.libraryVersion !== null
        ? { 'If-Unmodified-Since-Version': String(this.libraryVersion) }
        : { 'Zotero-Write-Token': randomBytes(16).toString('hex') },
      retry412: true,
    });
  }

  async _findSameAttachment(parentKey, md5, { contentType } = {}) {
    const children = await this._children(parentKey);
    return children.find((item) => {
      const data = itemData(item);
      const typeMatches = !contentType || String(data?.contentType ?? '').toLowerCase() === contentType.toLowerCase();
      return data?.itemType === 'attachment' && data.parentItem === parentKey && data.linkMode === 'imported_file' && typeMatches && String(data.md5 ?? '').toLowerCase() === md5.toLowerCase();
    }) ?? null;
  }

  async _getStoragePath(attachmentKey) {
    try {
      const { response, url } = await this._request(`${LIBRARY}/items/${encodeURIComponent(attachmentKey)}/file/view/url`, { method: 'GET' });
      if (!response.ok) return null;
      const raw = (await response.text()).trim();
      const fileUrl = new URL(raw);
      if (fileUrl.protocol !== 'file:' || fileUrl.host) return null;
      return fileURLToPath(fileUrl);
    } catch {
      return null;
    }
  }

  async _uploadFile({ parentKey, attachmentKey, filePath, fileInfo, contentType, attachment, receipt, local, importState, saveReceipt }) {
    const endpoint = `${LIBRARY}/items/${encodeURIComponent(attachmentKey)}/file`;
    const currentData = itemData(attachment);
    if (String(currentData?.md5 ?? '').toLowerCase() === fileInfo.md5) return attachment;
    const uploadAuthId = `${importState.id}:file-authorize`;
    const uploadBytesId = `${importState.id}:file-upload`;
    const registerId = `${importState.id}:file-register`;
    const expectedMatch = currentData?.md5 ? { 'If-Match': currentData.md5 } : { 'If-None-Match': '*' };

    let authRecord = local.operations[uploadAuthId];
    if (authRecord?.state === 'in_flight' || authRecord?.state === 'unknown') {
      const check = await this._lookupItem(attachmentKey);
      if (String(itemData(check)?.md5 ?? '').toLowerCase() === fileInfo.md5) {
        authRecord.state = 'complete';
        authRecord.result = { key: attachmentKey, recovered: true };
        await this._saveReceipt(local, receipt, saveReceipt);
        return check;
      }
      authRecord.state = 'unknown';
      await this._saveReceipt(local, receipt, saveReceipt);
      throw new ZoteroUnknownWriteError(uploadAuthId, attachmentKey);
    }
    if (authRecord?.state === 'failed') throw new ZoteroApiError(`Previous Zotero operation ${uploadAuthId} failed and requires review`, { status: authRecord.status });
    if (!authRecord) {
      authRecord = local.operations[uploadAuthId] = { kind: 'file-authorize', key: attachmentKey, state: 'prepared' };
      await this._saveReceipt(local, receipt, saveReceipt);
    }
    let authorization;
    if (authRecord.state === 'complete') {
      if (authRecord.result?.exists) {
        const after = await this._lookupItem(attachmentKey);
        if (String(itemData(after)?.md5 ?? '').toLowerCase() === fileInfo.md5) return after;
        throw new ZoteroUnknownWriteError(uploadAuthId, attachmentKey);
      }
      authorization = {
        uploadKey: authRecord.uploadKey,
        url: authRecord.uploadUrl,
        contentType: authRecord.contentType,
        prefix: authRecord.prefix,
        suffix: authRecord.suffix,
      };
    } else {
      authRecord.state = 'in_flight';
      authRecord.md5 = fileInfo.md5;
      await this._saveReceipt(local, receipt, saveReceipt);

      const params = new URLSearchParams({
        md5: fileInfo.md5,
        filename: safeFilename(filePath),
        filesize: String(fileInfo.size),
        mtime: String(fileInfo.mtime),
      });
      try {
        const { response, url } = await this._request(endpoint, {
          method: 'POST',
          headers: { ...expectedMatch, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params,
        }, { write: true });
        if (!response.ok) {
          if (response.status === 401) authRecord.state = 'prepared';
          else authRecord.state = 'failed';
          authRecord.status = response.status;
          await this._saveReceipt(local, receipt, saveReceipt);
          throw await this._apiError(response, url);
        }
        authorization = await response.json();
      } catch (error) {
        if (error instanceof ZoteroAuthorizationRequiredError) {
          authRecord.state = 'prepared';
          await this._saveReceipt(local, receipt, saveReceipt);
          throw error;
        }
        if (error instanceof ZoteroApiError && [401, 403, 412, 428].includes(error.status)) throw error;
        authRecord.state = 'unknown';
        await this._saveReceipt(local, receipt, saveReceipt);
        throw error;
      }
    }
    if (authorization?.exists) {
      const after = await this._lookupItem(attachmentKey);
      if (String(itemData(after)?.md5 ?? '').toLowerCase() !== fileInfo.md5) {
        authRecord.state = 'unknown';
        await this._saveReceipt(local, receipt, saveReceipt);
        throw new ZoteroUnknownWriteError(uploadAuthId, attachmentKey);
      }
      authRecord.state = 'complete';
      authRecord.result = { key: attachmentKey, exists: true };
      await this._saveReceipt(local, receipt, saveReceipt);
      return after;
    }
    if (!authorization?.url || !authorization?.uploadKey) {
      authRecord.state = 'unknown';
      await this._saveReceipt(local, receipt, saveReceipt);
      throw new ZoteroApiError('Zotero did not return a file upload URL and upload key');
    }
    let uploadUrl;
    try {
      uploadUrl = new URL(authorization.url, this.base);
    } catch {
      authRecord.state = 'failed';
      authRecord.status = 'invalid-upload-url';
      await this._saveReceipt(local, receipt, saveReceipt);
      throw new ZoteroApiError('Zotero returned an invalid upload URL');
    }
    const expectedUploadPath = `${this.base.pathname}local/uploads/`;
    if (uploadUrl.origin !== this.base.origin || !uploadUrl.pathname.startsWith(expectedUploadPath) || uploadUrl.username || uploadUrl.password || uploadUrl.hash) {
      authRecord.state = 'failed';
      authRecord.status = 'unsafe-upload-url';
      await this._saveReceipt(local, receipt, saveReceipt);
      throw new ZoteroApiError('Zotero returned an upload URL outside the configured local upload endpoint');
    }
    authRecord.state = 'complete';
    authRecord.uploadKey = authorization.uploadKey;
    authRecord.uploadUrl = uploadUrl.href;
    authRecord.contentType = authorization.contentType ?? 'application/octet-stream';
    authRecord.prefix = authorization.prefix ?? '';
    authRecord.suffix = authorization.suffix ?? '';
    await this._saveReceipt(local, receipt, saveReceipt);

    const uploadHeaders = new Headers({ 'Content-Type': authRecord.contentType });
    const prefix = Buffer.from(authRecord.prefix, 'utf8');
    const suffix = Buffer.from(authRecord.suffix, 'utf8');
    const latestFileInfo = await hashFile(filePath, { verifyPdf: contentType === 'application/pdf' });
    if (latestFileInfo.md5 !== fileInfo.md5 || latestFileInfo.sha256 !== fileInfo.sha256) {
      throw new ZoteroApiError('The file changed while its Zotero upload was being prepared');
    }
    const payload = Readable.from((async function* () {
      if (prefix.length) yield prefix;
      for await (const chunk of createReadStream(filePath)) yield chunk;
      if (suffix.length) yield suffix;
    })());
    let bytesRecord = local.operations[uploadBytesId];
    if (bytesRecord?.state === 'in_flight' || bytesRecord?.state === 'unknown') {
      bytesRecord.state = 'unknown';
      await this._saveReceipt(local, receipt, saveReceipt);
      throw new ZoteroUnknownWriteError(uploadBytesId, attachmentKey);
    }
    if (bytesRecord?.state === 'failed') throw new ZoteroApiError(`Previous Zotero operation ${uploadBytesId} failed and requires review`, { status: bytesRecord.status });
    if (!bytesRecord) {
      bytesRecord = local.operations[uploadBytesId] = { kind: 'file-bytes', key: authRecord.uploadKey, state: 'prepared' };
      await this._saveReceipt(local, receipt, saveReceipt);
    }
    if (bytesRecord.state !== 'complete') {
      bytesRecord.state = 'in_flight';
      await this._saveReceipt(local, receipt, saveReceipt);
      try {
        const response = await this.fetchImpl(uploadUrl, { method: 'POST', headers: uploadHeaders, body: payload, duplex: 'half', redirect: 'manual' });
        if (response.status !== 201) {
          bytesRecord.state = response.status === 401 ? 'prepared' : 'failed';
          bytesRecord.status = response.status;
          await this._saveReceipt(local, receipt, saveReceipt);
          throw new ZoteroApiError(`Zotero file upload failed with HTTP ${response.status}`, { status: response.status });
        }
        bytesRecord.state = 'complete';
        bytesRecord.result = { uploadKey: authRecord.uploadKey };
        await this._saveReceipt(local, receipt, saveReceipt);
      } catch (error) {
        if (error instanceof ZoteroApiError && error.status) throw error;
        bytesRecord.state = 'unknown';
        await this._saveReceipt(local, receipt, saveReceipt);
        throw error;
      }
    }

    let registerRecord = local.operations[registerId];
    if (registerRecord?.state === 'in_flight' || registerRecord?.state === 'unknown') {
      const check = await this._lookupItem(attachmentKey);
      if (String(itemData(check)?.md5 ?? '').toLowerCase() === fileInfo.md5) {
        registerRecord.state = 'complete';
        registerRecord.result = { key: attachmentKey, recovered: true };
        await this._saveReceipt(local, receipt, saveReceipt);
        return check;
      }
      registerRecord.state = 'unknown';
      await this._saveReceipt(local, receipt, saveReceipt);
      throw new ZoteroUnknownWriteError(registerId, attachmentKey);
    }
    if (registerRecord?.state === 'failed') throw new ZoteroApiError(`Previous Zotero operation ${registerId} failed and requires review`, { status: registerRecord.status });
    if (!registerRecord) {
      registerRecord = local.operations[registerId] = { kind: 'file-register', key: attachmentKey, state: 'prepared', uploadKey: authRecord.uploadKey };
      await this._saveReceipt(local, receipt, saveReceipt);
    }
    registerRecord.state = 'in_flight';
    await this._saveReceipt(local, receipt, saveReceipt);
    const registerParams = new URLSearchParams({ upload: authRecord.uploadKey });
    try {
      const { response, url } = await this._request(endpoint, {
        method: 'POST',
        headers: { ...expectedMatch, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: registerParams,
      }, { write: true });
      if (response.status !== 204) {
        if (response.status === 401) registerRecord.state = 'prepared';
        else registerRecord.state = 'failed';
        registerRecord.status = response.status;
        await this._saveReceipt(local, receipt, saveReceipt);
        throw await this._apiError(response, url);
      }
    } catch (error) {
      if (error instanceof ZoteroAuthorizationRequiredError) {
        registerRecord.state = 'prepared';
        await this._saveReceipt(local, receipt, saveReceipt);
        throw error;
      }
      if (error instanceof ZoteroApiError && [401, 403, 412, 428].includes(error.status)) throw error;
      registerRecord.state = 'unknown';
      await this._saveReceipt(local, receipt, saveReceipt);
      throw error;
    }
    const attached = await this._lookupItem(attachmentKey);
    if (String(itemData(attached)?.md5 ?? '').toLowerCase() !== fileInfo.md5) {
      registerRecord.state = 'unknown';
      await this._saveReceipt(local, receipt, saveReceipt);
      throw new ZoteroUnknownWriteError(registerId, attachmentKey);
    }
    registerRecord.state = 'complete';
    registerRecord.result = { key: attachmentKey, recovered: false };
    await this._saveReceipt(local, receipt, saveReceipt);
    return attached;
  }

  async _resetRejectedMarkdownOperations(local, receipt, saveReceipt, importId) {
    let changed = false;
    const prefix = `${importId}:`;
    for (const [operationId, record] of Object.entries(local.operations)) {
      if (!operationId.startsWith(prefix) || !['failed', 'unknown'].includes(record.state) || ![400, 415].includes(record.status)) continue;
      record.state = 'prepared';
      changed = true;
    }
    if (changed) await this._saveReceipt(local, receipt, saveReceipt);
  }

  async importPaper({ metadata = {}, pdfPath, collectionPath = [], rootName = '文献积累', receipt = {}, saveReceipt = async () => {} } = {}) {
    if (!pdfPath) throw new TypeError('pdfPath is required');
    return this._importFile({ metadata, filePath: pdfPath, fileKind: 'pdf', contentType: 'application/pdf', collectionPath, rootName, receipt, saveReceipt });
  }

  async importMarkdown({ metadata = {}, markdownPath, collectionPath = [], rootName = '文献积累', receipt = {}, saveReceipt = async () => {} } = {}) {
    if (!markdownPath) throw new TypeError('markdownPath is required');
    if (!['.md', '.markdown'].includes(path.extname(markdownPath).toLowerCase())) {
      throw new TypeError('markdownPath must point to a .md or .markdown file');
    }
    return this._importFile({ metadata, filePath: markdownPath, fileKind: 'markdown', contentType: 'text/markdown', collectionPath, rootName, receipt, saveReceipt });
  }

  async _importFile({ metadata, filePath, fileKind, contentType, collectionPath, rootName, receipt, saveReceipt }) {
    const serverId = await this._getServerId();
    const local = await this._receiptRoot(receipt, serverId, saveReceipt);
    const fileInfo = await hashFile(filePath, { verifyPdf: fileKind === 'pdf' });
    let importState = local.import;
    if (!importState) {
      importState = local.import = { id: randomBytes(16).toString('hex'), md5: fileInfo.md5, sha256: fileInfo.sha256, ...(fileKind === 'markdown' ? { fileKind } : {}) };
      await this._saveReceipt(local, receipt, saveReceipt);
    } else if (importState.md5 !== fileInfo.md5 || importState.sha256 !== fileInfo.sha256 || (importState.fileKind ?? 'pdf') !== fileKind) {
      throw new ZoteroApiError(`The ${fileKind} file changed after this import receipt was created`);
    }

    const collectionKeys = await this._ensureCollectionKeys(collectionPath, rootName, receipt, saveReceipt);
    let matched = null;
    const reservedParentKey = importState.parentKey;
    const createParentOp = local.operations[`${importState.id}:create-parent`];
    if (reservedParentKey && createParentOp && ['complete', 'in_flight', 'unknown'].includes(createParentOp.state)) {
      try {
        matched = await this._lookupItem(reservedParentKey);
        if (itemData(matched)?.itemType !== 'journalArticle') throw new ZoteroApiError(`Assigned parent key ${reservedParentKey} has the wrong item type`);
        const wasAlreadyComplete = createParentOp.state === 'complete';
        createParentOp.state = 'complete';
        createParentOp.result = { key: reservedParentKey, recovered: !wasAlreadyComplete };
        if (!wasAlreadyComplete) await this._saveReceipt(local, receipt, saveReceipt);
      } catch (error) {
        if (!(error instanceof ZoteroApiError && error.status === 404)) throw error;
        if (createParentOp.state === 'complete') throw new ZoteroApiError(`Receipt says parent ${reservedParentKey} exists, but Zotero could not find it`);
        createParentOp.state = 'unknown';
        await this._saveReceipt(local, receipt, saveReceipt);
        throw new ZoteroUnknownWriteError(`${importState.id}:create-parent`, reservedParentKey);
      }
    }
    if (!matched) matched = await this.findPaper({ doi: fieldValue(metadata, 'DOI', 'doi'), title: metadata.title });
    let parentKey;
    let reused = Boolean(matched);
    let parent;
    if (matched) {
      parent = matched;
      parentKey = itemData(matched).key ?? matched.key;
      if (createParentOp?.state === 'prepared' && parentKey !== reservedParentKey) {
        createParentOp.state = 'skipped';
        createParentOp.result = { key: parentKey, reason: 'exact-duplicate-found-before-create' };
        await this._saveReceipt(local, receipt, saveReceipt);
      }
      importState.parentKey = parentKey;
      importState.reusedParent = true;
      await this._saveReceipt(local, receipt, saveReceipt);
      parent = await this._updateParentCollections(parentKey, collectionKeys, receipt, local, saveReceipt, `${importState.id}:merge-collections`);
    } else {
      parentKey = importState.parentKey ?? makeZoteroKey();
      importState.parentKey = parentKey;
      await this._saveReceipt(local, receipt, saveReceipt);
      const parentData = journalArticleData(metadata, collectionKeys, parentKey);
      parent = await this._writeItemCreate({
        receipt, local, operationId: `${importState.id}:create-parent`, key: parentKey,
        body: parentData, saveReceipt,
        verify: (value) => {
          const data = itemData(value);
          return data?.key === parentKey && data.itemType === 'journalArticle';
        },
      });
    }

    let attachment = await this._findSameAttachment(parentKey, fileInfo.md5, fileKind === 'markdown' ? { contentType } : undefined);
    if (attachment) {
      reused = true;
      const attachmentData = itemData(attachment);
      importState.attachmentKey = attachmentData.key ?? attachment.key;
      await this._saveReceipt(local, receipt, saveReceipt);
    } else {
      const attachmentKey = importState.attachmentKey ?? makeZoteroKey();
      importState.attachmentKey = attachmentKey;
      await this._saveReceipt(local, receipt, saveReceipt);
      try {
        attachment = await this._writeItemCreate({
          receipt, local, operationId: `${importState.id}:create-attachment`, key: attachmentKey,
          body: {
            itemType: 'attachment',
            key: attachmentKey,
            parentItem: parentKey,
            linkMode: 'imported_file',
            title: safeFilename(filePath),
            note: '',
            tags: [],
            relations: {},
            contentType,
            charset: '',
            filename: safeFilename(filePath),
            md5: null,
            mtime: null,
          },
          saveReceipt,
          verify: (value) => {
            const data = itemData(value);
            return data?.key === attachmentKey && data.itemType === 'attachment' && data.parentItem === parentKey && data.linkMode === 'imported_file';
          },
        });
      } catch (error) {
        if (fileKind === 'markdown' && error instanceof ZoteroApiError && [400, 415].includes(error.status)) {
          await this._resetRejectedMarkdownOperations(local, receipt, saveReceipt, importState.id);
          throw new ZoteroMarkdownAttachmentUnsupportedError(error);
        }
        throw error;
      }
      try {
        attachment = await this._uploadFile({ parentKey, attachmentKey, filePath, fileInfo, contentType, attachment, receipt, local, importState, saveReceipt });
      } catch (error) {
        if (fileKind === 'markdown' && error instanceof ZoteroApiError && [400, 415].includes(error.status)) {
          await this._resetRejectedMarkdownOperations(local, receipt, saveReceipt, importState.id);
          throw new ZoteroMarkdownAttachmentUnsupportedError(error);
        }
        throw error;
      }
    }

    const attachmentData = itemData(attachment);
    if (String(attachmentData?.md5 ?? '').toLowerCase() !== fileInfo.md5) {
      try {
        attachment = await this._uploadFile({ parentKey, attachmentKey: attachmentData.key ?? importState.attachmentKey, filePath, fileInfo, contentType, attachment, receipt, local, importState, saveReceipt });
      } catch (error) {
        if (fileKind === 'markdown' && error instanceof ZoteroApiError && [400, 415].includes(error.status)) {
          await this._resetRejectedMarkdownOperations(local, receipt, saveReceipt, importState.id);
          throw new ZoteroMarkdownAttachmentUnsupportedError(error);
        }
        throw error;
      }
    }
    const verifiedAttachment = await this._lookupItem(attachmentData.key ?? importState.attachmentKey);
    const verifiedData = itemData(verifiedAttachment);
    if (verifiedData.itemType !== 'attachment' || verifiedData.parentItem !== parentKey || String(verifiedData.md5 ?? '').toLowerCase() !== fileInfo.md5 || (fileKind === 'markdown' && String(verifiedData.contentType ?? '').toLowerCase() !== contentType)) {
      const mismatch = new ZoteroApiError(`Zotero attachment read-back did not match the imported ${fileKind}`);
      if (fileKind === 'markdown') throw new ZoteroMarkdownAttachmentUnsupportedError(mismatch);
      throw mismatch;
    }
    const parentAfter = await this._lookupItem(parentKey);
    const parentData = itemData(parentAfter);
    if (!collectionKeys.every((key) => (parentData.collections ?? []).includes(key))) {
      throw new ZoteroApiError('Zotero parent read-back is missing one or more selected collections');
    }
    const currentCollections = await this.collections();
    const pathByKey = new Map(currentCollections.map((entry) => [entry.key, entry.path]));
    const storagePath = await this._getStoragePath(verifiedData.key);
    importState.state = 'complete';
    importState.result = { parentKey, attachmentKey: verifiedData.key, md5: fileInfo.md5, sha256: fileInfo.sha256 };
    await this._saveReceipt(local, receipt, saveReceipt);
    return {
      parentKey,
      attachmentKey: verifiedData.key,
      storagePath,
      collectionKeys: parentData.collections ?? [],
      collectionPaths: (parentData.collections ?? []).map((key) => pathByKey.get(key) ?? null),
      reused,
      sha256: fileInfo.sha256,
      md5: fileInfo.md5,
    };
  }
}
