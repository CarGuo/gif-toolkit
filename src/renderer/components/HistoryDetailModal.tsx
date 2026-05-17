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
import { TaskTable } from './TaskTable';
import { LogBox } from './LogBox';
import { PreviewModal } from './PreviewModal';
import type { HistoryRecord } from './useHistory';

const giftk = (typeof window !== 'undefined' ? window.giftk : undefined);

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
  /** Optional log lines to surface — App passes its global logs and we
   *  filter to lines that mention this record id when available. */
  logs: string[];
  /** R-29 (P0-C): live taskId → owning record id map. The modal uses
   *  this to confirm that a progress entry for `media.id` actually
   *  belongs to *this* record before rendering it, so a same-id task
   *  running for a different record (home view, another history
   *  modal session) cannot bleed into this TaskTable. Optional for
   *  back-compat; unfiltered fallback is the previous behaviour. */
  taskRecordMap?: Map<string, string>;
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
  logs,
  taskRecordMap
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

  // Filter the global log buffer down to lines plausibly related to
  // this record. We tag log entries from `onReprocessFromHistory`
  // with the record id so a substring match is enough; everything
  // else (resolve / sniff / generic batch) is kept too because it
  // gives the user useful context (e.g. "yt-dlp 解析中…").
  const recordLogs = useMemo<string[]>(() => {
    const recIdMarker = `record ${rec.id}`;
    return logs.filter((line) =>
      line.includes(recIdMarker) ||
      line.includes('[history]') ||
      line.includes('[busy]') ||
      line.includes('[error]')
    );
  }, [logs, rec.id]);

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
              <div className="card">
                <h2>1. 来源</h2>
                <div style={{ fontSize: 12, color: 'var(--muted)', wordBreak: 'break-all' }}>
                  {rec.pageUrl}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                  共 {rec.items.length} 项 · 创建于{' '}
                  {new Date(rec.createdAt).toLocaleString()}
                </div>
              </div>

              <div className="card">
                <h2>2. 处理参数</h2>
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
            </div>
          </div>

          <div className="hist-detail-bottom">
            <TaskTable
              items={items}
              progress={recordProgress}
              onRetry={(m) => onProcessOneFromRecord(rec, m)}
              onForceAllow={(m) => onProcessOneFromRecord(rec, m)}
            />
            <LogBox lines={recordLogs} />
          </div>
        </div>
      </div>

      {activeMedia ? (
        <PreviewModal
          media={activeMedia}
          options={previewOptions ?? options}
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
