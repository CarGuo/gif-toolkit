/**
 * R-45 — Upload-result modal.
 *
 * Originally a *post-batch* result panel: opened only after every job
 * settled, listing the markdown lines + a "复制全部" button.
 *
 * R-73 — Promoted to a live progress + result modal. The same component
 * now opens the moment `dispatchUpload` succeeds and updates as
 * `UploadProgress` events stream in. We render two stacked sections:
 *
 *   1) per-row live status list (always visible) — file name, status
 *      icon, percent bar (while uploading), URL link (when done),
 *      error text (when failed). Sourced directly from
 *      `record.items` so the same `applyProgressToRecord` folding
 *      already in place drives the UI.
 *
 *   2) markdown / html / bbcode / url copy block — only meaningful
 *      when at least one row reaches `done`. We keep it visible
 *      throughout the upload (greyed-out textarea while empty) so the
 *      user can grab partial results as they arrive instead of having
 *      to wait for the slowest upload in the batch.
 *
 * The header text (and aggregated status badges) re-renders to reflect
 * the live counts: "📤 上传中 · 7 / 12" while jobs are in flight,
 * "📤 上传完成" once everything settled, etc.
 *
 * Backdrop click is intentionally NOT a close hook anymore — a stray
 * mis-click while a 30 MB file is uploading shouldn't dismiss the
 * progress UI. Close still works via the × button or Escape.
 *
 * R-46 — Adds a format picker so the user can copy the result as
 * markdown / HTML <img> / BBCode / raw URL. The transformation is
 * done client-side (we keep the raw URL inside `UploadHistoryItem`
 * even when markdown is also stored, so re-formatting needs no
 * upload-history schema change).
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { UploadHistoryItem, UploadHistoryRecord, UploadStatus } from '../../shared/types';
import { backendLabel } from './useUploadHistory';

type CopyFormat = 'markdown' | 'html' | 'bbcode' | 'url';

const FORMAT_LABEL: Record<CopyFormat, string> = {
  markdown: 'Markdown',
  html: 'HTML <img>',
  bbcode: 'BBCode',
  url: '纯 URL'
};

/**
 * R-46 — Renderer-side formatter mirroring main's `formatMediaLink`.
 * We can't import the main-process util into the renderer bundle, but
 * the contract is straightforward enough that re-implementing in 12
 * lines is cheaper than threading another IPC. Keep these two impls
 * in lockstep; the main-side one has a unit test.
 */
function formatItem(it: UploadHistoryItem, format: CopyFormat): string {
  if (!it.url) return it.markdown || '';
  const fileName = it.fileName || 'file';
  const dot = fileName.lastIndexOf('.');
  const name = dot > 0 ? fileName.slice(0, dot) : fileName;
  switch (format) {
    case 'markdown':
      return it.markdown || `![${name.replace(/[[\]|`]/g, '')}](${it.url})`;
    case 'html': {
      const altRaw = name;
      const alt = altRaw.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const safeUrl = it.url.replace(/"/g, '&quot;');
      return `<img src="${safeUrl}" alt="${alt}" />`;
    }
    case 'bbcode':
      return `[img]${it.url}[/img]`;
    case 'url':
    default:
      return it.url;
  }
}

/** R-73 — Status icon + colour for a per-row badge. Pure helper so
 *  the unit test can assert "uploading rows render with a percent
 *  bar" without spinning up React. */
export function statusBadge(s: UploadStatus): { icon: string; color: string; label: string } {
  switch (s) {
    case 'done': return { icon: '✓', color: '#3fb950', label: '完成' };
    case 'failed': return { icon: '✗', color: '#ef5b6e', label: '失败' };
    case 'cancelled': return { icon: '⊘', color: '#a0a0a0', label: '取消' };
    case 'uploading': return { icon: '⟳', color: '#58a6ff', label: '上传中' };
    case 'pending':
    default: return { icon: '…', color: '#a0a0a0', label: '排队中' };
  }
}

/** R-73 — Header text given live counts. Pure for unit test. */
export function summarizeRecord(items: UploadHistoryItem[]): {
  done: number;
  failed: number;
  cancelled: number;
  inFlight: number;
  total: number;
  finished: boolean;
} {
  let done = 0; let failed = 0; let cancelled = 0; let inFlight = 0;
  for (const it of items) {
    if (it.status === 'done') done++;
    else if (it.status === 'failed') failed++;
    else if (it.status === 'cancelled') cancelled++;
    else inFlight++;
  }
  return { done, failed, cancelled, inFlight, total: items.length, finished: inFlight === 0 };
}

interface Props {
  record: UploadHistoryRecord;
  onClose: () => void;
}

export const UploadResultModal: React.FC<Props> = ({ record, onClose }) => {
  const [copied, setCopied] = useState(false);
  const [format, setFormat] = useState<CopyFormat>('markdown');

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const text = useMemo(() => record.items
    .filter((it) => it.url)
    .map((it) => formatItem(it, format))
    .join('\n')
  , [record.items, format]);

  const summary = useMemo(() => summarizeRecord(record.items), [record.items]);
  const headerTitle = summary.finished ? '上传完成' : '上传中';

  const copyAll = (): void => {
    if (!text) return;
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className="modal-backdrop"
      // R-73 — Don't dismiss on backdrop click; an accidental tap while
      // a 30 MB upload is in flight shouldn't tear down the progress
      // UI. × button + Escape remain as the explicit close paths.
      onClick={(e) => { if (summary.finished) onClose(); else e.stopPropagation(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }}
    >
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ background: 'var(--panel, #1e1f24)', color: 'var(--text, #ddd)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: 16, width: 720, maxHeight: '90vh', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 600 }}>📤 {headerTitle} · {backendLabel(record.backend)}</div>
          <button onClick={onClose} title={summary.finished ? '关闭' : '后台运行(关闭只是隐藏面板,上传不会中断)'}>关闭</button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          {summary.total} 项 · {summary.done} 成功
          {summary.failed ? ` · ${summary.failed} 失败` : ''}
          {summary.cancelled ? ` · ${summary.cancelled} 取消` : ''}
          {summary.inFlight ? ` · ${summary.inFlight} 进行中` : ''}
        </div>

        {/* R-73 — Per-row live progress list. Stays visible the whole
            time. Each row shows the file name, a status badge, and a
            percent bar while the row is uploading. Done rows show
            their URL inline; failed rows show the error string in
            red. The list scrolls internally so a 100-job batch
            doesn't blow out the modal height. */}
        <div
          style={{
            maxHeight: 260,
            overflowY: 'auto',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: 4,
            padding: 6,
            background: 'rgba(0,0,0,0.18)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4
          }}
        >
          {record.items.map((it) => {
            const badge = statusBadge(it.status);
            const showBar = it.status === 'uploading' || it.status === 'pending';
            const pct = typeof it.percent === 'number' ? it.percent : 0;
            return (
              <div
                key={it.jobId || it.filePath}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  padding: '4px 6px',
                  borderRadius: 3,
                  background: 'rgba(255,255,255,0.03)',
                  fontSize: 12
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: badge.color, width: 16, textAlign: 'center', fontWeight: 600 }} aria-label={badge.label}>
                    {badge.icon}
                  </span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={it.filePath}>
                    {it.fileName}
                    {it.reused ? <span style={{ marginLeft: 6, color: '#7ce7c1' }}>♻️ 复用</span> : null}
                  </span>
                  {showBar ? (
                    <span style={{ color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{pct.toFixed(0)}%</span>
                  ) : null}
                </div>
                {showBar ? (
                  <div style={{ height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${pct}%`, background: badge.color, transition: 'width 120ms linear' }} />
                  </div>
                ) : null}
                {it.status === 'done' && it.url ? (
                  <div style={{ color: '#7ce7c1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={it.url}>
                    {it.url}
                  </div>
                ) : null}
                {it.status === 'failed' && it.error ? (
                  <div style={{ color: '#ef5b6e', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={it.error}>
                    {it.error}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
          <span style={{ color: 'var(--muted)' }}>格式:</span>
          {(['markdown', 'html', 'bbcode', 'url'] as const).map((f) => (
            <label key={f} style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer' }}>
              <input type="radio" name="copy-format" checked={format === f} onChange={() => setFormat(f)} />
              {FORMAT_LABEL[f]}
            </label>
          ))}
        </div>
        <textarea readOnly value={text || (summary.finished ? '(暂无完成项)' : '(等待第一项完成…)')} style={{ flex: 1, minHeight: 120, padding: 10, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, background: 'rgba(0,0,0,0.25)', color: 'var(--text)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 4, resize: 'vertical' }} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="primary" onClick={copyAll} disabled={!text}>{copied ? '已复制 ✓' : `复制全部 (${FORMAT_LABEL[format]})`}</button>
        </div>
      </div>
    </div>
  );
};
