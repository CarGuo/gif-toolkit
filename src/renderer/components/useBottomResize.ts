/**
 * useBottomResize — extracted from App.tsx so the bottom-panel
 * (TaskTable + LogBox) drag-to-resize gesture can be unit-tested in
 * isolation without spinning up the entire app shell.
 *
 * Behaviour mirrors the original inline implementation 1:1:
 *   - Initial height is read from localStorage (key BOTTOM_H_KEY) on
 *     first render. Invalid / too-small values fall back to
 *     BOTTOM_H_DEFAULT. The read is SSR-safe (returns the default when
 *     `window` is undefined).
 *   - `onBottomResizeStart` is the mousedown handler for the drag
 *     handle. It registers document-level mousemove/mouseup listeners
 *     so the gesture keeps tracking even if the cursor leaves the
 *     handle's hit-box. The geometry is computed against
 *     `window.innerHeight` so cursor movement maps 1:1 to panel
 *     height delta (`dy = startY - clientY`, panel grows when the
 *     cursor moves up).
 *   - The new height is clamped to
 *     `[BOTTOM_H_MIN, floor(window.innerHeight * 0.7)]`.
 *   - On mouseup we tear down the listeners, restore the body cursor /
 *     userSelect overrides, and persist the *latest* height to
 *     localStorage. We use the `setBottomH(v => { write(v); return v;
 *     })` "setter snapshot" trick to read the most recent state value
 *     without depending on a possibly-stale closure capture.
 */
import { useCallback, useState } from 'react';
import type React from 'react';

/** localStorage key for the persisted bottom-panel height. */
export const BOTTOM_H_KEY = 'giftk.bottomPanelHeight';
/** Floor for the panel — anything smaller hides the table content. */
export const BOTTOM_H_MIN = 80;
/** Initial / fallback height used when no valid persisted value exists. */
export const BOTTOM_H_DEFAULT = 180;

/** Public surface of the hook — exactly what App.tsx needs. */
export interface UseBottomResizeApi {
  /** Current panel height in CSS pixels. */
  bottomH: number;
  /** Mousedown handler for the drag handle. */
  onBottomResizeStart: (e: React.MouseEvent<HTMLDivElement>) => void;
  /**
   * Reset the panel height back to `BOTTOM_H_DEFAULT` and persist
   * that value. Used by the drag-handle's double-click affordance —
   * "拖动调节高度,双击恢复默认". Persistence failures are swallowed
   * so the in-memory reset still lands.
   */
  resetBottomH: () => void;
}

/**
 * Read the persisted height from localStorage with full validation.
 * Kept as a pure function so the lazy `useState` initialiser and the
 * tests can both exercise it without duplicating the logic.
 */
function readPersistedHeight(): number {
  // SSR / Node guard. happy-dom DOES define `window`, but production
  // Electron renderer also runs through this path and we want to be
  // defensive against any future test runner that might not.
  if (typeof window === 'undefined') return BOTTOM_H_DEFAULT;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(BOTTOM_H_KEY);
  } catch {
    // localStorage can throw in some sandboxed contexts (e.g. data:
    // URLs, Safari private mode). Treat as "no value".
    return BOTTOM_H_DEFAULT;
  }
  const n = raw ? Number(raw) : NaN;
  // Both `Number.isFinite` and the floor check are required: NaN /
  // Infinity / negative numbers / values smaller than the minimum
  // would all yield a broken layout if we trusted them blindly.
  return Number.isFinite(n) && n >= BOTTOM_H_MIN ? n : BOTTOM_H_DEFAULT;
}

/**
 * Hook that owns the bottom-panel height and exposes a drag-handle
 * mousedown callback. See module-level docblock for behaviour notes.
 */
export function useBottomResize(): UseBottomResizeApi {
  // Lazy initialiser — `readPersistedHeight` only runs on the very
  // first render, never on subsequent re-renders.
  const [bottomH, setBottomH] = useState<number>(() => readPersistedHeight());

  const onBottomResizeStart = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Stop the browser from initiating a text selection drag, which
      // would otherwise fight our cursor override.
      e.preventDefault();

      // Snapshot the gesture's anchor: cursor Y at mousedown and the
      // current panel height. The closure captures `bottomH` here so
      // every mousemove computes its delta against this stable origin
      // (we do NOT recompute against the latest state on every tick —
      // that would compound rounding errors).
      const startY = e.clientY;
      const startH = bottomH;

      const onMove = (ev: MouseEvent): void => {
        // Negative dy when cursor moves down (panel shrinks),
        // positive when up (panel grows).
        const dy = startY - ev.clientY;
        // Cap at 70% of viewport so the user can't accidentally drag
        // the panel over the entire app and lose the top toolbars.
        // The `+1` guard ensures `maxH > BOTTOM_H_MIN` even on
        // pathologically tiny windows.
        const maxH = Math.max(
          BOTTOM_H_MIN + 1,
          Math.floor(window.innerHeight * 0.7),
        );
        const next = Math.min(maxH, Math.max(BOTTOM_H_MIN, startH + dy));
        setBottomH(next);
      };

      const onUp = (): void => {
        // Tear down the document-level listeners first so any stray
        // pointer event after this point can't mutate state.
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        // Restore body cosmetics that we hijacked at gesture start.
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        try {
          // Persist the most recent height. We can't use the
          // `bottomH` from the outer closure because it would be the
          // value at gesture-start time. Instead we use the functional
          // setter form: React passes us the latest committed state
          // and we side-effect inside, returning it unchanged so React
          // bails out of the re-render.
          setBottomH((v) => {
            window.localStorage.setItem(BOTTOM_H_KEY, String(v));
            return v;
          });
        } catch {
          // Ignore localStorage quota / sandbox failures — the panel
          // still works, just won't survive a reload.
        }
      };

      // Hijack the body cursor so the resize affordance persists even
      // when the cursor leaves the 4px-tall drag handle, and disable
      // text selection across the whole app for the duration of the
      // gesture (otherwise dragging would highlight everything).
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    // We deliberately depend on `bottomH` so the captured `startH`
    // reflects the latest committed height each time the user starts
    // a new drag. (Without this dep, the second drag would always
    // start from the initial height.)
    [bottomH],
  );

  // Stable reset callback — depends on nothing because both the
  // setter and the storage key are module-level constants.
  const resetBottomH = useCallback(() => {
    setBottomH(BOTTOM_H_DEFAULT);
    try {
      window.localStorage.setItem(BOTTOM_H_KEY, String(BOTTOM_H_DEFAULT));
    } catch {
      // Same swallow-and-continue policy as the gesture-end persist
      // above: a quota / sandbox error must NOT block the reset.
    }
  }, []);

  return { bottomH, onBottomResizeStart, resetBottomH };
}
