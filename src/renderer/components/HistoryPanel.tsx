/**
 * R-27 → R-28 → R-30 → R-34 — History panel.
 *
 * R-30 #2: redesigned from a narrow single-column list (which was
 * compressed into a 360px sidebar by the home view's grid) into a
 * full-width responsive grid of large cards. Each card shows:
 *  - a fixed decorative cover (no per-record content);
 *  - title + page URL;
 *  - meta footer: time, item count, ✓done / ✗failed counts;
 *  - inline 打开目录 / 删除 actions.
 * Clicking the card body opens the HistoryDetailModal — same as
 * before, just no longer hidden behind a 250px-wide sliver.
 *
 * R-30 #4: the toolbar now has its own row above the grid with the
 * record count + tip on the left and the 清空历史 button on the right.
 *
 * R-34 — covers are now a fixed decorative placeholder. Previously
 * we ran a `pickCover` policy that, depending on the items, either
 * (a) loaded an HTTP poster URL, or (b) routed through <Thumb/> which
 * downloaded the media via IPC and ran ffmpeg to extract a frame.
 * Both paths were costly (network + ffmpeg + a "!" placeholder when
 * they failed) and added zero discoverability — users came to the
 * history tab to find a record by *title + URL + time*, not by a
 * thumbnail. Replacing the dynamic cover with a static one removes
 * the failure modes (poster 404 / poisoned cache / unresolved embed),
 * deletes a non-trivial amount of network and disk work on every
 * panel render, and makes the grid visually consistent.
 *
 * Re-run is intentionally still snapshot-based (see HistoryDetailModal
 * for the rationale). HistoryPanel is purely presentational and never
 * reads localStorage itself — the dependency graph stays one-way.
 */
import React from 'react';
import type { HistoryRecord } from './useHistory';

export interface HistoryPanelProps {
  history: HistoryRecord[];
  /** Open the detail modal for a record. App is responsible for
   *  showing the modal and wiring re-run callbacks. */
  onOpenDetail: (rec: HistoryRecord) => void;
  /** Open this record's batch output directory in the OS file
   *  manager. Caller is expected to have already called
   *  registerOutputDir during hydration. */
  onOpenOutputDir: (dir: string) => void;
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

/** R-34 — fixed decorative cover. Pure presentational, no per-record
 *  data dependencies. We render a small SVG film-strip glyph centred
 *  on a gradient panel; the visual is identical for every card so
 *  the eye scans the *title + meta* rather than the cover. */
function FixedCover(): React.ReactElement {
  return (
    <div className="hist-card-cover-fixed" aria-hidden="true">
      <svg
        className="hist-card-cover-icon"
        viewBox="0 0 48 48"
        width="48"
        height="48"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="6" y="10" width="36" height="28" rx="3" />
        <path d="M6 18h36M6 30h36M14 10v28M34 10v28" />
        <circle cx="24" cy="24" r="3" />
      </svg>
    </div>
  );
}

function HistoryCard(props: {
  rec: HistoryRecord;
  onOpenDetail: HistoryPanelProps['onOpenDetail'];
  onOpenOutputDir: HistoryPanelProps['onOpenOutputDir'];
  onRemove: HistoryPanelProps['onRemove'];
}): React.ReactElement {
  const { rec, onOpenDetail, onOpenOutputDir, onRemove } = props;
  // R-27 (post-review): single-pass tally so big histories stay snappy.
  let totalDone = 0;
  let totalFailed = 0;
  for (const s of Object.values(rec.taskStatus)) {
    if (s === 'done') totalDone++;
    else if (s === 'failed') totalFailed++;
  }
  return (
    <div
      className="hist-card"
      role="button"
      tabIndex={0}
      onClick={() => onOpenDetail(rec)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpenDetail(rec);
        }
      }}
      title="单击打开详情(在新窗口中查看 / 调参 / 重跑)"
    >
      <div className="hist-card-cover">
        <FixedCover />
        <span className="hist-card-count-badge">{rec.items.length} 项</span>
      </div>
      <div className="hist-card-body">
        <div className="hist-card-title" title={rec.title || rec.pageUrl}>
          {rec.title || rec.pageUrl}
        </div>
        <div className="hist-card-url" title={rec.pageUrl}>
          {rec.pageUrl}
        </div>
        <div className="hist-card-meta">
          <span className="hist-time" title={new Date(rec.createdAt).toISOString()}>
            {fmtTime(rec.createdAt)}
          </span>
          <span className="hist-card-stats">
            {totalDone > 0 ? <span className="hist-done">✓ {totalDone}</span> : null}
            {totalFailed > 0 ? <span className="hist-failed">✗ {totalFailed}</span> : null}
            {totalDone === 0 && totalFailed === 0 ? <span className="muted">未处理</span> : null}
          </span>
        </div>
      </div>
      <div className="hist-card-actions" onClick={(e) => e.stopPropagation()}>
        {rec.outputDir ? (
          <button
            type="button"
            className="hist-open-dir"
            onClick={() => onOpenOutputDir(rec.outputDir as string)}
            title="在文件管理器中打开此条记录的输出目录"
          >
            打开目录
          </button>
        ) : null}
        <button
          type="button"
          className="hist-remove"
          onClick={() => {
            // R-27 (post-review #7.1): symmetry with the toolbar
            // 全部清空 confirm — even though the produced files
            // survive on disk, dropping the record is irrecoverable
            // for the metadata so we keep the same confirm.
            const ok =
              typeof window === 'undefined' ||
              window.confirm('确定从历史中删除此条吗?磁盘上的输出目录不会被删。');
            if (ok) onRemove(rec.id);
          }}
          title="从历史中删除此条(磁盘上的输出目录不会被删)"
        >
          删除
        </button>
      </div>
    </div>
  );
}

export const HistoryPanel: React.FC<HistoryPanelProps> = ({
  history,
  onOpenDetail,
  onOpenOutputDir,
  onRemove,
  onClear
}) => {
  if (history.length === 0) {
    return (
      <div className="hist-panel">
        <div className="hist-toolbar">
          <span className="hist-count">0 / 30</span>
          <span className="hist-tip muted">
            还没有历史记录;每次嗅探或批处理完成后会自动出现在这里(最多保留 30 条)。
          </span>
        </div>
        <div className="hist-empty">
          <p>还没有历史记录</p>
          <p className="muted">嗅探一个 URL 后回到这里看看吧。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="hist-panel">
      <div className="hist-toolbar">
        <span className="hist-count">{history.length} / 30</span>
        <span className="hist-tip muted">单击卡片打开详情(可调参 / 重跑)</span>
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
      <div className="hist-grid">
        {history.map((rec) => (
          <HistoryCard
            key={rec.id}
            rec={rec}
            onOpenDetail={onOpenDetail}
            onOpenOutputDir={onOpenOutputDir}
            onRemove={onRemove}
          />
        ))}
      </div>
    </div>
  );
};
