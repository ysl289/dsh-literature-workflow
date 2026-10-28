import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDir = path.dirname(fileURLToPath(import.meta.url));

function yamlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * Build this bundle's own patch with portable defaults. Paths come from the
 * same environment variables the engine reads, then fall back to the user's
 * home directory — never to a machine-specific absolute path.
 */
export function buildBundlePatch({ directory = packageDir, home = os.homedir() } = {}) {
  const root = process.env.DSH_LIT_WORKFLOW || path.join(home, 'Downloads', '文献积累工作流');
  const config = {
    workflowRoot: root,
    stateDir: path.join(root, '.plugin-state'),
    inputDir: path.join(root, 'input'),
    rootCollection: '',
    cardsHome: process.env.KCARD_HOME || process.env.DSH_CARDS_HOME || '',
    publishMode: 'preview',
    watchInput: false,
    maxPapers: 10,
    autoRun: false,
    nativeUI: true,
  };
  const configYaml = Object.entries(config)
    .map(([key, value]) => `        ${key}: ${typeof value === 'string' ? yamlString(value) : String(value)}`)
    .join('\n');
  return [
    '- insert:',
    '    - id: dsh-literature-workflow',
    "      name: 'dsh-literature-workflow'",
    '      config:',
    configYaml,
    '',
  ].join('\n');
}

/**
 * Create the bundle's own patch file without touching a Harness profile. The
 * compare-before-write behavior preserves an existing local edit or concurrent
 * replacement; an identical file is treated as an idempotent success.
 */
export async function prepareBundle({ directory = packageDir, patchFile } = {}) {
  const targetDirectory = path.resolve(directory);
  const targetFile = patchFile || path.join(targetDirectory, 'bundle.patch.yml');
  const expected = buildBundlePatch({ directory: targetDirectory });
  try {
    const current = await fs.readFile(targetFile, 'utf8');
    if (current === expected) return { path: targetFile, created: false, unchanged: true };
    throw new Error(`Refusing to replace a different bundle patch: ${targetFile}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    await fs.writeFile(targetFile, expected, { encoding: 'utf8', flag: 'wx' });
    return { path: targetFile, created: true, unchanged: false };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const current = await fs.readFile(targetFile, 'utf8');
    if (current === expected) return { path: targetFile, created: false, unchanged: true };
    throw new Error(`Bundle patch changed while preparing; preserved current file: ${targetFile}`);
  }
}

export function installPlan({ directory = packageDir } = {}) {
  const target = path.resolve(directory);
  return {
    bundleDirectory: target,
    patchPath: path.join(target, 'bundle.patch.yml'),
    pluginModule: pathToFileURL(path.join(target, 'index.mjs')).href,
    managerCall: {
      action: 'install_bundle',
      target,
      enabled: true,
    },
    note: 'Use DeepSeek Harness plugin_manager.install_bundle after review. This script never writes a profile, installs a package, starts the app, or restarts it.',
  };
}

function showHelp() {
  console.log('Usage: node install.mjs [--print-plan | --prepare-bundle | --help]');
  console.log('  --print-plan      Print the local bundle path and native plugin_manager call; no files are changed.');
  console.log('  --prepare-bundle  Create bundle.patch.yml in this package only; never edits the Harness profile.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || '--print-plan';
  if (command === '--help') showHelp();
  else if (command === '--prepare-bundle') {
    const result = await prepareBundle();
    console.log(JSON.stringify({ ...result, plan: installPlan() }, null, 2));
  } else if (command === '--print-plan') {
    console.log(JSON.stringify({ plan: installPlan(), patch: buildBundlePatch() }, null, 2));
  } else {
    showHelp();
    process.exitCode = 2;
  }
}
