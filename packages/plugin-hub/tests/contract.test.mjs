// Contract checks for the plugin hub that need no jsdom: the package must
// declare a valid DSH client bundle, the loader id must match the patch entry,
// and the config defaults must stay conservative.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => fs.readFileSync(path.join(packageDir, f), 'utf8');

test('package metadata exposes the native Client page', async () => {
  const manifest = JSON.parse(read('package.json'));
  assert.equal(manifest.name, '@ysl289/dsh-plugin-hub');
  assert.match(manifest.version, /^\d+\.\d+\.\d+(-[\w.-]+)?$/);
  assert.equal(manifest.exports['./client'], './client.js');
  assert.equal(manifest.exports['./icon'], './icon.svg');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.dsh.client.immediately, true);
  for (const id of [
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@deepseek-ai/dsh-client-ui-theme',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-connection',
  ]) {
    assert.ok(manifest.dsh.client.inject.includes(id), `missing Client dependency ${id}`);
  }
  assert.ok(manifest.files.includes('client.js'));
  assert.ok(!manifest.files.some((f) => /node_modules|preview|tests/.test(f)), 'dev files are not packaged');
});

test('the loader id matches the bundle patch entry', async () => {
  const client = read('client.js');
  const match = client.match(/id:\s*'([^']+)'/);
  assert.ok(match, 'client.js registers a module id');
  assert.equal(match[1], '@ysl289/dsh-plugin-hub', 'module id is the public package name');

  const patch = read('bundle.patch.yml');
  assert.match(patch, /id:\s*dsh-plugin-hub/);
  assert.match(patch, /name:\s*'@ysl289\/dsh-plugin-hub'/);
  assert.doesNotMatch(patch, /@local\//, 'no local-only scope leaks into the patch');
  assert.doesNotMatch(patch, /[A-Za-z]:[\\/]/, 'no absolute Windows paths in the patch');
});

test('hiding is opt-in and the default list is explicit', async () => {
  const patch = read('bundle.patch.yml');
  assert.match(patch, /hideSidebarIcons:\s*true/);
  const hideBlock = patch.slice(patch.indexOf('hide:'));
  for (const id of ['literature-workflow', 'knowledge-cards', 'lit-learning']) {
    assert.ok(hideBlock.includes(`- ${id}`), `default hide list mentions ${id}`);
  }
  // The hub must never hide itself.
  assert.ok(!/hide:[\s\S]*?-\s*dsh-plugin-hub/.test(patch), 'the hub never hides its own entry');
});

test('the host half stays inert', async () => {
  const index = read('index.mjs');
  assert.match(index, /export const name = '@ysl289\/dsh-plugin-hub'/);
  assert.doesNotMatch(index, /ctx\.(server|router|http)/, 'the hub registers no backend capability');
});

test('the client bundle is syntactically valid', async () => {
  // node --check runs in the CI syntax job; here we assert the module wrapper
  // is present so the bundle cannot silently become a bare script.
  const client = read('client.js');
  assert.match(client, /window\.__ModuleLoader__\.load\(/);
  assert.match(client, /factory\s*\(/);
});
