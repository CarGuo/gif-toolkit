/**
 * SUITE A + A2 — offline sniff real pipeline.
 *
 * Both probes hit `giftk.importOfflinePage()` directly without UI
 * involvement. SUITE A uses an .html fixture and asserts SniffResult
 * shape + progress + log. SUITE A2 is a R-68 regression guard against
 * the single-media-file path silently dropping `durationSec`.
 *
 * This file is loaded via side-effect import from
 * [realPipeline.spec.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/e2e/realPipeline.spec.ts);
 * Playwright collects every `test()` registered during spec evaluation
 * regardless of which file it was textually written in.
 */
import { test, expect } from '@playwright/test';
import {
  FIXTURE_HTML,
  FIXTURE_LONG,
  getHarness,
  installRecorder,
  tearDownRecorder,
  snapshotRecorder
} from './_harness';

test('SUITE A — offline sniff real pipeline produces SniffResult + progress + log', async () => {
  const { page } = getHarness();
  await installRecorder();
  try {
    const result = await page.evaluate(async (absHtml: string) => {
      const g = (window as unknown as {
        giftk: { importOfflinePage(p: string): Promise<unknown> };
      }).giftk;
      return g.importOfflinePage(absHtml);
    }, FIXTURE_HTML);

    expect(result).toBeTruthy();
    const r = result as { pageUrl: string; items: Array<{ kind: string }>; warnings: string[] };
    expect(r.pageUrl.endsWith('offline-page.html')).toBe(true);
    expect(Array.isArray(r.items)).toBe(true);
    expect(r.items.length).toBeGreaterThanOrEqual(1);
    expect(r.items.some((it) => it.kind === 'video' || it.kind === 'gif')).toBe(true);

    const snap = await snapshotRecorder();
    expect(snap.logs.some((l) => /offline.import/i.test(l))).toBe(true);
    expect(
      snap.sniff.some(
        (p) => p.stage === 'parsing' || p.stage === 'fetching' || p.stage === 'done' || (typeof p.percent === 'number' && p.percent > 0)
      )
    ).toBe(true);
  } finally {
    await tearDownRecorder();
  }
});

// SUITE A2 — R-68 regression guard.
//
// importOfflinePage() applied to a single-media-file (no .html, no
// .mhtml) path used to return SniffedMedia with `durationSec`
// undefined, which silently disabled the long-video segment picker
// downstream. The fix probes ffprobe inline. This test pins the
// behaviour so any future refactor that drops the probe call (or
// changes the field name) fails immediately rather than at the next
// SUITE I run-through.
test('SUITE A2 — single-file offline import populates durationSec via ffprobe', async () => {
  const { page } = getHarness();
  const result = await page.evaluate(async (absMp4: string) => {
    const g = (window as unknown as {
      giftk: { importOfflinePage(p: string): Promise<unknown> };
    }).giftk;
    return g.importOfflinePage(absMp4);
  }, FIXTURE_LONG);

  const r = result as { items: Array<{ kind: string; durationSec?: number; width?: number; height?: number }> };
  expect(r.items.length).toBe(1);
  const it = r.items[0];
  expect(it.kind).toBe('video');
  // long.mp4 fixture is 21s @ 320x240; allow ±0.6s tolerance for
  // ffprobe's container-vs-stream rounding.
  expect(typeof it.durationSec).toBe('number');
  expect(it.durationSec!).toBeGreaterThan(20);
  expect(it.durationSec!).toBeLessThan(22);
  expect(it.width).toBe(320);
  expect(it.height).toBe(240);
});
