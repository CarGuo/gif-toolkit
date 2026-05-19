#!/usr/bin/env node
// R-80 hardening (post-mortem) · ensure better-sqlite3 .node matches Electron ABI.
//
// Why this script exists:
//   `npm run test:db:to-node` rebuilds better-sqlite3 against the *Node*
//   ABI so vitest (running under plain Node) can dlopen it. If a developer
//   forgets to run `test:db:to-electron` afterwards, the next `npm run dev`
//   crashes at db init with "compiled against a different Node.js version".
//
// What we do:
//   1. Probe the on-disk .node and the Electron runtime ABI.
//   2. If they don't match, run `electron-rebuild -f -w better-sqlite3`
//      automatically and re-probe.
//   3. Exit 0 only when ABIs match. Used as a `predev` / `prestart` guard
//      and at the start of `npm run test:db`.
//
// Reverse-assertion (do NOT regress):
//   - This script must work on macOS / Windows / Linux (no shell pipes).
//   - Errors during probe must NOT be silent — log + exit 1.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(new URL('.', import.meta.url).pathname, '..');
const electronBin = resolve(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron',
);

function probeElectronAbi() {
  const out = execFileSync(electronBin, ['-e', 'process.stdout.write(String(process.versions.modules))'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return Number(out.trim());
}

function probeNodeFileAbi() {
  // Use Electron itself to dlopen the .node and report whether it loads.
  // If it loads, ABIs match. If it throws, the error message contains the
  // numbers we want.
  const probeScript = `
    try {
      require('better-sqlite3');
      process.stdout.write('OK');
    } catch (e) {
      process.stdout.write('FAIL ' + String(e.message).split('\\n').join(' | '));
    }
  `;
  const out = execFileSync(electronBin, ['-e', probeScript], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out.trim();
}

function rebuildToElectron() {
  console.log('[ensure-sqlite-abi] running electron-rebuild -f -w better-sqlite3 …');
  const r = spawnSync('npx', ['--no-install', 'electron-rebuild', '-f', '-w', 'better-sqlite3'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) {
    console.error('[ensure-sqlite-abi] electron-rebuild failed with status', r.status);
    process.exit(1);
  }
}

function main() {
  if (!existsSync(electronBin)) {
    console.warn('[ensure-sqlite-abi] electron binary not found at', electronBin, '— skipping (assume not yet installed).');
    return;
  }
  const electronAbi = probeElectronAbi();
  const probe = probeNodeFileAbi();
  if (probe.startsWith('OK')) {
    console.log(`[ensure-sqlite-abi] ok abi=${electronAbi} (better-sqlite3 loads under Electron)`);
    return;
  }
  console.warn(`[ensure-sqlite-abi] mismatch detected — Electron abi=${electronAbi}, dlopen says: ${probe}`);
  rebuildToElectron();
  const after = probeNodeFileAbi();
  if (after.startsWith('OK')) {
    console.log(`[ensure-sqlite-abi] recovered: ok abi=${electronAbi}`);
    return;
  }
  console.error('[ensure-sqlite-abi] still failing after rebuild:', after);
  process.exit(1);
}

main();
