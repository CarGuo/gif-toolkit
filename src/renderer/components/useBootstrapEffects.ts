/**
 * useBootstrapEffects — consolidates the four mount-once side effects
 * that previously lived inline at the top of App.tsx (lines 91-155 and
 * 411-423 of the pre-Step-11A blob):
 *
 *   1. bootstrapImportFromLocalStorage  → kicks off the legacy
 *      localStorage → SQLite migration on first launch and reload()s
 *      the visible top-level hooks (history / sniffHistory /
 *      uploadHistory) so freshly-imported rows surface without a
 *      restart. Idempotent — every subsequent launch is a no-op.
 *
 *   2. setDbErrorListener  → wires a one-shot toast onto the
 *      dbErrorBus so the FIRST `window.giftk.db.*` IPC failure of
 *      the session surfaces as user-visible feedback instead of being
 *      silently swallowed by the hooks' optimistic-update `.catch()`
 *      blocks. Bus enforces "fire once per session" semantics
 *      internally; we just register the listener.
 *
 *   3. getCapabilities  → asks main for the platform capability
 *      report and surfaces one toast per issue (via
 *      toaster.pushCapability, which itself filters out previously
 *      "不再提醒"'d issues). Capabilities are cached on the main
 *      side so this only runs once per process lifetime.
 *
 *   4. db.onFlushBeforeQuit  → subscribes to main's pre-quit flush
 *      request. We await both debounced upsert queues (history +
 *      uploadHistory) then ack so main can proceed with closing the
 *      DB. Main has a 1-second hard timeout, so a hung renderer can't
 *      block the quit. The two flush callbacks are bridged via refs
 *      (kept in sync with the latest stable identities) so we never
 *      re-subscribe on a re-render and never call a stale captured
 *      flush.
 *
 * Why a hook
 * ----------
 * All four effects:
 *   - run exactly once on mount (no per-render deps that mutate)
 *   - are mutually independent (bootstrap doesn't gate db-error
 *     listener registration, etc.)
 *   - have hand-written `eslint-disable react-hooks/exhaustive-deps`
 *     comments in App.tsx because the `reload*` callbacks intentionally
 *     don't go into the deps array (we want bootstrap-once semantics,
 *     not "re-run whenever a reload identity changes")
 *
 * Pulling them into a single hook collapses ~70 lines of "App.tsx
 * top-of-component lifecycle scaffolding" into one call site. The
 * hook accepts a `BootstrapDeps` bag of callbacks rather than owning
 * the underlying state — the four reload() / flushPending() functions
 * still live in their respective family hooks (useHistory,
 * useSniffHistory, useUploadHistory) and we don't want to duplicate
 * any of that ownership here.
 *
 * R-80 contract preserved
 * -----------------------
 * The pre-quit ack path (Foot-gun #5 of AGENTS.md, R-80 #8) MUST keep
 * its 1:1 behaviour: subscribe once on mount, ack via the same
 * callback main passed in, await Promise.allSettled([...]) so a
 * single failing flush doesn't block the other. We use the same ref
 * trick the original inline code used — `flushHistoryPendingRef` and
 * `flushUploadHistoryPendingRef` are seeded from props on every
 * render via a tiny `useEffect`, and the subscribe-once effect reads
 * `.current` at quit time. This keeps the listener registration
 * stable across renders even though the underlying flush callbacks
 * may receive new identities every frame.
 */
import { useEffect, useRef } from 'react';
import { useToaster } from './Toast';
import { bootstrapImportFromLocalStorage } from './storageSchema';
import { setDbErrorListener, type DbErrorEvent } from './dbErrorBus';

type ToasterApi = ReturnType<typeof useToaster>;

export interface BootstrapDeps {
  /** Refresh the in-memory history list (post-bootstrap). */
  reloadHistory: () => void;
  /** Refresh the in-memory sniff history list (post-bootstrap). */
  reloadSniffHistory: () => void;
  /** Refresh the in-memory upload history list (post-bootstrap). */
  reloadUploadHistory: () => void;
  /** Awaitable flush of the history debounced upsert queue. */
  flushHistoryPending: () => Promise<unknown>;
  /** Awaitable flush of the upload-history debounced upsert queue. */
  flushUploadHistoryPending: () => Promise<unknown>;
}

/**
 * Wires the four mount-once side effects described in the file
 * docblock. Call exactly once at the top of App's render body (after
 * the family hooks that produce `reload*` / `flushPending` are
 * initialised — those identities are read through refs so unstable
 * references on re-render are fine).
 */
export function useBootstrapEffects(toaster: ToasterApi, deps: BootstrapDeps): void {
  const {
    reloadHistory,
    reloadSniffHistory,
    reloadUploadHistory,
    flushHistoryPending,
    flushUploadHistoryPending
  } = deps;

  // R-80 hardening (H5) — keep the latest flushPending callbacks in
  // refs so the one-shot `db:flushBeforeQuit` listener can call them
  // without re-subscribing on every re-render.
  const flushHistoryPendingRef = useRef(flushHistoryPending);
  const flushUploadHistoryPendingRef = useRef(flushUploadHistoryPending);
  useEffect(() => { flushHistoryPendingRef.current = flushHistoryPending; }, [flushHistoryPending]);
  useEffect(() => { flushUploadHistoryPendingRef.current = flushUploadHistoryPending; }, [flushUploadHistoryPending]);

  // Mirror the reload callbacks behind a ref too. The bootstrap
  // effect is intentionally `[]`-deps (run once); without the ref a
  // future caller wiring the hook with non-stable reload identities
  // would either eat a stale closure or trigger a false re-bootstrap.
  const reloadHistoryRef = useRef(reloadHistory);
  const reloadSniffHistoryRef = useRef(reloadSniffHistory);
  const reloadUploadHistoryRef = useRef(reloadUploadHistory);
  useEffect(() => { reloadHistoryRef.current = reloadHistory; }, [reloadHistory]);
  useEffect(() => { reloadSniffHistoryRef.current = reloadSniffHistory; }, [reloadSniffHistory]);
  useEffect(() => { reloadUploadHistoryRef.current = reloadUploadHistory; }, [reloadUploadHistory]);

  // Effect 1 — legacy localStorage → SQLite import + reload visible families.
  useEffect(() => {
    let cancelled = false;
    bootstrapImportFromLocalStorage()
      .then((result) => {
        if (cancelled || !result) return;
        const total = result.history + result.uploadHistory + result.sniffHistory + result.toolboxHistory;
        if (total > 0) {
          // Refresh every hook that's already mounted at this point
          // so freshly-imported rows surface without a restart.
          try { reloadHistoryRef.current(); } catch { /* best-effort. */ }
          try { reloadSniffHistoryRef.current(); } catch { /* best-effort. */ }
          try { reloadUploadHistoryRef.current(); } catch { /* best-effort. */ }
        }
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.warn('[bootstrap] legacy import failed (will retry next launch):', e);
      });
    return () => { cancelled = true; };
  }, []);

  // Effect 2 — dbErrorBus → toaster bridge.
  useEffect(() => {
    setDbErrorListener((evt: DbErrorEvent) => {
      const familyLabel: Record<DbErrorEvent['family'], string> = {
        history: '历史记录',
        uploadHistory: '上传历史',
        sniffHistory: '嗅探历史',
        toolboxHistory: '工具箱历史',
        bootstrap: '历史数据迁移'
      };
      toaster.push({
        id: `db-error-${evt.family}-${evt.op}`,
        severity: 'warn',
        title: `${familyLabel[evt.family]}暂存失败`,
        detail: '内存中的记录仍可见,但本次未能写入本地数据库,重启后可能丢失最近变更。'
      });
    });
    return () => setDbErrorListener(null);
  }, [toaster]);

  // Effect 3 — capability probe → one toast per issue.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cap = await window.giftk?.getCapabilities?.();
        if (cancelled || !cap) return;
        for (const issue of cap.issues) {
          toaster.pushCapability(issue);
        }
      } catch (e) {
        // Don't toast about the toaster failing — just log.
        // eslint-disable-next-line no-console
        console.warn('[capabilities] probe failed:', e);
      }
    })();
    return () => { cancelled = true; };
    // toaster identity is stable for the lifetime of the App component
    // (useToaster returns a memoised object); we still depend on it
    // so the rule-of-hooks lint passes without a disable comment.
  }, [toaster]);

  // Effect 4 — main → renderer pre-quit flush handshake (R-80 #8).
  useEffect(() => {
    const off = window.giftk?.db?.onFlushBeforeQuit?.((acked) => {
      Promise.allSettled([
        flushHistoryPendingRef.current(),
        flushUploadHistoryPendingRef.current()
      ]).finally(() => acked());
    });
    return () => { try { off?.(); } catch { /* ignore */ } };
  }, []);
}
