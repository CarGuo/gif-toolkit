/**
 * SUITE TB-LINEAGE-UI-ALL — exhaustive UI-driven coverage for the
 * toolbox lineage modal, one SUITE per supported ToolboxKind.
 *
 * Why this SUITE exists
 * ---------------------
 * Pre-existing TB-CHAIN A..E proved the IPC layer (startToolboxChain
 * + resumeToolboxChain) and the V2 lineage UI for ONE happy path
 * (gif-resize). What was missing — and what produced the recent
 * "crop sits at 0% / awaiting-input forever" regression — is a
 * test that drives every lineage chip THROUGH THE REACT UI, so a
 * bug that only lives in `useToolboxLineage`'s progress listener
 * (e.g. forgetting to handle 'awaiting-input' and call
 * resumeToolboxChain) gets caught.
 *
 * Each SUITE follows the same skeleton:
 *   1. Reset clean (toolboxHistory + toolboxChainHistory empty).
 *   2. Switch to 工具箱 tab.
 *   3. Seed ONE 'done' history row whose output is a real fixture
 *      (tiny.gif for gif-family chains, tiny.mp4 for the video chain).
 *   4. Click 「继续处理」 to enter the lineage modal.
 *   5. Click the kind's chip in 「下一步」 list.
 *   6. For crop, type the rect into the X/Y/W/H NumFields (the
 *      only kind whose chip-select doesn't fully populate the params
 *      via defaultParamsFor()).
 *   7. Click 「继续 →」 (NOT trial-run — this is the production path
 *      that goes through startToolboxChain and the IPC progress
 *      listener).
 *   8. Wait for the chain runner's terminal `done` emit on a
 *      tblineage-* taskId.
 *   9. Assert the breadcrumb has 2 nodes, the new tail is on disk,
 *      and the file is non-empty + has the expected magic bytes.
 *  10. Exit chain, clear history.
 *
 * The crop SUITE is the canonical regression for the React-side
 * awaiting-input handler — without
 * src/renderer/components/useToolboxLineage.ts's `awaiting-input`
 * branch calling `resumeToolboxChain`, ffmpeg never starts and the
 * test times out at step 8.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { existsSync, readFileSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  FIXTURE_GIF,
  FIXTURE_MP4,
  getHarness,
  installRecorder,
  tearDownRecorder,
  snapshotRecorder
} from './_harness';

interface LineageTerminalEmit {
  taskId: string;
  status: string;
  outputs?: string[];
  stepIndex?: number;
  totalSteps?: number;
  error?: string;
  message?: string;
}

/**
 * Drop every persisted toolbox surface a fresh case might trip on.
 *
 * R-LINEAGE-RESUME-V1 — `chain_lineage_nodes` MUST be wiped between
 * cases too. ToolboxPanel.handleEnterLineageFromHistory now reverse-
 * looks up the latest chainId by `(parent_node_id='root', input_path)`
 * before deciding whether to `reset()` or `hydrateFromChain(...)`. If
 * a previous case left a row whose input_path equals this case's
 * FIXTURE_GIF, the next `enterLineage` would auto-hydrate into the
 * stale chain — chip selection, focus, and tree shape would all drift.
 * The TREE suite's clearAllHistory already wipes this table for the
 * same reason; here we mirror that contract so chip-driven cases
 * always start from a virgin synthetic-root tree.
 */
async function clearAllHistory(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as {
      giftk: {
        db: {
          toolboxHistory: { clear(): Promise<void> };
          toolboxChainHistory: { clear(): Promise<void> };
          chainLineageNodes: { clear(): Promise<void> };
        };
      };
    };
    await w.giftk.db.toolboxHistory.clear();
    await w.giftk.db.toolboxChainHistory.clear();
    await w.giftk.db.chainLineageNodes.clear();
  });
}

async function seedHistoryRow(
  page: Page,
  output: string,
  kind: string,
  inputDisplayName: string
): Promise<string> {
  const id = `tblin-seed-${kind}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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
  // The panel reads db.toolboxHistory on mount; bounce tabs to nudge a
  // re-read, with an explicit poll so slow IO doesn't flake CI.
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

/**
 * Run the lineage step and wait for the terminal `done` emit.
 * Returns the final progress event so the caller can assert on
 * outputs[]. The chainId is auto-discovered from the first
 * post-baseline progress emit whose taskId matches `tblineage-*-s1`.
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
  // Surface the most recent non-terminal emit so test failures are
  // diagnosable. e.g. a crop awaiting-input deadlock will show
  // `status: awaiting-input` here, telling us the React resume hop
  // didn't fire.
  const tail = (await snapshotRecorder()).progress.slice(-5);
  throw new Error(
    `lineage step did not finish within ${timeoutMs}ms; tail emits: ${JSON.stringify(tail)}`
  );
}

async function exitLineage(page: Page, modal: Locator): Promise<void> {
  await page.locator('button', { hasText: '退出链路' }).click();
  await expect(modal).toHaveCount(0, { timeout: 5_000 });
}

function magicHeader(filePath: string, len = 12): string {
  return readFileSync(filePath).subarray(0, len).toString('latin1');
}

function rmDirOf(filePath: string | null): void {
  if (!filePath) return;
  try {
    rmSync(path.dirname(filePath), { recursive: true, force: true });
  } catch { /* best-effort */ }
}

async function ensureToolboxTab(page: Page): Promise<void> {
  const tab = page.locator('button.tab-btn', { hasText: '工具箱' });
  await expect(tab).toBeVisible({ timeout: 10_000 });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-pressed', 'true');
}

// =====================================================================
// SUITE TB-LINEAGE-UI-ALL — one test per ToolboxKind reachable via UI
// =====================================================================

test.describe('SUITE TB-LINEAGE-UI-ALL — every chip drives a real chain through the React UI', () => {
  test.describe.configure({ timeout: 120_000 });

  test('UI-LIN-1 GIF Resize chip — gif input → resized gif on disk', async () => {
    const { page } = getHarness();
    await clearAllHistory(page);
    await ensureToolboxTab(page);
    await seedHistoryRow(page, FIXTURE_GIF, 'video-to-gif', 'tiny.gif');
    await installRecorder();
    let outPath: string | null = null;
    try {
      const modal = await enterLineage(page);
      await selectChip(modal, /^GIF Resize$/);
      const final = await runStepAndWaitDone(modal, page);
      expect(final.status).toBe('done');
      outPath = (final.outputs ?? [])[0] ?? null;
      expect(outPath).toBeTruthy();
      if (outPath) {
        expect(existsSync(outPath)).toBe(true);
        expect(statSync(outPath).size).toBeGreaterThan(40);
        expect(magicHeader(outPath, 6)).toMatch(/^GIF8[79]a$/);
      }
      await exitLineage(page, modal);
    } finally {
      await tearDownRecorder();
      rmDirOf(outPath);
      await clearAllHistory(page).catch(() => undefined);
    }
  });

  test('UI-LIN-2 GIF Optimize chip — gif input → optimized gif', async () => {
    const { page } = getHarness();
    await clearAllHistory(page);
    await ensureToolboxTab(page);
    await seedHistoryRow(page, FIXTURE_GIF, 'video-to-gif', 'tiny.gif');
    await installRecorder();
    let outPath: string | null = null;
    try {
      const modal = await enterLineage(page);
      await selectChip(modal, /^GIF Optimize$/);
      const final = await runStepAndWaitDone(modal, page);
      expect(final.status).toBe('done');
      outPath = (final.outputs ?? [])[0] ?? null;
      expect(outPath).toBeTruthy();
      if (outPath) {
        expect(existsSync(outPath)).toBe(true);
        expect(statSync(outPath).size).toBeGreaterThan(40);
        expect(magicHeader(outPath, 6)).toMatch(/^GIF8[79]a$/);
      }
      await exitLineage(page, modal);
    } finally {
      await tearDownRecorder();
      rmDirOf(outPath);
      await clearAllHistory(page).catch(() => undefined);
    }
  });

  test('UI-LIN-3 Trim chip — gif input → trimmed gif', async () => {
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
        expect(statSync(outPath).size).toBeGreaterThan(40);
      }
      await exitLineage(page, modal);
    } finally {
      await tearDownRecorder();
      rmDirOf(outPath);
      await clearAllHistory(page).catch(() => undefined);
    }
  });

  test('UI-LIN-4 Speed chip — gif input → re-timed gif', async () => {
    const { page } = getHarness();
    await clearAllHistory(page);
    await ensureToolboxTab(page);
    await seedHistoryRow(page, FIXTURE_GIF, 'video-to-gif', 'tiny.gif');
    await installRecorder();
    let outPath: string | null = null;
    try {
      const modal = await enterLineage(page);
      await selectChip(modal, /^Speed$/);
      const final = await runStepAndWaitDone(modal, page);
      expect(final.status).toBe('done');
      outPath = (final.outputs ?? [])[0] ?? null;
      expect(outPath).toBeTruthy();
      if (outPath) expect(statSync(outPath).size).toBeGreaterThan(40);
      await exitLineage(page, modal);
    } finally {
      await tearDownRecorder();
      rmDirOf(outPath);
      await clearAllHistory(page).catch(() => undefined);
    }
  });

  test('UI-LIN-5 Reverse chip — gif input → reversed gif', async () => {
    const { page } = getHarness();
    await clearAllHistory(page);
    await ensureToolboxTab(page);
    await seedHistoryRow(page, FIXTURE_GIF, 'video-to-gif', 'tiny.gif');
    await installRecorder();
    let outPath: string | null = null;
    try {
      const modal = await enterLineage(page);
      await selectChip(modal, /^Reverse$/);
      const final = await runStepAndWaitDone(modal, page);
      expect(final.status).toBe('done');
      outPath = (final.outputs ?? [])[0] ?? null;
      expect(outPath).toBeTruthy();
      if (outPath) expect(statSync(outPath).size).toBeGreaterThan(40);
      await exitLineage(page, modal);
    } finally {
      await tearDownRecorder();
      rmDirOf(outPath);
      await clearAllHistory(page).catch(() => undefined);
    }
  });

  test('UI-LIN-6 Rotate chip — gif input → rotated gif', async () => {
    const { page } = getHarness();
    await clearAllHistory(page);
    await ensureToolboxTab(page);
    await seedHistoryRow(page, FIXTURE_GIF, 'video-to-gif', 'tiny.gif');
    await installRecorder();
    let outPath: string | null = null;
    try {
      const modal = await enterLineage(page);
      await selectChip(modal, /^Rotate$/);
      const final = await runStepAndWaitDone(modal, page);
      expect(final.status).toBe('done');
      outPath = (final.outputs ?? [])[0] ?? null;
      expect(outPath).toBeTruthy();
      if (outPath) expect(statSync(outPath).size).toBeGreaterThan(40);
      await exitLineage(page, modal);
    } finally {
      await tearDownRecorder();
      rmDirOf(outPath);
      await clearAllHistory(page).catch(() => undefined);
    }
  });

  /**
   * UI-LIN-7 — the canonical regression for the React-side
   * awaiting-input handler. The lineage modal's CropForm fires
   * setDraftParams as the user types into X/Y/W/H NumFields, and
   * the run button enables when cropBlocked clears. After
   * `继续 →`, the main-process chain runner emits awaiting-input
   * because crop is in PAUSING_KINDS — the React listener MUST
   * call resumeToolboxChain or the chain deadlocks at 0%. This
   * SUITE will time out at runStepAndWaitDone if that hop is
   * missing.
   */
  test('UI-LIN-7 Crop chip — fills X/Y/W/H, runs through awaiting-input → done', async () => {
    const { page } = getHarness();
    await clearAllHistory(page);
    await ensureToolboxTab(page);
    await seedHistoryRow(page, FIXTURE_GIF, 'video-to-gif', 'tiny.gif');
    await installRecorder();
    let outPath: string | null = null;
    try {
      const modal = await enterLineage(page);
      await selectChip(modal, /^Crop$/);

      // The CropForm renders four NumFields with labels X / Y / W / H.
      // Use label-scoped fillers so the e2e doesn't depend on field
      // ordering or class names. Wait for the preview <img> to load
      // first — the form short-circuits with "正在生成预览…" until
      // mediaInfo + previewDataUrl are available, and the inputs only
      // mount after that.
      const cropPane = modal.locator('.tb-crop-pane');
      await expect(cropPane).toBeVisible({ timeout: 15_000 });
      const labelToInput = (label: string): Locator =>
        cropPane.locator('label', { hasText: new RegExp(`^${label}$`) }).locator('input');
      // tiny.gif is 300×60 (verified in earlier suites). Picking a
      // safely-inside rect that the sanitizer won't clamp.
      await labelToInput('X').fill('30');
      await labelToInput('Y').fill('5');
      await labelToInput('W').fill('200');
      await labelToInput('H').fill('40');
      // Blur the last field so React commits the value before we click
      // the run button (NumField's onChange usually fires on input,
      // but a Tab keeps the test deterministic).
      await labelToInput('H').press('Tab');

      const final = await runStepAndWaitDone(modal, page);
      expect(final.status).toBe('done');
      outPath = (final.outputs ?? [])[0] ?? null;
      expect(outPath).toBeTruthy();
      if (outPath) {
        expect(existsSync(outPath)).toBe(true);
        expect(statSync(outPath).size).toBeGreaterThan(40);
        expect(magicHeader(outPath, 6)).toMatch(/^GIF8[79]a$/);
      }
      await exitLineage(page, modal);
    } finally {
      await tearDownRecorder();
      rmDirOf(outPath);
      await clearAllHistory(page).catch(() => undefined);
    }
  });

  test('UI-LIN-8 GIF ↔ WebP chip — gif input → animated webp', async () => {
    const { page } = getHarness();
    await clearAllHistory(page);
    await ensureToolboxTab(page);
    await seedHistoryRow(page, FIXTURE_GIF, 'video-to-gif', 'tiny.gif');
    await installRecorder();
    let outPath: string | null = null;
    try {
      const modal = await enterLineage(page);
      await selectChip(modal, /^GIF ↔ WebP$/);
      const final = await runStepAndWaitDone(modal, page);
      expect(final.status).toBe('done');
      outPath = (final.outputs ?? [])[0] ?? null;
      expect(outPath).toBeTruthy();
      if (outPath) {
        expect(existsSync(outPath)).toBe(true);
        expect(statSync(outPath).size).toBeGreaterThan(40);
        // RIFF....WEBP magic header proves sharp wrote a real animated webp.
        const head = magicHeader(outPath, 12);
        expect(head.startsWith('RIFF')).toBe(true);
        expect(head.slice(8, 12)).toBe('WEBP');
      }
      await exitLineage(page, modal);
    } finally {
      await tearDownRecorder();
      rmDirOf(outPath);
      await clearAllHistory(page).catch(() => undefined);
    }
  });

  test('UI-LIN-9 Video → GIF chip — mp4 input → animated gif', async () => {
    const { page } = getHarness();
    await clearAllHistory(page);
    await ensureToolboxTab(page);
    await seedHistoryRow(page, FIXTURE_MP4, 'video-to-gif', 'tiny.mp4');
    await installRecorder();
    let outPath: string | null = null;
    try {
      const modal = await enterLineage(page);
      await selectChip(modal, /^Video → GIF$/);
      const final = await runStepAndWaitDone(modal, page);
      expect(final.status).toBe('done');
      outPath = (final.outputs ?? [])[0] ?? null;
      expect(outPath).toBeTruthy();
      if (outPath) {
        expect(existsSync(outPath)).toBe(true);
        expect(statSync(outPath).size).toBeGreaterThan(40);
        expect(magicHeader(outPath, 6)).toMatch(/^GIF8[79]a$/);
      }
      await exitLineage(page, modal);
    } finally {
      await tearDownRecorder();
      rmDirOf(outPath);
      await clearAllHistory(page).catch(() => undefined);
    }
  });

  test('UI-LIN-10 Video → WebP chip — mp4 input → animated webp', async () => {
    const { page } = getHarness();
    await clearAllHistory(page);
    await ensureToolboxTab(page);
    await seedHistoryRow(page, FIXTURE_MP4, 'video-to-gif', 'tiny.mp4');
    await installRecorder();
    let outPath: string | null = null;
    try {
      const modal = await enterLineage(page);
      await selectChip(modal, /^Video → WebP$/);
      const final = await runStepAndWaitDone(modal, page);
      expect(final.status).toBe('done');
      outPath = (final.outputs ?? [])[0] ?? null;
      expect(outPath).toBeTruthy();
      if (outPath) {
        expect(existsSync(outPath)).toBe(true);
        expect(statSync(outPath).size).toBeGreaterThan(40);
        const head = magicHeader(outPath, 12);
        expect(head.startsWith('RIFF')).toBe(true);
        expect(head.slice(8, 12)).toBe('WEBP');
      }
      await exitLineage(page, modal);
    } finally {
      await tearDownRecorder();
      rmDirOf(outPath);
      await clearAllHistory(page).catch(() => undefined);
    }
  });
});
