/**
 * SUITE MEDIA-IO — `media:preview` / `media:thumbnail` IPC schema +
 * graceful-degradation contract (R-MEDIA-IO-V1).
 *
 * Why this SUITE exists
 * ---------------------
 * The two media handlers in [src/main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L1199-L1212)
 * are hit by the renderer on every sniff result card (thumbnail
 * preload) and every "试跑" / hover-preview tap. They sit on top of
 * `previewMedia` / `prefetchThumbnail` in [src/main/processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts#L774-L853),
 * which mix download + ffprobe + ffmpeg / image decode. Existing unit
 * tests cover individual primitives (downloader retry, thumb cache TTL,
 * preview frame extraction) but no e2e drives the actual IPC surface
 * with a SniffedMedia payload, asserts the wire shape, and verifies
 * the negative-cache fallback for unreachable URLs.
 *
 * Strategy
 * --------
 * Two happy-path cases use the on-disk video / gif fixtures via a
 * `giftk-local://` URL — `sanitizeMedia` accepts the scheme since R-56
 * specifically so offline-imported items survive the boundary
 * ([sanitizeMedia branch](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L216-L220)).
 * The negative case uses a syntactically-valid but DNS-unresolvable
 * `http://` host so `prefetchThumbnail` exhausts its download attempts
 * and falls into the `{status:'error', error:…}` shape the renderer
 * surfaces as a placeholder thumbnail. We do NOT skip on no-network:
 * the host is intentionally `127.0.0.255:1` (port 1 is privileged +
 * unbound) which any reachable network rejects fast (~ms), and the
 * downloader's connect timeout caps the wall clock.
 */
import { test, expect } from '@playwright/test';
import {
  FIXTURE_GIF,
  FIXTURE_MEDIUM,
  getHarness,
  pathToGiftkLocal
} from './_harness';

interface PreviewFrameWire {
  index: number;
  timeSec: number;
  dataUrl: string;
}
interface PreviewResultWire {
  taskId: string;
  durationSec: number;
  width: number;
  height: number;
  frames: PreviewFrameWire[];
  error?: string;
}
interface ThumbnailResultWire {
  id: string;
  status: 'ok' | 'error';
  dataUrl?: string;
  width?: number;
  height?: number;
  localPath?: string;
  kind?: string;
  error?: string;
}

function makeMedia(
  id: string,
  url: string,
  kind: 'video' | 'gif' | 'image'
): Record<string, unknown> {
  return {
    id,
    url,
    kind,
    source: 'video-tag',
    pageUrl: url,
    width: 240,
    height: 180,
    durationSec: 1
  };
}

test.describe('SUITE MEDIA-IO — media:preview / media:thumbnail wire shape + fallback', () => {
  test('SUITE MEDIA-A — media:thumbnail on a local mp4 returns ok with dataUrl + localPath', async () => {
    test.setTimeout(60_000);
    const { page } = getHarness();
    // We deliberately use FIXTURE_MEDIUM (~23KB) instead of tiny.mp4
    // because the smaller fixture occasionally lacks a complete moov
    // atom for ffprobe to extract a frame from; medium.mp4 is exercised
    // by SUITE LIFE-A so we know it round-trips through ffmpeg cleanly.
    const localUrl = pathToGiftkLocal(FIXTURE_MEDIUM);
    const id = `media-a-${Date.now()}`;
    const r = await page.evaluate(
      async (args: { media: Record<string, unknown> }) => {
        const g = (window as unknown as {
          giftk: { thumbnail(m: Record<string, unknown>): Promise<ThumbnailResultWire> };
        }).giftk;
        return g.thumbnail(args.media);
      },
      { media: makeMedia(id, localUrl, 'video') }
    );
    expect(r.id).toBe(id);
    if (r.status !== 'ok') {
      throw new Error(
        `expected status:ok for medium.mp4 thumbnail, got error: ${r.error ?? '<no error>'}`
      );
    }
    expect(r.status).toBe('ok');
    expect(typeof r.dataUrl).toBe('string');
    expect(r.dataUrl!.startsWith('data:image/')).toBe(true);
    expect(typeof r.width).toBe('number');
    expect(typeof r.height).toBe('number');
    expect(typeof r.localPath).toBe('string');
    expect(r.kind).toBe('video');
  });

  test('SUITE MEDIA-B — media:preview on a local gif returns ≥1 frame plus dimensions', async () => {
    test.setTimeout(60_000);
    const { page } = getHarness();
    const localUrl = pathToGiftkLocal(FIXTURE_GIF);
    // NOTE — `previewMedia` ignores opts.taskId; the response.taskId
    // echoes media.id so the renderer can correlate. We assert against
    // media.id directly to match the production contract.
    const mediaId = `media-b-${Date.now()}`;
    const r = await page.evaluate(
      async (args: { media: Record<string, unknown> }) => {
        const g = (window as unknown as {
          giftk: {
            preview(
              m: Record<string, unknown>,
              opts: Record<string, unknown>
            ): Promise<PreviewResultWire>;
          };
        }).giftk;
        return g.preview(args.media, {
          fps: 8,
          maxWidth: 120,
          maxBytes: 256_000,
          softMaxBytes: 128_000,
          minSize: 96,
          speed: 1,
          maxSegmentSec: 60,
          lossyCeiling: 80,
          colorsFloor: 64,
          optimizeLevel: 3,
          dither: 'floyd-steinberg'
        });
      },
      { media: makeMedia(mediaId, localUrl, 'gif') }
    );
    expect(r.taskId).toBe(mediaId);
    expect(typeof r.durationSec).toBe('number');
    expect(typeof r.width).toBe('number');
    expect(typeof r.height).toBe('number');
    expect(Array.isArray(r.frames)).toBe(true);
    // Tiny gif fixture should yield at least one decoded frame; we
    // don't pin an exact count (depends on ffmpeg sample step rules).
    expect(r.frames.length).toBeGreaterThanOrEqual(1);
    if (r.frames.length > 0) {
      expect(typeof r.frames[0].dataUrl).toBe('string');
      expect(r.frames[0].dataUrl.startsWith('data:image/')).toBe(true);
      expect(typeof r.frames[0].timeSec).toBe('number');
      expect(typeof r.frames[0].index).toBe('number');
    }
  });

  test('SUITE MEDIA-C — media:thumbnail on an unreachable http URL falls back to {status:error}', async () => {
    test.setTimeout(60_000);
    const { page } = getHarness();
    // 127.0.0.255 is a TEST-NET-1 routable-but-likely-rejected address;
    // port 1 is the IANA tcpmux which nothing legitimate listens on. The
    // downloader's connect attempt fails fast on any network. Even on
    // the rare box that DOES accept the connection, the read would
    // never produce a valid video header so ffprobe / image decode
    // throws and we still land in the error branch.
    const id = `media-c-${Date.now()}`;
    const r = await page.evaluate(
      async (args: { media: Record<string, unknown> }) => {
        const g = (window as unknown as {
          giftk: { thumbnail(m: Record<string, unknown>): Promise<ThumbnailResultWire> };
        }).giftk;
        return g.thumbnail(args.media);
      },
      { media: makeMedia(id, 'http://127.0.0.255:1/nonexistent.mp4', 'video') }
    );
    expect(r.id === id || r.id === '').toBe(true);
    expect(r.status).toBe('error');
    expect(typeof r.error).toBe('string');
    expect(r.error!.length).toBeGreaterThan(0);
    // Crucially — `dataUrl` MUST be absent on error so the renderer
    // doesn't try to set it as <img src="undefined">.
    expect(r.dataUrl).toBeUndefined();
  });
});
