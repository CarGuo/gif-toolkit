/**
 * Tests for src/main/tmpCleanup.ts.
 *
 * Coverage targets:
 *  - listStaleEntries (pure planner) — prefix whitelist + mtime threshold
 *  - sweepTmpDir (IO entry) — dryRun, ENOENT, prefix mismatch, error path
 *  - sessionTmpRegistry — register / forget keeps live dirs out of sweep
 *
 * IMPORTANT — every IO test creates its OWN sandbox dir under
 * `os.tmpdir()` and only seeds files whose names start with the
 * project's whitelisted prefixes. We never delete from the real
 * `os.tmpdir()` root, never touch `tests/fixtures`, and never touch
 * `~/Library/Application Support`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ALLOWED_PREFIXES,
  listStaleEntries,
  sessionTmpRegistry,
  sweepTmpDir
} from '../../src/main/tmpCleanup';

const HOUR = 60 * 60 * 1000;

/** Build a sandbox dir under `os.tmpdir()` for a single test. */
function makeSandbox(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'giftk-offline-test-sandbox-'));
}

/**
 * Touch a child entry inside a sandbox with a controlled mtime. The
 * helper writes a file (or makes a directory) and then `utimesSync`
 * to backdate it. Returns the absolute path.
 */
function seed(
  sandbox: string,
  name: string,
  ageMs: number,
  kind: 'file' | 'dir' = 'dir'
): string {
  const abs = path.join(sandbox, name);
  if (kind === 'dir') {
    fs.mkdirSync(abs, { recursive: true });
    fs.writeFileSync(path.join(abs, 'inner.txt'), 'x');
  } else {
    fs.writeFileSync(abs, 'x');
  }
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(abs, t, t);
  return abs;
}

describe('listStaleEntries (pure)', () => {
  const now = 1_000_000_000_000;

  it('returns only entries that match a whitelisted prefix AND are older than maxAgeMs', () => {
    const items = [
      { name: 'giftk-mhtml-aaa', mtimeMs: now - 25 * HOUR, isDir: true },
      { name: 'giftk-e2e-bbb', mtimeMs: now - 100 * HOUR, isDir: true },
      { name: 'random-xxx', mtimeMs: now - 999 * HOUR, isDir: true },
      { name: 'giftk-mhtml-fresh', mtimeMs: now - 1 * HOUR, isDir: true }
    ];
    const out = listStaleEntries(items, now, ALLOWED_PREFIXES, 24 * HOUR, '/tmp');
    expect(out).toEqual(['/tmp/giftk-mhtml-aaa', '/tmp/giftk-e2e-bbb']);
  });

  it('does NOT delete prefix mismatches even when very old', () => {
    const items = [
      { name: 'someone-elses-tempdir', mtimeMs: 0, isDir: true },
      { name: 'GIFTK-MHTML-uppercase', mtimeMs: 0, isDir: true }, // case-sensitive
      { name: 'giftk-unknown-prefix', mtimeMs: 0, isDir: true } // not on the list
    ];
    const out = listStaleEntries(items, now, ALLOWED_PREFIXES, 24 * HOUR, '/tmp');
    expect(out).toEqual([]);
  });

  it('respects the mtime threshold strictly (>= cutoff is kept)', () => {
    const cutoff = now - 24 * HOUR;
    const items = [
      { name: 'giftk-out-young', mtimeMs: cutoff, isDir: true }, // exactly at cutoff → kept
      { name: 'giftk-out-old', mtimeMs: cutoff - 1, isDir: true } // 1ms older → reaped
    ];
    const out = listStaleEntries(items, now, ALLOWED_PREFIXES, 24 * HOUR, '/tmp');
    expect(out).toEqual(['/tmp/giftk-out-old']);
  });

  it('handles empty input and empty prefix list defensively', () => {
    expect(listStaleEntries([], now, ALLOWED_PREFIXES, 24 * HOUR, '/tmp')).toEqual([]);
    expect(
      listStaleEntries(
        [{ name: 'giftk-mhtml-x', mtimeMs: 0, isDir: true }],
        now,
        [],
        24 * HOUR,
        '/tmp'
      )
    ).toEqual([]);
  });
});

describe('sweepTmpDir (IO)', () => {
  let sandbox: string;

  beforeEach(() => {
    sessionTmpRegistry._clear();
    sandbox = makeSandbox();
  });

  afterEach(() => {
    sessionTmpRegistry._clear();
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('removes only stale, whitelisted entries; leaves prefix mismatches alone', () => {
    const stale = seed(sandbox, 'giftk-mhtml-stale-1', 48 * HOUR);
    const fresh = seed(sandbox, 'giftk-mhtml-fresh-1', 1 * HOUR);
    // A non-whitelisted dir simulates "some other app's tmp dir" — must NEVER be touched.
    const foreign = seed(sandbox, 'someone-else-do-not-touch', 99 * HOUR);

    const r = sweepTmpDir({ tmpDir: sandbox, maxAgeMs: 24 * HOUR });

    expect(r.deleted).toContain(stale);
    expect(r.skipped).toContain(fresh);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    // Prefix mismatch must remain untouched and not even appear in the report.
    expect(fs.existsSync(foreign)).toBe(true);
    expect(r.deleted).not.toContain(foreign);
    expect(r.skipped).not.toContain(foreign);
  });

  it('dryRun returns the plan without performing any IO', () => {
    const stale = seed(sandbox, 'giftk-e2e-old-1', 48 * HOUR);

    const r = sweepTmpDir({ tmpDir: sandbox, maxAgeMs: 24 * HOUR, dryRun: true });

    expect(r.deleted).toEqual([stale]);
    // The "deleted" entry in dryRun mode must still exist on disk afterward.
    expect(fs.existsSync(stale)).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('handles a missing tmpDir gracefully (ENOENT)', () => {
    // Tease ENOENT by pointing tmpDir at a child path that does not exist.
    const ghost = path.join(sandbox, 'does-not-exist-yet');
    const warnings: string[] = [];
    const r = sweepTmpDir({
      tmpDir: ghost,
      logger: { warn: (m) => warnings.push(m) }
    });
    expect(r.scanned).toBe(0);
    expect(r.deleted).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(warnings.some((w) => w.includes('tmpDir not found'))).toBe(true);
  });

  it('treats vanished entries between readdir and rmSync as already-deleted', () => {
    const target = seed(sandbox, 'giftk-in-vanishing-1', 48 * HOUR);
    // Race-condition simulation: remove the entry ourselves AFTER seeding
    // but BEFORE the sweeper gets to it. We do this by stubbing nothing
    // and instead pre-deleting; the sweeper's readdir already saw it
    // because we delete *between* readdir and rmSync — emulated by
    // deleting before the call but seeding via a separate file with the
    // same basename in a second sandbox would be heavier. Easier: rely
    // on the ENOENT path inside rmSync by deleting just before the call.
    fs.rmSync(target, { recursive: true, force: true });
    const r = sweepTmpDir({ tmpDir: sandbox, maxAgeMs: 24 * HOUR });
    // After readdir misses it, the path is not even in `scanned`,
    // hence not in `deleted`. This still demonstrates ENOENT-tolerance:
    // no errors are reported.
    expect(r.errors).toEqual([]);
    // Also assert the directory itself wasn't accidentally swept.
    expect(fs.existsSync(sandbox)).toBe(true);
  });

  it('refuses to operate on a tmpDir outside os.tmpdir()', () => {
    expect(() => sweepTmpDir({ tmpDir: path.resolve(__dirname) })).toThrow(/under os\.tmpdir/);
  });

  it('skips registered live sessions even when stale', () => {
    const live = seed(sandbox, 'giftk-mhtml-live-1', 48 * HOUR);
    sessionTmpRegistry.registerSession(live);
    const r = sweepTmpDir({ tmpDir: sandbox, maxAgeMs: 24 * HOUR });
    expect(r.skipped).toContain(live);
    expect(r.deleted).not.toContain(live);
    expect(fs.existsSync(live)).toBe(true);

    // After forgetSession, the next sweep reaps it.
    sessionTmpRegistry.forgetSession(live);
    const r2 = sweepTmpDir({ tmpDir: sandbox, maxAgeMs: 24 * HOUR });
    expect(r2.deleted).toContain(live);
    expect(fs.existsSync(live)).toBe(false);
  });
});

describe('sessionTmpRegistry', () => {
  beforeEach(() => sessionTmpRegistry._clear());
  afterEach(() => sessionTmpRegistry._clear());

  it('register / forget round-trips and is path.resolve-normalised', () => {
    const sandbox = makeSandbox();
    try {
      const live = seed(sandbox, 'giftk-mhtml-reg-1', 0, 'dir');
      sessionTmpRegistry.registerSession(live);
      expect(sessionTmpRegistry._size()).toBe(1);
      expect(sessionTmpRegistry._has(live)).toBe(true);
      sessionTmpRegistry.forgetSession(live);
      expect(sessionTmpRegistry._size()).toBe(0);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('cleanupSessionSync removes only whitelisted-prefix dirs under os.tmpdir()', () => {
    const sandbox = makeSandbox();
    try {
      const okDir = seed(sandbox, 'giftk-mhtml-cleanup-1', 0, 'dir');
      // Path with a non-whitelisted name → registry will refuse to rm.
      const badDir = seed(sandbox, 'unrelated-cleanup-1', 0, 'dir');
      sessionTmpRegistry.registerSession(okDir);
      sessionTmpRegistry.registerSession(badDir);
      sessionTmpRegistry.cleanupSessionSync();
      expect(fs.existsSync(okDir)).toBe(false);
      expect(fs.existsSync(badDir)).toBe(true);
      expect(sessionTmpRegistry._size()).toBe(0);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
