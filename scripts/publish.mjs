#!/usr/bin/env node
/**
 * Publish all four packages to npm.
 *
 * Order matters: the hub is last because its README references the others.
 * Each package is published from its own directory; a failure stops the run so
 * you never end up with a half-published set that still looks complete.
 *
 * Usage:
 *   node scripts/publish.mjs            # publish current versions
 *   node scripts/publish.mjs --dry-run  # show what would be published
 *   node scripts/publish.mjs --otp 123456
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packages = ['literature-workflow', 'knowledge-cards', 'lit-learning', 'plugin-hub'];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const otpIndex = args.indexOf('--otp');
const otp = otpIndex >= 0 ? args[otpIndex + 1] : null;

// Refuse to publish anything that is not a scoped public package.
let problems = 0;
for (const dir of packages) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'packages', dir, 'package.json'), 'utf8'));
  const issues = [];
  if (!manifest.name.startsWith('@')) issues.push('name is not scoped');
  if (manifest.private) issues.push('marked private');
  if (manifest.publishConfig?.access !== 'public') issues.push('publishConfig.access is not public');
  if (!manifest.version) issues.push('missing version');
  if (issues.length) {
    console.error(`FAIL ${dir}: ${issues.join('; ')}`);
    problems++;
  } else {
    console.log(`ok   ${manifest.name}@${manifest.version}`);
  }
}
if (problems) {
  console.error(`\n${problems} package(s) not publishable; aborting.`);
  process.exit(1);
}

if (dryRun) {
  console.log('\n--- dry run: npm pack --dry-run ---');
  for (const dir of packages) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'packages', dir, 'package.json'), 'utf8'));
    console.log(`\n=== ${manifest.name}@${manifest.version}`);
    spawnSync('npm', ['pack', '--dry-run'], {
      cwd: path.join(root, 'packages', dir),
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  }
  console.log('\nDry run complete; nothing was published.');
  process.exit(0);
}

for (const dir of packages) {
  const cwd = path.join(root, 'packages', dir);
  const manifest = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  console.log(`\n=== publishing ${manifest.name}@${manifest.version}`);
  const publishArgs = ['publish', '--access', 'public'];
  if (otp) publishArgs.push('--otp', otp);
  const result = spawnSync('npm', publishArgs, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error(`\nFAILED at ${manifest.name}. Fix the problem, then re-run;`);
    console.error('packages already published keep their version, so bump only the failed one if needed.');
    process.exit(result.status ?? 1);
  }
}

console.log('\nAll four packages published.');
