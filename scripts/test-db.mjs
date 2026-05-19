#!/usr/bin/env node
// R-80 hardening (post-mortem) · safe wrapper for db tests.
//
// Why this script exists:
//   db tests need better-sqlite3 compiled against the Node ABI so plain
//   vitest (running on Node) can dlopen it. Previously the developer had
//   to manually call `npm run test:db:to-node`, then `test:db:run`, then
//   remember to call `test:db:to-electron` to restore Electron-ABI build
//   for `npm run dev`. Forgetting the third step left the dev environment
//   broken — that exact bug bit us in production.
//
// What we do:
//   1. Rebuild better-sqlite3 against Node ABI (`test:db:to-node`).
//   2. Run the db test suite (`test:db:run`).
//   3. Restore Electron ABI (`test:db:to-electron`) — ALWAYS, regardless
//      of step 2's exit code. This is the "finally" arm we couldn't write
//      portably in pure npm-script shell.
//
// Exit code = step 2's exit code. Step 3 failures are surfaced as a
// loud warning but don't mask test failures.
//
// Reverse-assertion (do NOT regress):
//   - We MUST run `to-electron` even if tests fail or are killed by the
//     user (we register SIGINT/SIGTERM handlers to honor that).
//   - We MUST forward step 2's exit code; CI relies on it.

import { spawnSync } from 'node:child_process';

const isWin = process.platform === 'win32';

function npmRun(scriptName) {
  const r = spawnSync('npm', ['run', scriptName], {
    stdio: 'inherit',
    shell: isWin,
  });
  return typeof r.status === 'number' ? r.status : 1;
}

let exitedEarly = false;
function restoreElectronAbi(reason) {
  if (exitedEarly) return;
  exitedEarly = true;
  console.log(`\n[test-db] restoring Electron ABI (reason: ${reason}) …`);
  const code = npmRun('test:db:to-electron');
  if (code !== 0) {
    console.error('[test-db] WARNING: failed to restore Electron ABI; run `npm run test:db:to-electron` manually before `npm run dev`.');
  }
}

process.on('SIGINT', () => { restoreElectronAbi('SIGINT'); process.exit(130); });
process.on('SIGTERM', () => { restoreElectronAbi('SIGTERM'); process.exit(143); });

const toNodeCode = npmRun('test:db:to-node');
if (toNodeCode !== 0) {
  console.error('[test-db] failed to rebuild better-sqlite3 against Node ABI; aborting.');
  restoreElectronAbi('to-node failed');
  process.exit(toNodeCode);
}

const runCode = npmRun('test:db:run');
restoreElectronAbi(runCode === 0 ? 'tests passed' : `tests exit ${runCode}`);
process.exit(runCode);
