import fsp from 'node:fs/promises';
import path from 'node:path';
import {readJsonStrict} from './fsx.mjs';
import {currentRoot} from './storage.mjs';

const cache = new Map();
function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 只读轻量目录。一个请求固定一代；不把全文、复述答案与逐条评级理由送到列表。 */
export async function listPapers(config, payload = {}) {
  const root = await currentRoot(config.learningRoot);
  const manifest = await readJsonStrict(path.join(root, 'manifest.json'), {optional: true});
  if (!manifest) return {total: 0, papers: [], generation: '', offset: 0, nextOffset: null};
  const key = root + ':' + manifest.contentHash;
  let loading = cache.get(key);
  if (!loading) {
    loading = (async () => {
      const realRoot = await fsp.realpath(root);
      const files = (manifest.outputs?.content || []).filter(rel => /^papers\/[A-Za-z0-9_.-]{1,120}\.json$/.test(rel) && rel !== 'papers/index.json');
      const rows = new Array(files.length);
      let cursor = 0;
      async function reader() {
        for (;;) {
          const index = cursor++;
          if (index >= files.length) return;
          const file = path.join(root, files[index]);
          if (!inside(realRoot, await fsp.realpath(file))) throw Object.assign(new Error('论文列表文件越出当前代'), {code:'GENERATION_PATH_ESCAPE'});
          const paper = await readJsonStrict(file);
          rows[index] = {paperId:paper.paperId,title:paper.title,year:paper.citation?.year || '',grade:paper.rating?.grade || '',strategy:paper.strategy,cards:paper.cards || [],readiness:paper.readiness || null};
        }
      }
      await Promise.all(Array.from({length:Math.min(8, files.length)}, reader));
      return rows;
    })();
    cache.set(key, loading);
    if (cache.size > 6) cache.delete(cache.keys().next().value);
    loading.catch(() => { if (cache.get(key) === loading) cache.delete(key); });
  }
  const query = String(payload.query || '').trim().toLowerCase();
  const rows = (await loading).filter(p => !query || `${p.title} ${p.year} ${p.strategy?.label || ''}`.toLowerCase().includes(query));
  const offset = Math.max(0, Math.trunc(Number(payload.offset) || 0));
  const limit = Math.max(1, Math.min(1000, Math.trunc(Number(payload.limit) || 100)));
  return {total:rows.length,papers:rows.slice(offset,offset+limit),generation:manifest.generation || manifest.contentHash,offset,nextOffset:offset+limit < rows.length ? offset+limit : null};
}
