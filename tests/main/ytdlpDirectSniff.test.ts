/**
 * R-52 — Tests for the yt-dlp direct sniff entry.
 * R-53 — Updated to reflect:
 *  - id derived from pageUrl (so retries against the same page dedup
 *    correctly even when the underlying CDN URL rotates a signed token);
 *  - resolveDirectUrl now accepts an AbortSignal and is the only thing
 *    the wrapper races against (no Promise.race fake-cancel anymore);
 *  - ensurePublicHttp guards the entry against SSRF / private hosts.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false },
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}));

const resolveDirectUrlMock = vi.fn();
const ensurePublicHttpMock = vi.fn((u: string) => u);
class FakeYtDlpNotInstalledError extends Error {
  binaryPath: string;
  constructor(binaryPath: string, reason?: string) {
    super(reason ? `yt-dlp not available: ${reason}` : 'yt-dlp not available');
    this.name = 'YtDlpNotInstalledError';
    this.binaryPath = binaryPath;
  }
}
vi.mock('../../src/main/resolver/ytdlp', () => ({
  resolveDirectUrl: (...args: unknown[]) => resolveDirectUrlMock(...args),
  YtDlpNotInstalledError: FakeYtDlpNotInstalledError,
  ensurePublicHttp: (u: string) => ensurePublicHttpMock(u)
}));

const { buildSniffedMediaFromResolved, sniffViaYtdlp } = await import('../../src/main/ytdlpDirectSniff');
import type { ResolvedMedia, SniffProgress } from '../../src/shared/types';

const baseResolved: ResolvedMedia = {
  url: 'https://cdn.example.com/v/abc.mp4',
  mime: 'video/mp4',
  qualityLabel: '720p',
  width: 1280,
  height: 720,
  durationSec: 42,
  sizeBytes: 1234567,
  source: 'ytdlp',
  extractor: 'youtube',
  title: 'Sample Video',
  headers: { Referer: 'https://www.youtube.com/' }
};

describe('buildSniffedMediaFromResolved', () => {
  it('produces a video SniffedMedia with source=ytdlp-direct and requiresExternalDownload=false', () => {
    const out = buildSniffedMediaFromResolved('https://www.youtube.com/watch?v=abc', baseResolved);
    expect(out.source).toBe('ytdlp-direct');
    expect(out.kind).toBe('video');
    expect(out.requiresExternalDownload).toBe(false);
    expect(out.url).toBe(baseResolved.url);
    expect(out.pageUrl).toBe('https://www.youtube.com/watch?v=abc');
    expect(out.width).toBe(1280);
    expect(out.height).toBe(720);
    expect(out.durationSec).toBe(42);
    expect(out.sizeBytes).toBe(1234567);
    expect(out.resolved).toEqual(baseResolved);
    expect(out.id.startsWith('ytdlp-direct-')).toBe(true);
  });

  it('classifies image/gif mime as gif kind', () => {
    const out = buildSniffedMediaFromResolved('https://e.com/p', { ...baseResolved, mime: 'image/gif' });
    expect(out.kind).toBe('gif');
  });

  it('classifies non-gif image mime as image kind', () => {
    const out = buildSniffedMediaFromResolved('https://e.com/p', { ...baseResolved, mime: 'image/webp' });
    expect(out.kind).toBe('image');
  });

  it('falls back to video kind when mime is missing', () => {
    const noMime = { ...baseResolved };
    delete (noMime as { mime?: string }).mime;
    const out = buildSniffedMediaFromResolved('https://e.com/p', noMime);
    expect(out.kind).toBe('video');
  });

  it('produces stable ids derived from the page URL (R-53 dedup invariance under signed-URL rotation)', () => {
    // Same page URL → same ID, even when the resolved direct URL changes.
    const pageA = 'https://www.youtube.com/watch?v=abc';
    const r1 = { ...baseResolved, url: 'https://cdn.example.com/sig=AAA/v.mp4' };
    const r2 = { ...baseResolved, url: 'https://cdn.example.com/sig=BBB/v.mp4' };
    const a = buildSniffedMediaFromResolved(pageA, r1);
    const b = buildSniffedMediaFromResolved(pageA, r2);
    expect(a.id).toBe(b.id);
    // Different page URLs → different IDs.
    const c = buildSniffedMediaFromResolved('https://www.youtube.com/watch?v=zzz', r1);
    expect(a.id).not.toBe(c.id);
  });
});

describe('sniffViaYtdlp', () => {
  beforeEach(() => {
    resolveDirectUrlMock.mockReset();
    ensurePublicHttpMock.mockReset();
    ensurePublicHttpMock.mockImplementation((u: string) => u);
  });

  it('returns a single-item SniffResult on the happy path with title carried through', async () => {
    resolveDirectUrlMock.mockResolvedValueOnce(baseResolved);
    const r = await sniffViaYtdlp('https://www.youtube.com/watch?v=abc');
    expect(r.pageUrl).toBe('https://www.youtube.com/watch?v=abc');
    expect(r.title).toBe('Sample Video');
    expect(r.items).toHaveLength(1);
    expect(r.items[0].source).toBe('ytdlp-direct');
    expect(r.warnings).toEqual([]);
    expect(resolveDirectUrlMock).toHaveBeenCalledTimes(1);
  });

  it('passes the abort signal through to resolveDirectUrl (R-53 real abort)', async () => {
    resolveDirectUrlMock.mockResolvedValueOnce(baseResolved);
    const ctrl = new AbortController();
    await sniffViaYtdlp('https://www.youtube.com/watch?v=abc', { signal: ctrl.signal });
    expect(resolveDirectUrlMock).toHaveBeenCalledWith('https://www.youtube.com/watch?v=abc', ctrl.signal);
  });

  it('rejects payloads that fail the SSRF gate (ensurePublicHttp throws)', async () => {
    ensurePublicHttpMock.mockImplementationOnce(() => {
      throw new Error('resolved URL points at a private host (refused)');
    });
    await expect(sniffViaYtdlp('http://127.0.0.1/')).rejects.toThrow(/URL 不可用/);
    expect(resolveDirectUrlMock).not.toHaveBeenCalled();
  });

  it('fires onProgress in fetching → parsing → parsing → done order', async () => {
    resolveDirectUrlMock.mockResolvedValueOnce(baseResolved);
    const events: SniffProgress[] = [];
    await sniffViaYtdlp('https://www.youtube.com/watch?v=abc', {
      onProgress: (p) => events.push(p)
    });
    const stages = events.map((e) => e.stage);
    expect(stages).toEqual(['fetching', 'parsing', 'parsing', 'done']);
    const last = events[events.length - 1];
    expect(last.percent).toBe(100);
    expect(last.found).toBe(1);
  });

  it('translates YtDlpNotInstalledError into a friendly Chinese hint', async () => {
    resolveDirectUrlMock.mockRejectedValueOnce(new FakeYtDlpNotInstalledError('/x/yt-dlp', 'enotfound'));
    await expect(sniffViaYtdlp('https://www.youtube.com/watch?v=abc')).rejects.toThrow(/yt-dlp 不可用/);
  });

  it('translates "Unsupported URL" into a friendly fallback hint', async () => {
    resolveDirectUrlMock.mockRejectedValueOnce(new Error('Unsupported URL: https://random.example.com/'));
    await expect(sniffViaYtdlp('https://random.example.com/')).rejects.toThrow(/yt-dlp 不支持该站点/);
  });

  it('translates "no playable format" into the same fallback hint', async () => {
    resolveDirectUrlMock.mockRejectedValueOnce(new Error('no playable format found'));
    await expect(sniffViaYtdlp('https://www.youtube.com/watch?v=zzz')).rejects.toThrow(/yt-dlp 不支持该站点/);
  });

  it('classifies "Sign in to confirm you\'re not a bot" as login-wall', async () => {
    resolveDirectUrlMock.mockRejectedValueOnce(new Error("Sign in to confirm you're not a bot"));
    await expect(sniffViaYtdlp('https://www.youtube.com/watch?v=abc')).rejects.toThrow(/需要登录|私密|地区限制/);
  });

  it('classifies HTTP 429 as rate-limit', async () => {
    resolveDirectUrlMock.mockRejectedValueOnce(new Error('HTTP Error 429: Too Many Requests'));
    await expect(sniffViaYtdlp('https://www.youtube.com/watch?v=abc')).rejects.toThrow(/限流|拒绝/);
  });

  it('classifies network failures with a "网络错误" prefix', async () => {
    resolveDirectUrlMock.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND something'));
    await expect(sniffViaYtdlp('https://www.youtube.com/watch?v=abc')).rejects.toThrow(/网络错误/);
  });

  it('wraps unrelated runtime errors with "yt-dlp 解析失败" prefix', async () => {
    resolveDirectUrlMock.mockRejectedValueOnce(new Error('something weird'));
    await expect(sniffViaYtdlp('https://www.youtube.com/watch?v=abc')).rejects.toThrow(/yt-dlp 解析失败: something weird/);
  });

  it('rejects immediately with 用户取消 when the signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      sniffViaYtdlp('https://www.youtube.com/watch?v=abc', { signal: ctrl.signal })
    ).rejects.toThrow('用户取消');
    expect(resolveDirectUrlMock).not.toHaveBeenCalled();
  });

  it('translates an "aborted" rejection from resolveDirectUrl into 用户取消', async () => {
    resolveDirectUrlMock.mockRejectedValueOnce(new Error('aborted'));
    await expect(
      sniffViaYtdlp('https://www.youtube.com/watch?v=abc', { signal: new AbortController().signal })
    ).rejects.toThrow('用户取消');
  });
});
