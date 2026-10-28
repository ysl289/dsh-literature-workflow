#!/usr/bin/env node
/**
 * Run each package's Node test suite. Packages are independent; a failure in
 * one does not stop the others, and the final exit code reflects all of them.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packages = ['literature-workflow', 'knowledge-cards', 'lit-learning'];
let failed = 0;

for (const name of packages) {
  const dir = path.join(root, 'packages', name);
  const tests = path.join(dir, 'tests');
  if (!fs.existsSync(tests)) continue;
  console.log(`\n=== ${name} ===`);
  const result = spawnSync(process.execPath, ['--test', ...fs.readdirSync(tests).filter(f => f.endsWith('.test.mjs')).map(f => path.join('tests', f))], {
    cwd: dir,
    stdio: 'inherit',
  });
  if (result.status !== 0) failed += 1;
}
process.exitCode = failed === 0 ? 0 : 1;
