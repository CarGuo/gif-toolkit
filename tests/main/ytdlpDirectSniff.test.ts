/**
 * R-52 — Tests for the yt-dlp direct sniff entry.
 *
 * Two surfaces are covered:
 *  1. `buildSniffedMediaFromResolved`: the pure ResolvedMedia → SniffedMedia
 *     adapter. We assert the SniffedMedia carries source='ytdlp-direct',
 *     `requiresExternalDownload=false`, and the original `resolved` payload
 *     so the renderer can dispatch into the processor without an extra
 *     resolve roundtrip.
 *  2. `sniffViaYtdlp`: the high-level wrapper. We mock `resolveDirectUrl`
 *     out of the `./resolver/ytdlp` module so the test never spawns a real
 *     yt-dlp binary, and assert:
 *      - happy path → SniffResult with 1 item + correct title
 *      - YtDlpNotInstalledError → friendly Chinese hint mentioning offline
 *      - "Unsupported URL" → friendly Chinese hint suggesting fallback
 *      - aborted signal → 用户取消
 *      - onProgress callbacks fire in order: fetching → parsing → done
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false },
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}));

const resolveDirectUrlMock = vi.fn();
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
  YtDlpNotInstalledError: FakeYtDlpNotInstalledError
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

  it('produces stable ids for the same resolved url', () => {
    const a = buildSniffedMediaFromResolved('https://e.com/p1', baseResolved);
    const b = buildSniffedMediaFromResolved('https://e.com/p2', baseResolved);
    expect(a.id).toBe(b.id);
  });
});

describe('sniffViaYtdlp', () => {
  beforeEach(() => {
    resolveDirectUrlMock.mockReset();
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

  it('fires onProgress in fetching → parsing → probing → done order', async () => {
    resolveDirectUrlMock.mockResolvedValueOnce(baseResolved);
    const events: SniffProgress[] = [];
    await sniffViaYtdlp('https://www.youtube.com/watch?v=abc', {
      onProgress: (p) => events.push(p)
    });
    const stages = events.map((e) => e.stage);
    expect(stages).toEqual(['fetching', 'parsing', 'probing', 'done']);
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

  it('wraps unrelated runtime errors with "yt-dlp 解析失败" prefix', async () => {
    resolveDirectUrlMock.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(sniffViaYtdlp('https://www.youtube.com/watch?v=abc')).rejects.toThrow(/yt-dlp 解析失败: socket hang up/);
  });

  it('rejects immediately with 用户取消 when the signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      sniffViaYtdlp('https://www.youtube.com/watch?v=abc', { signal: ctrl.signal })
    ).rejects.toThrow('用户取消');
    expect(resolveDirectUrlMock).not.toHaveBeenCalled();
  });

  it('aborts in-flight resolution when signal fires mid-flight', async () => {
    // resolveDirectUrl never resolves so we can race the abort.
    resolveDirectUrlMock.mockImplementationOnce(() => new Promise(() => { /* never */ }));
    const ctrl = new AbortController();
    const p = sniffViaYtdlp('https://www.youtube.com/watch?v=abc', { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 10);
    await expect(p).rejects.toThrow('用户取消');
  });
});
