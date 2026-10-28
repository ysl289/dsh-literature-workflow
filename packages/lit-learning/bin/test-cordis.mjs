import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const installRoot = process.env.DSH_TEST_INSTALL_ROOT
  || path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'DeepSeek Harness');
const executable = path.join(installRoot, 'DeepSeek Harness.exe');
const testFile = fileURLToPath(new URL('../tests/cordis.test.mjs', import.meta.url));
const result = spawnSync(executable, ['--test', testFile], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8', timeout: 30_000,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
