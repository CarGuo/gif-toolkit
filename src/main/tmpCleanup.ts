/**
 * Stale temp-dir reaper for the gif-toolkit main process.
 *
 * Why this file exists
 * ====================
 * The mhtml importer (src/main/offlineImport.ts) and the offline /
 * e2e harness routinely call `fs.mkdtempSync(os.tmpdir() + '/giftk-…')`
 * to stage decoded parts. When the surrounding pipeline throws (or
 * the host crashes mid-import) those directories are orphaned and
 * accumulate on disk forever. This module centralises:
 *
 *   1. A *whitelist* of prefixes we ever produce (ALLOWED_PREFIXES).
 *      Anything not matching one of these is left strictly alone —
 *      we never delete random tmp dirs.
 *   2. A pure planner (listStaleEntries) that, given a directory
 *      listing + clock + threshold, returns the absolute paths
 *      that are safe to delete. This is the unit-tested core.
 *   3. A thin IO wrapper (sweepTmpDir) that performs the real
 *      `fs.rmSync({ recursive, force })` and reports a summary.
 *      Supports `dryRun` so callers can preview the plan.
 *   4. A live-session registry (sessionTmpRegistry) that the mhtml
 *      importer uses to declare "this dir belongs to an in-flight
 *      session, do NOT sweep it" and to clean up on graceful exit.
 *
 * Hard safety invariants (any breach throws):
 *   - Every candidate's basename MUST start with one of
 *     ALLOWED_PREFIXES.
 *   - Every candidate's path, after `path.relative(tmpDir, target)`,
 *     MUST NOT escape `tmpDir` (no `..` and no leading `..`).
 *   - We NEVER touch `~/Library/Application Support`, the project's
 *     `tests/fixtures` directory, or any path not under
 *     `os.tmpdir()`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Whitelist of basename prefixes the toolkit is allowed to remove.
 * Anything else is treated as "not ours" and skipped.
 */
export const ALLOWED_PREFIXES: readonly string[] = [
  'giftk-mhtml-',
  'giftk-offline-test-',
  'giftk-e2e-',
  'giftk-in-',
  'giftk-out-',
  'giftk-fake-',
  // R-COMPRESS-V1 #4 — Lineage modal "试跑 0.5s" produces an isolated
  // tmp dir per click (clip + trial output). The renderer rm -rf's it
  // on modal close, but if the renderer crashes mid-preview the dir
  // would otherwise leak — so we list its prefix here so the daily
  // sweep can reap it as a backstop.
  'giftk-trial-'
];

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Minimal directory entry shape consumed by the pure planner. */
export interface TmpEntry {
  /** Basename (NOT absolute path). */
  name: string;
  /** Last modification time, ms since epoch. */
  mtimeMs: number;
  /** Whether the entry is a directory. Files are also accepted. */
  isDir: boolean;
}

export interface SweepLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface SweepOptions {
  /** Absolute path to the tmp root (typically `os.tmpdir()`). */
  tmpDir: string;
  /** Entries older than this are eligible. Defaults to 24h. */
  maxAgeMs?: number;
  /** When true, plan only — never call `fs.rmSync`. */
  dryRun?: boolean;
  logger?: SweepLogger;
}

export interface SweepReport {
  /** Total whitelisted entries inspected. */
  scanned: number;
  /** Absolute paths actually (or, for dryRun, planned to be) deleted. */
  deleted: string[];
  /** Absolute paths intentionally left in place (live session, too young, etc). */
  skipped: string[];
  /** `{ path, message }` for any per-entry rmSync failure. */
  errors: { path: string; message: string }[];
}

/**
 * Returns true iff `name` starts with EXACTLY one of `prefixes`.
 * The prefix list is treated as a closed set; partial / case-insensitive
 * matches are intentionally NOT supported because OS tmp dirs are
 * case-sensitive on all our targets except Windows (which uses our
 * literal lowercase prefixes anyway).
 */
function hasAllowedPrefix(name: string, prefixes: readonly string[]): boolean {
  for (const p of prefixes) {
    if (p.length > 0 && name.startsWith(p)) return true;
  }
  return false;
}

/**
 * Pure planner. Given a directory listing snapshot and a threshold,
 * return the absolute paths safe to delete. No IO, no clock reads.
 *
 * Caller MUST supply absolute `tmpDir` so we can build absolute
 * targets; the function does not call `path.resolve` on its own.
 */
export function listStaleEntries(
  items: TmpEntry[],
  now: number,
  prefixes: readonly string[],
  maxAgeMs: number,
  tmpDir?: string
): string[] {
  const cutoff = now - maxAgeMs;
  const out: string[] = [];
  const base = tmpDir ?? '';
  for (const it of items) {
    if (!it || typeof it.name !== 'string') continue;
    if (!hasAllowedPrefix(it.name, prefixes)) continue;
    if (typeof it.mtimeMs !== 'number') continue;
    if (it.mtimeMs >= cutoff) continue;
    out.push(base ? path.join(base, it.name) : it.name);
  }
  return out;
}

/**
 * Hard guard: the resolved `target` MUST live under `tmpDir`. We
 * compute `path.relative(tmpDir, target)` and refuse anything that
 * starts with `..` (escape) or is exactly `..` (parent). The function
 * also rejects an empty relative result because that would mean
 * `target === tmpDir`, i.e. someone asked us to wipe `os.tmpdir()`
 * itself.
 */
function assertUnderTmpDir(tmpDir: string, target: string): void {
  const rel = path.relative(tmpDir, target);
  if (rel === '' || rel === '..' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `tmpCleanup: refused to operate on path outside tmpDir (${target} not under ${tmpDir})`
    );
  }
}

/**
 * Live-session registry. The mhtml importer registers its staged dir
 * before any work and forgets it on success, so a concurrent sweep
 * never reaps an in-flight directory even if (for some reason) its
 * mtime would have suggested it's stale.
 */
const liveSessions = new Set<string>();

// R-87 — All paths in `liveSessions` are stored in their canonical
// (realpath'd) form so set membership lookups against sweep targets
// (which we also canonicalise via fs.realpathSync in sweepTmpDir)
// can never miss due to /var ↔ /private/var symlink drift on macOS.
// Falls back to path.resolve when realpath fails (path may have just
// been deleted or never existed) — at that point set membership is
// moot anyway.
function canonPath(p: string): string {
  if (typeof p !== 'string' || p.length === 0) return p;
  // Try the path itself first.
  try { return fs.realpathSync(p); } catch { /* fall through to parent walk */ }
  // The path doesn't exist (yet) — walk up to the nearest existing
  // ancestor, realpath that, and re-attach the trailing segments.
  // This is what makes the macOS /var → /private/var fix actually
  // hold for paths like `/var/folders/.../does-not-yet-exist`,
  // which would otherwise stay in the non-canonical /var prefix and
  // trip the jail check below against a /private/var sysTmp.
  const resolved = path.resolve(p);
  const parts = resolved.split(path.sep);
  for (let i = parts.length - 1; i > 0; i--) {
    const ancestor = parts.slice(0, i).join(path.sep) || path.sep;
    try {
      const canonAncestor = fs.realpathSync(ancestor);
      return path.join(canonAncestor, ...parts.slice(i));
    } catch { /* keep walking up */ }
  }
  return resolved;
}

export const sessionTmpRegistry = {
  registerSession(p: string): void {
    if (typeof p === 'string' && p.length > 0) {
      liveSessions.add(canonPath(p));
    }
  },
  forgetSession(p: string): void {
    if (typeof p === 'string' && p.length > 0) {
      liveSessions.delete(canonPath(p));
    }
  },
  /**
   * Synchronously remove every still-registered session dir. Intended
   * for graceful shutdown hooks (`app.on('before-quit', …)`). Failures
   * are swallowed because the process is exiting anyway.
   */
  cleanupSessionSync(): void {
    const tmp = canonPath(os.tmpdir());
    for (const p of Array.from(liveSessions)) {
      liveSessions.delete(p);
      try {
        assertUnderTmpDir(tmp, p);
        const base = path.basename(p);
        if (!hasAllowedPrefix(base, ALLOWED_PREFIXES)) continue;
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        // best-effort during shutdown
      }
    }
  },
  /** Test helper. Not exported as part of the public surface. */
  _has(p: string): boolean {
    return liveSessions.has(canonPath(p));
  },
  _size(): number {
    return liveSessions.size;
  },
  _clear(): void {
    liveSessions.clear();
  }
};

/**
 * IO entry point. Scans `tmpDir` for whitelisted entries, plans the
 * stale ones via `listStaleEntries`, and removes each one with
 * `fs.rmSync({ recursive: true, force: true })` unless `dryRun` is
 * set. Live sessions are skipped. Entries that disappear between
 * `readdir` and `rmSync` (ENOENT) are counted as deleted because
 * the desired post-condition holds.
 */
export function sweepTmpDir(opts: SweepOptions): SweepReport {
  // R-87 — jail must compare paths in the same canonical form.
  // On macOS, `os.tmpdir()` returns `/var/folders/...` but the same
  // dir resolves through the symlink to `/private/var/folders/...`.
  // If a caller passes the realpath'd form (or any caller that
  // does `fs.realpathSync(os.tmpdir())`), `path.relative` between
  // the resolved-but-not-realpath'd `sysTmp` and the realpath'd
  // `tmpDir` returns `../../private/var/...`, which then trips the
  // `..` jail check and throws on perfectly legal input.
  //
  // Fix: keep `tmpDir` in the caller's original form so reports +
  // readdir paths surface what they passed in (no surprise path
  // rewriting), but compute jail check + liveSession set lookups
  // against canonicalised forms so the symlink can never bite.
  const tmpDir = path.resolve(opts.tmpDir);
  const tmpDirCanon = canonPath(opts.tmpDir);
  const sysTmpCanon = canonPath(os.tmpdir());
  // Refuse to operate on anything outside the OS tmp root. This is
  // the single most important safety check: it prevents a misuse
  // like `sweepTmpDir({ tmpDir: '/' })` from ever touching real data.
  const rel = path.relative(sysTmpCanon, tmpDirCanon);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`tmpCleanup: tmpDir must be under os.tmpdir() (got ${tmpDir})`);
  }

  const maxAgeMs = typeof opts.maxAgeMs === 'number' ? opts.maxAgeMs : DEFAULT_MAX_AGE_MS;
  const dryRun = opts.dryRun === true;
  const logger = opts.logger;

  const report: SweepReport = {
    scanned: 0,
    deleted: [],
    skipped: [],
    errors: []
  };

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(tmpDir, { withFileTypes: true });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err && err.code === 'ENOENT') {
      logger?.warn?.(`tmpCleanup: tmpDir not found, nothing to do (${tmpDir})`);
      return report;
    }
    throw e;
  }

  const items: TmpEntry[] = [];
  for (const d of dirents) {
    if (!hasAllowedPrefix(d.name, ALLOWED_PREFIXES)) continue;
    const abs = path.join(tmpDir, d.name);
    let mtimeMs = 0;
    let isDir = d.isDirectory();
    try {
      const st = fs.statSync(abs);
      mtimeMs = st.mtimeMs;
      isDir = st.isDirectory();
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err && err.code === 'ENOENT') continue;
      report.errors.push({ path: abs, message: err?.message ?? String(e) });
      continue;
    }
    items.push({ name: d.name, mtimeMs, isDir });
  }

  report.scanned = items.length;
  const stale = listStaleEntries(items, Date.now(), ALLOWED_PREFIXES, maxAgeMs, tmpDir);

  for (const target of stale) {
    try {
      assertUnderTmpDir(tmpDir, target);
    } catch (e) {
      report.errors.push({ path: target, message: (e as Error).message });
      continue;
    }
    if (liveSessions.has(canonPath(target))) {
      report.skipped.push(target);
      logger?.info?.(`tmpCleanup: skip live session ${target}`);
      continue;
    }
    if (dryRun) {
      report.deleted.push(target);
      logger?.info?.(`tmpCleanup [dryRun]: would remove ${target}`);
      continue;
    }
    try {
      fs.rmSync(target, { recursive: true, force: true });
      report.deleted.push(target);
      logger?.info?.(`tmpCleanup: removed ${target}`);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err && err.code === 'ENOENT') {
        // Already gone — desired post-condition holds.
        report.deleted.push(target);
        continue;
      }
      report.errors.push({ path: target, message: err?.message ?? String(e) });
      logger?.error?.(`tmpCleanup: failed to remove ${target}: ${err?.message ?? e}`);
    }
  }

  // Anything we read but didn't classify as stale stays "skipped" so
  // callers (and the CLI) can surface a coherent summary.
  for (const it of items) {
    const abs = path.join(tmpDir, it.name);
    if (report.deleted.includes(abs)) continue;
    if (report.skipped.includes(abs)) continue;
    if (report.errors.some((x) => x.path === abs)) continue;
    report.skipped.push(abs);
  }

  return report;
}
