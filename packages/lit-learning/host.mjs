import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { readLayerFile } from './lib/service.mjs';
import { currentManifestSync } from './lib/storage.mjs';

export const NATIVE_API = '/api/litLearning';

const headers = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const json = (value, status = 200) => new Response(JSON.stringify(value ?? null), {
  status, headers: { ...headers, 'content-type': 'application/json; charset=utf-8' },
});

const failure = error => String(error?.message || error)
  .replace(/Bearer\s+\S+/gi, 'Bearer [隐藏]')
  .replace(/sk-[\w-]+/g, '[隐藏]')
  .slice(0, 800);

/** 每次请求落一行日志：面板拿不到数据时，先看这里有没有请求进来。 */
function logRequest(config, line) {
  try {
    const file = path.join(config.learningRoot, 'report', 'requests.log');
    fsSync.mkdirSync(path.dirname(file), { recursive: true });
    fsSync.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch { /* 日志失败不影响请求 */ }
}

async function readBody(request, maximum = 256 * 1024) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) throw new Error('请求体过大');
  if (!request.body) return {};
  const text = await new Response(request.body).text();
  if (text.length > maximum) throw new Error('请求体过大');
  if (!text.trim()) return {};
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求体必须是对象');
  return value;
}

/**
 * 原生页面的路由注册在 Harness Connection 的 owner-only Fetch 注册表上。
 * 学习层只暴露自己的目录：读文件必须落在 learningRoot 内，且只允许 json/md/html。
 */
export function attachLearningUI(ctx, service, config) {
  if (typeof ctx.connection?.fetch?.register !== 'function') {
    throw new Error('Harness Connection Fetch registry 不可用，无法注册文献学习层原生页面。');
  }

  const disposers = [];

  function route(suffix, method, handler, requestBody = 'buffered') {
    const dispose = ctx.connection.fetch.register({
      path: NATIVE_API + suffix,
      methods: [method],
      requestBody,
      async fetch(request) {
        const started = Date.now();
        let response;
        try {
          if (request.method !== method) response = json({ error: '请求方法不支持' }, 405);
          else response = await handler(request, new URL(request.url));
        } catch (error) {
          const code = /^[A-Z0-9_]{1,80}$/.test(String(error?.code || '')) ? error.code : 'REQUEST_FAILED';
          const status = ['BUILD_BUSY', 'BUILD_LOCKED', 'ATTEMPT_CONFLICT', 'ITEM_VERSION_STALE', 'ITEM_NOT_FOUND'].includes(code) ? 409
            : ['JSON_INVALID', 'REVIEW_LOG_INVALID', 'STATE_INVALID', 'VALIDATION_STRUCTURE'].includes(code) ? 422 : 400;
          response = json({ error: failure(error), code,
            ...(error?.committed === true ? {committed:true,newGeneration:error.newGeneration || ''} : {}),
          }, status);
        }
        logRequest(config, `${method} ${NATIVE_API}${suffix} → ${response.status} (${Date.now() - started}ms)`);
        return response;
      },
    });
    if (typeof dispose === 'function') disposers.push(dispose);
  }

  try {
    // 探针：不带任何副作用，用来判断「路由通不通、认证过没过」。
    route('/ping', 'GET', async () => json({
      ok: true,
      plugin: 'dsh-lit-learning',
      pid: process.pid,
      learningRoot: config.learningRoot,
      built: Boolean(currentManifestSync(config.learningRoot)),
      at: new Date().toISOString(),
    }));

    route('/status', 'GET', async () => json(await service.status()));

    route('/invoke', 'POST', async request => {
      const body = await readBody(request);
      const action = String(body.action || '');
      if (!action) throw new Error('缺少 action');
      const payload = body.payload ?? {};
      if (typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload 必须是对象');
      return json(await service.invoke(action, payload));
    });

    route('/review', 'POST', async request => {
      const body = await readBody(request);
      return json(await service.recordReview(body));
    });

    route('/file', 'GET', async (_request, url) => {
      const target = readLayerFile(config, url.searchParams.get('rel'));
      const ext = path.extname(target).toLowerCase();
      const body = await fs.readFile(target);
      if (ext === '.html') {
        return new Response(body, {
          headers: {
            ...headers,
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': "sandbox allow-scripts allow-downloads; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:",
          },
        });
      }
      const type = ext === '.json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
      return new Response(body, { headers: { ...headers, 'content-type': type } });
    });
  } catch (error) {
    for (const dispose of disposers.reverse()) {
      try { dispose(); } catch { /* 保留原始错误 */ }
    }
    throw error;
  }

  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try { dispose(); } catch { /* 卸载失败不影响其它路由 */ }
    }
  };
}
