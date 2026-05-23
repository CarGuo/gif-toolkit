/**
 * SUITE CAPABILITY-FAILSAFE — `system:capabilities` + `resolve:checkYtdlp`
 * full schema lock + resolver invalid-input contract
 * (R-CAPABILITY-FAILSAFE-V1).
 *
 * Why this SUITE exists
 * ---------------------
 * [SUITE LIFE-C](file:///Users/guoshuyu/workspace/gif-toolkit/tests/e2e/realPipeline/suite-lifecycle.ts#L142-L188)
 * already proves the capability probe runs end-to-end and that ffmpeg
 * is OK on the test machine. What it does NOT do:
 *
 *   - Lock down the FULL [CapabilityReport](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types/system.ts#L43-L63) wire shape (each
 *     of the 4 binaries × {path:string, ok:boolean, version:string})
 *   - Verify `issues` is always an array (UI iterates blindly)
 *   - Drive [resolve:checkYtdlp](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L2035-L2037)
 *     and assert the YtdlpStatus contract
 *   - Verify [resolve:embed](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L2039-L2061)
 *     rejects non-embed media without crashing the IPC channel
 *
 * A regression in any of these — say, a future refactor flipping
 * `binaries.ytdlp.ok` from boolean to `{ok}` object, or `issues`
 * leaking `null` — would cascade silently into every renderer toast
 * gate without this SUITE catching it first.
 */
import { test, expect } from '@playwright/test';
import { getHarness } from './_harness';

interface BinaryProbe {
  path: string;
  ok: boolean;
  version: string;
}
interface CapabilityIssueWire {
  id: string;
  severity: 'info' | 'warning' | 'error';
  title: string;
  detail: string;
  docUrl?: string;
}
interface CapabilityReportWire {
  platform: string;
  arch: string;
  hasHiResIcon: boolean;
  binaries: {
    ffmpeg: BinaryProbe;
    ffprobe: BinaryProbe;
    gifsicle: BinaryProbe;
    ytdlp: BinaryProbe;
  };
  issues: CapabilityIssueWire[];
}
interface YtdlpStatusWire {
  installed: boolean;
  binaryPath: string;
  version?: string;
  workingDir: string;
  source?: 'packaged' | 'userData' | 'missing';
}

function assertBinaryProbe(label: string, b: BinaryProbe): void {
  expect(typeof b.path, `${label}.path`).toBe('string');
  expect(typeof b.ok, `${label}.ok`).toBe('boolean');
  expect(typeof b.version, `${label}.version`).toBe('string');
}

test.describe('SUITE CAPABILITY-FAILSAFE — system:capabilities + resolve:* schema lock', () => {
  test('SUITE CAP-A — system:capabilities full schema is well-formed', async () => {
    // Use the full LIFE-C 90s budget — first cold-spawn after a full
    // realPipeline launch can take ~35s on Rosetta. The harness
    // typically caches it after LIFE-C, so subsequent calls are
    // sub-millisecond, but we keep headroom for cold runs.
    test.setTimeout(90_000);
    const { page } = getHarness();
    const r = (await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: { getCapabilities(): Promise<CapabilityReportWire> };
      };
      return w.giftk.getCapabilities();
    })) as CapabilityReportWire;
    // Top-level scalars
    expect(typeof r.platform).toBe('string');
    expect(r.platform.length).toBeGreaterThan(0);
    expect(typeof r.arch).toBe('string');
    expect(r.arch.length).toBeGreaterThan(0);
    expect(typeof r.hasHiResIcon).toBe('boolean');
    // Binaries — 4 named probes, each with the full schema.
    expect(typeof r.binaries).toBe('object');
    assertBinaryProbe('ffmpeg', r.binaries.ffmpeg);
    assertBinaryProbe('ffprobe', r.binaries.ffprobe);
    assertBinaryProbe('gifsicle', r.binaries.gifsicle);
    assertBinaryProbe('ytdlp', r.binaries.ytdlp);
    // ffmpeg / ffprobe MUST be ok on a working dev box — they're
    // bundled by ffmpeg-static / ffprobe-static. If this trips, the
    // SUITE is exposing a real regression in binary resolution.
    expect(r.binaries.ffmpeg.ok).toBe(true);
    expect(r.binaries.ffprobe.ok).toBe(true);
    // Issues — must be an array (the UI uses .map() blindly). Each
    // entry, when present, must be a well-formed CapabilityIssue.
    expect(Array.isArray(r.issues)).toBe(true);
    for (const iss of r.issues) {
      expect(typeof iss.id).toBe('string');
      expect(iss.id.length).toBeGreaterThan(0);
      expect(['info', 'warning', 'error']).toContain(iss.severity);
      expect(typeof iss.title).toBe('string');
      expect(typeof iss.detail).toBe('string');
    }
  });

  test('SUITE CAP-B — system:capabilities is cached: second call is fast', async () => {
    test.setTimeout(20_000);
    const { page } = getHarness();
    // Warm up — the previous test almost certainly already populated
    // the cache, but call once more so we deterministically benchmark
    // the cached branch and not the cold-spawn branch.
    await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: { getCapabilities(): Promise<CapabilityReportWire> };
      };
      return w.giftk.getCapabilities();
    });
    const elapsedMs = (await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: { getCapabilities(): Promise<CapabilityReportWire> };
      };
      const t0 = performance.now();
      await w.giftk.getCapabilities();
      return performance.now() - t0;
    })) as number;
    // The cached branch should round-trip in well under a second.
    // 2000ms is generous to absorb IPC + scheduling jitter on busy CI.
    expect(elapsedMs).toBeLessThan(2000);
  });

  test('SUITE CAP-C — resolve:checkYtdlp returns a YtdlpStatus with the documented fields', async () => {
    test.setTimeout(45_000);
    const { page } = getHarness();
    const r = (await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: { checkYtdlp(): Promise<YtdlpStatusWire> };
      };
      return w.giftk.checkYtdlp();
    })) as YtdlpStatusWire;
    expect(typeof r.installed).toBe('boolean');
    expect(typeof r.binaryPath).toBe('string');
    expect(typeof r.workingDir).toBe('string');
    expect(r.workingDir.length).toBeGreaterThan(0);
    if (r.installed) {
      expect(r.binaryPath.length).toBeGreaterThan(0);
      // version is optional but, when present, must be a string.
      if (typeof r.version !== 'undefined') {
        expect(typeof r.version).toBe('string');
      }
    }
    // source is optional but, when present, must be one of three known
    // values — guards against a future enum drift.
    if (typeof r.source !== 'undefined') {
      expect(['packaged', 'userData', 'missing']).toContain(r.source);
    }
  });

  test('SUITE CAP-D — resolve:embed rejects non-embed media without crashing the channel', async () => {
    test.setTimeout(15_000);
    const { page } = getHarness();
    const r = (await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: {
          resolveEmbed(media: Record<string, unknown>): Promise<unknown>;
          getCapabilities(): Promise<CapabilityReportWire>;
        };
      };
      const out: { rejected: boolean; message: string; channelAlive: boolean } = {
        rejected: false,
        message: '',
        channelAlive: false
      };
      // A vanilla non-embed video-tag media — `requiresExternalDownload`
      // defaults to false so resolveEmbed MUST throw.
      const plain = {
        id: 'cap-d-plain',
        url: 'https://example.com/video.mp4',
        kind: 'video',
        source: 'video-tag',
        pageUrl: 'https://example.com/article'
      };
      try {
        await w.giftk.resolveEmbed(plain);
      } catch (e) {
        out.rejected = true;
        out.message = (e as Error).message;
      }
      // The IPC channel survives — capabilities still works after the
      // rejection (defence against a handler that crashes the worker).
      const cap = await w.giftk.getCapabilities();
      out.channelAlive = typeof cap.platform === 'string';
      return out;
    })) as { rejected: boolean; message: string; channelAlive: boolean };
    expect(r.rejected).toBe(true);
    expect(r.message.length).toBeGreaterThan(0);
    expect(r.channelAlive).toBe(true);
  });
});
