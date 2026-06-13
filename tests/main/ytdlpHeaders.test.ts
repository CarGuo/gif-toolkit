/**
 * R-84 regression — guarantee yt-dlp is always spawned with our
 * evergreen Chrome `--user-agent`, and that bilibili.com / b23.tv page
 * URLs additionally inject `--referer https://www.bilibili.com`.
 *
 * Why this test exists: the original 412 bug for Bilibili came back the
 * moment somebody refactored `resolveDirectUrl` and let one branch fall
 * through to `ytdlp-nodejs.getInfoAsync()` (which has no headers). The
 * `harness/rules/R-84-ytdlp-default-headers.md` rule mandates that the
 * UA + Referer wiring lives on the actual `spawn(yt-dlp, …)` argv. This
 * test locks that contract.
 *
 * Coverage matrix:
 *   - bilibiliReferer pure-fn: bilibili.com / *.bilibili.com / b23.tv
 *     → 'https://www.bilibili.com';  YouTube / arbitrary host → null.
 *   - getInfoSpawn: every code path appends `--user-agent <DEFAULT_UA>`
 *     before the positional URL; bilibili URL additionally appends
 *     `--referer https://www.bilibili.com`; non-bilibili URL must NOT
 *     have any `--referer` arg.
 *   - downloadYtdlpSections: mirrors the same UA + Referer contract for
 *     the section-download path (the other R-84 entry point).
 */
import { EventEmitter } from 'events';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Stub electron's `app` so module load doesn't blow up; the helpers we
// touch never call `app.getPath()`.
vi.mock('electron', () => ({ app: { getPath: (_: string) => '/tmp/test-userdata' } }));

// Stub `../logger` so it doesn't try to register IPC handlers in node-only
// mode (M-2 isn't fully landed when this test was written; defensive).
vi.mock('../../src/main/logger', () => ({ log: (..._args: unknown[]) => undefined }));

// Capture every spawn invocation so individual tests can inspect args.
const spawnCalls: Array<{ cmd: string; args: string[] }> = [];

function makeFakeChild(opts: { exit?: number; stdout?: string; stderr?: string } = {}): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: () => void;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => undefined;
  setImmediate(() => {
    if (opts.stdout) child.stdout.emit('data', Buffer.from(opts.stdout));
    if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
    child.emit('close', opts.exit ?? 0, null);
  });
  return child;
}

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn((cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args: args.slice() });
      // Default fake: emit a minimal yt-dlp JSON payload + exit 0.
      const fakeJson = JSON.stringify({ formats: [{ url: 'https://cdn.example/v.mp4', ext: 'mp4' }], extractor: 'fake' });
      return makeFakeChild({ stdout: fakeJson }) as unknown as ReturnType<typeof actual.spawn>;
    })
  };
});

import { bilibiliReferer, DEFAULT_UA, getInfoSpawn, downloadYtdlpSections } from '../../src/main/resolver/ytdlp';
import * as ytdlpModule from '../../src/main/resolver/ytdlp';

beforeEach(() => {
  spawnCalls.length = 0;
  // R-84 test: downloadYtdlpSections internally calls ensureYtdlp() which
  // network-downloads the real binary on first run. Stub it to a fake path
  // so the test only exercises argv construction.
  vi.spyOn(ytdlpModule, 'ensureYtdlp').mockResolvedValue('/fake/yt-dlp');
});

describe('bilibiliReferer', () => {
  it('returns the bilibili origin for bare bilibili.com', () => {
    expect(bilibiliReferer('https://bilibili.com/video/BV1abc')).toBe('https://www.bilibili.com');
  });
  it('returns the bilibili origin for www.bilibili.com / m.bilibili.com', () => {
    expect(bilibiliReferer('https://www.bilibili.com/video/BV1abc')).toBe('https://www.bilibili.com');
    expect(bilibiliReferer('https://m.bilibili.com/video/BV1abc')).toBe('https://www.bilibili.com');
  });
  it('returns the bilibili origin for b23.tv shortlinks', () => {
    expect(bilibiliReferer('https://b23.tv/abcd')).toBe('https://www.bilibili.com');
  });
  it('returns null for unrelated hosts', () => {
    expect(bilibiliReferer('https://www.youtube.com/watch?v=xyz')).toBeNull();
    expect(bilibiliReferer('https://twitter.com/i/status/123')).toBeNull();
  });
  it('returns null on malformed URLs without throwing', () => {
    expect(bilibiliReferer('not a url')).toBeNull();
  });
  it('does NOT match lookalike hosts (suffix-only check is anchored)', () => {
    // "evilbilibili.com" shouldn't match — endsWith('.bilibili.com') is
    // anchored by the leading dot so attacker-controlled subdomains of
    // a different second-level domain can't steal the Referer.
    expect(bilibiliReferer('https://evilbilibili.com/x')).toBeNull();
  });
});

describe('DEFAULT_UA', () => {
  it('looks like an evergreen Chrome desktop UA (R-84)', () => {
    expect(DEFAULT_UA).toMatch(/Mozilla\/5\.0/);
    expect(DEFAULT_UA).toMatch(/Chrome\/\d+/);
    expect(DEFAULT_UA).toMatch(/Safari\/537\.36/);
  });
});

describe('getInfoSpawn argv contract (R-84)', () => {
  it('always injects --user-agent <DEFAULT_UA> before the positional URL', async () => {
    await getInfoSpawn('/fake/yt-dlp', 'https://www.youtube.com/watch?v=xyz');
    expect(spawnCalls).toHaveLength(1);
    const { args } = spawnCalls[0];
    const uaIdx = args.indexOf('--user-agent');
    expect(uaIdx).toBeGreaterThanOrEqual(0);
    expect(args[uaIdx + 1]).toBe(DEFAULT_UA);
    const urlIdx = args.indexOf('https://www.youtube.com/watch?v=xyz');
    expect(urlIdx).toBeGreaterThan(uaIdx + 1);
  });

  it('injects --referer https://www.bilibili.com for bilibili page URLs', async () => {
    await getInfoSpawn('/fake/yt-dlp', 'https://www.bilibili.com/video/BV153EC68EES');
    const { args } = spawnCalls[0];
    const refIdx = args.indexOf('--referer');
    expect(refIdx).toBeGreaterThanOrEqual(0);
    expect(args[refIdx + 1]).toBe('https://www.bilibili.com');
  });

  it('does NOT add --referer for non-bilibili URLs', async () => {
    await getInfoSpawn('/fake/yt-dlp', 'https://www.youtube.com/watch?v=xyz');
    const { args } = spawnCalls[0];
    expect(args.indexOf('--referer')).toBe(-1);
  });

  it('works without a signal (R-84 main flow — embed resolve has no abort)', async () => {
    // The original H-2 bug was: `if (signal) spawn-path else nodejs-wrapper`.
    // After the fix, the no-signal call must STILL spawn yt-dlp with the
    // R-84 headers. Asserting that getInfoSpawn returns a real argv-bearing
    // spawn here is a proxy for "resolveDirectUrl() also goes through
    // getInfoSpawn even without a signal."
    await getInfoSpawn('/fake/yt-dlp', 'https://www.bilibili.com/video/BV1');
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args).toContain('--user-agent');
    expect(spawnCalls[0].args).toContain('--referer');
  });
});

describe('downloadYtdlpSections argv contract (R-84)', () => {
  it('injects --user-agent + bilibili --referer for bilibili source pages', async () => {
    await downloadYtdlpSections(
      'https://www.bilibili.com/video/BV153EC68EES',
      '/tmp/out.mp4',
      [{ startSec: 0, endSec: 5 }]
    );
    expect(spawnCalls).toHaveLength(1);
    const { args } = spawnCalls[0];
    const uaIdx = args.indexOf('--user-agent');
    expect(uaIdx).toBeGreaterThanOrEqual(0);
    expect(args[uaIdx + 1]).toBe(DEFAULT_UA);
    const refIdx = args.indexOf('--referer');
    expect(refIdx).toBeGreaterThanOrEqual(0);
    expect(args[refIdx + 1]).toBe('https://www.bilibili.com');
    expect(args.indexOf('--download-sections')).toBeGreaterThanOrEqual(0);
  });

  it('injects --user-agent but NO --referer for non-bilibili page URLs', async () => {
    await downloadYtdlpSections(
      'https://www.youtube.com/watch?v=xyz',
      '/tmp/out.mp4',
      [{ startSec: 1, endSec: 3 }]
    );
    const { args } = spawnCalls[0];
    expect(args).toContain('--user-agent');
    expect(args.indexOf('--referer')).toBe(-1);
  });
});
