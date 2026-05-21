/**
 * SUITE B + C — real conversion core.
 *
 * SUITE B drives the production startBatch() IPC against the real
 * ffmpeg + gifsicle binaries with a tiny mp4 fixture and asserts a
 * `done` terminal + non-empty output file.
 *
 * SUITE C is the [forceAllowSmallSide](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts)
 * oracle: a 300x60 gif normally fails ASPECT_RATIO_OUT_OF_RANGE, but
 * setting `forceAllowSmallSide: true` should let the chain produce a
 * real artifact. Pinning both branches in one SUITE keeps the toggle's
 * semantics legible.
 */
import { test, expect } from '@playwright/test';
import { existsSync, statSync, rmSync } from 'node:fs';
import {
  FIXTURE_MP4,
  FIXTURE_GIF,
  getHarness,
  freshOutDir,
  pathToGiftkLocal,
  installRecorder,
  tearDownRecorder,
  snapshotRecorder,
  waitForTerminal
} from './_harness';

test('SUITE B — real conversion: mp4 → gif via real ffmpeg + gifsicle', async () => {
  const { page } = getHarness();
  await installRecorder();
  const outDir = freshOutDir('B');
  try {
    const localUrl = pathToGiftkLocal(FIXTURE_MP4);
    const startResult = await page.evaluate(async (args: { url: string; outDir: string }) => {
      const g = (window as unknown as {
        giftk: { startBatch(tasks: unknown[], pageTitle?: string, outputDirOverride?: string, sessionId?: string): Promise<{ ok: boolean; outputDir: string }> };
      }).giftk;
      const media = {
        id: 'realtest-1',
        url: args.url,
        kind: 'video',
        source: 'video-tag',
        pageUrl: args.url,
        width: 240,
        height: 180,
        durationSec: 1
      };
      const options = {
        outDir: args.outDir,
        fps: 10,
        maxWidth: 160,
        maxBytes: 512000,
        softMaxBytes: 256000,
        minSize: 120,
        speed: 1,
        maxSegmentSec: 60,
        lossyCeiling: 80,
        colorsFloor: 64,
        optimizeLevel: 3,
        dither: 'floyd-steinberg'
      };
      return g.startBatch([{ id: 'realtest-1', media, options }], 'fixture-title', undefined, undefined);
    }, { url: localUrl, outDir });

    expect(startResult.ok).toBe(true);
    expect(startResult.outputDir).toBeTruthy();
    expect(existsSync(startResult.outputDir)).toBe(true);

    const final = await waitForTerminal('realtest-1', 60_000);
    expect(final.status).toBe('done');
    expect(Array.isArray(final.outputs)).toBe(true);
    expect((final.outputs ?? []).length).toBeGreaterThanOrEqual(1);
    const outputPath = (final.outputs as string[])[0];
    expect(existsSync(outputPath)).toBe(true);
    expect(statSync(outputPath).size).toBeGreaterThan(0);

    const snap = await snapshotRecorder();
    expect(snap.logs.length).toBeGreaterThan(0);
  } finally {
    await tearDownRecorder();
    try { rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('SUITE C — forceAllowSmallSide real chain (300x60 gif)', async () => {
  const { page } = getHarness();
  await installRecorder();
  const outDir1 = freshOutDir('C-fail');
  const outDir2 = freshOutDir('C-pass');
  try {
    const localUrl = pathToGiftkLocal(FIXTURE_GIF);

    await page.evaluate(async (args: { url: string; outDir: string }) => {
      const g = (window as unknown as {
        giftk: { startBatch(tasks: unknown[]): Promise<unknown> };
      }).giftk;
      const media = {
        id: 'realtest-c',
        url: args.url,
        kind: 'gif',
        source: 'img-tag',
        pageUrl: args.url,
        width: 300,
        height: 60
      };
      const options = {
        outDir: args.outDir,
        fps: 10,
        maxWidth: 160,
        maxBytes: 512000,
        softMaxBytes: 256000,
        minSize: 120,
        speed: 1,
        maxSegmentSec: 60,
        lossyCeiling: 80,
        colorsFloor: 64,
        optimizeLevel: 3,
        dither: 'floyd-steinberg'
      };
      return g.startBatch([{ id: 'realtest-c', media, options }]);
    }, { url: localUrl, outDir: outDir1 });

    const failTerm = await waitForTerminal('realtest-c', 30_000);
    expect(failTerm.status).toBe('failed');
    const haystack = `${failTerm.error ?? ''} ${failTerm.errorCode ?? ''} ${failTerm.message ?? ''}`;
    expect(haystack).toMatch(/ASPECT_RATIO_OUT_OF_RANGE|short.?side|minSize|aspect/i);

    await tearDownRecorder();
    await installRecorder();

    await page.evaluate(async (args: { url: string; outDir: string }) => {
      const g = (window as unknown as {
        giftk: { startBatch(tasks: unknown[]): Promise<unknown> };
      }).giftk;
      const media = {
        id: 'realtest-c',
        url: args.url,
        kind: 'gif',
        source: 'img-tag',
        pageUrl: args.url,
        width: 300,
        height: 60
      };
      const options = {
        outDir: args.outDir,
        fps: 10,
        maxWidth: 160,
        maxBytes: 512000,
        softMaxBytes: 256000,
        minSize: 120,
        speed: 1,
        maxSegmentSec: 60,
        lossyCeiling: 80,
        colorsFloor: 64,
        optimizeLevel: 3,
        dither: 'floyd-steinberg',
        forceAllowSmallSide: true
      };
      return g.startBatch([{ id: 'realtest-c', media, options }]);
    }, { url: localUrl, outDir: outDir2 });

    const okTerm = await waitForTerminal('realtest-c', 30_000);
    expect(okTerm.status).toBe('done');
    expect(Array.isArray(okTerm.outputs)).toBe(true);
    expect((okTerm.outputs ?? []).length).toBeGreaterThanOrEqual(1);
    const outputPath = (okTerm.outputs as string[])[0];
    expect(existsSync(outputPath)).toBe(true);
    expect(statSync(outputPath).size).toBeGreaterThan(0);
  } finally {
    await tearDownRecorder();
    try { rmSync(outDir1, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(outDir2, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
