#!/usr/bin/env node
/**
 * scripts/clean-tmp.mjs
 *
 * One-shot CLI for sweeping leftover `giftk-*` directories from
 * `os.tmpdir()`. Defaults to `--dry-run` so a careless invocation
 * never deletes anything; pass `--apply` to actually delete.
 *
 * Usage:
 *   node scripts/clean-tmp.mjs              # plan only (dry-run)
 *   node scripts/clean-tmp.mjs --apply      # really delete
 *   node scripts/clean-tmp.mjs --max-age-h 48 [--apply]
 *
 * The script delegates to `sweepTmpDir` from
 * `src/main/tmpCleanup.ts`, so behaviour stays identical to the
 * runtime cleaner the main process uses (same prefix whitelist,
 * same safety guards). It expects the TypeScript code to have been
 * compiled to `dist/main/tmpCleanup.js` (i.e. run `npm run build:main`
 * first). Falling back to a re-implementation here would risk drift.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const compiled = path.join(projectRoot, 'dist', 'main', 'tmpCleanup.js');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dryRun = !apply;
const maxAgeIdx = args.indexOf('--max-age-h');
const maxAgeH = maxAgeIdx >= 0 ? Number(args[maxAgeIdx + 1]) : 24;
if (!Number.isFinite(maxAgeH) || maxAgeH <= 0) {
  console.error('clean-tmp: --max-age-h must be a positive number of hours');
  process.exit(2);
}

if (!existsSync(compiled)) {
  console.error(`clean-tmp: compiled module not found at ${compiled}`);
  console.error('             Run \`npm run build:main\` first.');
  process.exit(2);
}

const require = createRequire(import.meta.url);
const { sweepTmpDir, ALLOWED_PREFIXES } = require(compiled);

const tmpDir = os.tmpdir();
console.log(`clean-tmp: scanning ${tmpDir}`);
console.log(`clean-tmp: prefixes = ${ALLOWED_PREFIXES.join(', ')}`);
console.log(`clean-tmp: maxAgeMs = ${maxAgeH}h, mode = ${dryRun ? 'DRY-RUN' : 'APPLY'}`);

const report = sweepTmpDir({
  tmpDir,
  maxAgeMs: maxAgeH * 60 * 60 * 1000,
  dryRun,
  logger: {
    info: (m) => console.log(`  · ${m}`),
    warn: (m) => console.warn(`  ! ${m}`),
    error: (m) => console.error(`  x ${m}`)
  }
});

console.log('');
console.log(`scanned : ${report.scanned}`);
console.log(`deleted : ${report.deleted.length}${dryRun ? ' (planned)' : ''}`);
console.log(`skipped : ${report.skipped.length}`);
console.log(`errors  : ${report.errors.length}`);
if (dryRun && report.deleted.length > 0) {
  console.log('');
  console.log('Re-run with --apply to perform the deletions above.');
}
process.exit(report.errors.length === 0 ? 0 : 1);
