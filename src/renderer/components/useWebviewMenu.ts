/**
 * useWebviewMenu — owns the state + a11y wiring for the home page's
 * "网页嗅探" split-button menu.
 *
 * Why this exists
 * ---------------
 * The home page (App.tsx) used to inline ~95 lines of
 *   • `useState` for "is the popup open?" and the persisted preferred
 *     mode,
 *   • `useLayoutEffect` for left/right viewport-edge anchoring,
 *   • `useEffect` for focus management, click-outside dismissal and
 *     Escape-to-close,
 *   • a `useCallback` for keyboard navigation on the radio items
 * directly in the component body. That made App.tsx longer than it
 * needed to be and tied a piece of pure UI plumbing to the rest of the
 * sniff/processing pipeline. Extracting the bundle here keeps App.tsx
 * focused on data flow and lets us unit-test the menu's contract in
 * isolation (renderHook + jsdom-style fake DOM events) instead of
 * having to spin up the entire home page.
 *
 * Behavior parity
 * ---------------
 * The hook is a *byte-equivalent* port of the inlined logic, not a
 * re-design. In particular:
 *  • localStorage key, accepted values and "embed-on-anything-else"
 *    fallback semantics are preserved (`giftk:preferredWebviewMode`).
 *  • The viewport-anchoring rule is unchanged: prefer right anchor
 *    (caret's right edge == menu's right edge) when there's at least
 *    8 px of room to the LEFT of the caret; otherwise flip to left
 *    anchor if the menu fits on the right; otherwise stay right (the
 *    least-bad fallback).
 *  • On open, focus snaps to the currently selected radio item via
 *    `queueMicrotask` — micro-task scheduling lets React commit the
 *    popup DOM first, so `focus()` actually lands on a mounted
 *    element. (Calling `focus()` synchronously inside the effect runs
 *    too early on some browsers.)
 *  • Click-outside uses `mousedown` (not `click`) so the popup closes
 *    on the press rather than the release — this matches Chromium's
 *    own native menus and avoids a "phantom open" if the user starts
 *    a press inside and drags out.
 *  • Escape closes AND restores focus to the caret button, so a
 *    keyboard-only user doesn't get dumped onto `<body>`.
 *  • Arrow / Home / End wrap on overflow because the menu only has 3
 *    items — wrapping is the WAI-ARIA recommended behaviour for
 *    `role="menu"` with a small fixed item count.
 *
 * What this hook deliberately does NOT do
 * ---------------------------------------
 *  • It does not render the menu — that stays in App.tsx so the JSX,
 *    inline styles, copy and i18n live next to the rest of the UI.
 *    The hook just hands back the refs the renderer needs to wire up.
 *  • It does not own the actual sniff dispatch. `preferredMode` is the
 *    *user preference*; the imperative call site in App.tsx still
 *    decides which sniff entrypoint to invoke based on this value.
 *  • It does not debounce the resize listener. We measure on every
 *    resize event because the popup is short-lived and laying out a
 *    280-px box is cheap compared with throttling overhead.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react';

/**
 * The three "how should we sniff?" strategies the split-button surfaces:
 *  • `embed`         — embedded WebContentsView (fastest, fails on
 *                       heavy Cloudflare challenges).
 *  • `system-chrome` — spawns the user's real Chrome with CDP so it
 *                       can clear CF Turnstile / hCaptcha.
 *  • `ytdlp-direct`  — skips the webview entirely; hands the URL to
 *                       yt-dlp's 1900+ extractors.
 *
 * The string literals double as the persisted localStorage payload, so
 * any rename here is a breaking change for users who already have a
 * preference saved.
 */
export type WebviewMode = 'embed' | 'system-chrome' | 'ytdlp-direct';

/** localStorage key — module-private so we have a single source of truth. */
const STORAGE_KEY = 'giftk:preferredWebviewMode';

/**
 * Mapping from preferredMode → tabindex inside the radio group, used
 * by the focus-on-open logic. Kept as a plain object lookup so the
 * branching is data, not control flow — easier to extend if a fourth
 * mode is ever added.
 */
const MODE_TO_INDEX: Readonly<Record<WebviewMode, number>> = {
  embed: 0,
  'system-chrome': 1,
  'ytdlp-direct': 2
};

/** Public API surface. */
export interface UseWebviewMenuApi {
  /** True when the popup should be rendered. */
  open: boolean;
  /**
   * Imperative open/close. Accepts either a boolean or a
   * `(prev) => next` updater so callers can write
   * `setOpen((v) => !v)` for toggle semantics, just like the
   * original inlined `useState` setter we replaced.
   */
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  /** Currently persisted user preference. */
  preferredMode: WebviewMode;
  /**
   * Persist + update preferredMode. Rejects writes silently if
   * localStorage is unavailable (private mode, file:// URLs, …) so
   * the UI never crashes when the user just wants to flip a radio.
   */
  setPreferredMode: (m: WebviewMode) => void;
  /**
   * Where the popup should anchor to relative to the caret button.
   * `right` = top-right of menu aligns with top-right of caret.
   * `left`  = top-left  of menu aligns with top-left  of caret
   *           (used when right-anchoring would clip off the left
   *            viewport edge in narrow columns).
   */
  anchor: 'left' | 'right';
  /**
   * Ref the caller MUST attach to the caret <button>. Typed as
   * `MutableRefObject<T | null>` (not `RefObject<T | null>`) so it
   * stays assignable to the JSX `ref` prop slot under React 18 +
   * @types/react 18.3, which narrowed `RefObject` to disallow
   * `null` in its generic argument.
   */
  caretRef: React.MutableRefObject<HTMLButtonElement | null>;
  /** Ref the caller MUST attach to the popup root <div>. */
  menuRef: React.MutableRefObject<HTMLDivElement | null>;
  /**
   * Ref-array the caller MUST populate via
   *   `ref={(el) => { itemRefs.current[i] = el; }}`
   * so we can move focus among the radio items. Mutable on purpose —
   * React reconciles the array element-by-element.
   */
  itemRefs: React.MutableRefObject<Array<HTMLButtonElement | null>>;
  /**
   * Per-item keydown handler. Pass the item's index; the hook handles
   * ArrowDown/ArrowUp (wrap), Home, End. All other keys propagate so
   * the renderer can still react to Enter/Space natively.
   */
  onItemKeyDown: (
    ev: React.KeyboardEvent<HTMLButtonElement>,
    i: number
  ) => void;
}

/**
 * Read the persisted preference once on mount. We tolerate three
 * failure modes:
 *  1. localStorage doesn't exist (SSR, sandboxed iframe) — fall back.
 *  2. The stored value is not one of our literals (corruption,
 *     manual tampering, schema migration) — fall back.
 *  3. localStorage throws (Safari private mode quota) — fall back.
 * In every case we silently return `'embed'` so the UI is never
 * blocked on a storage error.
 */
const readInitialMode = (): WebviewMode => {
  try {
    const v =
      typeof localStorage !== 'undefined'
        ? localStorage.getItem(STORAGE_KEY)
        : null;
    if (v === 'system-chrome' || v === 'ytdlp-direct') return v;
    return 'embed';
  } catch {
    return 'embed';
  }
};

/**
 * The hook itself. Returns a stable API object — the *fields* may
 * change between renders (refs/state), but the function identities
 * (`setOpen`, `setPreferredMode`, `onItemKeyDown`) are
 * `useCallback`-stable so consumers can pass them straight into JSX
 * without triggering child re-renders.
 */
export function useWebviewMenu(): UseWebviewMenuApi {
  const [open, setOpen] = useState(false);
  const [preferredMode, setPreferredModeState] =
    useState<WebviewMode>(readInitialMode);

  // Refs the renderer hooks into. We deliberately allow `null` in the
  // array entries because React assigns refs after the DOM commits —
  // there is a brief window where `itemRefs.current[i]` is undefined,
  // and `onItemKeyDown` simply no-ops in that case via optional chain.
  const caretRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Default to `'right'` because that's where the caret sits in the
  // toolbar 99% of the time; the layout effect below will flip to
  // `'left'` only when the right-anchored popup would clip.
  const [anchor, setAnchor] = useState<'left' | 'right'>('right');

  /**
   * Persist + state-update fused into one callback. Stable identity
   * because React's setState is itself stable, and we don't depend on
   * any closed-over state.
   */
  const setPreferredMode = useCallback((m: WebviewMode) => {
    setPreferredModeState(m);
    try {
      localStorage.setItem(STORAGE_KEY, m);
    } catch {
      /* swallow — see readInitialMode for rationale */
    }
  }, []);

  /**
   * Layout-effect (NOT plain effect) so we measure synchronously
   * before the browser paints. Otherwise users would see a 1-frame
   * flash of the popup at the wrong anchor when the menu opens in a
   * narrow column.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const recompute = (): void => {
      const caret = caretRef.current;
      const menu = menuRef.current;
      if (!caret || !menu) return;
      const caretRect = caret.getBoundingClientRect();
      const menuW = menu.offsetWidth;
      const vw = typeof window !== 'undefined' ? window.innerWidth : 0;
      // Anchor right (top-right corner of menu == top-right corner
      // of caret) when there's enough room to the LEFT of the caret;
      // otherwise anchor left so the menu opens toward the wider
      // side of the screen. The 8 px gutter keeps the popup off the
      // viewport edge for visual breathing room.
      const fitsRightAnchor = caretRect.right - menuW >= 8;
      setAnchor(
        fitsRightAnchor
          ? 'right'
          : caretRect.left + menuW + 8 <= vw
            ? 'left'
            : 'right'
      );
    };
    recompute();
    window.addEventListener('resize', recompute);
    return () => window.removeEventListener('resize', recompute);
  }, [open]);

  /**
   * Plain effect for the *interactive* concerns: focus, click-outside,
   * Escape. We keep these out of the layout effect because they don't
   * affect first-paint geometry, and synchronous DOM mutation here
   * (focus()) inside a layout effect can trigger forced re-layout.
   */
  useEffect(() => {
    if (!open) return;
    // Move focus into the menu on open, defaulting to the currently
    // selected mode for a "where am I?" anchor. queueMicrotask defers
    // the focus call until React has flushed the popup DOM, otherwise
    // `itemRefs.current[idx]` could still be null on first open.
    const idx = MODE_TO_INDEX[preferredMode];
    queueMicrotask(() => {
      itemRefs.current[idx]?.focus();
    });
    const onDocMouseDown = (ev: MouseEvent): void => {
      const t = ev.target as Node | null;
      if (!t) return;
      // Clicks inside the popup itself are obviously not "outside";
      // clicks on the caret are handled by the caret's own toggle, so
      // we let them pass without closing here (otherwise the caret
      // would close+re-open in the same tick).
      if (menuRef.current?.contains(t)) return;
      if (caretRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onDocKeyDown = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        setOpen(false);
        // Restore focus to the trigger so a keyboard-only user
        // doesn't lose their place in the toolbar.
        caretRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onDocKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onDocKeyDown);
    };
  }, [open, preferredMode]);

  /**
   * Keyboard nav on the radio items themselves. We read the live
   * length of `itemRefs.current` so the handler stays correct if a
   * future iteration adds a fourth mode without code changes here.
   */
  const onItemKeyDown = useCallback(
    (ev: React.KeyboardEvent<HTMLButtonElement>, i: number) => {
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        const len = itemRefs.current.length;
        if (len === 0) return;
        const next = (i + 1) % len;
        itemRefs.current[next]?.focus();
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        const len = itemRefs.current.length;
        if (len === 0) return;
        const prev = (i - 1 + len) % len;
        itemRefs.current[prev]?.focus();
      } else if (ev.key === 'Home') {
        ev.preventDefault();
        itemRefs.current[0]?.focus();
      } else if (ev.key === 'End') {
        ev.preventDefault();
        itemRefs.current[itemRefs.current.length - 1]?.focus();
      }
    },
    []
  );

  return {
    open,
    setOpen,
    preferredMode,
    setPreferredMode,
    anchor,
    caretRef,
    menuRef,
    itemRefs,
    onItemKeyDown
  };
}
