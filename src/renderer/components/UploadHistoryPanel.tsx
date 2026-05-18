/**
 * R-45 — Upload-history side panel.
 *
 * Reverse-chrono list of "upload batches". Each row shows the file
 * name + status + a quick "copy markdown" button when the upload
 * completed. Clicking a batch header opens a UploadResultModal that
 * shows the full markdown for the entire batch.
 *
 * R-54 — Pagination
 * -----------------
 * The previous version rendered every record in one go. With the
 * R-54 unbounded persistence (see useUploadHistory), a power user
 * can easily accumulate hundreds of records — rendering all of them
 * at once produces hundreds of expandable cards and chokes the
 * scrollbar. We page in fixed chunks (default 20 records / page)
 * with prev / next + jump-to-page controls. Page index is local-only
 * (resets on remount) — the user almost always wants the newest
 * page first, which is page 1 by definition.
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { UploadHistoryRecord, UploadStatus } from '../../shared/types';
import { backendLabel, paginateHistory, UPLOAD_HISTORY_PAGE_SIZE } from './useUploadHistory';
import { UploadResultModal } from './UploadResultModal';

interface Props {
  history: UploadHistoryRecord[];
  onRemove: (id: string) => void;
  onClear: () => void;
  /** Override the page size (defaults to {@link UPLOAD_HISTORY_PAGE_SIZE}).
   *  Exposed so tests can render a deterministic pagination size. */
  pageSize?: number;
}

export const UploadHistoryPanel: React.FC<Props> = ({ history, onRemove, onClear, pageSize = UPLOAD_HISTORY_PAGE_SIZE }) => {
  const [open, setOpen] = useState<UploadHistoryRecord | null>(null);
  const [page, setPage] = useState(1);

  // R-54 — when the user removes the last row of the current page,
  // step back instead of leaving them on an empty page. Same for a
  // background "clear" while a higher page was open.
  const { rows, pageCount, safePage } = useMemo(
    () => paginateHistory(history, page, pageSize),
    [history, page, pageSize]
  );
  useEffect(() => {
    if (safePage !== page) setPage(safePage);
  }, [safePage, page]);

  if (history.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
        还没有上传记录。处理完产物后,点列表行尾的「上传」或顶部的「⚡ 上传所有产物」即可发到图床。
      </div>
    );
  }

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>
          共 {history.length} 条 · 第 {safePage} / {pageCount} 页
        </span>
        <button onClick={onClear} title="清空全部上传历史">🗑 清空</button>
      </div>
      {rows.map((rec) => (
        <UploadBatchCard key={rec.id} rec={rec} onOpen={() => setOpen(rec)} onRemove={() => onRemove(rec.id)} />
      ))}
      {pageCount > 1 ? (
        <div
          role="navigation"
          aria-label="上传历史分页"
          style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 4 }}
        >
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={safePage <= 1}
            aria-label="上一页"
            title="上一页"
          >
            ← 上一页
          </button>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {safePage} / {pageCount}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            disabled={safePage >= pageCount}
            aria-label="下一页"
            title="下一页"
          >
            下一页 →
          </button>
          <input
            type="number"
            min={1}
            max={pageCount}
            value={safePage}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) setPage(Math.max(1, Math.min(pageCount, Math.round(n))));
            }}
            aria-label="跳转到页码"
            title="跳转到页码"
            style={{ width: 56 }}
          />
        </div>
      ) : null}
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        {/* R-64 — Header meta row.
            The previous version put 时间戳 + backend chip + counts + 操作按钮 in
            one nowrap flex row. When the Upload-History side panel was
            narrow (the user's screenshot was ~360px wide), the chips and
            counts collapsed onto multiple visual lines INSIDE each item
            because their inner span had default `whiteSpace: normal`.
            That produced "5/17/2026,\n5:40:31 PM" / "七牛\n云" / "1 项 · 1\n
            成功" stacks. Fix: every fixed-purpose inline label is now
            `whiteSpace: 'nowrap'`; the meta-block itself is allowed to
            wrap (`flexWrap: 'wrap'`) so the timestamp/chip/counts row
            and the action-buttons row can break instead of compressing
            their contents. minWidth: 0 on the flex child also stops the
            ellipsis from being applied INSIDE the timestamp. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 200px', minWidth: 0, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{new Date(rec.createdAt).toLocaleString()}</span>
          <span style={{ fontSize: 11, padding: '2px 6px', background: 'rgba(255,255,255,0.06)', borderRadius: 4, whiteSpace: 'nowrap' }}>
            {backendLabel(rec.backend)}
          </span>
          <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
            {total} 项 · {counts.done} 成功{counts.failed ? ` · ${counts.failed} 失败` : ''}{counts.cancelled ? ` · ${counts.cancelled} 取消` : ''}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
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
      {item.reused ? (
        <span
          title={`hash 命中,复用了上次的远程地址 (sha256 ${item.fileHash ? item.fileHash.slice(0, 8) + '…' : ''})`}
          style={{ fontSize: 10, color: '#7bd47b', padding: '1px 5px', background: 'rgba(123,212,123,0.12)', borderRadius: 4 }}
        >
          ♻️ 复用
        </span>
      ) : null}
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
