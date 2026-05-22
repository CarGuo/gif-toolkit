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
 * SUITE TB-CHAIN-E — UI-driven progressive lineage (R-TB-CHAIN-V2).
 *
 * What this proves end-to-end against the packaged Electron app
 * --------------------------------------------------------------
 * 1. The user navigates to the 工具箱 tab via a real DOM click.
 * 2. We seed ONE 'done' row into `db.toolboxHistory` whose `outputs[0]`
 *    points at the real tests/fixtures/tiny.gif. That mimics "user
 *    just finished a video-to-gif batch" without spending 10s actually
 *    running ffmpeg twice — that path is already covered by SUITE E.
 *    The crucial assertion is that the V2.2 lineage UI takes a real
 *    artifact and chains a real follow-up step on it.
 * 3. Click the row's 「继续处理 →」 button → assert the lineage section
 *    mounts (面包屑 visible, batch 开始 button gone).
 * 4. Verify the chip filter (extension-aware): .gif focus must show
 *    GIF Resize and must NOT show Video → GIF.
 * 5. Click GIF Resize → click 「继续 →」 → wait for the chain runner's
 *    terminal `done` emit (single-step chain, totalSteps=1).
 * 6. Assert: the new tail-node path exists on disk + non-empty .gif.
 *    Breadcrumb DOM now shows TWO `.tb-lineage-crumb` entries with
 *    `is-focus` on the second one.
 * 7. Click the first crumb → focus walks back to root.
 * 8. Click 「退出链路」 → lineage section unmounts, batch UI returns.
 *
 * This SUITE deliberately does NOT call `window.giftk.startToolboxChain`
 * directly; every transition is triggered by a DOM event, exactly as a
 * human user would. The only test-only escape hatch is the history
 * seed — a single IPC call that mirrors what the real batch flow would
 * have written anyway.
 */
test('SUITE TB-CHAIN-E — UI lineage: history → 继续处理 → GIF Resize → 2-node breadcrumb', async () => {
  const { page } = getHarness();
  test.setTimeout(120_000);

  // Reset clean — both legacy chain history (TB-CHAIN A-D wrote rows)
  // and tb history (any earlier suite may have left rows behind).
  await clearChainHistory().catch(() => undefined);
  await page.evaluate(async () => {
    const w = window as unknown as {
      giftk: { db: { toolboxHistory: { clear(): Promise<void> } } };
    };
    await w.giftk.db.toolboxHistory.clear();
  });

  // Switch to the 工具箱 view — the panel mounts only when this tab is
  // active, so every subsequent locator query depends on this click.
  const toolboxTab = page.locator('button.tab-btn', { hasText: '工具箱' });
  await expect(toolboxTab).toBeVisible({ timeout: 10_000 });
  await toolboxTab.click();
  await expect(toolboxTab).toHaveAttribute('aria-pressed', 'true');

  // Seed history with one row whose primary output IS the real
  // tiny.gif fixture. The subsequent chain step (GIF Resize) will
  // read it via ffmpeg, so this must be a path that actually exists.
  const seedId = `tbchain-e-seed-${Date.now()}`;
  const finishedAt = Date.now();
  await page.evaluate(
    async (args: { id: string; output: string; finishedAt: number }) => {
      const w = window as unknown as {
        giftk: { db: { toolboxHistory: { upsert(entry: unknown): Promise<void> } } };
      };
      await w.giftk.db.toolboxHistory.upsert({
        id: args.id,
        kind: 'video-to-gif',
        inputPath: '/synthetic/source.mp4',
        displayName: 'source.mp4',
        outputs: [args.output],
        params: { fps: 10, maxWidth: 200 },
        status: 'done',
        finishedAt: args.finishedAt
      });
    },
    { id: seedId, output: FIXTURE_GIF, finishedAt }
  );

  // The panel reads db.toolboxHistory on mount, so we have to nudge a
  // re-read by bouncing tabs. Issue R8a — instead of a fixed sleep,
  // poll until the seeded row is actually present in the DB before
  // re-mounting the panel; this kills CI flake on slow IO.
  await page.locator('button.tab-btn', { hasText: '主页' }).click().catch(() => undefined);
  await expect.poll(
    async () => {
      const rows = (await page.evaluate(async () => {
        const w = window as unknown as {
          giftk: { db: { toolboxHistory: { readAll(): Promise<unknown[]> } } };
        };
        return await w.giftk.db.toolboxHistory.readAll();
      })) as Array<{ id: string }>;
      return rows.some((r) => r.id === seedId);
    },
    { timeout: 10_000, intervals: [50, 100, 200] }
  ).toBe(true);
  await toolboxTab.click();

  // The seeded row should now be visible.
  const continueBtn = page.locator('button.tb-history-continue').first();
  await expect(continueBtn).toBeVisible({ timeout: 10_000 });
  await expect(continueBtn).toHaveText(/继续处理/);

  await installRecorder();
  let lineageOutputPath: string | null = null;
  try {
    // === Step 1 — enter lineage from history ============================
    await continueBtn.click();
    const lineageSection = page.locator('section.tb-lineage');
    await expect(lineageSection).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('button', { hasText: '退出链路' })).toBeVisible();
    // Batch mode's 开始 button must be unmounted — proves the ternary
    // really swapped sections (not just stacked them).
    const batchStart = page.locator('footer.tb-footer button.primary', { hasText: '开始' });
    await expect(batchStart).toHaveCount(0);

    // === Step 2 — verify breadcrumb at 1 node + chip filter ============
    let crumbs = lineageSection.locator('.tb-lineage-crumb');
    await expect(crumbs).toHaveCount(1, { timeout: 5_000 });
    const chipBar = lineageSection.locator('.tb-lineage-chips');
    await expect(chipBar).toBeVisible();
    // .gif focus → MUST show GIF Resize, MUST NOT show Video → GIF.
    await expect(chipBar.locator('button[role="tab"]', { hasText: /GIF Resize/ })).toBeVisible();
    await expect(chipBar.locator('button[role="tab"]', { hasText: 'Video → GIF' })).toHaveCount(0);

    // === Step 3 — explicitly select GIF Resize so width is deterministic ===
    const resizeChip = chipBar.locator('button[role="tab"]', { hasText: /^GIF Resize$/ });
    await resizeChip.click();
    await expect(resizeChip).toHaveAttribute('aria-selected', 'true');
    await expect(lineageSection.locator('.tb-lineage-form')).toBeVisible();

    // === Step 4 — fire 「继续 →」 and rendezvous on the terminal emit ===
    const baselineProgress = (await snapshotRecorder()).progress.length;
    const continueStepBtn = lineageSection.locator('button.btn.primary', { hasText: /^继续 →/ });
    await expect(continueStepBtn).toBeEnabled();
    await continueStepBtn.click();

    // Issue R8b — bind to the chainId emitted by THIS step. The hook
    // generates a fresh `tblineage-<ts>-<rand>` per call, and lineage
    // step IDs are exactly `${chainId}-s1`. We discover the chainId
    // from the first post-baseline emit whose taskId matches that
    // prefix, then require terminal-emit matching to come from the
    // SAME chainId. This stops a stale TB-CHAIN-A..D residual single-
    // step emit from being mistaken for our lineage step.
    let boundChainId: string | null = null;
    let final: ChainTerminalProgress | null = null;
    const startWait = Date.now();
    while (Date.now() - startWait < 60_000) {
      const snap = await snapshotRecorder();
      const candidates = snap.progress.slice(baselineProgress);
      if (!boundChainId) {
        for (const p of candidates) {
          const tid = (p as { taskId?: unknown }).taskId;
          if (typeof tid !== 'string') continue;
          const m = /^(tblineage-[a-z0-9-]+)-s1$/i.exec(tid);
          if (m) { boundChainId = m[1]; break; }
        }
      }
      if (boundChainId) {
        const expectedTaskId = `${boundChainId}-s1`;
        const last = [...candidates].reverse().find((p) => {
          const cp = p as unknown as ChainTerminalProgress & { taskId?: string };
          if (cp.taskId !== expectedTaskId) return false;
          if (cp.totalSteps !== 1 || cp.stepIndex !== 1) return false;
          return cp.status === 'done' || cp.status === 'failed' || cp.status === 'cancelled';
        });
        if (last) {
          final = last as unknown as ChainTerminalProgress;
          break;
        }
      }
      await page.waitForTimeout(200);
    }
    if (!boundChainId) throw new Error('SUITE TB-CHAIN-E: no tblineage-* taskId observed within 60s');
    if (!final) throw new Error(`SUITE TB-CHAIN-E: lineage step ${boundChainId} did not emit a terminal status within 60s`);
    expect(final.status).toBe('done');
    const outs = final.outputs ?? [];
    expect(outs.length).toBeGreaterThanOrEqual(1);
    lineageOutputPath = outs[0];
    expect(existsSync(lineageOutputPath)).toBe(true);
    expect(statSync(lineageOutputPath).size).toBeGreaterThan(0);
    expect(/\.gif$/i.test(lineageOutputPath)).toBe(true);

    // === Step 5 — breadcrumb now has 2 nodes, focus on the new tail ===
    // Issue R8d — Playwright's retrying `toHaveCount` already covers the
    // React flush window; no need for a fixed sleep.
    crumbs = lineageSection.locator('.tb-lineage-crumb');
    await expect(crumbs).toHaveCount(2, { timeout: 5_000 });
    await expect(crumbs.nth(1)).toHaveClass(/is-focus/);
    await expect(crumbs.nth(0)).not.toHaveClass(/is-focus/);

    // === Step 6 — click the first crumb → focus walks back ============
    const firstCrumbBtn = crumbs.nth(0).locator('button.tb-lineage-crumb-btn');
    await firstCrumbBtn.click();
    await expect(crumbs.nth(0)).toHaveClass(/is-focus/);
    await expect(crumbs.nth(1)).not.toHaveClass(/is-focus/);

    // === Step 7 — exit chain → batch UI back ==========================
    await page.locator('button', { hasText: '退出链路' }).click();
    await expect(lineageSection).toHaveCount(0);
    await expect(page.locator('footer.tb-footer button.primary', { hasText: '开始' })).toBeVisible();

    // eslint-disable-next-line no-console
    console.log(
      '\n[SUITE TB-CHAIN-E artifact]\n' +
      `  source gif         : ${FIXTURE_GIF}\n` +
      `  resize output      : ${lineageOutputPath}\n` +
      `  output size bytes  : ${statSync(lineageOutputPath).size}\n`
    );
  } finally {
    await tearDownRecorder();
    if (lineageOutputPath) {
      try {
        const dir = path.dirname(lineageOutputPath);
        rmSync(dir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
    await clearChainHistory().catch(() => undefined);
    // Issue R8c — the lineage step writes a real row into toolbox_chain_history
    // via the chain runner's terminal hook. Sibling SUITES (B/C) that assume an
    // empty chain history would be polluted otherwise.
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
    }).catch(() => undefined);
  }
});
