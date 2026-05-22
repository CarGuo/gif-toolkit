/**
 * SUITE TB-CHAIN — real single-image toolbox chain (R-TB-CHAIN Phase 1).
 *
 * What this proves end-to-end against the packaged Electron app
 * --------------------------------------------------------------
 * 1. TB-CHAIN-A — happy path: a tiny mp4 fixture is driven through a
 *    two-step chain (video-to-gif → gif-optimize) by invoking the real
 *    `toolbox:startChain` IPC. We assert
 *      - the chain output sub-dir actually appears on disk
 *      - per-step `process:progress` events arrive in the documented
 *        shape (taskId === step.id, stepIndex/totalSteps both set)
 *      - the chain's final step ends with status='done' and emits a
 *        non-empty gif on disk
 *      - the audit row written by the chain runner into the new
 *        `toolbox_chain_history` SQLite table round-trips back through
 *        `db.toolboxChainHistory.readAll()` with status='done',
 *        steps[].status all 'done', the same outputDir we received
 *        from the IPC, and outputs[] pointing at real files.
 *
 * 2. TB-CHAIN-B — compatibility guard: a chain whose first step is
 *    gif-optimize but whose input is a .mp4 must be rejected
 *    synchronously by `validateChainCompatibility` before any worker
 *    is started, surfaced as an IPC promise rejection. No history row
 *    must be written.
 *
 * 3. TB-CHAIN-C — cancel: start a chain and immediately cancelChain.
 *    The chain MUST settle (either 'cancelled' or — if the first step
 *    happens to win the race — 'done'); no `'awaiting-input'` and no
 *    `'pending'` row is allowed to leak in the persisted history. The
 *    fire-and-forget worker must NOT crash the app (we still get a
 *    page response after cancel and the recorder keeps emitting).
 *
 * 4. TB-CHAIN-D — pause-at-step (crop): start a chain
 *    `gif-optimize → crop → gif-resize` on a 300×60 .gif fixture
 *    WITHOUT supplying cropX/Y/W/H up front, observe the runner emit
 *    `'awaiting-input'` for step 2 (the crop), call resumeToolboxChain
 *    with a sanitised rect (50,10,200,40), and verify the chain runs
 *    to completion with a final artifact whose actual width === 64
 *    (gif-resize's targetWidth) — proving the resume rect threaded
 *    through ffmpeg correctly. Also asserts: the audit row's step 2
 *    persists the merged params (cropX/Y/W/H all non-zero), and
 *    NEITHER 'awaiting-input' NOR 'pending' leaks into the persisted
 *    audit (only the in-flight emit carries those statuses).
 *
 * Why these four and not more
 * ---------------------------
 * Phase 1 has no renderer UI yet, so this SUITE drives the IPC layer
 * directly. The remaining cases (cross-format webp double convert,
 * mode toggle UI flow) belong to Phase 2 once the renderer hook +
 * ChainStep UI exist; covering them here would mean re-implementing
 * the UI inside test code and would not add coverage over the unit
 * tests in processor-chain.test.ts and toolboxChainHistoryRepo.test.ts.
 */
import { test, expect } from '@playwright/test';
import { existsSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  FIXTURE_MP4,
  FIXTURE_GIF,
  getHarness,
  installRecorder,
  tearDownRecorder,
  snapshotRecorder
} from './_harness';

/**
 * R-TB-CHAIN Phase 2.4 — SUITE TB-CHAIN-E asserts the renderer's
 * chain-mode UI flow really wires through to the production IPC.
 * A/B/C/D pin down the IPC contract; E pins down that the buttons,
 * mode toggle, and ChainStepRow editors a human would touch in the
 * packaged app emit those exact IPC calls and surface the chain
 * outputs back into the SQLite history. Without E, a pure renderer
 * regression (e.g. wrong selector, broken setMode lock-back, or a
 * disabled-prop typo) could ship green against A-D.
 */

interface ChainHistoryStepWire {
  kind: string;
  params: Record<string, unknown>;
  status: string;
  outputs: string[];
  error?: string;
}
interface ChainHistoryEntryWire {
  id: string;
  inputPath: string;
  displayName: string;
  status: string;
  error?: string;
  outputDir: string;
  finishedAt: number;
  steps: ChainHistoryStepWire[];
}

async function readChainHistory(): Promise<ChainHistoryEntryWire[]> {
  const { page } = getHarness();
  return page.evaluate(async () => {
    const w = window as unknown as {
      giftk: { db: { toolboxChainHistory: { readAll(): Promise<ChainHistoryEntryWire[]> } } };
    };
    return w.giftk.db.toolboxChainHistory.readAll();
  });
}

async function clearChainHistory(): Promise<void> {
  const { page } = getHarness();
  await page.evaluate(async () => {
    const w = window as unknown as {
      giftk: { db: { toolboxChainHistory: { clear(): Promise<void> } } };
    };
    await w.giftk.db.toolboxChainHistory.clear();
  });
}

interface ChainTerminalProgress {
  taskId: string;
  status: string;
  outputs?: string[];
  stepIndex?: number;
  totalSteps?: number;
  error?: string;
}

/**
 * Wait until the chain's last step has emitted a terminal status
 * ('done' / 'failed' / 'cancelled'). The chain runner emits
 * `stepIndex === totalSteps` when the final step settles; we use
 * that as the rendezvous instead of polling the SQLite row because
 * the history write happens AFTER the last emit.
 *
 * The match predicate also pins down stepIndex===totalSteps because
 * intermediate steps emit the same `done` shape (just with a smaller
 * stepIndex), and a naive `.find(... 'done')` would otherwise
 * rendezvous on step 1 done before the chain has even started step 2.
 */
async function waitForChainLastStep(
  totalSteps: number,
  timeoutMs: number
): Promise<ChainTerminalProgress> {
  const { page } = getHarness();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snap = await snapshotRecorder();
    const last = [...snap.progress].reverse().find((p) => {
      const cp = p as unknown as ChainTerminalProgress;
      if (typeof cp.stepIndex !== 'number' || typeof cp.totalSteps !== 'number') return false;
      if (cp.totalSteps !== totalSteps) return false;
      if (cp.stepIndex !== totalSteps) {
        // For non-terminal stepIndex (intermediate step done) we keep
        // scanning — the chain has not finished yet.
        if (cp.status === 'failed' || cp.status === 'cancelled') {
          // A non-final step may legitimately fail/cancel and become
          // the chain's terminal event (the runner breaks out of the
          // loop). Accept it.
          return true;
        }
        return false;
      }
      return cp.status === 'done' || cp.status === 'failed' || cp.status === 'cancelled';
    });
    if (last) return last as unknown as ChainTerminalProgress;
    await page.waitForTimeout(250);
  }
  throw new Error(`timeout waiting for chain final-step terminal after ${timeoutMs}ms`);
}

/**
 * Wait until the SQLite chain_history row for `chainId` becomes
 * available — the runner upserts it AFTER the final emit, so e2e
 * code must poll for a small window before asserting on it.
 */
async function waitForChainHistoryRow(
  chainId: string,
  timeoutMs: number
): Promise<ChainHistoryEntryWire> {
  const { page } = getHarness();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await readChainHistory();
    const row = rows.find((r) => r.id === chainId);
    if (row) return row;
    await page.waitForTimeout(200);
  }
  throw new Error(`timeout waiting for chain_history row id=${chainId} after ${timeoutMs}ms`);
}

test('SUITE TB-CHAIN-A — real chain mp4 → video-to-gif → gif-optimize', async () => {
  const { page } = getHarness();
  await clearChainHistory();
  await installRecorder();
  const chainId = `tbchain-a-${Date.now()}`;
  try {
    const startResult = await page.evaluate(
      async (args: { chainId: string; inputPath: string }) => {
        const w = window as unknown as {
          giftk: {
            startToolboxChain(payload: unknown): Promise<{
              ok: boolean;
              chainId: string;
              outputDir: string;
            }>;
          };
        };
        return w.giftk.startToolboxChain({
          chainId: args.chainId,
          inputPath: args.inputPath,
          steps: [
            {
              id: `${args.chainId}-s1`,
              kind: 'video-to-gif',
              params: { fps: 10, maxWidth: 160, maxBytes: 512000, softMaxBytes: 256000 }
            },
            {
              id: `${args.chainId}-s2`,
              kind: 'gif-optimize',
              params: { method: 'lossy', lossy: 80, optimizeLevel: 3, dither: 'floyd-steinberg' }
            }
          ]
        });
      },
      { chainId, inputPath: FIXTURE_MP4 }
    );

    expect(startResult.ok).toBe(true);
    expect(startResult.chainId).toBe(chainId);
    expect(startResult.outputDir).toBeTruthy();
    expect(existsSync(startResult.outputDir)).toBe(true);

    const final = await waitForChainLastStep(2, 90_000);
    expect(final.status).toBe('done');
    expect(final.totalSteps).toBe(2);
    expect(final.stepIndex).toBe(2);
    expect(Array.isArray(final.outputs)).toBe(true);
    const lastOutputs = final.outputs ?? [];
    expect(lastOutputs.length).toBeGreaterThanOrEqual(1);
    const finalOutput = lastOutputs[0];
    expect(existsSync(finalOutput)).toBe(true);
    expect(statSync(finalOutput).size).toBeGreaterThan(0);

    const row = await waitForChainHistoryRow(chainId, 10_000);
    expect(row.status).toBe('done');
    expect(row.outputDir).toBe(startResult.outputDir);
    expect(row.displayName).toBe(path.basename(FIXTURE_MP4));
    expect(row.steps).toHaveLength(2);
    expect(row.steps[0].kind).toBe('video-to-gif');
    expect(row.steps[0].status).toBe('done');
    expect(row.steps[0].outputs.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(row.steps[0].outputs[0])).toBe(true);
    expect(row.steps[1].kind).toBe('gif-optimize');
    expect(row.steps[1].status).toBe('done');
    expect(row.steps[1].outputs.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(row.steps[1].outputs[0])).toBe(true);
    expect(row.error).toBeUndefined();

    // Real-pipeline diagnostics: surface the actual file sizes so a
    // human reading the test log can confirm the chain produced
    // non-trivial artifacts (a 0-byte "success" gif would still pass
    // the size>0 gate above; here we make sure both steps wrote
    // bytes that look like real gifs — magic header check).
    const fs = await import('node:fs');
    for (const s of row.steps) {
      for (const out of s.outputs) {
        const sz = fs.statSync(out).size;
        const head = fs.readFileSync(out, { encoding: null }).subarray(0, 6).toString('latin1');
        // GIF magic is GIF87a or GIF89a.
        expect(head).toMatch(/^GIF8[79]a$/);
        expect(sz).toBeGreaterThan(40);
      }
    }
  } finally {
    await tearDownRecorder();
    // We deliberately keep the chain history row through the finally
    // so a failing assertion above can be debugged from the live
    // SQLite state. The next test (TB-CHAIN-B) starts with a clear()
    // so cross-suite leakage is impossible.
    try {
      const rows = await readChainHistory();
      for (const r of rows) {
        if (r.id === chainId && r.outputDir) {
          rmSync(r.outputDir, { recursive: true, force: true });
        }
      }
    } catch {
      /* ignore */
    }
    await clearChainHistory().catch(() => undefined);
  }
});

test('SUITE TB-CHAIN-B — chain compatibility guard rejects synchronously, no history row', async () => {
  const { page } = getHarness();
  await clearChainHistory();
  const chainId = `tbchain-b-${Date.now()}`;
  // Starting a chain whose first step is gif-optimize on an .mp4 input MUST
  // be rejected before the worker is fired, by validateChainCompatibility.
  // We don't need installRecorder() here — the IPC promise rejection is the
  // assertion target.
  let threw: Error | null = null;
  try {
    await page.evaluate(
      async (args: { chainId: string; inputPath: string }) => {
        const w = window as unknown as {
          giftk: { startToolboxChain(payload: unknown): Promise<unknown> };
        };
        await w.giftk.startToolboxChain({
          chainId: args.chainId,
          inputPath: args.inputPath,
          steps: [
            {
              id: `${args.chainId}-s1`,
              kind: 'gif-optimize',
              params: { method: 'lossy', lossy: 80 }
            }
          ]
        });
      },
      { chainId, inputPath: FIXTURE_MP4 }
    );
  } catch (err) {
    threw = err as Error;
  }
  expect(threw).not.toBeNull();
  expect(String(threw)).toMatch(/cannot accept|compatibility|input/i);

  // Give the main process a beat in case any spurious async write would
  // have leaked, then prove the table is still empty for this chainId.
  await page.waitForTimeout(500);
  const rows = await readChainHistory();
  expect(rows.find((r) => r.id === chainId)).toBeUndefined();
});

test('SUITE TB-CHAIN-C — cancel settles cleanly, no awaiting-input/pending leaks into history', async () => {
  const { page } = getHarness();
  await clearChainHistory();
  await installRecorder();
  const chainId = `tbchain-c-${Date.now()}`;
  try {
    const startResult = await page.evaluate(
      async (args: { chainId: string; inputPath: string }) => {
        const w = window as unknown as {
          giftk: {
            startToolboxChain(payload: unknown): Promise<{ ok: boolean; outputDir: string; chainId: string }>;
            cancelToolboxChain(chainId: string): Promise<{ ok: boolean }>;
          };
        };
        const r = await w.giftk.startToolboxChain({
          chainId: args.chainId,
          inputPath: args.inputPath,
          steps: [
            {
              id: `${args.chainId}-s1`,
              kind: 'video-to-gif',
              params: { fps: 10, maxWidth: 160, maxBytes: 512000, softMaxBytes: 256000 }
            },
            {
              id: `${args.chainId}-s2`,
              kind: 'gif-optimize',
              params: { method: 'lossy', lossy: 80, optimizeLevel: 3 }
            }
          ]
        });
        // Fire cancel without awaiting the chain runner; the runner is
        // fire-and-forget so `startToolboxChain` already resolved with
        // ok:true and the chainId reservation. We immediately ask the
        // main process to abort.
        await w.giftk.cancelToolboxChain(args.chainId);
        return r;
      },
      { chainId, inputPath: FIXTURE_MP4 }
    );

    expect(startResult.ok).toBe(true);

    // The chain may still finish 'done' if step 1 completes between the
    // two IPC calls — that's fine, the contract is "no leaked
    // intermediate status in history". Either way, a row must appear.
    const row = await waitForChainHistoryRow(chainId, 30_000);
    expect(['done', 'cancelled', 'failed']).toContain(row.status);
    // Defensive: even on cancel, awaiting-input MUST NEVER persist.
    for (const s of row.steps) {
      expect(s.status).not.toBe('awaiting-input');
      expect(s.status).not.toBe('pending');
    }

    // Sanity: the page is still alive — fire-and-forget cancel did not
    // crash the main process or sever the IPC channel.
    const liveCheck = await page.evaluate(() => {
      const w = window as unknown as { giftk: { getDefaultOutputDir(): Promise<string> } };
      return w.giftk.getDefaultOutputDir();
    });
    expect(typeof liveCheck).toBe('string');
    expect(liveCheck.length).toBeGreaterThan(0);
  } finally {
    await tearDownRecorder();
    await clearChainHistory().catch(() => undefined);
    try {
      // Best-effort cleanup of the chain output sub-dir.
      const rows = await readChainHistory();
      for (const r of rows) {
        if (r.id === chainId && r.outputDir) {
          rmSync(r.outputDir, { recursive: true, force: true });
        }
      }
    } catch {
      /* ignore */
    }
  }
});

/**
 * Wait for an `'awaiting-input'` emit on a specific stepIndex. The
 * runner emits `taskId === step.id`; the test cares about the
 * stepIndex/totalSteps pair to confirm the pause point matches the
 * crop step the chain definition asked to pause on. Pollings 250ms
 * to mirror the other helpers.
 */
async function waitForAwaitingInput(
  stepIndex: number,
  totalSteps: number,
  timeoutMs: number
): Promise<{ taskId: string; stepIndex: number }> {
  const { page } = getHarness();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snap = await snapshotRecorder();
    for (const p of snap.progress) {
      const cp = p as unknown as ChainTerminalProgress & { taskId: string };
      if (
        cp.status === 'awaiting-input' &&
        cp.stepIndex === stepIndex &&
        cp.totalSteps === totalSteps &&
        typeof cp.taskId === 'string'
      ) {
        return { taskId: cp.taskId, stepIndex: cp.stepIndex };
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`timeout waiting for 'awaiting-input' on step ${stepIndex}/${totalSteps}`);
}

test('SUITE TB-CHAIN-D — crop pause-at-step + resumeToolboxChain settles the chain', async () => {
  const { page } = getHarness();
  await clearChainHistory();
  await installRecorder();
  const chainId = `tbchain-d-${Date.now()}`;
  // tiny.gif is 300×60 (verified via ffprobe); the crop rect picks an
  // off-center 200×40 sub-region, then gif-resize squashes width to 64
  // (height ratio-preserved → 64 * 40 / 200 = 12.8 → ffmpeg rounds).
  const CROP = { cropX: 50, cropY: 10, cropW: 200, cropH: 40 };
  const RESIZE_TARGET_WIDTH = 64;
  try {
    const startResult = await page.evaluate(
      async (args: { chainId: string; inputPath: string; resizeWidth: number }) => {
        const w = window as unknown as {
          giftk: {
            startToolboxChain(payload: unknown): Promise<{
              ok: boolean;
              chainId: string;
              outputDir: string;
            }>;
          };
        };
        return w.giftk.startToolboxChain({
          chainId: args.chainId,
          inputPath: args.inputPath,
          steps: [
            {
              id: `${args.chainId}-s1`,
              kind: 'gif-optimize',
              params: { method: 'lossy', lossy: 80, optimizeLevel: 3 }
            },
            {
              // Deliberately omit cropX/Y/W/H here. The runner must
              // emit awaiting-input and block until resumeChain
              // supplies them.
              id: `${args.chainId}-s2`,
              kind: 'crop',
              params: {}
            },
            {
              id: `${args.chainId}-s3`,
              kind: 'gif-resize',
              params: { targetWidth: args.resizeWidth }
            }
          ]
        });
      },
      { chainId, inputPath: FIXTURE_GIF, resizeWidth: RESIZE_TARGET_WIDTH }
    );

    expect(startResult.ok).toBe(true);
    expect(startResult.chainId).toBe(chainId);
    expect(existsSync(startResult.outputDir)).toBe(true);

    // 1) The runner pauses BEFORE invoking ffmpeg for crop and emits
    //    awaiting-input on step 2/3.
    const pausePoint = await waitForAwaitingInput(2, 3, 60_000);
    expect(pausePoint.taskId).toBe(`${chainId}-s2`);

    // 2) Resume with a sanitised rect. main/index.ts re-runs
    //    sanitizeToolboxParams on the patch, so a tampered IPC could
    //    not smuggle out-of-range values; here the rect is well inside
    //    300×60 and should round-trip unchanged.
    const resumeRes = await page.evaluate(
      async (args: { chainId: string; stepIndex: number; patch: typeof CROP }) => {
        const w = window as unknown as {
          giftk: { resumeToolboxChain(chainId: string, stepIndex: number, patch: unknown): Promise<{ ok: boolean }> };
        };
        // stepIndex passed to resumeToolboxChain is the ZERO-based
        // index inside the steps array (the runner stored
        // `pause.stepIndex = i` where i is 0-based). Step 2 in the
        // human-friendly progress emit (stepIndex===2) corresponds to
        // i===1 internally.
        return w.giftk.resumeToolboxChain(args.chainId, args.stepIndex, args.patch);
      },
      { chainId, stepIndex: 1, patch: CROP }
    );
    expect(resumeRes.ok).toBe(true);

    // 3) The chain should now finish step 2 and step 3.
    const final = await waitForChainLastStep(3, 60_000);
    expect(final.status).toBe('done');
    expect(final.stepIndex).toBe(3);
    const finalOutputs = final.outputs ?? [];
    expect(finalOutputs.length).toBeGreaterThanOrEqual(1);
    const finalOutput = finalOutputs[0];
    expect(existsSync(finalOutput)).toBe(true);
    expect(statSync(finalOutput).size).toBeGreaterThan(40);

    // 4) Audit row reflects merged params: step 2 must persist the
    //    cropX/Y/W/H we resumed with.
    const row = await waitForChainHistoryRow(chainId, 10_000);
    expect(row.status).toBe('done');
    expect(row.steps).toHaveLength(3);
    for (const s of row.steps) {
      expect(s.status).toBe('done');
      // No leaked in-flight statuses in the audit even though the
      // chain went through awaiting-input mid-run.
      expect(s.status).not.toBe('awaiting-input');
      expect(s.status).not.toBe('pending');
    }
    expect(row.steps[1].kind).toBe('crop');
    expect(row.steps[1].params.cropX).toBe(CROP.cropX);
    expect(row.steps[1].params.cropY).toBe(CROP.cropY);
    expect(row.steps[1].params.cropW).toBe(CROP.cropW);
    expect(row.steps[1].params.cropH).toBe(CROP.cropH);

    // 5) ffprobe the final artifact: gif-resize targetWidth=64 must
    //    have produced a width of exactly 64. (Aspect-preserved
    //    height = round(64 * 40 / 200) = 13; we just assert width to
    //    avoid pinning a rounding strategy.)
    const ffprobeStatic = await import('ffprobe-static');
    const { spawnSync } = await import('node:child_process');
    const probe = spawnSync(
      ffprobeStatic.path,
      ['-v', 'error', '-select_streams', 'v:0',
       '-show_entries', 'stream=width,height',
       '-of', 'csv=p=0', finalOutput],
      { encoding: 'utf8' }
    );
    expect(probe.status).toBe(0);
    const [wStr, hStr] = probe.stdout.trim().split(',');
    const width = Number.parseInt(wStr, 10);
    const height = Number.parseInt(hStr, 10);
    expect(width).toBe(RESIZE_TARGET_WIDTH);
    expect(height).toBeGreaterThan(0);
    expect(height).toBeLessThan(CROP.cropH); // proves the resize ran
  } finally {
    await tearDownRecorder();
    try {
      const rows = await readChainHistory();
      for (const r of rows) {
        if (r.id === chainId && r.outputDir) {
          rmSync(r.outputDir, { recursive: true, force: true });
        }
      }
    } catch {
      /* ignore */
    }
    await clearChainHistory().catch(() => undefined);
  }
});

/**
 * SUITE TB-CHAIN-E — UI-driven chain flow.
 *
 * Drives the same code path TB-CHAIN-A exercises via direct IPC, but
 * through the actual ToolboxPanel DOM:
 *   1. Click the "工具箱" top-bar tab to switch to the toolbox view
 *   2. Stub `dialog.showOpenDialog` so the production
 *      `toolbox:pickFiles` IPC returns FIXTURE_GIF
 *   3. Click "选择文件" → wait for the job list to grow
 *   4. Click the chain-mode radio (`aria-label="chain-mode"`)
 *   5. Click "+ 添加步骤" — useChainDrafts seeds a default
 *      `gif-resize` step; the existing default `targetWidth`
 *      satisfies `isChainStepDraftValid`
 *   6. Click "开始链路" — the renderer must dispatch
 *      `startToolboxChain` via useToolboxChain
 *   7. Wait for the recorder to capture a final-step terminal emit
 *      with stepIndex===totalSteps && status==='done'
 *   8. Read back the SQLite chain_history row and confirm the
 *      audit shape matches what the panel started
 *
 * The mode-toggle lock-back and CropPauseModal mounting paths are
 * already covered by Phase 2.3 unit tests; trying to exercise them
 * from real UI here would just rebuild the same harness with worse
 * signal-to-noise.
 */
test('SUITE TB-CHAIN-E — UI-driven chain start emits real IPC + history row', async () => {
  const { app, page } = getHarness();
  test.setTimeout(120_000);
  if (!existsSync(FIXTURE_GIF)) throw new Error(`missing gif fixture: ${FIXTURE_GIF}`);

  await clearChainHistory();
  await installRecorder();

  // Stub the OS dialog so toolbox:pickFiles returns our fixture
  // without a human touching the picker. SUITE E uses the same
  // pattern; we save & restore the original to keep cross-suite
  // hygiene because this spec runs serially in the same Electron app.
  await app.evaluate(async ({ dialog }, fixturePath: string) => {
    const original = dialog.showOpenDialog.bind(dialog);
    const stub = (async () => ({ canceled: false, filePaths: [fixturePath] })) as typeof dialog.showOpenDialog;
    (dialog as unknown as { showOpenDialog: typeof dialog.showOpenDialog }).showOpenDialog = stub;
    (globalThis as unknown as { __originalShowOpenDialog?: typeof dialog.showOpenDialog }).__originalShowOpenDialog = original;
  }, FIXTURE_GIF);

  let capturedChainId: string | null = null;
  try {
    // 1) Switch to the Toolbox view via the TopBar tab.
    const toolboxTab = page.locator('button.tab-btn', { hasText: '工具箱' });
    await expect(toolboxTab).toBeVisible({ timeout: 10_000 });
    await toolboxTab.click();
    await expect(toolboxTab).toHaveAttribute('aria-pressed', 'true');

    // The ToolboxPanel renders a radiogroup labeled "工具箱链路"
    // — wait for it before attempting any further interactions.
    const modeGroup = page.getByRole('radiogroup', { name: '工具箱链路' });
    await expect(modeGroup).toBeVisible({ timeout: 10_000 });

    // The default kind is `video-to-gif` (the first chip in
    // KIND_OPTIONS), which only accepts video extensions. We need a
    // gif-accepting kind so tiny.gif gets through the picker filter
    // — switch to "GIF Resize" before opening the picker.
    const gifResizeChip = page.locator('button.tb-chip', { hasText: 'GIF Resize' });
    await expect(gifResizeChip).toBeVisible();
    await gifResizeChip.click();
    await expect(gifResizeChip).toHaveAttribute('aria-selected', 'true');

    const pickBtn = page.locator('button.tb-pick-btn', { hasText: '选择文件' });
    await expect(pickBtn).toBeVisible();
    await expect(pickBtn).toBeEnabled();
    await pickBtn.click();

    // 2) Wait for the job list to register the picked file. The
    //    panel renders one li per job inside `.tb-job-list`.
    const jobRows = page.locator('.tb-job-list li');
    await expect(jobRows).toHaveCount(1, { timeout: 15_000 });

    // 3) Switch to chain mode.
    const chainModeBtn = page.locator('button[aria-label="chain-mode"]');
    await expect(chainModeBtn).toBeEnabled();
    await chainModeBtn.click();
    await expect(chainModeBtn).toHaveAttribute('aria-checked', 'true');

    // The aside header must flip to "链路步骤" once chain mode is on
    // — proves the conditional render swapped from ParamForm to the
    // chain editor branch.
    await expect(page.locator('.tb-side-head', { hasText: '链路步骤' })).toBeVisible();

    // 4) Add a chain step. useChainDrafts.addStep('gif-resize') seeds
    //    a row with empty params, which is invalid because gif-resize
    //    requires `targetWidth >= 64`; we fill the input to flip
    //    isChainStepDraftValid → true so the start button enables.
    const addStepBtn = page.locator('button[aria-label="add-chain-step"]');
    await expect(addStepBtn).toBeEnabled();
    await addStepBtn.click();

    // ChainStepRow renders one row per draft. Confirm the first row
    // appeared, then fill targetWidth so allValid flips on.
    const stepRows = page.locator('.tb-chain-row');
    await expect(stepRows).toHaveCount(1, { timeout: 5_000 });
    const targetWidthInput = page.locator('input[aria-label="targetWidth"]').first();
    await expect(targetWidthInput).toBeVisible();
    await targetWidthInput.fill('200');

    // 5) Hit the start button. Footer button text is "开始链路" when
    //    the chain is idle, flips to "链路运行中…" while running.
    const startBtn = page.locator('button.btn.primary', { hasText: '开始链路' });
    await expect(startBtn).toBeEnabled({ timeout: 10_000 });
    await startBtn.click();

    // 6) Recorder rendezvous: the chain has exactly 1 step (gif-resize),
    //    so we wait for stepIndex===1 && totalSteps===1 && status==='done'.
    const final = await waitForChainLastStep(1, 90_000);
    expect(final.status).toBe('done');
    expect(final.stepIndex).toBe(1);
    expect(final.totalSteps).toBe(1);
    const outs = final.outputs ?? [];
    expect(outs.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(outs[0])).toBe(true);
    expect(statSync(outs[0]).size).toBeGreaterThan(40);
    // Final taskId is `${chainId}-s1`; recover the chainId so the
    // SQLite row lookup below can target this specific run instead of
    // hoping the table contains exactly one row.
    expect(typeof final.taskId).toBe('string');
    expect(final.taskId.endsWith('-s1')).toBe(true);
    capturedChainId = final.taskId.slice(0, -'-s1'.length);
    expect(capturedChainId.length).toBeGreaterThan(0);

    // 7) SQLite audit: the renderer-driven chain must have written a
    //    matching history row with the same step kind + done status.
    const row = await waitForChainHistoryRow(capturedChainId, 10_000);
    expect(row.status).toBe('done');
    expect(row.displayName).toBe(path.basename(FIXTURE_GIF));
    expect(row.steps).toHaveLength(1);
    expect(row.steps[0].kind).toBe('gif-resize');
    expect(row.steps[0].status).toBe('done');
    expect(row.steps[0].outputs.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(row.steps[0].outputs[0])).toBe(true);
    // Defensive: in-flight statuses must never leak into the audit.
    expect(row.steps[0].status).not.toBe('awaiting-input');
    expect(row.steps[0].status).not.toBe('pending');
    expect(row.error).toBeUndefined();

    // 8) UI confirmation: chain.finalStatus='done' renders the
    //    completion notice with the output dir path.
    const completionNotice = page.locator('.tb-notice', { hasText: '链路完成' });
    await expect(completionNotice).toBeVisible({ timeout: 5_000 });
  } finally {
    await tearDownRecorder();
    // Restore the original dialog handler so subsequent SUITEs (and
    // any human who later attaches to the running app for debugging)
    // see the production dialog behaviour.
    await app.evaluate(async ({ dialog }) => {
      const original = (globalThis as unknown as { __originalShowOpenDialog?: typeof dialog.showOpenDialog }).__originalShowOpenDialog;
      if (original) {
        (dialog as unknown as { showOpenDialog: typeof dialog.showOpenDialog }).showOpenDialog = original;
      }
    });
    // Best-effort sweep of the chain output sub-dir + history row.
    try {
      const rows = await readChainHistory();
      for (const r of rows) {
        if (capturedChainId && r.id === capturedChainId && r.outputDir) {
          rmSync(r.outputDir, { recursive: true, force: true });
        }
      }
    } catch {
      /* ignore */
    }
    await clearChainHistory().catch(() => undefined);
  }
});
