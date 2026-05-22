/**
 * SUITE SIZE-REGRESSION-UI — proves the R-SIZE-REGRESSION-V1
 * detection + ⚠️ UI badge survives the entire production stack.
 *
 * Why this SUITE exists
 * ---------------------
 * A user reported a real-world regression: cropping a 2.6MB
 * highly-optimized .gif with the lineage modal produced a 4.2MB
 * output (+65.7%). Root cause is that ffmpeg's GIF re-encode resets
 * the palette / LZW cache that Photoshop carefully built. The fix
 * isn't to magically un-grow the file — that would silently mutate
 * the user's intent. Instead main attaches a `sizeRegression` field
 * to the `done` progress event whenever afterBytes / beforeBytes
 * exceeds 1.05, and the renderer paints a ⚠️ badge next to the
 * size figure so the user can see what happened and decide whether
 * to keep the original.
 *
 * This SUITE proves both halves of that contract through the real
 * Electron + Playwright stack:
 *
 *   • SIZE-CROP-WARN-A    — canonical reproducer using tiny.gif
 *     (1368 bytes, already minimal). Driving Crop X/Y/W/H through
 *     the lineage modal MUST emit a `done` event whose
 *     `sizeRegression` field is populated, and the lineage progress
 *     row MUST render the ⚠️ badge.
 *
 *   • SIZE-CROP-PERSIST-B — the same crop run, but instead of just
 *     watching IPC we ensure the React `LineageProgressRow` ⚠️
 *     becomes visible while the chain is still in flight (i.e. the
 *     ⚠️ stays attached to the final progress event the renderer
 *     sees, not just the IPC payload).
 *
 *   • SIZE-NO-WARN-C      — a Trim chain on tiny.gif. Trim cuts
 *     frames so afterBytes < beforeBytes is the strict expectation;
 *     the SUITE asserts `sizeRegression` IS undefined on the final
 *     emit and no ⚠️ badge is rendered. This is the negative
 *     control that prevents future false positives if someone ever
 *     accidentally lowers the 1.05 ratio threshold.
 *
 * The SUITE intentionally stays UI-driven and does NOT call
 * `startToolboxChain` directly. The whole point of R-SIZE-
 * REGRESSION-V1 is that users see the warning in the React tree
 * during the lineage flow.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { existsSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  FIXTURE_GIF,
  FIXTURE_MEDIUM,
  getHarness,
  installRecorder,
  tearDownRecorder,
  snapshotRecorder
} from './_harness';

interface SizeRegressionPayload {
  beforeBytes: number;
  afterBytes: number;
  ratio: number;
}

interface LineageTerminalEmit {
  taskId: string;
  status: string;
  outputs?: string[];
  stepIndex?: number;
  totalSteps?: number;
  error?: string;
  message?: string;
  sizeRegression?: SizeRegressionPayload;
}

async function clearAllHistory(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as {
      giftk: {
        db: {
          toolboxHistory: { clear(): Promise<void> };
          toolboxChainHistory: { clear(): Promise<void> };
        };
      };
    };
    await w.giftk.db.toolboxHistory.clear();
    await w.giftk.db.toolboxChainHistory.clear();
  });
}

async function seedHistoryRow(
  page: Page,
  output: string,
  kind: string,
  inputDisplayName: string
): Promise<string> {
  const id = `tblin-size-seed-${kind}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await page.evaluate(
    async (args: { id: string; output: string; kind: string; displayName: string; finishedAt: number }) => {
      const w = window as unknown as {
        giftk: { db: { toolboxHistory: { upsert(entry: unknown): Promise<void> } } };
      };
      await w.giftk.db.toolboxHistory.upsert({
        id: args.id,
        kind: args.kind,
        inputPath: `/synthetic/${args.displayName}`,
        displayName: args.displayName,
        outputs: [args.output],
        params: {},
        status: 'done',
        finishedAt: args.finishedAt
      });
    },
    { id, output, kind, displayName: inputDisplayName, finishedAt: Date.now() }
  );
  await page.locator('button.tab-btn', { hasText: '主页' }).click().catch(() => undefined);
  await expect.poll(
    async () => {
      const rows = (await page.evaluate(async () => {
        const w = window as unknown as {
          giftk: { db: { toolboxHistory: { readAll(): Promise<unknown[]> } } };
        };
        return await w.giftk.db.toolboxHistory.readAll();
      })) as Array<{ id: string }>;
      return rows.some((r) => r.id === id);
    },
    { timeout: 10_000, intervals: [50, 100, 200] }
  ).toBe(true);
  await page.locator('button.tab-btn', { hasText: '工具箱' }).click();
  return id;
}

async function ensureToolboxTab(page: Page): Promise<void> {
  const tab = page.locator('button.tab-btn', { hasText: '工具箱' });
  await expect(tab).toBeVisible({ timeout: 10_000 });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-pressed', 'true');
}

async function enterLineage(page: Page): Promise<Locator> {
  const continueBtn = page.locator('button.tb-history-continue').first();
  await expect(continueBtn).toBeVisible({ timeout: 10_000 });
  await continueBtn.click();
  const modal = page.locator('div.modal.tb-lineage-modal[role="dialog"]');
  await expect(modal).toBeVisible({ timeout: 5_000 });
  return modal;
}

async function selectChip(modal: Locator, label: string | RegExp): Promise<void> {
  const chip = modal.locator('.tb-lineage-chips button[role="tab"]', {
    hasText: typeof label === 'string' ? new RegExp(`^${label}$`) : label
  });
  await expect(chip).toBeVisible({ timeout: 5_000 });
  await chip.click();
  await expect(chip).toHaveAttribute('aria-selected', 'true');
}

async function exitLineage(page: Page, modal: Locator): Promise<void> {
  await page.locator('button', { hasText: '退出链路' }).click();
  await expect(modal).toHaveCount(0, { timeout: 5_000 });
}

function rmDirOf(filePath: string | null): void {
  if (!filePath) return;
  try {
    rmSync(path.dirname(filePath), { recursive: true, force: true });
  } catch { /* best-effort */ }
}

/**
 * Build a "gold-standard" highly-optimized animated GIF by running
 * medium.mp4 through video-to-gif (which internally uses ffmpeg
 * palettegen + gifsicle -O3 by default). The resulting palette /
 * LZW packing on the multi-frame output is so tight that any
 * subsequent ffmpeg re-encode (e.g. a crop) inflates the output
 * well past the 1.05 ratio gate, reproducing the user's
 * "2.6MB → 4.2MB" report deterministically. tiny.gif is a 300x60
 * single-frame fixture and after gif-optimize still re-crops
 * smaller, so we deliberately use a multi-frame animation here.
 * Returns the absolute path of the optimized output. Caller is
 * responsible for cleanup via rmDirOf().
 */
async function buildHighlyOptimizedGif(page: Page): Promise<string> {
  const result = await page.evaluate(async (inputPath: string) => {
    const w = window as unknown as {
      giftk: {
        startToolbox(jobs: unknown[]): Promise<unknown>;
        onProgress(cb: (p: { taskId: string; status: string; outputs?: string[] }) => void): () => void;
      };
    };
    const jobId = `size-rgsn-pre-v2g-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    return await new Promise<string>((resolve, reject) => {
      let off: (() => void) | null = null;
      const timer = setTimeout(() => {
        if (off) off();
        reject(new Error('video-to-gif did not finish within 60s'));
      }, 60_000);
      off = w.giftk.onProgress((p) => {
        if (p.taskId !== jobId) return;
        if (p.status === 'done' && p.outputs && p.outputs.length > 0) {
          clearTimeout(timer);
          if (off) off();
          resolve(p.outputs[0]);
        } else if (p.status === 'failed') {
          clearTimeout(timer);
          if (off) off();
          reject(new Error('video-to-gif failed'));
        }
      });
      w.giftk.startToolbox([{
        id: jobId,
        kind: 'video-to-gif',
        inputPath,
        // Default fps=12, default width = source width, engine ffmpeg.
        // The processor automatically pipes the result through gifsicle
        // -O3 which produces the gold-standard packing we need.
        params: { fps: 12, engine: 'ffmpeg' }
      }]).catch(reject);
    });
  }, FIXTURE_MEDIUM);
  return result;
}

/**
 * Click 「继续 →」 and poll the IPC recorder for the chain's
 * terminal `done` emit. Returns the full progress payload so
 * callers can assert on `sizeRegression`.
 */
async function runStepAndWaitDone(
  modal: Locator,
  page: Page,
  timeoutMs = 90_000
): Promise<LineageTerminalEmit> {
  const baseline = (await snapshotRecorder()).progress.length;
  const continueStepBtn = modal.locator('button.btn.primary', { hasText: /^继续 →/ });
  await expect(continueStepBtn).toBeEnabled({ timeout: 10_000 });
  await continueStepBtn.click();

  let boundChainId: string | null = null;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snap = await snapshotRecorder();
    const candidates = snap.progress.slice(baseline);
    if (!boundChainId) {
      for (const p of candidates) {
        const tid = (p as { taskId?: unknown }).taskId;
        if (typeof tid !== 'string') continue;
        const m = /^(tblineage-[a-z0-9-]+)-s1$/i.exec(tid);
        if (m) { boundChainId = m[1]; break; }
      }
    }
    if (boundChainId) {
      const expected = `${boundChainId}-s1`;
      const last = [...candidates].reverse().find((p) => {
        const cp = p as unknown as LineageTerminalEmit;
        if (cp.taskId !== expected) return false;
        if (cp.totalSteps !== 1 || cp.stepIndex !== 1) return false;
        return cp.status === 'done' || cp.status === 'failed' || cp.status === 'cancelled';
      });
      if (last) return last as unknown as LineageTerminalEmit;
    }
    await page.waitForTimeout(250);
  }
  const tail = (await snapshotRecorder()).progress.slice(-5);
  throw new Error(
    `size-regression chain did not finish within ${timeoutMs}ms; tail emits: ${JSON.stringify(tail)}`
  );
}

// =====================================================================
// SUITE SIZE-REGRESSION-UI — main + UI gates for R-SIZE-REGRESSION-V1
// =====================================================================

test.describe('SUITE SIZE-REGRESSION-UI — R-SIZE-REGRESSION-V1 contract', () => {
  test.describe.configure({ timeout: 120_000 });

  /**
   * SIZE-CROP-WARN-A — canonical reproducer.
   * We first run tiny.gif through gif-optimize (gifsicle -O3) so the
   * source becomes a "gold-standard" highly-optimized GIF — exactly
   * the kind of file that triggered the user-reported regression.
   * Cropping that source through the lineage modal forces ffmpeg to
   * decode + re-encode, which resets the palette / LZW packing and
   * inflates the output well past the 1.05 ratio gate. The IPC
   * payload MUST carry a populated `sizeRegression` field.
   */
  test('SIZE-CROP-WARN-A Crop on highly-optimized gif emits sizeRegression', async () => {
    const { page } = getHarness();
    await clearAllHistory(page);
    await ensureToolboxTab(page);
    const goldGif = await buildHighlyOptimizedGif(page);
    expect(existsSync(goldGif)).toBe(true);
    await seedHistoryRow(page, goldGif, 'video-to-gif', path.basename(goldGif));
    await installRecorder();
    let outPath: string | null = null;
    try {
      const modal = await enterLineage(page);
      await selectChip(modal, /^Crop$/);
      const cropPane = modal.locator('.tb-crop-pane');
      await expect(cropPane).toBeVisible({ timeout: 15_000 });
      const labelToInput = (label: string): Locator =>
        cropPane.locator('label', { hasText: new RegExp(`^${label}$`) }).locator('input');
      // Match the user's reported scenario: keep ALMOST the full
       // frame (only shave off a 5px border). Pixel count barely
       // drops, but ffmpeg re-encodes from scratch and the LZW /
       // palette repack inflates the file past the 1.05 ratio gate.
       // medium.gif is 480x360 — a 470x350 crop at (5,5) keeps 95%+
       // of the pixels and is the canonical "size goes UP after a
       // tiny crop" repro.
      await labelToInput('X').fill('5');
      await labelToInput('Y').fill('5');
      await labelToInput('W').fill('470');
      await labelToInput('H').fill('350');
      await labelToInput('H').press('Tab');

      const final = await runStepAndWaitDone(modal, page);
      expect(final.status).toBe('done');
      outPath = (final.outputs ?? [])[0] ?? null;
      expect(outPath).toBeTruthy();
      if (outPath) {
        expect(existsSync(outPath)).toBe(true);
      }

      // The contract: main MUST attach sizeRegression because the
      // gold-standard input is so tightly packed that any re-encode
      // inflates it past the 1.05 ratio gate.
      expect(final.sizeRegression).toBeDefined();
      const sr = final.sizeRegression!;
      expect(sr.beforeBytes).toBeGreaterThan(0);
      expect(sr.afterBytes).toBeGreaterThan(0);
      expect(sr.ratio).toBeGreaterThan(1.05);
      // Cross-check against actual file sizes — main computed
      // sizeRegression from inputPath (gold-standard gif) vs outputs[0],
      // so the on-disk numbers must agree.
      const onDiskAfter = statSync(outPath as string).size;
      expect(sr.afterBytes).toBe(onDiskAfter);

      await exitLineage(page, modal);
    } finally {
      await tearDownRecorder();
      rmDirOf(outPath);
      rmDirOf(goldGif);
      await clearAllHistory(page).catch(() => undefined);
    }
  });

  /**
   * SIZE-CROP-PERSIST-B — proves the renderer paints the ⚠️ badge.
   * The lineage progress row keeps the LAST progress event around
   * after `done`, so we can poll [data-testid=
   * lineage-progress-size-regression-warn] AFTER the chain
   * completes and assert it's visible.
   */
  test('SIZE-CROP-PERSIST-B Crop ⚠️ renders on lineage progress row', async () => {
    const { page } = getHarness();
    await clearAllHistory(page);
    await ensureToolboxTab(page);
    const goldGif = await buildHighlyOptimizedGif(page);
    await seedHistoryRow(page, goldGif, 'video-to-gif', path.basename(goldGif));
    await installRecorder();
    let outPath: string | null = null;
    try {
      const modal = await enterLineage(page);
      await selectChip(modal, /^Crop$/);
      const cropPane = modal.locator('.tb-crop-pane');
      await expect(cropPane).toBeVisible({ timeout: 15_000 });
      const labelToInput = (label: string): Locator =>
        cropPane.locator('label', { hasText: new RegExp(`^${label}$`) }).locator('input');
      await labelToInput('X').fill('5');
      await labelToInput('Y').fill('5');
      await labelToInput('W').fill('470');
      await labelToInput('H').fill('350');
      await labelToInput('H').press('Tab');

      const final = await runStepAndWaitDone(modal, page);
      expect(final.status).toBe('done');
      outPath = (final.outputs ?? [])[0] ?? null;
      expect(final.sizeRegression).toBeDefined();

      // Now poll the React tree — the LineageProgressRow re-renders
      // off `progress`, so once main has emitted `done` with
      // sizeRegression, the ⚠️ data-testid must surface.
      const warn = modal.locator('[data-testid="lineage-progress-size-regression-warn"]');
      await expect(warn).toBeVisible({ timeout: 5_000 });
      const titleAttr = await warn.getAttribute('title');
      expect(titleAttr).toBeTruthy();
      expect(titleAttr!).toMatch(/体积反向增加/);

      await exitLineage(page, modal);
    } finally {
      await tearDownRecorder();
      rmDirOf(outPath);
      rmDirOf(goldGif);
      await clearAllHistory(page).catch(() => undefined);
    }
  });

  /**
   * SIZE-NO-WARN-C — negative control. Trim shrinks the gif by
   * cutting frames. afterBytes / beforeBytes MUST stay at or below
   * 1.05 (typically far below), so `sizeRegression` MUST be
   * undefined and the renderer MUST NOT paint ⚠️.
   *
   * If this case ever fails it means either (a) someone lowered
   * the 1.05 tolerance and Trim is now triggering false positives,
   * or (b) the trim implementation regressed and is no longer
   * actually trimming frames.
   */
  test('SIZE-NO-WARN-C Trim on tiny.gif does NOT emit sizeRegression', async () => {
    const { page } = getHarness();
    await clearAllHistory(page);
    await ensureToolboxTab(page);
    await seedHistoryRow(page, FIXTURE_GIF, 'video-to-gif', 'tiny.gif');
    await installRecorder();
    let outPath: string | null = null;
    try {
      const modal = await enterLineage(page);
      await selectChip(modal, /^Trim$/);
      const final = await runStepAndWaitDone(modal, page);
      expect(final.status).toBe('done');
      outPath = (final.outputs ?? [])[0] ?? null;
      expect(outPath).toBeTruthy();
      if (outPath) {
        expect(existsSync(outPath)).toBe(true);
        // Trim is supposed to make things smaller, never bigger.
        const beforeBytes = statSync(FIXTURE_GIF).size;
        const afterBytes = statSync(outPath).size;
        expect(afterBytes).toBeLessThanOrEqual(Math.ceil(beforeBytes * 1.05));
      }
      expect(final.sizeRegression).toBeUndefined();

      // The ⚠️ badge MUST NOT be in the DOM.
      const warn = modal.locator('[data-testid="lineage-progress-size-regression-warn"]');
      await expect(warn).toHaveCount(0);

      await exitLineage(page, modal);
    } finally {
      await tearDownRecorder();
      rmDirOf(outPath);
      await clearAllHistory(page).catch(() => undefined);
    }
  });
});
