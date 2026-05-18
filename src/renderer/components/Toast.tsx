/**
 * R-62 — Toast renderer. Surfaces cross-platform `CapabilityIssue`s
 * (and any future ad-hoc notifications) as a stacked column in the
 * bottom-right corner of the app.
 *
 * Design choices:
 *
 *  - Plain DOM nodes inside a `position: fixed` overlay so the toasts
 *    sit above every modal / titlebar without participating in the
 *    main grid. We keep the markup inside the regular React tree
 *    (no portals) because we never have more than one Toaster
 *    instance and React 18's automatic batching is good enough for
 *    open/close transitions.
 *  - Severity drives color and an emoji icon. We keep the icon as a
 *    plain literal (no icon font) — same constraint as the rest of
 *    the renderer.
 *  - Each toast can be dismissed locally (X button) or persistently
 *    (reads/writes `localStorage.giftk.dismissedCaps`, JSON-encoded
 *    `string[]`). Persistent dismissal is offered ONLY for capability
 *    issues (`source === 'capability'`) because ad-hoc toasts are
 *    transient by definition.
 *  - Auto-dismiss timer is OFF for `error` and OFF for any sticky
 *    toast (caller passes `sticky: true`); 8s for `warn`; 5s for
 *    `info`. The user can override by hovering (timer pauses while
 *    pointer is inside the toast — implemented via plain
 *    setTimeout / clearTimeout, not CSS animations, so we don't pay
 *    for layout thrash).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CapabilityIssue, CapabilitySeverity } from '../../shared/types';

/* ----------------------- Public API ----------------------- */

export interface ToastItem {
  id: string;
  severity: CapabilitySeverity;
  title: string;
  detail?: string;
  /** When true, the item won't auto-dismiss. Default: false (severity-driven). */
  sticky?: boolean;
  /** When true, the dismiss button writes id into the persistent
   *  dismissal list. Capability toasts always set this to true; ad-hoc
   *  toasts (e.g. "上传成功") leave it false. */
  persistDismiss?: boolean;
  /** Optional doc link surfaced as "了解更多". */
  docUrl?: string;
}

export interface ToasterHandle {
  push: (item: ToastItem) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

/* ----------------------- Persistence ----------------------- */

const DISMISSED_KEY = 'giftk.dismissedCaps';

function readDismissed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((s): s is string => typeof s === 'string'));
  } catch {
    return new Set();
  }
}

function writeDismissed(set: Set<string>): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(Array.from(set)));
  } catch { /* ignore quota / disabled storage */ }
}

/** Convert a `CapabilityIssue` from the main-side IPC into a ToastItem.
 *  Items whose id is in the persistent dismissed set are filtered out
 *  by the caller — this helper just shapes the data. */
export function capabilityIssueToToast(issue: CapabilityIssue): ToastItem {
  return {
    id: issue.id,
    severity: issue.severity,
    title: issue.title,
    detail: issue.detail,
    sticky: issue.severity === 'error',
    persistDismiss: true,
    docUrl: issue.docUrl
  };
}

/** Read the persistent dismissed-id set. Exposed so App can filter
 *  capability issues *before* calling toaster.push() — that way an
 *  already-dismissed issue never even animates in. */
export function getDismissedCaps(): Set<string> {
  return readDismissed();
}

/* ----------------------- Component ----------------------- */

const SEVERITY_ICON: Record<CapabilitySeverity, string> = {
  error: '⛔',
  warn: '⚠️',
  info: 'ℹ️'
};

const SEVERITY_BG: Record<CapabilitySeverity, string> = {
  error: 'rgba(220, 38, 38, 0.96)',
  warn: 'rgba(217, 119, 6, 0.96)',
  info: 'rgba(37, 99, 235, 0.96)'
};

const AUTO_DISMISS_MS: Record<CapabilitySeverity, number | null> = {
  error: null, // never auto-dismiss
  warn: 8000,
  info: 5000
};

interface VisibleToast extends ToastItem {
  /** Wall-clock timestamp at which the auto-dismiss timer was last
   *  (re)started. Used to compute remaining time on hover-out. */
  startedAt: number;
}

interface ToasterProps {
  /** Imperative handle the parent uses to push toasts. */
  registerHandle?: (handle: ToasterHandle) => void;
}

export const Toaster: React.FC<ToasterProps> = ({ registerHandle }) => {
  const [items, setItems] = useState<VisibleToast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Track which item the pointer is currently over so we can pause/
  // resume auto-dismiss on enter/leave.
  const hoveredRef = useRef<Set<string>>(new Set());

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
    const t = timersRef.current.get(id);
    if (t) {
      clearTimeout(t);
      timersRef.current.delete(id);
    }
    hoveredRef.current.delete(id);
  }, []);

  const persistDismiss = useCallback((id: string) => {
    const cur = readDismissed();
    cur.add(id);
    writeDismissed(cur);
    dismiss(id);
  }, [dismiss]);

  const scheduleAutoDismiss = useCallback((item: VisibleToast) => {
    if (item.sticky) return;
    const ms = AUTO_DISMISS_MS[item.severity];
    if (ms == null) return;
    const t = setTimeout(() => dismiss(item.id), ms);
    timersRef.current.set(item.id, t);
  }, [dismiss]);

  const push = useCallback((item: ToastItem) => {
    setItems((prev) => {
      // Dedupe by id. If the same id is already showing we re-prime
      // the auto-dismiss timer instead of stacking duplicates — that
      // matters when capability re-probes (R-62 future) re-emit the
      // same issue id during a single session.
      const existing = prev.find((t) => t.id === item.id);
      if (existing) {
        const prevTimer = timersRef.current.get(item.id);
        if (prevTimer) clearTimeout(prevTimer);
        const refreshed: VisibleToast = { ...existing, ...item, startedAt: Date.now() };
        scheduleAutoDismiss(refreshed);
        return prev.map((t) => (t.id === item.id ? refreshed : t));
      }
      const next: VisibleToast = { ...item, startedAt: Date.now() };
      scheduleAutoDismiss(next);
      return [...prev, next];
    });
  }, [scheduleAutoDismiss]);

  const clear = useCallback(() => {
    setItems([]);
    timersRef.current.forEach((t) => clearTimeout(t));
    timersRef.current.clear();
    hoveredRef.current.clear();
  }, []);

  useEffect(() => {
    if (registerHandle) registerHandle({ push, dismiss, clear });
  }, [registerHandle, push, dismiss, clear]);

  // Cleanup all timers on unmount.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  const onMouseEnter = useCallback((id: string) => {
    hoveredRef.current.add(id);
    const t = timersRef.current.get(id);
    if (t) {
      clearTimeout(t);
      timersRef.current.delete(id);
    }
  }, []);

  const onMouseLeave = useCallback((item: VisibleToast) => {
    hoveredRef.current.delete(item.id);
    // Re-schedule with the full duration. Computing the remaining
    // time would be nicer but requires tracking elapsed-while-shown
    // state; for capability toasts the user usually either dismisses
    // immediately or reads through the whole detail, so resetting is
    // adequate.
    scheduleAutoDismiss({ ...item, startedAt: Date.now() });
  }, [scheduleAutoDismiss]);

  if (items.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        maxWidth: 420,
        pointerEvents: 'none'
      }}
      role="region"
      aria-label="通知"
    >
      {items.map((it) => (
        <div
          key={it.id}
          role="alert"
          style={{
            background: SEVERITY_BG[it.severity],
            color: '#fff',
            borderRadius: 8,
            padding: '12px 14px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            display: 'flex',
            gap: 10,
            alignItems: 'flex-start',
            pointerEvents: 'auto',
            cursor: 'default'
          }}
          onMouseEnter={() => onMouseEnter(it.id)}
          onMouseLeave={() => onMouseLeave(it)}
        >
          <span aria-hidden style={{ fontSize: 18, lineHeight: '20px', flex: '0 0 auto' }}>
            {SEVERITY_ICON[it.severity]}
          </span>
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 14, lineHeight: '20px' }}>
              {it.title}
            </div>
            {it.detail ? (
              <div style={{ fontSize: 12, lineHeight: '18px', marginTop: 4, opacity: 0.92, whiteSpace: 'pre-wrap' }}>
                {it.detail}
              </div>
            ) : null}
            {it.docUrl ? (
              <div style={{ marginTop: 6 }}>
                <a
                  href={it.docUrl}
                  // R-62 — `setWindowOpenHandler` in main routes
                  // window.open() externals via shell.openExternal,
                  // but plain <a href> + click still triggers
                  // will-navigate. We rely on the existing main-side
                  // will-navigate handler to forward https:// URLs to
                  // the OS browser, so no extra wiring is needed
                  // here — just prevent the default in-app navigation.
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: '#fff', textDecoration: 'underline', fontSize: 12 }}
                >
                  了解更多 ↗
                </a>
              </div>
            ) : null}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '0 0 auto' }}>
            <button
              type="button"
              onClick={() => dismiss(it.id)}
              aria-label="关闭"
              style={{
                background: 'transparent',
                color: '#fff',
                border: '1px solid rgba(255,255,255,0.4)',
                borderRadius: 4,
                padding: '2px 8px',
                fontSize: 12,
                cursor: 'pointer'
              }}
            >
              关闭
            </button>
            {it.persistDismiss ? (
              <button
                type="button"
                onClick={() => persistDismiss(it.id)}
                title="不再为此应用提醒"
                style={{
                  background: 'transparent',
                  color: '#fff',
                  border: '1px solid rgba(255,255,255,0.4)',
                  borderRadius: 4,
                  padding: '2px 8px',
                  fontSize: 11,
                  cursor: 'pointer'
                }}
              >
                不再提醒
              </button>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
};

/* ----------------------- Hook for App ----------------------- */

/**
 * Convenience hook that owns a Toaster handle and exposes a stable
 * `push` / `clear` pair. Wire `<Toaster registerHandle={setHandle} />`
 * into your render tree and call `push(...)` from anywhere — the
 * handle ref ensures `push` doesn't recreate on every render.
 */
export function useToaster(): {
  handleSetter: (h: ToasterHandle) => void;
  push: (item: ToastItem) => void;
  pushCapability: (issue: CapabilityIssue) => void;
  clear: () => void;
} {
  const ref = useRef<ToasterHandle | null>(null);
  const handleSetter = useCallback((h: ToasterHandle) => {
    ref.current = h;
  }, []);
  return useMemo(() => ({
    handleSetter,
    push: (item) => ref.current?.push(item),
    pushCapability: (issue) => {
      const dismissed = getDismissedCaps();
      if (dismissed.has(issue.id)) return;
      ref.current?.push(capabilityIssueToToast(issue));
    },
    clear: () => ref.current?.clear()
  }), [handleSetter]);
}
