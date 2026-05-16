/**
 * R-27 — Read-only history panel.
 *
 * Design choices:
 * - List view with most-recent on top. Each row collapses to a one-line
 *   summary; click to expand and see every media item from that sniff.
 * - Per-record actions: 打开目录 (uses giftk.openOutputDir) + 删除.
 * - Per-item actions: 重跑 (calls back to App which re-dispatches a
 *   single SniffedMedia through onProcessOne) + 预览 (open the media
 *   url in the system browser via giftk.openOutputDir on the file path
 *   if it's a local output, else just shows the original url —
 *   intentionally simple, since the modal preview machinery requires
 *   live sniff state).
 * - "Re-run" intentionally re-uses the SAME ProcessOptions snapshotted
 *   at sniff time; this matches the user's mental model of "回到那次
 *   处理时的设置" rather than picking up the current form values.
 *
 * The component is purely presentational — it consumes a HistoryRecord[]
 * and a set of callbacks and never reads localStorage itself, which
 * keeps the dependency graph one-way (App owns the data, panel renders
 * it). Easier to test, easier to add Storybook later.
 */
import React, { useCallback, useState } from 'react';
import type { HistoryRecord } from './useHistory';
import type { SniffedMedia, TaskStatus } from '../../shared/types';

export interface HistoryPanelProps {
  history: HistoryRecord[];
  /** Open this record's batch output directory in the OS file
   *  manager. Caller is expected to have already called
   *  registerOutputDir during hydration. */
  onOpenOutputDir: (dir: string) => void;
  /** Re-dispatch a single media item through the normal processing
   *  pipeline using the snapshotted options. Caller decides whether
   *  to splice in the snapshotted options or the current form. */
  onReprocessOne: (rec: HistoryRecord, media: SniffedMedia) => void;
  /** Drop a single record. */
  onRemove: (id: string) => void;
  /** Wipe all records (with confirmation in the caller). */
  onClear: () => void;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function shortPath(p: string, max = 38): string {
  if (p.length <= max) return p;
  return '…' + p.slice(p.length - (max - 1));
}

function statusChip(s: TaskStatus | undefined): { label: string; color: string } {
  switch (s) {
    case 'done': return { label: '完成', color: 'var(--good)' };
    case 'failed': return { label: '失败', color: 'var(--bad)' };
    case 'cancelled': return { label: '已取消', color: 'var(--muted)' };
    case 'skipped': return { label: '跳过', color: 'var(--muted)' };
    case undefined: return { label: '未跑', color: 'var(--muted)' };
    default: return { label: s, color: 'var(--accent)' };
  }
}

function HistoryRow(props: {
  rec: HistoryRecord;
  expanded: boolean;
  onToggle(): void;
  onOpenOutputDir: HistoryPanelProps['onOpenOutputDir'];
  onReprocessOne: HistoryPanelProps['onReprocessOne'];
  onRemove: HistoryPanelProps['onRemove'];
}): React.ReactElement {
  const { rec, expanded, onToggle, onOpenOutputDir, onReprocessOne, onRemove } = props;
  const totalDone = Object.values(rec.taskStatus).filter((s) => s === 'done').length;
  const totalFailed = Object.values(rec.taskStatus).filter((s) => s === 'failed').length;
  const summary = (
    <div className="hist-summary">
      <span className="hist-time" title={new Date(rec.createdAt).toISOString()}>
        {fmtTime(rec.createdAt)}
      </span>
      <span className="hist-title" title={rec.pageUrl}>
        {rec.title || rec.pageUrl}
      </span>
      <span className="hist-counts">
        {rec.items.length} 项
        {totalDone > 0 ? <span className="hist-done"> · ✓ {totalDone}</span> : null}
        {totalFailed > 0 ? <span className="hist-failed"> · ✗ {totalFailed}</span> : null}
      </span>
    </div>
  );

  return (
    <div className={`hist-row ${expanded ? 'expanded' : ''}`}>
      <button
        type="button"
        className="hist-row-head"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="hist-caret" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        {summary}
      </button>
      {expanded ? (
        <div className="hist-row-body">
          <div className="hist-meta">
            <div className="hist-meta-row">
              <span className="hist-meta-label">URL</span>
              <a
                className="hist-meta-val link"
                href={rec.pageUrl}
                title={rec.pageUrl}
                onClick={(e) => {
                  e.preventDefault();
                  if (typeof window !== 'undefined') {
                    window.open(rec.pageUrl, '_blank', 'noopener,noreferrer');
                  }
                }}
              >
                {rec.pageUrl}
              </a>
            </div>
            {rec.outputDir ? (
              <div className="hist-meta-row">
                <span className="hist-meta-label">输出目录</span>
                <span className="hist-meta-val" title={rec.outputDir}>
                  {shortPath(rec.outputDir, 60)}
                </span>
                <button
                  type="button"
                  className="hist-open-dir"
                  onClick={() => onOpenOutputDir(rec.outputDir as string)}
                  title="在文件管理器中打开此条记录的输出目录"
                >
                  打开目录
                </button>
              </div>
            ) : (
              <div className="hist-meta-row hist-no-output">
                <span className="hist-meta-label">输出目录</span>
                <span className="hist-meta-val muted">尚未批处理</span>
              </div>
            )}
            <div className="hist-meta-row">
              <span className="hist-meta-label">参数</span>
              <span className="hist-meta-val muted">
                maxBytes {(rec.options.maxBytes / 1024 / 1024).toFixed(1)}MB ·
                maxWidth {rec.options.maxWidth} ·
                minSize {rec.options.minSize} ·
                fps {rec.options.fps} ·
                segCap {rec.options.maxSegmentSec}s
              </span>
            </div>
          </div>
          <table className="hist-items">
            <thead>
              <tr>
                <th>媒体</th>
                <th>状态</th>
                <th>产物</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rec.items.map((m) => {
                const st = rec.taskStatus[m.id];
                const chip = statusChip(st);
                const outs = rec.outputsByTaskId[m.id] || [];
                const reusable =
                  m.kind !== 'image' &&
                  (!m.requiresExternalDownload || !!m.resolved);
                return (
                  <tr key={m.id}>
                    <td className="hist-item-url" title={m.url}>
                      <span className={`pill ${m.kind}`}>{m.kind}</span>
                      {shortPath(m.url, 48)}
                    </td>
                    <td>
                      <span className="hist-status-chip" style={{ color: chip.color }}>
                        {chip.label}
                      </span>
                    </td>
                    <td className="hist-outputs">
                      {outs.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        outs.map((o) => (
                          <div key={o} className="hist-output-line" title={o}>
                            {shortPath(o, 50)}
                          </div>
                        ))
                      )}
                    </td>
                    <td className="hist-actions">
                      <button
                        type="button"
                        className="hist-rerun"
                        disabled={!reusable}
                        title={
                          reusable
                            ? '用本条记录当时的参数重新处理这一项'
                            : m.kind === 'image'
                              ? 'image 不支持处理'
                              : '该 embed 当时未解析直链,无法直接重跑'
                        }
                        onClick={() => onReprocessOne(rec, m)}
                      >
                        重跑
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="hist-row-foot">
            <button
              type="button"
              className="hist-remove"
              onClick={() => onRemove(rec.id)}
              title="从历史中删除此条(磁盘上的输出目录不会被删)"
            >
              删除此条
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export const HistoryPanel: React.FC<HistoryPanelProps> = ({
  history,
  onOpenOutputDir,
  onReprocessOne,
  onRemove,
  onClear
}) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const toggle = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  if (history.length === 0) {
    return (
      <div className="hist-empty">
        <p>还没有历史记录</p>
        <p className="muted">每次嗅探或批处理完成后会自动出现在这里(最多保留 30 条)。</p>
      </div>
    );
  }

  return (
    <div className="hist-panel">
      <div className="hist-toolbar">
        <span className="hist-count">{history.length} / 30</span>
        <div className="spacer" />
        <button
          type="button"
          className="hist-clear"
          onClick={() => {
            const ok = typeof window !== 'undefined'
              ? window.confirm('清空全部历史记录?磁盘上已生成的输出目录不会被删,但下次进入面板时它们不再出现。')
              : true;
            if (ok) onClear();
          }}
        >
          清空历史
        </button>
      </div>
      <div className="hist-list">
        {history.map((rec) => (
          <HistoryRow
            key={rec.id}
            rec={rec}
            expanded={expandedId === rec.id}
            onToggle={() => toggle(rec.id)}
            onOpenOutputDir={onOpenOutputDir}
            onReprocessOne={onReprocessOne}
            onRemove={onRemove}
          />
        ))}
      </div>
    </div>
  );
};
