/**
 * R-UPDATE — Pure / DI tests for [src/main/updater.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/updater.ts).
 *
 * The module is built so unit tests don't have to invoke electron's
 * main-process `net` module: every IO entry takes an injectable
 * `fetcher` (and clock + currentVersion overrides), and the cache is
 * resettable via `_resetUpdaterCache`. So we mock `electron` only
 * enough that `import { app, net } from 'electron'` resolves at module
 * load time — the actual `net.request` path is never exercised here.
 *
 * Coverage:
 *   - parseSemver: stable / prerelease / leading "v" / garbage
 *   - compareSemver: major/minor/patch ordering, prerelease < stable
 *   - pickRelease: happy path / draft / prerelease / null release
 *   - checkLatestRelease: success → hasUpdate=true,
 *     same version → hasUpdate=false, 404 → error,
 *     timeout (fetcher rejects) → error, JSON parse fail → error,
 *     cache hit returns cached=true on second call without re-fetching.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.1.1',
  },
  net: {
    request: () => {
      throw new Error('net.request should never be called in unit tests');
    },
  },
}));

import {
  parseSemver,
  compareSemver,
  pickRelease,
  checkLatestRelease,
  _resetUpdaterCache,
  type GithubReleasePayload,
} from '../../src/main/updater';

beforeEach(() => {
  _resetUpdaterCache();
});

describe('parseSemver', () => {
  it.each([
    ['1.2.3', { major: 1, minor: 2, patch: 3, prerelease: null }],
    ['v1.2.3', { major: 1, minor: 2, patch: 3, prerelease: null }],
    ['10.20.30', { major: 10, minor: 20, patch: 30, prerelease: null }],
    ['1.2.3-beta.1', { major: 1, minor: 2, patch: 3, prerelease: 'beta.1' }],
    ['v0.1.1', { major: 0, minor: 1, patch: 1, prerelease: null }],
  ])('parses %s', (input, expected) => {
    expect(parseSemver(input)).toEqual(expected);
  });

  it.each(['', 'abc', '1.2', '1.2.3.4', null, undefined])(
    'returns null for invalid input %s',
    (input) => {
      expect(parseSemver(input as string)).toBeNull();
    }
  );
});

describe('compareSemver', () => {
  it('orders major/minor/patch correctly', () => {
    expect(compareSemver('1.0.0', '2.0.0')).toBeLessThan(0);
    expect(compareSemver('1.2.0', '1.3.0')).toBeLessThan(0);
    expect(compareSemver('1.2.3', '1.2.4')).toBeLessThan(0);
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });

  it('treats prerelease as older than the same stable', () => {
    expect(compareSemver('1.2.3-beta.1', '1.2.3')).toBeLessThan(0);
    expect(compareSemver('1.2.3', '1.2.3-rc.1')).toBeGreaterThan(0);
  });

  it('tolerates leading v', () => {
    expect(compareSemver('v1.2.3', '1.2.4')).toBeLessThan(0);
    expect(compareSemver('1.2.4', 'v1.2.3')).toBeGreaterThan(0);
  });
});

describe('pickRelease', () => {
  const sampleRelease: GithubReleasePayload = {
    tag_name: 'v0.1.2',
    name: 'v0.1.2 - May 2026',
    html_url: 'https://github.com/CarGuo/gif-toolkit/releases/tag/v0.1.2',
    published_at: '2026-05-22T10:00:00Z',
    body: '* Add update checker',
  };

  it('detects an available update (current 0.1.1 → latest 0.1.2)', () => {
    const r = pickRelease(sampleRelease, '0.1.1', 1_000);
    expect(r.current).toBe('0.1.1');
    expect(r.latest).toBe('0.1.2');
    expect(r.hasUpdate).toBe(true);
    expect(r.htmlUrl).toBe(sampleRelease.html_url);
    expect(r.publishedAt).toBe(sampleRelease.published_at);
    expect(r.body).toBe(sampleRelease.body);
    expect(r.error).toBeNull();
    expect(r.cached).toBe(false);
    expect(r.fetchedAt).toBe(1_000);
  });

  it('reports already-on-latest when versions match', () => {
    const r = pickRelease(sampleRelease, '0.1.2', 2_000);
    expect(r.hasUpdate).toBe(false);
    expect(r.latest).toBe('0.1.2');
    expect(r.error).toBeNull();
  });

  it('skips drafts (no update offered even if newer tag)', () => {
    const r = pickRelease({ ...sampleRelease, draft: true }, '0.1.1', 3_000);
    expect(r.hasUpdate).toBe(false);
  });

  it('skips prereleases (no update offered even if newer tag)', () => {
    const r = pickRelease({ ...sampleRelease, prerelease: true }, '0.1.1', 4_000);
    expect(r.hasUpdate).toBe(false);
  });

  it('returns error on null release', () => {
    const r = pickRelease(null, '0.1.1', 5_000);
    expect(r.hasUpdate).toBe(false);
    expect(r.latest).toBeNull();
    expect(r.error).not.toBeNull();
  });
});

describe('checkLatestRelease', () => {
  const ok: GithubReleasePayload = {
    tag_name: 'v0.2.0',
    name: 'v0.2.0',
    html_url: 'https://github.com/CarGuo/gif-toolkit/releases/tag/v0.2.0',
    published_at: '2026-05-22T10:00:00Z',
    body: 'changelog',
  };

  it('happy path: fetcher returns 200 + valid JSON → hasUpdate=true', async () => {
    const r = await checkLatestRelease({
      currentVersion: '0.1.1',
      now: () => 100,
      fetcher: async () => ({ status: 200, body: JSON.stringify(ok) }),
    });
    expect(r.error).toBeNull();
    expect(r.hasUpdate).toBe(true);
    expect(r.latest).toBe('0.2.0');
    expect(r.cached).toBe(false);
  });

  it('404 → error set, never throws', async () => {
    const r = await checkLatestRelease({
      currentVersion: '0.1.1',
      now: () => 100,
      fetcher: async () => ({ status: 404, body: 'Not Found' }),
    });
    expect(r.hasUpdate).toBe(false);
    expect(r.latest).toBeNull();
    expect(r.error).toBe('no-release');
  });

  it('non-2xx (e.g. 500) → error reflects status code', async () => {
    const r = await checkLatestRelease({
      currentVersion: '0.1.1',
      now: () => 100,
      fetcher: async () => ({ status: 500, body: 'Server Error' }),
    });
    expect(r.hasUpdate).toBe(false);
    expect(r.error).toMatch(/500/);
  });

  it('fetcher rejects (timeout/network) → error, never throws', async () => {
    const r = await checkLatestRelease({
      currentVersion: '0.1.1',
      now: () => 100,
      fetcher: async () => { throw new Error('timeout after 8000ms'); },
    });
    expect(r.hasUpdate).toBe(false);
    expect(r.error).toMatch(/timeout/);
  });

  it('malformed JSON body → error, never throws', async () => {
    const r = await checkLatestRelease({
      currentVersion: '0.1.1',
      now: () => 100,
      fetcher: async () => ({ status: 200, body: 'not-json' }),
    });
    expect(r.hasUpdate).toBe(false);
    expect(r.error).toBe('invalid-json');
  });

  it('cache hit on second call without force', async () => {
    let calls = 0;
    const fetcher = async (): Promise<{ status: number; body: string }> => {
      calls += 1;
      return { status: 200, body: JSON.stringify(ok) };
    };
    const first = await checkLatestRelease({
      currentVersion: '0.1.1',
      now: () => 100,
      fetcher,
    });
    expect(first.cached).toBe(false);
    expect(calls).toBe(1);

    const second = await checkLatestRelease({
      currentVersion: '0.1.1',
      now: () => 200,
      fetcher,
    });
    expect(second.cached).toBe(true);
    expect(calls).toBe(1);
  });

  it('force=true bypasses the cache', async () => {
    let calls = 0;
    const fetcher = async (): Promise<{ status: number; body: string }> => {
      calls += 1;
      return { status: 200, body: JSON.stringify(ok) };
    };
    await checkLatestRelease({ currentVersion: '0.1.1', now: () => 100, fetcher });
    expect(calls).toBe(1);

    const refreshed = await checkLatestRelease({
      currentVersion: '0.1.1',
      now: () => 200,
      fetcher,
      force: true,
    });
    expect(refreshed.cached).toBe(false);
    expect(calls).toBe(2);
  });
});
