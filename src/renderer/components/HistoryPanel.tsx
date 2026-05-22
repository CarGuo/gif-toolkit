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
import type { ToolboxKind, ToolboxParams } from '../../shared/types';

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
  /** R-COMPRESS-V1 — 点击卡片上的「☁ 上传」胶囊时跳转到上传历史
   *  tab 并打开此 record 关联的最新上传批次。当 record 还没有任何
   *  成功上传时不会被触发（CSS 把胶囊渲染成 inactive 不可点）。
   *  反查逻辑由 caller (App.tsx → ModalsHost) 实现并复用现有
   *  `rec.uploadsByOutputPath[*].url ∩ uploadHistory[*].items[*].url`
   *  集合相交策略；HistoryPanel 不直接读 uploadHistory，依旧保持
   *  单向数据流。可选 prop — 旧 caller 不传则胶囊回退为纯展示。 */
  onJumpToUploadHistory?: (rec: HistoryRecord) => void;
  /** R-COMPRESS-V1 #5 — 「推荐预设」chip 行的回调。当用户在嗅探历史
   *  卡片上点击「转 GIF · 快速」「转 GIF · 高质量」「压到 <5MB」
   *  「压到 <2MB」中的任意一个时，HistoryPanel 把 (rec, preset)
   *  抛给 caller，由 App.tsx 负责：
   *    1) 取 rec 第一个 done output 路径作为 inputPath；
   *    2) 切换 activeTab → '工具箱'；
   *    3) 调 toolbox.applyPreset({ inputPath, kind, params })。
   *  本组件仅决定 chip 集合（按第一个 done output 的扩展名分流：
   *  video → 转 GIF 两挡；gif/webp → 压到 5MB / 2MB），并在
   *  click 时 e.stopPropagation 防止误触整张卡片的 onOpenDetail。
   *  可选 prop —— 没传则不渲染 chip 行（旧 caller 兼容）。 */
  onApplyPreset?: (rec: HistoryRecord, preset: { kind: ToolboxKind; params: ToolboxParams }) => void;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** R-COMPRESS-V1 #5 — chip descriptor; `label` doubles as aria-label. */
interface PresetChip {
  label: string;
  kind: ToolboxKind;
  params: ToolboxParams;
}

const VIDEO_EXTS_FOR_PRESET = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v']);
const GIF_FAMILY_EXTS_FOR_PRESET = new Set(['.gif', '.webp']);

/** Decide chip set by inputPath extension. video → 转 GIF 两挡;
 *  gif/webp → 压到 5MB / 2MB; anything else → []. The two families
 *  are mutually exclusive: a chip click means "I want this exact
 *  kind+params", so we don't mix‐and‐match. */
export function pickPresetChipsForPath(inputPath: string | undefined | null): PresetChip[] {
  if (!inputPath || typeof inputPath !== 'string') return [];
  const dot = inputPath.lastIndexOf('.');
  if (dot < 0) return [];
  const ext = inputPath.slice(dot).toLowerCase();
  if (VIDEO_EXTS_FOR_PRESET.has(ext)) {
    return [
      { label: '转 GIF · 快速', kind: 'video-to-gif', params: { engine: 'ffmpeg' } },
      { label: '转 GIF · 高质量', kind: 'video-to-gif', params: { engine: 'gifski' } }
    ];
  }
  if (GIF_FAMILY_EXTS_FOR_PRESET.has(ext)) {
    return [
      { label: '压到 <5MB', kind: 'gif-optimize', params: { method: 'budget', maxBytes: 5 * 1024 * 1024 } },
      { label: '压到 <2MB', kind: 'gif-optimize', params: { method: 'budget', maxBytes: 2 * 1024 * 1024 } }
    ];
  }
  return [];
}

/** Pick the first done output path on a record, or null if none.
 *  Re-exported so App.tsx can mirror the same heuristic when
 *  forwarding chip clicks to toolbox.applyPreset. */
export function pickFirstDoneOutput(rec: HistoryRecord): string | null {
  const outputs = rec.outputsByTaskId || {};
  const status = rec.taskStatus || {};
  for (const taskId of Object.keys(outputs)) {
    if (status[taskId] !== 'done') continue;
    const list = outputs[taskId];
    if (Array.isArray(list) && list.length > 0 && typeof list[0] === 'string' && list[0]) {
      return list[0];
    }
  }
  return null;
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

/** R-COMPRESS-V1 #5 — Renders the「推荐预设」chip strip. Returns null
 *  when caller didn't wire onApplyPreset, when the record has no done
 *  outputs, or when the first done output's extension doesn't map to
 *  any preset family. Each chip stops propagation so a click never
 *  also triggers the surrounding card's onOpenDetail. */
function PresetChipStrip(props: {
  rec: HistoryRecord;
  onApplyPreset?: HistoryPanelProps['onApplyPreset'];
}): React.ReactElement | null {
  const { rec, onApplyPreset } = props;
  if (!onApplyPreset) return null;
  const firstOutput = pickFirstDoneOutput(rec);
  if (!firstOutput) return null;
  const chips = pickPresetChipsForPath(firstOutput);
  if (chips.length === 0) return null;
  return (
    <div className="hist-card-presets" role="group" aria-label="推荐预设">
      <span className="hist-card-presets-label muted" aria-hidden="true">推荐预设</span>
      {chips.map((chip) => (
        <button
          key={chip.label}
          type="button"
          className="hist-preset-chip"
          data-testid="hist-preset-chip"
          aria-label={`推荐预设:${chip.label}`}
          title={`一键预填工具箱:${chip.label}`}
          onClick={(e) => { e.stopPropagation(); onApplyPreset(rec, { kind: chip.kind, params: chip.params }); }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }}
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}

function HistoryCard(props: {
  rec: HistoryRecord;
  onOpenDetail: HistoryPanelProps['onOpenDetail'];
  onOpenOutputDir: HistoryPanelProps['onOpenOutputDir'];
  onRemove: HistoryPanelProps['onRemove'];
  onJumpToUploadHistory?: HistoryPanelProps['onJumpToUploadHistory'];
  onApplyPreset?: HistoryPanelProps['onApplyPreset'];
}): React.ReactElement {
  const { rec, onOpenDetail, onOpenOutputDir, onRemove, onJumpToUploadHistory, onApplyPreset } = props;
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
        {/* R-COMPRESS-V1 #5 — 「推荐预设」chip strip above the stepper. */}
        <PresetChipStrip rec={rec} onApplyPreset={onApplyPreset} />
        {/* R-WS-90 P5g — 3-stage stepper. 用户一眼可读最远阶段。
            R-COMPRESS-V1 — 上传段在「已成功上传 ≥1 项 且 caller 提供
            onJumpToUploadHistory」时升级为可点 button,直接跳转到上传
            历史 tab 并打开匹配批次。其他阶段保持纯展示。 */}
        <div className="hist-card-stages" role="group" aria-label="处理阶段">
          {stages.map((s, i) => {
            const isClickableUpload =
              s.key === 'upload' && uploadedDone > 0 && !!onJumpToUploadHistory;
            const stageClassName = `hist-stage hist-stage-${s.key} ${s.active ? 'is-active' : 'is-inactive'}${isClickableUpload ? ' is-clickable' : ''}`;
            const stageTitle = isClickableUpload
              ? `${s.title} — 点击跳转到上传历史`
              : s.title;
            const stageContent = (
              <>
                <span className="hist-stage-icon" aria-hidden="true">{s.icon}</span>
                <span className="hist-stage-label">{s.label}</span>
                <span className="hist-stage-detail">{s.detail}</span>
              </>
            );
            return (
              <React.Fragment key={s.key}>
                {isClickableUpload ? (
                  <button
                    type="button"
                    className={stageClassName}
                    title={stageTitle}
                    aria-label={stageTitle}
                    onClick={(e) => {
                      // Prevent the surrounding card's onClick (open detail
                      // modal) from firing — clicking the upload pill is a
                      // dedicated jump action and should NOT also open detail.
                      e.stopPropagation();
                      onJumpToUploadHistory!(rec);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.stopPropagation();
                      }
                    }}
                  >
                    {stageContent}
                  </button>
                ) : (
                  <span
                    className={stageClassName}
                    title={stageTitle}
                    aria-label={stageTitle}
                  >
                    {stageContent}
                  </span>
                )}
                {i < stages.length - 1 ? (
                  <span
                    className={`hist-stage-connector ${stages[i + 1].active ? 'is-active' : 'is-inactive'}`}
                    aria-hidden="true"
                  />
                ) : null}
              </React.Fragment>
            );
          })}
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
  pageSize = HISTORY_PAGE_SIZE,
  onJumpToUploadHistory,
  onApplyPreset
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
            onJumpToUploadHistory={onJumpToUploadHistory}
            onApplyPreset={onApplyPreset}
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
