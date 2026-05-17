/**
 * R-45 — Upload-history side panel.
 *
 * Reverse-chrono list of "upload batches". Each row shows the file
 * name + status + a quick "copy markdown" button when the upload
 * completed. Clicking a batch header opens a UploadResultModal that
 * shows the full markdown for the entire batch.
 */
import React, { useMemo, useState } from 'react';
import type { UploadHistoryRecord, UploadStatus } from '../../shared/types';
import { backendLabel } from './useUploadHistory';
import { UploadResultModal } from './UploadResultModal';

interface Props {
  history: UploadHistoryRecord[];
  onRemove: (id: string) => void;
  onClear: () => void;
}

export const UploadHistoryPanel: React.FC<Props> = ({ history, onRemove, onClear }) => {
  const [open, setOpen] = useState<UploadHistoryRecord | null>(null);

  if (history.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
        还没有上传记录。处理完产物后,点列表行尾的「上传」或顶部的「⚡ 上传所有产物」即可发到图床。
      </div>
    );
  }

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={onClear} title="清空全部上传历史">🗑 清空</button>
      </div>
      {history.map((rec) => (
        <UploadBatchCard key={rec.id} rec={rec} onOpen={() => setOpen(rec)} onRemove={() => onRemove(rec.id)} />
      ))}
      {open ? <UploadResultModal record={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
};

const UploadBatchCard: React.FC<{ rec: UploadHistoryRecord; onOpen: () => void; onRemove: () => void }> = ({ rec, onOpen, onRemove }) => {
  const counts = useMemo(() => {
    const c: Record<UploadStatus, number> = { pending: 0, uploading: 0, done: 0, failed: 0, cancelled: 0 };
    for (const it of rec.items) c[it.status] = (c[it.status] || 0) + 1;
    return c;
  }, [rec.items]);
  const total = rec.items.length;
  const pct = total > 0 ? Math.round(((counts.done + counts.failed + counts.cancelled) / total) * 100) : 0;

  return (
    <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, padding: 10, background: 'rgba(255,255,255,0.02)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>{new Date(rec.createdAt).toLocaleString()}</span>
          <span style={{ fontSize: 11, padding: '2px 6px', background: 'rgba(255,255,255,0.06)', borderRadius: 4 }}>
            {backendLabel(rec.backend)}
          </span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            {total} 项 · {counts.done} 成功{counts.failed ? ` · ${counts.failed} 失败` : ''}{counts.cancelled ? ` · ${counts.cancelled} 取消` : ''}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={onOpen} title="查看 markdown">查看</button>
          <button onClick={onRemove} title="删除该批">删除</button>
        </div>
      </div>
      {pct < 100 ? (
        <div style={{ marginTop: 6, height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${pct}%`, background: '#3aa0ff' }} />
        </div>
      ) : null}
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {rec.items.slice(0, 6).map((it) => (
          <UploadHistoryRow key={it.jobId} item={it} />
        ))}
        {rec.items.length > 6 ? <div style={{ fontSize: 11, color: 'var(--muted)' }}>…还有 {rec.items.length - 6} 项,点「查看」</div> : null}
      </div>
    </div>
  );
};

const UploadHistoryRow: React.FC<{ item: UploadHistoryRecord['items'][number] }> = ({ item }) => {
  const onCopyMd = (): void => {
    if (item.markdown) void navigator.clipboard.writeText(item.markdown);
  };
  const onCopyUrl = (): void => {
    if (item.url) void navigator.clipboard.writeText(item.url);
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
      <span style={{ width: 14 }}>{statusIcon(item.status)}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.fileName}>{item.fileName}</span>
      {item.status === 'done' && item.url ? (
        <>
          <button onClick={onCopyUrl} style={{ fontSize: 10, padding: '2px 6px' }} title="复制 URL">复制 url</button>
          {item.markdown ? (
            <button onClick={onCopyMd} style={{ fontSize: 10, padding: '2px 6px' }} title="复制 markdown">复制 md</button>
          ) : null}
        </>
      ) : null}
      {item.status === 'failed' && item.error ? (
        <span style={{ color: '#ef5b6e', fontSize: 11, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.error}>{item.error}</span>
      ) : null}
    </div>
  );
};

function statusIcon(s: UploadStatus): string {
  switch (s) {
    case 'pending': return '⏳';
    case 'uploading': return '↑';
    case 'done': return '✓';
    case 'failed': return '✖';
    case 'cancelled': return '⊘';
  }
}
