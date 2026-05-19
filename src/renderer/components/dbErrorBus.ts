/**
 * R-80 hardening — Lightweight singleton bus for surfacing the FIRST
 * `window.giftk.db.*` IPC failure in a session as a single toast,
 * replacing the silent `.catch(() => {})` fire-and-forget pattern in
 * the four history hooks.
 *
 * Design constraints:
 *  - Must NOT throw or block the hook's optimistic-update path.
 *  - Must NOT spam the user: a flapping main process emitting a
 *    failure for every write would otherwise produce a wall of toasts.
 *    We fire ONCE per session and silently swallow the rest.
 *  - The bus is decoupled from React via a module-level callback so
 *    the four hooks can call `reportDbError(family, op)` without
 *    needing the toaster context wired through their props.
 *  - App.tsx registers a listener once on mount; that listener is
 *    the only place that decides what kind of toast to render. The
 *    bus only carries the message and the family/op metadata.
 *
 * Thread / module isolation: this lives in the renderer only. Main-
 * side errors are logged via dbIpc's `safeHandle` in addition to
 * being re-thrown so this bus picks them up.
 */

export type DbErrorFamily =
  | 'history'
  | 'uploadHistory'
  | 'sniffHistory'
  | 'toolboxHistory'
  | 'bootstrap';

export type DbErrorOp = 'readAll' | 'upsert' | 'remove' | 'clear' | 'import';

export interface DbErrorEvent {
  family: DbErrorFamily;
  op: DbErrorOp;
  message: string;
}

type Listener = (event: DbErrorEvent) => void;

let listener: Listener | null = null;
/** Has the bus already fired in this session? Once true we silently
 *  drop further reports so we don't spam the toaster on a flapping
 *  main process. */
let firedOnce = false;

/**
 * Register a listener (typically App.tsx). Calling this a second time
 * replaces the previous listener (used by tests + StrictMode).
 */
export function setDbErrorListener(fn: Listener | null): void {
  listener = fn;
}

/**
 * Reset the "fired once" guard. Used by tests; not normally called
 * during a real session.
 */
export function _resetDbErrorBusForTests(): void {
  firedOnce = false;
  listener = null;
}

/**
 * Hooks call this from inside their `.catch()` blocks. The first
 * call in a session forwards to the listener; subsequent calls are
 * silently dropped.
 */
export function reportDbError(family: DbErrorFamily, op: DbErrorOp, err: unknown): void {
  if (firedOnce) return;
  firedOnce = true;
  const message = err instanceof Error ? err.message : String(err);
  // Always log to console for diagnostics (the toast is intentionally
  // brief; the console message has the family + op for context).
  // eslint-disable-next-line no-console
  console.error(`[db:${family}:${op}]`, message);
  if (listener) {
    try {
      listener({ family, op, message });
    } catch {
      /* a broken listener must not break the hook. */
    }
  }
}
