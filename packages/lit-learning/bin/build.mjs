import os from 'node:os';
import path from 'node:path';
import { normalizeConfig } from '../lib/config.mjs';
import { buildLearningLayer } from '../lib/build.mjs';

const rootArg = process.argv.find(arg => arg.startsWith('--root='));
const learningRoot = rootArg
  ? rootArg.slice('--root='.length)
  : (process.env.DSH_LIT_LEARNING || path.join(os.homedir(), 'Desktop', '文献学习层'));

const config = normalizeConfig({ learningRoot });
const result = await buildLearningLayer(config, { rebuild: process.argv.includes('--rebuild') });

console.log(JSON.stringify({
  ok: result.ok,
  publishable: result.validation?.publishable,
  learningRoot: result.learningRoot,
  hash: result.contentHash,
  inputsHash: result.inputsHash,
  written: result.written.length,
  unchanged: result.unchanged.length,
  reclaimed: result.reclaimed,
  counts: result.counts,
  ratings: result.ratings,
  review: result.review,
  validation: result.validation,
}, null, 2));

for (const check of result.checks) {
  console.log(`${check.ok ? 'OK  ' : 'FAIL'} ${check.id} — ${check.detail}`);
}
