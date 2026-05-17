/**
 * R-45 — Upload-result modal.
 *
 * Shows all markdown lines of a batch in a single textarea + a
 * "copy all" button. This is the central panel that pops up on batch
 * completion (per spec: "完成时弹中央面板").
 *
 * R-46 — Adds a format picker so the user can copy the result as
 * markdown / HTML <img> / BBCode / raw URL. The transformation is
 * done client-side (we keep the raw URL inside `UploadHistoryItem`
 * even when markdown is also stored, so re-formatting needs no
 * upload-history schema change).
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { UploadHistoryItem, UploadHistoryRecord } from '../../shared/types';
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

interface Props {
  record: UploadHistoryRecord;
  onClose: () => void;
}

export const UploadResultModal: React.FC<Props> = ({ record, onClose }) => {
  const [copied, setCopied] = useState(false);
  const [format, setFormat] = useState<CopyFormat>('markdown');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const text = useMemo(() => record.items
    .filter((it) => it.url)
    .map((it) => formatItem(it, format))
    .join('\n')
  , [record.items, format]);

  const failed = record.items.filter((it) => it.status === 'failed');
  const cancelled = record.items.filter((it) => it.status === 'cancelled');
  const inFlight = record.items.filter((it) => it.status === 'uploading' || it.status === 'pending');

  const copyAll = (): void => {
    if (!text) return;
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="modal-backdrop" onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ background: 'var(--panel, #1e1f24)', color: 'var(--text, #ddd)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: 16, width: 720, maxHeight: '90vh', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 600 }}>📤 上传结果 · {backendLabel(record.backend)}</div>
          <button onClick={onClose}>关闭</button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          {record.items.length} 项 · {record.items.filter((i) => i.status === 'done').length} 成功
          {failed.length ? ` · ${failed.length} 失败` : ''}
          {cancelled.length ? ` · ${cancelled.length} 取消` : ''}
          {inFlight.length ? ` · ${inFlight.length} 进行中` : ''}
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
        <textarea readOnly value={text || '(暂无完成项)'} style={{ flex: 1, minHeight: 220, padding: 10, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, background: 'rgba(0,0,0,0.25)', color: 'var(--text)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 4, resize: 'vertical' }} />
        {failed.length > 0 ? (
          <details style={{ fontSize: 12 }}>
            <summary style={{ color: '#ef5b6e', cursor: 'pointer' }}>失败 {failed.length} 项</summary>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {failed.map((it) => (
                <li key={it.jobId} style={{ marginTop: 4 }}>
                  <code>{it.fileName}</code>: <span style={{ color: '#ef5b6e' }}>{it.error || '(无错误信息)'}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="primary" onClick={copyAll} disabled={!text}>{copied ? '已复制 ✓' : `复制全部 (${FORMAT_LABEL[format]})`}</button>
        </div>
      </div>
    </div>
  );
};
