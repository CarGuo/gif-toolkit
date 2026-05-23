/**
 * SUITE PROCESS-CANCEL — `process:*` IPC negative-path lock
 * (R-PROCESS-CANCEL-V1).
 *
 * Why this SUITE exists
 * ---------------------
 * The full-pipeline SUITEs exercise `process:start` happy path and
 * `process:cancelAll` mid-flight (CANCEL-A..D). What is NOT covered:
 *
 *   - [process:cancelAll](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L1345-L1348)
 *     called against an empty inflight set must still return ok:true
 *     (defence: a tray-menu-quick-tap before any task starts must not
 *     crash the channel).
 *   - [process:cancelTask](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L1356-L1362)
 *     against a non-string / empty / unknown taskId must return
 *     `{ok:false, cancelled:false, error}` — never throw.
 *   - [process:start](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L1214-L1343)
 *     with an empty / malformed batch must reject early without
 *     mutating any DB row or kicking off a chain.
 *
 * UI flows have masked these behind "no batch button is enabled when
 * there's nothing to do", but the IPC channel itself must survive a
 * compromised renderer probing it directly.
 */
import { test, expect } from '@playwright/test';
import { getHarness } from './_harness';

interface CancelTaskWire { ok: boolean; cancelled: boolean; error?: string; }

test.describe('SUITE PROCESS-CANCEL — process:* negative-path lock', () => {
  test('SUITE PROC-A — process:cancelAll on empty inflight set is idempotent', async () => {
    test.setTimeout(10_000);
    const { page } = getHarness();
    // Call cancelAll twice in a row with no batch in flight. Both
    // calls MUST resolve without throwing.
    const r = await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: { cancelAll(): Promise<unknown> };
      };
      try {
        await w.giftk.cancelAll();
        await w.giftk.cancelAll();
        return { kind: 'resolved' as const };
      } catch (e) {
        return { kind: 'threw' as const, message: (e as Error).message };
      }
    });
    expect(r.kind).toBe('resolved');
  });

  test('SUITE PROC-B — process:cancelTask against an unknown taskId returns ok:true cancelled:false', async () => {
    test.setTimeout(10_000);
    const { page } = getHarness();
    const r = (await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: { cancelTask(taskId: string): Promise<CancelTaskWire> };
      };
      // Real-shaped but never-issued taskId. The handler's lookup will
      // miss; per contract it returns ok:true with cancelled:false (no
      // controller was actually aborted).
      return w.giftk.cancelTask(`nonexistent-task-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    })) as CancelTaskWire;
    expect(r.ok).toBe(true);
    expect(r.cancelled).toBe(false);
  });

  test('SUITE PROC-C — process:cancelTask with empty / non-string taskId returns ok:false (no throw)', async () => {
    test.setTimeout(10_000);
    const { page } = getHarness();
    const r = await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: { cancelTask(taskId: unknown): Promise<CancelTaskWire> };
      };
      // The main-side guard returns {ok:false, cancelled:false, error}
      // for both "" and non-string inputs. We bypass the preload's
      // type-system to hit those branches directly.
      const empty = await (w.giftk.cancelTask as unknown as (
        v: unknown
      ) => Promise<CancelTaskWire>)('');
      const nonString = await (w.giftk.cancelTask as unknown as (
        v: unknown
      ) => Promise<CancelTaskWire>)(null);
      return { empty, nonString };
    });
    expect(r.empty.ok).toBe(false);
    expect(r.empty.cancelled).toBe(false);
    expect(typeof r.empty.error).toBe('string');
    expect(r.nonString.ok).toBe(false);
    expect(r.nonString.cancelled).toBe(false);
    expect(typeof r.nonString.error).toBe('string');
  });

  test('SUITE PROC-D — process:start preload guard rejects non-array tasks payload', async () => {
    test.setTimeout(15_000);
    const { page } = getHarness();
    // The preload startBatch() bridge enforces `Array.isArray(tasks)`
    // before invoking the IPC channel. We bypass TS to feed it the
    // shapes a compromised renderer might try and verify each one is
    // rejected at the bridge — the channel never fires, no DB row is
    // mutated, no worker spawned.
    const r = await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: {
          startBatch(
            tasks: unknown,
            pageTitle?: string,
            outputDirOverride?: string,
            sessionId?: string
          ): Promise<unknown>;
        };
      };
      const tries: Array<[string, unknown]> = [
        ['null', null],
        ['undefined', undefined],
        ['stringTasks', 'not-an-array'],
        ['objectTasks', { fake: true }],
        ['numberTasks', 42]
      ];
      const out: Record<string, { kind: string; message?: string }> = {};
      for (const [label, tasks] of tries) {
        try {
          await (w.giftk.startBatch as unknown as (
            v: unknown
          ) => Promise<unknown>)(tasks);
          out[label] = { kind: 'resolved' };
        } catch (e) {
          out[label] = { kind: 'threw', message: (e as Error).message };
        }
      }
      return out;
    });
    // Every non-array shape MUST throw at the preload bridge.
    for (const [label, v] of Object.entries(r)) {
      expect(v.kind, `${label} should be rejected`).toBe('threw');
      expect((v.message ?? '').length, `${label} message`).toBeGreaterThan(0);
    }
  });
});
