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
import React, { useEffect, useMemo, useState } from 'react';
import type { HistoryRecord } from './useHistory';
import { paginateHistory } from './useUploadHistory';

/** R-84 — Default page size for the snapshot history grid.
 *
 *  The hook caps `history` at HISTORY_MAX_ENTRIES (=30) for now, but
 *  pagination is still useful: a 4×3 grid (12 cards) reads as a single
 *  scannable page on a 1280-wide laptop, the user can jump back and
 *  forth without thumb-scrolling, and if we ever lift the 30-cap the
 *  panel won't suddenly explode. We re-use the upload-history
 *  paginateHistory helper (already covered by tests) so the two
 *  panels share clamp / pageCount / safePage semantics. */
export const HISTORY_PAGE_SIZE = 12;

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
  /** R-80 — true while the SQLite read on first mount is in flight.
   *  We render a distinct empty-state copy so users don't briefly
   *  see "还没有历史记录" before their actual rows appear. */
  isLoading?: boolean;
  /** Override the page size (defaults to {@link HISTORY_PAGE_SIZE}).
   *  Exposed for tests so they can render with a deterministic page size. */
  pageSize?: number;
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
  // R-WS-90 P5g — Three-stage status stepper.
  // 用户反馈"历史那里需要优化下,只嗅探 / 有处理过 / 有上传,
  // 要能一眼看出来"。我们直接从 record 自带数据出发计算 3 阶段
  // 状态(无任何额外 IPC),让卡片底部的三段胶囊 ✦ 嗅探 → ⚙️ 处理
  //  → ☁️ 上传 颜色化:active 段(已完成且至少有 1 项)用 accent
  // 系填色,inactive 段是中性 muted。这样:
  //   - 只嗅探未处理   → 仅第 1 段亮
  //   - 处理中/已处理  → 1+2 段亮
  //   - 已上传过      → 1+2+3 段亮
  // 三段配上各自的成功/失败计数,用户扫一眼就知道当前记录走到了
  // 哪一步,而不必点开详情。
  const sniffCount = rec.items.length;
  // 处理段:taskStatus 是权威 — done/failed 任一即代表"处理过"。
  // 注意 done==0 但 failed>0 也是"处理过(失败了)"。
  const processedDone = totalDone;
  const processedFailed = totalFailed;
  const processed = processedDone + processedFailed;
  // 上传段:uploadsByOutputPath 是 R-54 起的字段,key 是磁盘路径,
  // value.status 反映该输出文件最近一次上传的终态('done' / 'failed'
  // / 'cancelled')。"成功上传" = status === 'done' && url 非空;
  // "上传失败" = 'failed' / 'cancelled'。
  let uploadedDone = 0;
  let uploadedFailed = 0;
  if (rec.uploadsByOutputPath) {
    for (const u of Object.values(rec.uploadsByOutputPath)) {
      if (!u || typeof u !== 'object') continue;
      if (u.status === 'done' && typeof u.url === 'string' && u.url.length > 0) {
        uploadedDone++;
      } else if (u.status === 'failed' || u.status === 'cancelled') {
        uploadedFailed++;
      }
    }
  }
  const stages: Array<{
    key: 'sniff' | 'process' | 'upload';
    label: string;
    icon: string;
    active: boolean;
    detail: string;
    title: string;
  }> = [
    {
      key: 'sniff',
      label: '嗅探',
      icon: '✦',
      active: sniffCount > 0,
      detail: `${sniffCount}`,
      title: `已嗅探 ${sniffCount} 项媒体`
    },
    {
      key: 'process',
      label: '处理',
      icon: '⚙',
      active: processed > 0,
      detail:
        processedDone > 0 || processedFailed > 0
          ? `${processedDone}${processedFailed > 0 ? `/${processedFailed}✗` : ''}`
          : '—',
      title:
        processed === 0
          ? '未处理'
          : `已处理 ${processedDone} 项${processedFailed > 0 ? `,失败 ${processedFailed} 项` : ''}`
    },
    {
      key: 'upload',
      label: '上传',
      icon: '☁',
      active: uploadedDone > 0,
      detail:
        uploadedDone > 0 || uploadedFailed > 0
          ? `${uploadedDone}${uploadedFailed > 0 ? `/${uploadedFailed}✗` : ''}`
          : '—',
      title:
        uploadedDone === 0 && uploadedFailed === 0
          ? '未上传'
          : `已上传 ${uploadedDone} 项${uploadedFailed > 0 ? `,失败 ${uploadedFailed} 项` : ''}`
    }
  ];
  // 把整体阶段也挂到 card 上,这样 CSS 可以根据"最远到达的阶段"
  // 给整张卡微微上色(uploaded > processed > sniffed),进一步加
  // 强一眼可读性。
  const reachedStage: 'sniff' | 'process' | 'upload' = uploadedDone > 0
    ? 'upload'
    : processed > 0
      ? 'process'
      : 'sniff';
  return (
    <div
      className="hist-card"
      data-reached-stage={reachedStage}
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
        {/* R-WS-90 P5g — 3-stage stepper. 用户一眼可读最远阶段。 */}
        <div className="hist-card-stages" role="group" aria-label="处理阶段">
          {stages.map((s, i) => (
            <React.Fragment key={s.key}>
              <span
                className={`hist-stage hist-stage-${s.key} ${s.active ? 'is-active' : 'is-inactive'}`}
                title={s.title}
                aria-label={s.title}
              >
                <span className="hist-stage-icon" aria-hidden="true">{s.icon}</span>
                <span className="hist-stage-label">{s.label}</span>
                <span className="hist-stage-detail">{s.detail}</span>
              </span>
              {i < stages.length - 1 ? (
                <span
                  className={`hist-stage-connector ${stages[i + 1].active ? 'is-active' : 'is-inactive'}`}
                  aria-hidden="true"
                />
              ) : null}
            </React.Fragment>
          ))}
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
  onClear,
  isLoading,
  pageSize = HISTORY_PAGE_SIZE
}) => {
  // R-84 — pagination state.
  // Local-only (resets on remount) — when the user reopens the
  // history tab the most-recent page (page 1) is the right default.
  const [page, setPage] = useState(1);
  const { rows, pageCount, safePage } = useMemo(
    () => paginateHistory(history, page, pageSize),
    [history, page, pageSize]
  );
  // Walk the page back if the current one disappeared (last record on
  // the page deleted, or background clear shrank the list).
  useEffect(() => {
    if (safePage !== page) setPage(safePage);
  }, [safePage, page]);

  if (history.length === 0) {
    return (
      <div className="hist-panel">
        <div className="hist-toolbar">
          <span className="hist-count">0 / 30</span>
          <span className="hist-tip muted">
            {isLoading
              ? '正在从本地数据库加载历史…'
              : '还没有历史记录;每次嗅探或批处理完成后会自动出现在这里(最多保留 30 条)。'}
          </span>
        </div>
        <div className="hist-empty">
          <p>{isLoading ? '加载中…' : '还没有历史记录'}</p>
          {!isLoading ? <p className="muted">嗅探一个 URL 后回到这里看看吧。</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="hist-panel">
      <div className="hist-toolbar">
        <span className="hist-count">
          {history.length} / 30
          {pageCount > 1 ? <span className="muted"> · 第 {safePage} / {pageCount} 页</span> : null}
        </span>
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
        {rows.map((rec) => (
          <HistoryCard
            key={rec.id}
            rec={rec}
            onOpenDetail={onOpenDetail}
            onOpenOutputDir={onOpenOutputDir}
            onRemove={onRemove}
          />
        ))}
      </div>
      {/* R-84 — pagination controls. Only rendered when more than
          one page exists; mirrors UploadHistoryPanel's prev/next +
          jump-to-page interaction so the two history surfaces feel
          like one feature. */}
      {pageCount > 1 ? (
        <div
          className="hist-pager"
          role="navigation"
          aria-label="历史记录分页"
        >
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={safePage <= 1}
            aria-label="上一页"
            title="上一页"
          >
            ← 上一页
          </button>
          <span className="hist-pager-pos muted">
            {safePage} / {pageCount}
          </span>
          <button
            type="button"
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
              if (Number.isFinite(n)) {
                setPage(Math.max(1, Math.min(pageCount, Math.round(n))));
              }
            }}
            aria-label="跳转到页码"
            title="跳转到页码"
            className="hist-pager-jump"
          />
        </div>
      ) : null}
    </div>
  );
};
