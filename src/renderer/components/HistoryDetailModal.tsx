/**
 * R-28 — History detail modal.
 *
 * Background:
 *   The first cut of R-27 used an inline expand/collapse row inside
 *   HistoryPanel for "see what's in this record + re-run a single
 *   item". That UI made the per-item 重跑 button the *only* affordance
 *   for working with historical media, which felt cramped — users
 *   wanted to re-tweak ProcessOptions, preview frames, force-allow
 *   small sides, batch-process a subset, etc., all the things the
 *   home view already supports. The user described that interaction
 *   as "太傻逼了" and asked for the home page experience to be reused.
 *
 * Design:
 *   - This modal opens when the user single-clicks a row in
 *     HistoryPanel. It covers the whole window (modal-mask + modal)
 *     so the user has the full home-page real estate to work with.
 *   - It renders the same MediaGrid + OptionsForm + TaskTable + LogBox
 *     stack the home view uses — the components are imported as-is, no
 *     forks. The only difference is that the URL is locked (it's
 *     whichever page this record was sniffed from) and the items list
 *     is the snapshotted rec.items rather than a live sniff.
 *   - State that **must** be local to the modal (so it doesn't fight
 *     the home view): `selected`, `options`, `previewing`. State that
 *     **must** be shared with the rest of the app (so the IPC layer
 *     keeps routing events correctly): `progress`, `processingOne`,
 *     `logs`. These are passed down as props from App.tsx.
 *
 * Why not a separate BrowserWindow?
 *   - A second BrowserWindow would force us to duplicate the preload
 *     bridge, hot-reload story, and the entire renderer state graph.
 *     The modal-overlay approach keeps a single state tree, makes
 *     re-runs trivially share the existing onProcessOne /
 *     dispatchBatch / onPreview plumbing, and reads as one logical
 *     "screen" that happens to be modal.
 *
 * Re-run flow:
 *   - For a single media item the user clicks 处理此项 (same as home),
 *     which calls onProcessOne(media) on App. App runs through the
 *     SAME onProcessOne path it uses for the home view, but pinned to
 *     this record via taskRecordMapRef so that progress events update
 *     this record's outputs/taskStatus instead of bleeding into the
 *     active home record.
 *   - For batch the modal asks App.dispatchBatchForRecord(rec, perId)
 *     (a thin wrapper around dispatchBatch that pins the record).
 *
 * Cancel:
 *   - The cancel button calls giftk.cancelAll, same as the home view —
 *     there's only one batch queue in the main process, so cancel is
 *     global by definition.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ProcessOptions,
  SniffedMedia,
  TaskProgress,
  TaskStatus
} from '../../shared/types';
import { MediaGrid } from './MediaGrid';
import { OptionsForm } from './OptionsForm';
import { ProgressDock } from './ProgressDock';
import { PreviewModal } from './PreviewModal';
import type { HistoryRecord } from './useHistory';
import { backendLabel } from './useUploadHistory';
import { useSessionLogs } from './useSessionLogs';
import type { SessionLogEntry } from '../../shared/types';

const giftk = (typeof window !== 'undefined' ? window.giftk : undefined);

// R-X — `HIST_DETAIL_LOGS_VISIBLE_KEY` (the persisted in-memory log
// toggle) was retired together with the duplicate dock log button.
// SessionLogPanel pop-up is now the only log surface in this modal.

export interface HistoryDetailModalProps {
  rec: HistoryRecord;
  /** Live progress map shared with the rest of the app. The modal
   *  filters to only its own record's media ids before rendering the
   *  TaskTable, so progress from the home view never bleeds in. */
  progress: Record<string, TaskProgress>;
  /** Same predicate the home view uses; we forward it through to
   *  MediaGrid so the per-card "处理此项 / 处理中" button is correct. */
  isProcessing: (id: string) => boolean;
  /** Re-dispatch a single media item, pinned to this record. */
  onProcessOneFromRecord: (rec: HistoryRecord, media: SniffedMedia) => void;
  /** Re-dispatch the user's selected subset as a batch, pinned to
   *  this record. The modal only ever calls this with a non-empty
   *  selection (batch button is disabled otherwise). */
  onBatchFromRecord: (
    rec: HistoryRecord,
    medias: SniffedMedia[],
    options: ProcessOptions
  ) => void;
  /** Cancel any running batch (global to the main-process queue). */
  onCancel: () => void;
  /** Open the record's output directory in the OS file manager. */
  onOpenOutputDir: (dir: string) => void;
  /** Close the modal without aborting in-flight work. */
  onClose: () => void;
  /** R-X — Deprecated: previously surfaced as a filtered LogStream
   *  inside a dock toggle. Now ignored — the history detail uses
   *  SessionLogPanel (DB-backed session_log_entries) as its only log
   *  surface. Kept in the prop shape so existing callers in App.tsx
   *  compile without an immediate refactor. Safe to delete once all
   *  call sites stop passing it. */
  logs?: string[];
  /** R-29 (P0-C): live taskId → owning record id map. The modal uses
   *  this to confirm that a progress entry for `media.id` actually
   *  belongs to *this* record before rendering it, so a same-id task
   *  running for a different record (home view, another history
   *  modal session) cannot bleed into this TaskTable. Optional for
   *  back-compat; unfiltered fallback is the previous behaviour. */
  taskRecordMap?: Map<string, string>;
  /**
   * R-54 — Upload one output file (or a list of them) from this
   * record. Optional so older callers compile; when omitted the
   * upload section is read-only (just displays past results). The
   * App-side wrapper pipes `recordId = rec.id` through to
   * `dispatchUpload` so the upload-progress handler can patch
   * `rec.uploadsByOutputPath` when each upload settles.
   */
  onUploadFromRecord?: (
    rec: HistoryRecord,
    plan: Array<{ media: SniffedMedia; filePath: string }>
  ) => void;
  /** R-54 — `true` when the upload IPC is wired AND the active
   *  backend has all required fields. Surfacing it as a prop avoids
   *  the modal having to reach into App.tsx state to check. */
  isUploadConfigured?: boolean;
}

export const HistoryDetailModal: React.FC<HistoryDetailModalProps> = ({
  rec,
  progress,
  isProcessing,
  onProcessOneFromRecord,
  onBatchFromRecord,
  onCancel,
  onOpenOutputDir,
  onClose,
  // R-X — `logs` accepted in the prop shape but intentionally not
  // destructured: the history detail no longer renders an in-memory
  // LogStream view. Removing the binding keeps lint quiet about an
  // unused parameter while preserving the prop for existing callers.
  taskRecordMap,
  onUploadFromRecord,
  isUploadConfigured = false
}) => {
  // Modal-local state. We seed `options` from the snapshot at first
  // open so the user sees the same parameters they used when they
  // originally processed this page — they can edit freely; their edits
  // stay scoped to this modal and never leak back into App's home
  // form. Re-running a single item still uses the snapshot (mental
  // model: "重跑 = 还原当时设置"), but the batch button uses the
  // live edited options so this form has a purpose.
  const [options, setOptions] = useState<ProcessOptions>(() => ({
    ...rec.options
  }));
  // Default selection mirrors the home view — preselect every
  // processable item (video / gif) that has a usable source. Embed
  // items without a resolved direct URL stay unselected; the user can
  // tick them once a fresh resolve completes.
  const [selected, setSelected] = useState<Set<string>>(() => {
    const next = new Set<string>();
    for (const m of rec.items) {
      if (m.kind !== 'video' && m.kind !== 'gif') continue;
      if (m.requiresExternalDownload && !m.resolved) continue;
      next.add(m.id);
    }
    return next;
  });
  const [activeId, setActiveId] = useState<string | null>(null);

  // R-X — In-memory LogStream toggle (the home view's "📋 日志 ▸"
  // overlay) is intentionally NOT exposed here. The history detail
  // already owns a richer log channel via SessionLogPanel pulling
  // from session_log_entries in the DB, so a second toggle would
  // either show a duplicate or — when the in-memory buffer is empty
  // (which it usually is once the modal opens after the run) — open
  // an empty overlay and look broken. The R-79b state and persisted
  // `giftk.histDetail.logsVisible` key were removed with that toggle.

  // R-29 (P0-D): the embedded PreviewModal needs its own copy of the
  // options so per-item tweaks (cropRect, startSec/endSec, etc.) made
  // while previewing don't trample the modal's batch-form options
  // and, more importantly, don't get cleared every time the user
  // switches to a different card (which would re-render PreviewModal
  // with a fresh `options` reference and erase their crop / range
  // edits). We seed it lazily when a card is opened and keep it in
  // sync with the *modal* options on first open only.
  const [previewOptions, setPreviewOptions] = useState<ProcessOptions | null>(null);
  useEffect(() => {
    if (activeId) {
      // Seed the preview-local copy with the current modal options
      // when transitioning from "no card open" → "card open". We
      // intentionally do NOT reset on every activeId change (only on
      // null → non-null) so swapping between cards preserves prior
      // crop / segment edits the user just made — that's the whole
      // point of P0-D.
      setPreviewOptions((cur) => cur ?? { ...options });
    } else {
      // Card closed → drop the local copy so the next open starts
      // fresh from the (possibly newly-edited) modal options.
      setPreviewOptions(null);
    }
    // We deliberately omit `options` from deps: we don't want every
    // form keystroke to clobber the user's preview edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // Esc-to-close, mirroring PreviewModal / BatchSegmentModal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (activeId) {
          setActiveId(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, activeId]);

  const toggleSelected = useCallback((id: string) => {
    // Same guard as App.toggleSelected (R-28 #1): an embed without a
    // resolved direct URL cannot be batched even if "ticked", so we
    // refuse the toggle to keep the affordance honest.
    const m = rec.items.find((it) => it.id === id);
    if (m && m.requiresExternalDownload && !m.resolved) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, [rec.items]);

  const openCard = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  // Filter the global progress map down to ONLY this record's media
  // ids AND only progress entries that the task→record map confirms
  // belong to this record. R-29 (P0-C): without the map check, a
  // same-id task running for the home view (or another history
  // re-run) would draw a row here too because media.id is derived
  // from the URL — duplicate URLs across records collide. The map
  // is the source of truth: an entry with no map binding (because
  // the task was dispatched before the modal opened) falls back to
  // "show it" so we don't regress the simple single-record case.
  const recordProgress = useMemo<Record<string, TaskProgress>>(() => {
    const out: Record<string, TaskProgress> = {};
    for (const m of rec.items) {
      const p = progress[m.id];
      if (!p) continue;
      if (taskRecordMap) {
        const owner = taskRecordMap.get(m.id);
        // owner === undefined means there's no live binding — the
        // task may have terminated already (binding was cleared on
        // its terminal emit), in which case showing the cached
        // terminal status is correct. owner !== rec.id means the
        // task is currently bound to a *different* record → skip.
        if (owner !== undefined && owner !== rec.id) continue;
      }
      out[m.id] = p;
    }
    return out;
  }, [progress, rec.items, rec.id, taskRecordMap]);

  // R-29 (P0-C): mirror the same filter for isProcessing. Without
  // this, a card in the modal could show "处理中" because the global
  // predicate sees a same-id task running for another record.
  const isProcessingScoped = useCallback(
    (id: string): boolean => {
      if (taskRecordMap) {
        const owner = taskRecordMap.get(id);
        if (owner !== undefined && owner !== rec.id) return false;
      }
      return isProcessing(id);
    },
    [isProcessing, rec.id, taskRecordMap]
  );

  // R-30 #3: per-card status chip on the embedded MediaGrid. Live
  // progress wins over the persisted snapshot (so a re-running task
  // immediately flips its chip from done → running → done/failed),
  // and recordProgress is already correctly scoped to *this* record
  // via P0-C. We fall back to the record's persisted taskStatus for
  // items the user hasn't re-run since the original batch — that's
  // exactly the case the user reported (✓3 / ✗1 visible in the panel
  // but invisible in the detail modal).
  const cardStatusMap = useMemo<Record<string, TaskStatus>>(() => {
    const out: Record<string, TaskStatus> = {};
    for (const m of rec.items) {
      const live = recordProgress[m.id];
      if (live) {
        out[m.id] = live.status;
      } else if (rec.taskStatus[m.id]) {
        out[m.id] = rec.taskStatus[m.id];
      }
    }
    return out;
  }, [rec.items, rec.taskStatus, recordProgress]);

  // R-X — `recordLogs` (filtered slice of the home view's in-memory
  // LogStream) was removed along with the duplicate "📋 日志 ▸" dock
  // toggle. The history detail's only log surface is now the
  // SessionLogPanel which queries session_log_entries directly.

  // Live items for MediaGrid — re-derive `resolved` from the
  // snapshotted record, since these don't go through resolveEmbed
  // again inside the modal. (If the user wants to re-resolve, the
  // simplest path is to close the modal and re-sniff the page on the
  // home view; doing it inline would require a real second sniff run
  // and risks leaving the record's snapshot in an inconsistent
  // state.)
  const items = rec.items;

  const processable = useMemo(() => items.filter((m) =>
    selected.has(m.id) &&
    (m.kind === 'video' || m.kind === 'gif') &&
    (!m.requiresExternalDownload || !!m.resolved)
  ), [items, selected]);

  const onStartBatch = useCallback(() => {
    if (processable.length === 0) return;
    onBatchFromRecord(rec, processable, options);
  }, [processable, rec, options, onBatchFromRecord]);

  const activeMedia = useMemo(
    () => (activeId ? items.find((m) => m.id === activeId) ?? null : null),
    [activeId, items]
  );

  return (
    <div
      className="modal-mask hist-detail-mask"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="历史记录详情"
    >
      <div className="modal hist-detail-modal">
        <div className="modal-header">
          <span className="badge gif" aria-hidden>历史</span>
          <span className="modal-title-text" title={rec.pageUrl}>
            {rec.title || rec.pageUrl}
          </span>
          {rec.outputDir ? (
            <button
              type="button"
              className="hist-open-dir"
              style={{ marginLeft: 8 }}
              onClick={() => onOpenOutputDir(rec.outputDir as string)}
              title="在文件管理器中打开输出目录"
            >
              打开目录
            </button>
          ) : null}
          <span className="modal-header-spacer" />
          <span className="modal-esc-hint">ESC 关闭</span>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </div>

        <div className="modal-body" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div className="layout" style={{ flex: 1, minHeight: 0 }}>
            <div className="left">
              {/* R-X — Mirror the home view layout: left column is a
                  pure control panel (source + options) that scrolls
                  as one column. ProgressDock + session log were moved
                  to the bottom of the right column so the geometry
                  matches what users see on the home page. */}
              <div className="hist-detail-modal-cards">
              <div className="card">
                <h2>来源</h2>
                <div style={{ fontSize: 12, color: 'var(--muted)', wordBreak: 'break-all' }}>
                  {rec.pageUrl}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                  共 {rec.items.length} 项 · 创建于{' '}
                  {new Date(rec.createdAt).toLocaleString()}
                </div>
              </div>

              <div className="card">
                <h2>处理参数</h2>
                <OptionsForm value={options} onChange={setOptions} />
                <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button
                    className="primary"
                    onClick={onStartBatch}
                    disabled={processable.length === 0}
                    title={processable.length === 0 ? '请先在右侧勾选 video / gif' : '用上面的参数批量重跑'}
                  >
                    ▶ 重跑选中 ({processable.length}{selected.size !== processable.length ? ` / 共选 ${selected.size}` : ''})
                  </button>
                  <button onClick={onCancel}>取消</button>
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8, lineHeight: 1.5 }}>
                  提示:单条卡片的 处理此项 始终使用本条记录原始参数(即 &quot;重跑&quot;);批量重跑使用上方编辑后的参数。
                </div>
              </div>
              </div>
            </div>

            <div className="right">
              <div className="grid-pane">
                <div className="grid-header">
                  <h2>媒体清单 ({items.length})</h2>
                  <span className="grid-tip">单击卡片预览 · 勾选后批量重跑</span>
                </div>
                <div className="grid-scroll">
                  <MediaGrid
                    items={items}
                    selected={selected}
                    onToggle={toggleSelected}
                    onOpen={openCard}
                    onProcessOne={(id) => {
                      const m = items.find((it) => it.id === id);
                      if (m) onProcessOneFromRecord(rec, m);
                    }}
                    isProcessing={isProcessingScoped}
                    taskStatusMap={cardStatusMap}
                  />
                </div>
              </div>
              {/* R-X — ProgressDock + session log moved out of the left
                  column so the modal mirrors the home page geometry
                  (media grid on top, dock pinned at the bottom of the
                  right column). The session log entry is folded into
                  the dock toolbar via `headerExtras` so we don't grow
                  a third visual stripe under the dock — keeps the
                  layout flat and identical to home.

                  R-X — Do NOT pass `logs / logsVisible / onToggleLogs`
                  here. Those props would make ProgressDock auto-render
                  its own home-style "📋 日志 ▸" toggle on the right
                  side of the toolbar, in addition to our session log
                  button injected via headerExtras. The home overlay is
                  fed by an in-memory string buffer that the history
                  detail does not maintain (its log channel is the
                  session_log_entries table, queried by SessionLogPanel)
                  so the home toggle would just open an empty overlay
                  and look broken. One entry only: 📋 查看日志 (N). */}
              <ProgressDock
                title="处理进度"
                items={items}
                progress={recordProgress}
                onRetry={(m) => onProcessOneFromRecord(rec, m)}
                onForceAllow={(m) => onProcessOneFromRecord(rec, m)}
                headerExtras={
                  rec.sessionId ? (
                    <SessionLogPanel
                      sessionId={rec.sessionId}
                      suggestedName={rec.title || rec.pageUrl || `session-${rec.sessionId}`}
                    />
                  ) : null
                }
                uploadsSlot={
                  <UploadsSection
                    rec={rec}
                    onUpload={onUploadFromRecord}
                    uploadConfigured={isUploadConfigured}
                  />
                }
              />
            </div>
          </div>
        </div>
      </div>

      {activeMedia ? (
        <PreviewModal
          media={activeMedia}
          baseOptions={previewOptions ?? options}
          // P1.2 — HistoryDetailModal already isolates the WHOLE ProcessOptions
          // into `previewOptions`. To match PreviewModal's new contract we feed
          // crop / start / end edits through a synthetic override that simply
          // patches the same local copy. The home-page global options stay
          // untouched (HistoryDetailModal never had write access to them).
          previewOverride={{
            cropRect: (previewOptions ?? options).cropRect,
            startSec: (previewOptions ?? options).startSec,
            endSec: (previewOptions ?? options).endSec,
            // R-22 — surface selectedSegments from the local preview copy so
            // the SegmentPicker chips reflect any pick the user already made
            // for the active media in this session.
            selectedSegments: (previewOptions ?? options).selectedSegments
          }}
          onChangeOverride={(next) => {
            setPreviewOptions((cur) => {
              const base = cur ?? { ...options };
              return {
                ...base,
                cropRect: next.cropRect,
                startSec: next.startSec,
                endSec: next.endSec,
                // R-22 — `undefined` means "no explicit pick": for short
                // videos this leaves the option absent, for long videos
                // the processor falls back to its own default. We
                // intentionally write the value verbatim rather than
                // collapsing empty arrays — PreviewModal already maps
                // empty selections to undefined before calling us.
                selectedSegments: next.selectedSegments
              };
            });
          }}
          onChangeOptions={(updater) => {
            // R-29 (P0-D): write to the local preview copy ONLY.
            // Edits stay scoped to the preview session and never
            // leak into the modal's batch-form options.
            setPreviewOptions((cur) => {
              const base = cur ?? { ...options };
              return typeof updater === 'function'
                ? (updater as (p: ProcessOptions) => ProcessOptions)(base)
                : updater;
            });
          }}
          onRequestPreview={() => {
            // The history modal does not own a fresh sniff, so live
            // preview frame extraction is not wired here. We hand the
            // user the option to close the modal and use the home
            // view's full preview flow instead. Calling giftk.preview
            // directly would work for *local* outputs but is brittle
            // for embed sources whose resolved url may have expired.
            if (typeof window !== 'undefined') {
              window.alert('详细预览仅在主页可用,请关闭此窗口后从最近的嗅探结果中查看。');
            }
          }}
          previewing={false}
          preview={null}
          onClose={() => setActiveId(null)}
          onProcessOne={(m) => onProcessOneFromRecord(rec, m)}
          processOneDisabled={
            isProcessingScoped(activeMedia.id) ||
            activeMedia.kind === 'image' ||
            (!!activeMedia.requiresExternalDownload && !activeMedia.resolved)
          }
        />
      ) : null}
    </div>
  );
};

// Suppress an unused-var warning when the giftk handle is unused in
// this build (e.g. type-check-only). The constant exists so a future
// inline preview / cancel-by-record could call into the bridge
// without re-importing.
void giftk;

/* ------------------------- R-54: UploadsSection -------------------------- */

/**
 * R-54 — Show every produced output file's upload state inside the
 * sniff-history detail modal. Per the user's product feedback, the
 * 嗅探 history *MUST* surface upload outcomes so users can answer
 * "where did this gif go?" without bouncing to the upload-history
 * tab. Three presentational concerns:
 *
 *   1. List every output file across all tasks of `rec`. We walk
 *      `rec.outputsByTaskId` (insertion-stable Object) and flatten.
 *   2. For each file, look up `rec.uploadsByOutputPath?.[path]` and
 *      render either ☁ url+md+复用 badge (done) or ✖ error (failed)
 *      or a 「📤 上传」 button (no record yet).
 *   3. Bulk action: 「⚡ 一键上传未传产物」 — collects every output
 *      that's not yet in `done` state and dispatches them in a single
 *      batch. Disabled when nothing's pending OR no upload backend
 *      configured.
 *
 * Pure-presentational: receives an `onUpload` callback the parent
 * piped down, so the modal stays decoupled from the dispatchUpload
 * implementation in App.tsx.
 *
 * R-79b — Visual rewrite. The previous build used inline `style={…}`
 * for every node, which gave a jarring "stuck-on UI block" look that
 * didn't match the rest of the modal. We now route everything through
 * `.upload-section` / `.upload-row` / `.ghost` classes in styles.css,
 * so the section uses the same design tokens (--bg-2 / --border /
 * --muted / --good / --bad) and button styling as the home view's
 * bottom toolbar. Functional behaviour is unchanged — the same
 * onUpload callback, the same enable/disable logic, the same bulk
 * action.
 */
const UploadsSection: React.FC<{
  rec: HistoryRecord;
  onUpload?: (rec: HistoryRecord, plan: Array<{ media: SniffedMedia; filePath: string }>) => void;
  uploadConfigured: boolean;
}> = ({ rec, onUpload, uploadConfigured }) => {
  // Flatten outputs keeping a stable order: by task id then by
  // emit-order array index. We index back into rec.items to attach a
  // SniffedMedia handle for the upload dispatch.
  const flat = useMemo(() => {
    const rows: Array<{ media: SniffedMedia; filePath: string }> = [];
    for (const m of rec.items) {
      const outs = rec.outputsByTaskId[m.id];
      if (!outs || outs.length === 0) continue;
      for (const p of outs) {
        rows.push({ media: m, filePath: p });
      }
    }
    return rows;
  }, [rec]);

  const pendingPlan = useMemo(() => {
    const ups = rec.uploadsByOutputPath || {};
    return flat.filter((r) => {
      const u = ups[r.filePath];
      return !u || u.status !== 'done';
    });
  }, [flat, rec.uploadsByOutputPath]);

  if (flat.length === 0) {
    return null;
  }

  const onUploadAllPending = (): void => {
    if (!onUpload) return;
    if (pendingPlan.length === 0) return;
    onUpload(rec, pendingPlan);
  };

  const ups = rec.uploadsByOutputPath || {};
  const allUploadDone = pendingPlan.length === 0;
  const bulkTitle = !onUpload
    ? '当前会话不支持上传'
    : !uploadConfigured
      ? '当前图床尚未配置完整,先去「📤 上传设置」里配置'
      : allUploadDone
        ? '本记录的所有产物都已上传'
        : `把本记录里 ${pendingPlan.length} 个未上传的产物全部派发到当前默认图床`;

  return (
    <div className="upload-section" role="region" aria-label="上传记录">
      <div className="upload-section-header">
        <span className="upload-section-title">📤 上传记录</span>
        <span className="upload-section-meta">
          {flat.length} 个产物 · {flat.length - pendingPlan.length} 已上传 / {pendingPlan.length} 未传
        </span>
        <span className="upload-section-spacer" />
        <button
          type="button"
          className="ghost"
          onClick={onUploadAllPending}
          disabled={!onUpload || !uploadConfigured || allUploadDone}
          aria-disabled={!onUpload || !uploadConfigured || allUploadDone}
          title={bulkTitle}
        >
          ⚡ 一键上传未传产物
        </button>
      </div>
      <div className="upload-section-list">
        {flat.map((row) => {
          const u = ups[row.filePath];
          const fileName = row.filePath.split(/[\\/]/).pop() || row.filePath;
          const onCopyUrl = (): void => {
            if (u?.url) void navigator.clipboard.writeText(u.url);
          };
          const onCopyMd = (): void => {
            if (u?.markdown) void navigator.clipboard.writeText(u.markdown);
          };
          const onUploadOne = (): void => {
            if (!onUpload) return;
            onUpload(rec, [row]);
          };
          const iconClass =
            u?.status === 'done' ? 'done'
              : u?.status === 'failed' ? 'failed'
                : u?.status === 'cancelled' ? 'cancelled'
                  : '';
          const iconText =
            u?.status === 'done' ? '☁'
              : u?.status === 'failed' ? '✖'
                : u?.status === 'cancelled' ? '⊘'
                  : '·';
          return (
            <div key={row.filePath} className="upload-row">
              <span className={`upload-row-icon ${iconClass}`} aria-hidden>
                {iconText}
              </span>
              <span className="upload-row-name" title={row.filePath}>
                {fileName}
              </span>
              {u && u.status === 'done' && u.url ? (
                <>
                  <span
                    className="upload-row-backend"
                    title={`已上传到 ${backendLabel(u.backend)} · ${new Date(u.uploadedAt).toLocaleString()}`}
                  >
                    {backendLabel(u.backend)}
                  </span>
                  {u.reused ? (
                    <span
                      className="upload-row-reused"
                      title={`hash 命中,复用了上次的远程地址${u.fileHash ? ` (sha ${u.fileHash.slice(0, 8)}…)` : ''}`}
                    >
                      ♻️ 复用
                    </span>
                  ) : null}
                  <button type="button" className="ghost" onClick={onCopyUrl} title="复制 URL">
                    复制 url
                  </button>
                  {u.markdown ? (
                    <button type="button" className="ghost" onClick={onCopyMd} title="复制 markdown">
                      复制 md
                    </button>
                  ) : null}
                </>
              ) : u && u.status !== 'done' ? (
                <>
                  <span className="upload-row-error" title={u.status}>
                    上传 {u.status}
                  </span>
                  <button
                    type="button"
                    className="ghost"
                    onClick={onUploadOne}
                    disabled={!onUpload || !uploadConfigured}
                    title={!uploadConfigured ? '先去「📤 上传设置」里配置可用图床' : '重新上传该产物'}
                  >
                    📤 重传
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="ghost"
                  onClick={onUploadOne}
                  disabled={!onUpload || !uploadConfigured}
                  title={!uploadConfigured ? '先去「📤 上传设置」里配置可用图床' : '把该产物上传到当前默认图床'}
                >
                  📤 上传
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

/**
 * Session log panel — expandable card embedded in HistoryDetailModal.
 *
 * Renders the per-session operation trail (sniff → process → upload)
 * pulled from the SQLite-backed `session_logs` family. The panel is
 * passive (no mutation IPC of its own beyond export); the user can:
 *   - 折叠 / 展开 the body to free vertical space.
 *   - 导出 .log (per-line text) or .json (structured array) via a
 *     native save dialog. The file is materialised inside the main
 *     process; renderer only flips state on success.
 *
 * Empty state: when `sessionId` is missing (legacy records pre-log
 * feature) we don't render the panel at all — there's nothing to
 * show. The parent HistoryDetailModal already conditionalises on
 * `rec.sessionId` so the JSX simply skips over us.
 */
const LEVEL_COLORS: Record<SessionLogEntry['level'], string> = {
  debug: 'var(--muted)',
  info: 'var(--text)',
  warn: '#d39c1f',
  error: '#d34b4b'
};

interface SessionLogPanelProps {
  sessionId: string;
  /** Suggested filename base (page title or url). Falls back to sid. */
  suggestedName?: string;
}

const SessionLogPanel: React.FC<SessionLogPanelProps> = ({ sessionId, suggestedName }) => {
  const { snapshot, loading, error, reload, exportLog } = useSessionLogs(sessionId);
  // R-X — `expanded` now opens a floating modal instead of inflating the
  // dock height. Same state, different presentation.
  const [expanded, setExpanded] = useState<boolean>(false);
  const [exporting, setExporting] = useState<'log' | 'json' | null>(null);

  const onExport = useCallback(async (format: 'log' | 'json') => {
    setExporting(format);
    try {
      await exportLog(format, suggestedName);
    } finally {
      setExporting(null);
    }
  }, [exportLog, suggestedName]);

  // R-X — close on ESC when modal is open.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  const entryCount = snapshot?.entries.length ?? 0;
  const outcome = snapshot?.outcome;

  return (
    <>
      {/* R-X — Compact toolbar group designed to be injected via the
          ProgressDock `headerExtras` slot. We deliberately drop the
          surrounding card / border / mt — the dock toolbar already
          provides the chrome, and a second framed strip below it was
          the very thing that made the modal look unlike the home
          page. Only the primary "查看日志" button + a tiny count
          chip stay visible inline; export buttons live inside the
          modal pop-up below.

          The wrapper span carries `marginLeft: auto` so this group is
          pushed to the far right of the dock toolbar (matching the
          home view's "📋 日志 ▸" button position). Without it the
          group would sit immediately after the title because the
          history detail does not also pass `logs/onToggleLogs` (which
          would otherwise have its own marginLeft-auto button to the
          right of headerExtras). */}
      <span
        style={{
          marginLeft: 'auto',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8
        }}
      >
        <button
          type="button"
          className="ghost"
          onClick={() => setExpanded(true)}
          disabled={!sessionId}
          title="在弹窗中查看完整 session 日志"
        >
          📋 查看日志{entryCount > 0 ? ` (${entryCount})` : ''}
        </button>
        {error ? (
          <span style={{ fontSize: 12, color: '#d34b4b' }}>
            读取失败:{error}
          </span>
        ) : outcome ? (
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            {outcome}
          </span>
        ) : null}
      </span>
      {expanded ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Session 日志详情"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setExpanded(false);
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999
          }}
        >
          <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              width: 'min(960px, 92vw)',
              height: 'min(640px, 82vh)',
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 20px 60px rgba(0,0,0,0.5)'
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 12px',
                borderBottom: '1px solid var(--border)'
              }}
            >
              <strong style={{ fontSize: 13 }}>📋 Session 日志</strong>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                {loading ? '加载中…' : `${entryCount} 条`}
                {outcome ? ` · ${outcome}` : ''}
              </span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className="ghost"
                  disabled={!!exporting || !sessionId}
                  onClick={() => void onExport('log')}
                  title="导出为 .log 纯文本"
                >
                  {exporting === 'log' ? '导出中…' : '⬇ .log'}
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={!!exporting || !sessionId}
                  onClick={() => void onExport('json')}
                  title="导出为 .json 结构化数据"
                >
                  {exporting === 'json' ? '导出中…' : '⬇ .json'}
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void reload()}
                  disabled={loading}
                  title="重新读取"
                >
                  ↻
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setExpanded(false)}
                  title="关闭(ESC)"
                >
                  ✕
                </button>
              </div>
            </div>
            <div
              style={{
                flex: 1,
                overflow: 'auto',
                padding: 10,
                fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
                fontSize: 12,
                lineHeight: 1.5,
                background: 'var(--bg)'
              }}
            >
              {snapshot && snapshot.entries.length > 0 ? (
                snapshot.entries.map((e) => (
                  <div
                    key={`${e.sessionId}-${e.seq}`}
                    style={{ color: LEVEL_COLORS[e.level], whiteSpace: 'pre-wrap' }}
                  >
                    [{new Date(e.ts).toISOString()}]
                    {' '}[{e.level.toUpperCase()}]
                    {' '}[{e.stage}{e.substep ? '/' + e.substep : ''}]
                    {' '}{e.message}
                  </div>
                ))
              ) : (
                <div style={{ color: 'var(--muted)' }}>(暂无日志)</div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
};
