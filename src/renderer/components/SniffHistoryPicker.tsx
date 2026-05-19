/**
 * R-32 — Quick "recently sniffed URLs" picker.
 *
 * Anchored to the URL input row's ☰ trigger button (App owns the
 * trigger so it can position the popover relative to its own input
 * box). This component is a *controlled* popover: the parent owns
 * `open` + `entries` + `onPick` / `onRemove` / `onClear` / `onClose`.
 *
 * Interaction model:
 *  - Click a row → onPick(url). Parent decides what to fill into the
 *    input. We do NOT auto-trigger sniff (per R-32 design Q3).
 *  - Click the row's small "✕" → onRemove(url). The row disappears
 *    but the popover stays open so the user can keep curating.
 *  - Click the footer "清空" → confirm + onClear().
 *  - Esc / click outside → onClose().
 *
 * Visuals:
 *  - Row layout: title (1 line, ellipsis) on top, url (1 line,
 *    ellipsis, muted) below, then a meta footer with relative time
 *    + item count (e.g. "5 项").
 *  - When entries is empty we render a small "(无解析历史)" hint
 *    instead of a list (the parent should also disable the trigger
 *    button in that state, but we render defensively).
 */
import React, { useEffect, useRef } from 'react';
import type { SniffHistoryEntry } from './useSniffHistory';

export interface SniffHistoryPickerProps {
  open: boolean;
  entries: SniffHistoryEntry[];
  /** Called when the user picks a row. Parent should call setUrlInput
   *  and close this popover. */
  onPick: (url: string) => void;
  onRemove: (url: string) => void;
  onClear: () => void;
  onClose: () => void;
  /** R-80 — true while the SQLite read on first mount is in flight.
   *  Only affects the empty-state copy: a freshly-opened picker on
   *  first launch would otherwise read "(无解析历史)" before rows
   *  finish loading. */
  isLoading?: boolean;
}

function fmtRelative(ts: number, now: number = Date.now()): string {
  const dt = Math.max(0, now - ts);
  const sec = Math.round(dt / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} 天前`;
  // Beyond 30 days fall back to absolute.
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const SniffHistoryPicker: React.FC<SniffHistoryPickerProps> = ({
  open,
  entries,
  onPick,
  onRemove,
  onClear,
  onClose,
  isLoading
}) => {
  const ref = useRef<HTMLDivElement | null>(null);

  // Close on Esc or outside-click. We attach listeners only while
  // open so we don't leak handlers when the popover is dismissed.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (ref.current && !ref.current.contains(target)) {
        // Don't fire close if the click landed on the trigger button
        // — App's trigger is OUTSIDE this popover, but it already
        // calls onClose itself when toggled off, so the duplicate
        // close is a no-op. Either way the popover dismisses cleanly.
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    // Use mousedown so we close before a button inside the popover
    // re-renders the input — avoids a stale focus blip.
    document.addEventListener('mousedown', onDocClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDocClick);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="sniff-hist-popover" role="dialog" aria-label="解析历史" ref={ref}>
      <div className="sniff-hist-header">
        <span className="sniff-hist-title">解析历史</span>
        <span className="sniff-hist-count muted">{entries.length} / 30</span>
      </div>
      {entries.length === 0 ? (
        <div className="sniff-hist-empty muted">{isLoading ? '加载中…' : '(无解析历史)'}</div>
      ) : (
        <ul className="sniff-hist-list" role="listbox">
          {entries.map((e) => (
            <li
              key={e.url}
              className="sniff-hist-row"
              role="option"
              aria-selected={false}
              tabIndex={0}
              onClick={() => onPick(e.url)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault();
                  onPick(e.url);
                }
              }}
              title={e.url}
            >
              <div className="sniff-hist-row-main">
                <div className="sniff-hist-row-title">
                  {e.title || e.url}
                </div>
                {e.title ? (
                  <div className="sniff-hist-row-url muted">{e.url}</div>
                ) : null}
                <div className="sniff-hist-row-meta muted">
                  <span>{fmtRelative(e.ts)}</span>
                  {typeof e.itemCount === 'number' ? (
                    <>
                      <span aria-hidden="true"> · </span>
                      <span>{e.itemCount} 项</span>
                    </>
                  ) : null}
                </div>
              </div>
              <button
                type="button"
                className="sniff-hist-row-remove"
                aria-label={`从解析历史中删除 ${e.url}`}
                title="从解析历史中删除"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onRemove(e.url);
                }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {entries.length > 0 ? (
        <div className="sniff-hist-footer">
          <button
            type="button"
            className="sniff-hist-clear"
            onClick={() => {
              const ok =
                typeof window === 'undefined' ||
                window.confirm('清空全部解析历史?(只清解析记录,不影响处理历史与磁盘上的输出)');
              if (ok) onClear();
            }}
          >
            清空
          </button>
        </div>
      ) : null}
    </div>
  );
};
