#!/usr/bin/env node
/**
 * Verify that every package is structurally installable before publishing:
 * manifest fields, bundle patch, exports, declared files and client id.
 * This does not install anything into a DSH profile.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packages = ['literature-workflow', 'knowledge-cards', 'lit-learning'];
let failures = 0;
const fail = (pkg, message) => {
  failures += 1;
  console.error(`FAIL ${pkg}: ${message}`);
};

function globExists(base, pattern) {
  const normalized = pattern.replace(/\\/g, '/');
  if (!normalized.includes('*')) return fs.existsSync(path.join(base, normalized));
  const [head] = normalized.split('*');
  const dir = path.join(base, path.dirname(head));
  const prefix = path.basename(head);
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some(name => name.startsWith(prefix));
}

for (const name of packages) {
  const dir = path.join(root, 'packages', name);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  if (manifest.name !== `dsh-${name === 'literature-workflow' ? 'literature-workflow' : name}`) {
    fail(name, `unexpected package name ${manifest.name}`);
  }
  if (manifest.license !== 'MIT') fail(name, 'license must be MIT');
  if (manifest.private === true) fail(name, 'package must not be private for a shareable repo');
  if (!manifest.dsh?.bundle?.patch) fail(name, 'missing dsh.bundle.patch');
  else if (!fs.existsSync(path.join(dir, manifest.dsh.bundle.patch))) fail(name, 'bundle patch file missing');

  const patchPath = path.join(dir, manifest.dsh?.bundle?.patch ?? 'bundle.patch.yml');
  if (fs.existsSync(patchPath)) {
    const patch = fs.readFileSync(patchPath, 'utf8');
    if (!patch.includes(`name: '${manifest.name}'`)) fail(name, 'bundle patch does not name this package');
    if (/[A-Za-z]:\\\\/.test(patch)) fail(name, 'bundle patch contains an absolute Windows path');
  }

  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    const rel = typeof target === 'string' ? target : target.default;
    if (!rel || rel.includes('*')) continue;
    if (!fs.existsSync(path.join(dir, rel))) fail(name, `export ${subpath} -> ${rel} is missing`);
  }
  for (const pattern of manifest.files ?? []) {
    if (!globExists(dir, pattern)) fail(name, `files entry missing: ${pattern}`);
  }
  if (manifest.dsh?.client) {
    const clientPath = path.join(dir, 'client.js');
    if (!fs.existsSync(clientPath)) fail(name, 'client.js missing');
    else {
      const client = fs.readFileSync(clientPath, 'utf8');
      if (!client.includes(`id: '${manifest.name}'`)) fail(name, 'client bundle id does not match package name');
    }
  }
  console.log(`ok ${manifest.name}@${manifest.version}`);
}

if (failures > 0) {
  console.error(`\n${failures} package check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nall package checks passed');
}
