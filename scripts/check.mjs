#!/usr/bin/env node
/**
 * Syntax-check every host module and client bundle in the repo.
 * Runs `node --check` in a child process so one broken file does not abort the
 * walk; exits non-zero when any file fails.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const targets = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(mjs|js)$/.test(entry.name)) targets.push(full);
  }
})(path.join(root, 'packages'));

let failed = 0;
for (const file of targets.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed += 1;
    console.error(`FAIL ${path.relative(root, file)}`);
    if (result.stderr) console.error(result.stderr.trim());
  }
}
console.log(`checked ${targets.length} file(s), ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
