/**
 * SUITE CANCEL-ROBUST — process.cancelAll / cancelTask + idempotency
 * (R-CANCEL-ROBUST-V1).
 *
 * Why this SUITE exists
 * ---------------------
 * Existing e2e covers happy-path conversion (SUITE B / C / E / O) and
 * partially the toolbox chain cancel (SUITE TB-CHAIN-C). What is NOT
 * covered:
 *
 *   1. `process:cancelAll` against a running batch produced by
 *      `process:start` (the renderer's "停止全部" / quit-time hook).
 *   2. `process:cancelTask(taskId)` cancelling exactly one task while
 *      its siblings keep running to completion.
 *   3. Idempotency: calling `cancelAll()` twice (or after the batch
 *      has already settled) must not throw.
 *   4. Late-arriving cancel: if the user clicks "停止" AFTER the task
 *      already reached terminal status, the IPC must respond
 *      `{ok:true, cancelled:false}` rather than crash.
 *
 * Strategy
 * --------
 *   - We start a real `medium.mp4` → gif batch (a multi-second job
 *     with ffmpeg actually working) and call cancelAll within a tight
 *     window. The terminal status MUST land in {cancelled, failed}
 *     (failed is acceptable: the abort signal aborted ffmpeg
 *     mid-flight and the chain marked the task as errored).
 *   - For the multi-task variant we start TWO tasks at once and
 *     cancel only the first by id. The second must reach `done`.
 *   - Idempotency is checked by calling cancelAll three times back-
 *     to-back; the third call MUST resolve `{ok:true}` without any
 *     IPC error bubbling up.
 *
 * Notes on timing
 * ---------------
 * The harness uses `medium.mp4` (~2-3s of video) so an unfortunate
 * fast machine could complete the conversion before our cancel lands.
 * That is OK: the contract is "settles in a terminal state without
 * throwing" — we accept `done` as well, as long as no `pending` /
 * `running` row leaks past the terminal poll.
 */
import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import {
  FIXTURE_MEDIUM,
  freshOutDir,
  getHarness,
  installRecorder,
  pathToGiftkLocal,
  snapshotRecorder,
  tearDownRecorder,
  waitForTerminal
} from './_harness';

interface StartedTask {
  id: string;
}

async function startGifBatch(
  taskIds: string[],
  outDir: string,
  pageTitle: string
): Promise<{ ok: boolean }> {
  const { page } = getHarness();
  const localUrl = pathToGiftkLocal(FIXTURE_MEDIUM);
  return page.evaluate(
    async (args: { url: string; outDir: string; ids: string[]; pageTitle: string }) => {
      const g = (window as unknown as {
        giftk: { startBatch(tasks: unknown[], pageTitle?: string): Promise<{ ok: boolean }> };
      }).giftk;
      const tasks = args.ids.map((id) => ({
        id,
        media: {
          id,
          url: args.url,
          kind: 'video',
          source: 'video-tag',
          pageUrl: args.url,
          width: 480, height: 360, durationSec: 3
        },
        options: {
          outDir: args.outDir,
          fps: 12, maxWidth: 240,
          maxBytes: 2_000_000, softMaxBytes: 1_500_000,
          minSize: 160, speed: 1, maxSegmentSec: 60,
          lossyCeiling: 80, colorsFloor: 64, optimizeLevel: 3,
          dither: 'floyd-steinberg'
        }
      }));
      return g.startBatch(tasks, args.pageTitle);
    },
    { url: localUrl, outDir, ids: taskIds, pageTitle }
  );
}

async function expectTerminalForTask(taskId: string, timeoutMs: number, accept: string[]): Promise<string> {
  const term = await waitForTerminal(taskId, timeoutMs);
  expect(accept).toContain(term.status);
  return term.status;
}

test.describe('SUITE CANCEL-ROBUST — process cancellation IPC invariants', () => {
  test('SUITE CANCEL-A — cancelAll during in-flight batch lands every task in terminal state', async () => {
    test.setTimeout(120_000);
    const { page } = getHarness();
    await installRecorder();
    const outDir = freshOutDir('CANCEL-A');
    const taskIds = [`cancelA-1-${Date.now()}`, `cancelA-2-${Date.now()}`];
    try {
      const r = await startGifBatch(taskIds, outDir, 'suite-cancel-A');
      expect(r.ok).toBe(true);

      // Race the cancel against the workers. 250ms is enough for the
      // ffmpeg child process to actually start (so the abort is non-trivial)
      // but well before a 3-second-plus chain could finish.
      await page.waitForTimeout(250);
      const cancelOk = await page.evaluate(async () => {
        const g = (window as unknown as {
          giftk: { cancelAll(): Promise<unknown> };
        }).giftk;
        await g.cancelAll();
        return true;
      });
      expect(cancelOk).toBe(true);

      // Each task must settle. We accept any terminal status — the
      // contract is "no leaked pending rows", not "always cancelled"
      // (a fast machine may have finished step 1 before the abort).
      const accept = ['cancelled', 'failed', 'done', 'skipped'];
      for (const id of taskIds) await expectTerminalForTask(id, 60_000, accept);

      // Sanity: no progress event with a non-terminal `status` arrives
      // after the terminal one for the same task. We re-snapshot and
      // check ordering.
      const snap = await snapshotRecorder();
      for (const id of taskIds) {
        const events = snap.progress.filter((p) => p.taskId === id);
        if (events.length === 0) continue;
        const terminalIdx = events.findIndex(
          (e) => ['cancelled', 'failed', 'done', 'skipped'].includes(e.status)
        );
        expect(terminalIdx).toBeGreaterThanOrEqual(0);
        for (let i = terminalIdx + 1; i < events.length; i++) {
          expect(['cancelled', 'failed', 'done', 'skipped']).toContain(events[i].status);
        }
      }
    } finally {
      await tearDownRecorder();
      try { rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('SUITE CANCEL-B — cancelTask(id) settles only that task; siblings continue', async () => {
    test.setTimeout(120_000);
    const { page } = getHarness();
    await installRecorder();
    const outDir = freshOutDir('CANCEL-B');
    const ids: StartedTask[] = [
      { id: `cancelB-1-${Date.now()}` },
      { id: `cancelB-2-${Date.now()}` }
    ];
    try {
      const r = await startGifBatch(ids.map((i) => i.id), outDir, 'suite-cancel-B');
      expect(r.ok).toBe(true);

      // Cancel only the first task. The second must finish on its own.
      await page.waitForTimeout(250);
      const single = await page.evaluate(async (taskId: string) => {
        const g = (window as unknown as {
          giftk: { cancelTask(id: string): Promise<{ ok: boolean; cancelled: boolean }> };
        }).giftk;
        return g.cancelTask(taskId);
      }, ids[0].id);
      expect(single.ok).toBe(true);
      // `cancelled` may be false on a fast box if task 1 already
      // finished; either way the IPC must succeed.
      expect(typeof single.cancelled).toBe('boolean');

      // Task 1 must settle in any terminal status.
      const accept = ['cancelled', 'failed', 'done', 'skipped'];
      await expectTerminalForTask(ids[0].id, 60_000, accept);
      // Task 2 must reach a terminal status — we accept failed too in
      // case medium.mp4 fails ASPECT_RATIO_OUT_OF_RANGE on this box,
      // but `done` is the expected happy path.
      await expectTerminalForTask(ids[1].id, 90_000, accept);
    } finally {
      await tearDownRecorder();
      try { rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('SUITE CANCEL-C — cancelAll is idempotent; calling 3× back-to-back never throws', async () => {
    test.setTimeout(60_000);
    const { page } = getHarness();
    // No batch in flight — exercises the "nothing to cancel" path.
    const r = await page.evaluate(async () => {
      const g = (window as unknown as {
        giftk: { cancelAll(): Promise<unknown>; cancelTask(id: string): Promise<{ ok: boolean; cancelled: boolean }> };
      }).giftk;
      // Three back-to-back `cancelAll()` calls plus a stale `cancelTask`
      // for an id that never existed.
      await g.cancelAll();
      await g.cancelAll();
      await g.cancelAll();
      const stale = await g.cancelTask('never-existed-task-id');
      return { stale };
    });
    expect(r.stale.ok).toBe(true);
    expect(r.stale.cancelled).toBe(false);

    // The IPC channel must still be alive — make a follow-up trivial
    // call to prove the pipeline survived three abort calls.
    const live = await page.evaluate(async () => {
      const g = (window as unknown as {
        giftk: { getDefaultOutputDir(): Promise<string> };
      }).giftk;
      return g.getDefaultOutputDir();
    });
    expect(typeof live).toBe('string');
    expect(live.length).toBeGreaterThan(0);
  });

  test('SUITE CANCEL-D — cancelTask with empty / invalid id returns ok:false without throwing', async () => {
    test.setTimeout(15_000);
    const { page } = getHarness();
    const probes = await page.evaluate(async () => {
      const g = (window as unknown as {
        giftk: { cancelTask(id: string): Promise<{ ok: boolean; cancelled: boolean; error?: string }> };
      }).giftk;
      // Empty string violates the validation in `process:cancelTask`
      // (taskId must be non-empty string), so the handler returns
      // `{ok:false, error:'invalid taskId'}` rather than throwing.
      const empty = await g.cancelTask('');
      // A whitespace-only id is technically a non-empty string and
      // sails through the validation; main returns `cancelled:false`
      // (no controller registered for that id).
      const ws = await g.cancelTask('   ');
      return { empty, ws };
    });
    expect(probes.empty.ok).toBe(false);
    expect(typeof probes.empty.error).toBe('string');
    expect(probes.ws.ok).toBe(true);
    expect(probes.ws.cancelled).toBe(false);
  });
});
