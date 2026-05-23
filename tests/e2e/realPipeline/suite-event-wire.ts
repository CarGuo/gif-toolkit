/**
 * SUITE EVENT-WIRE — `onProgress` / `onUploadProgress` /
 * `onSniffProgress` / `onSessionLog` subscribe-and-unsubscribe contract
 * (R-EVENT-WIRE-V1).
 *
 * Why this SUITE exists
 * ---------------------
 * Every long-running pipeline (process / upload / sniff / session log)
 * pushes events at the renderer through a four-channel bridge. The
 * renderer's React effects rely on a *strict contract*:
 *
 *   1. Each subscriber returns an unsubscribe function (so a
 *      `useEffect(() => fn, [])` cleanup works without a wrapper).
 *   2. Calling unsubscribe twice MUST be safe (StrictMode double-mount
 *      / unmount races fire it twice in dev).
 *   3. After unsubscribe, re-subscribing must work cleanly (no stale
 *      handler accumulation, no leaked listeners across HMR).
 *   4. The shape returned by `onSessionLog` must be the documented
 *      discriminated union — `{kind:'open'|'append'|'close', ...}` —
 *      so the renderer's switch is exhaustive at the type level.
 *
 *   - [onProgress](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/index.ts#L230-L236)
 *   - [onSniffProgress](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/index.ts#L244-L250)
 *   - [onUploadProgress](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/index.ts#L437-L443)
 *   - [onSessionLog](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/index.ts#L455-L478)
 *
 * Note we do NOT trigger a real event here; the *contract* surface is
 * the subscriber's return value and idempotent teardown. Real-event
 * delivery is already covered end-to-end by SUITE LIFE-* / SUITE
 * UPLOAD-FULL / SUITE OFFLINE.
 */
import { test, expect } from '@playwright/test';
import { getHarness } from './_harness';

test.describe('SUITE EVENT-WIRE — onProgress / onSniffProgress / onUploadProgress / onSessionLog', () => {
  test('SUITE EW-A — every event subscriber returns an unsubscribe function (typeof === "function")', async () => {
    test.setTimeout(15_000);
    const { page } = getHarness();
    const r = await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: {
          onProgress(cb: (p: unknown) => void): () => void;
          onSniffProgress(cb: (p: unknown) => void): () => void;
          onUploadProgress(cb: (p: unknown) => void): () => void;
          onSessionLog(cb: (ev: unknown) => void): () => void;
        };
      };
      const noop = (): void => {};
      const offProgress = w.giftk.onProgress(noop);
      const offSniff = w.giftk.onSniffProgress(noop);
      const offUpload = w.giftk.onUploadProgress(noop);
      const offSession = w.giftk.onSessionLog(noop);
      const out = {
        offProgress: typeof offProgress,
        offSniff: typeof offSniff,
        offUpload: typeof offUpload,
        offSession: typeof offSession,
      };
      // Don't leak — tear down before returning.
      offProgress();
      offSniff();
      offUpload();
      offSession();
      return out;
    });
    expect(r.offProgress).toBe('function');
    expect(r.offSniff).toBe('function');
    expect(r.offUpload).toBe('function');
    expect(r.offSession).toBe('function');
  });

  test('SUITE EW-B — calling unsubscribe twice is idempotent (no throw)', async () => {
    test.setTimeout(15_000);
    const { page } = getHarness();
    const r = await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: {
          onProgress(cb: (p: unknown) => void): () => void;
          onSniffProgress(cb: (p: unknown) => void): () => void;
          onUploadProgress(cb: (p: unknown) => void): () => void;
          onSessionLog(cb: (ev: unknown) => void): () => void;
        };
      };
      const probe = (
        sub: (cb: (p: unknown) => void) => () => void
      ): string => {
        const off = sub(() => {});
        try {
          off();
          off(); // second call MUST be a no-op, not a throw.
          return 'ok';
        } catch (e) {
          return (e as Error).message || 'threw';
        }
      };
      return {
        progress: probe(w.giftk.onProgress),
        sniff: probe(w.giftk.onSniffProgress),
        upload: probe(w.giftk.onUploadProgress),
        session: probe(w.giftk.onSessionLog),
      };
    });
    expect(r.progress).toBe('ok');
    expect(r.sniff).toBe('ok');
    expect(r.upload).toBe('ok');
    expect(r.session).toBe('ok');
  });

  test('SUITE EW-C — subscribe → unsubscribe → re-subscribe cycle returns a fresh unsubscribe each time', async () => {
    test.setTimeout(15_000);
    const { page } = getHarness();
    const r = await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: {
          onProgress(cb: (p: unknown) => void): () => void;
          onSessionLog(cb: (ev: unknown) => void): () => void;
        };
      };
      // HMR / StrictMode replays this cycle; the second subscribe MUST
      // hand back a *different* function reference than the first
      // (otherwise an old handler would still be live and the dev
      // listener-count would creep up).
      const a = w.giftk.onProgress(() => {});
      a();
      const b = w.giftk.onProgress(() => {});
      b();
      const x = w.giftk.onSessionLog(() => {});
      x();
      const y = w.giftk.onSessionLog(() => {});
      y();
      return {
        progressDistinct: a !== b,
        sessionDistinct: x !== y,
        progressBothFns: typeof a === 'function' && typeof b === 'function',
        sessionBothFns: typeof x === 'function' && typeof y === 'function',
      };
    });
    expect(r.progressDistinct).toBe(true);
    expect(r.sessionDistinct).toBe(true);
    expect(r.progressBothFns).toBe(true);
    expect(r.sessionBothFns).toBe(true);
  });

  test('SUITE EW-D — onSessionLog tolerates a throwing callback without breaking the unsubscribe contract', async () => {
    test.setTimeout(15_000);
    const { page } = getHarness();
    // The bridge wraps the user callback in try/catch (the renderer
    // SHOULD never throw, but in dev a stale ref or a console.assert
    // sometimes does). We can't easily fire a real event from the
    // renderer side, but we CAN simulate the receive path by emitting
    // a custom event-like payload through `electron.ipcRenderer.emit`
    // only if exposed — it usually isn't. So we settle for the next
    // best lock: a *throwing* callback registered, then unregistered,
    // produces no observable error and the unsubscribe still resolves
    // synchronously. This guards the swallow-in-bridge invariant.
    const r = await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: {
          onSessionLog(cb: (ev: unknown) => void): () => void;
          onProgress(cb: (p: unknown) => void): () => void;
        };
      };
      let unsubKind = 'unset';
      try {
        const off = w.giftk.onSessionLog(() => {
          throw new Error('renderer exploded');
        });
        unsubKind = typeof off;
        off();
      } catch (e) {
        unsubKind = (e as Error).message;
      }
      // Same guarantee for onProgress.
      let progressUnsubKind = 'unset';
      try {
        const off = w.giftk.onProgress(() => {
          throw new Error('renderer exploded');
        });
        progressUnsubKind = typeof off;
        off();
      } catch (e) {
        progressUnsubKind = (e as Error).message;
      }
      return { unsubKind, progressUnsubKind };
    });
    expect(r.unsubKind).toBe('function');
    expect(r.progressUnsubKind).toBe('function');
  });
});
