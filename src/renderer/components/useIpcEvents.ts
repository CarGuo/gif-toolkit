/**
 * useIpcEvents — extracts the four-channel IPC subscription wiring that
 * previously lived inline in App.tsx (lines 404-502 of the original blob).
 *
 * What this hook does
 * -------------------
 * On mount, it subscribes to four preload-exposed event channels and
 * tears them all down on unmount:
 *   • `process:progress` (via `giftk.onProgress`)        — per-task progress
 *   • `app:log`          (via `giftk.onLog`)             — log line stream
 *   • `sniff:progress`   (via `giftk.onSniffProgress`)   — sniffer progress
 *   • `upload:progress`  (via `giftk.onUploadProgress`)  — upload progress
 *
 * Why a hook
 * ----------
 * App.tsx only needs these subscriptions wired exactly once at mount, but
 * the inline effect grew thick with P1 fixes (TERMINAL list dedup, recId
 * fallback, R-54 sniff history fold, in-flight counter → centre upload
 * result modal). Pulling the wiring into a dedicated hook keeps App.tsx
 * focused on layout / data flow and lets us unit-test the IPC routing
 * semantics without spinning up the entire home page tree.
 *
 * Why "deps" injection (refs + setters)
 * -------------------------------------
 * The original effect deliberately used an empty dependency array
 * (mount-once) and read the latest record-mapping refs / setters via
 * closure. We preserve that contract by:
 *   1. Accepting all collaborators in a single `IpcEventsDeps` bag.
 *   2. Mirroring the bag in a ref so the mount-once effect can read the
 *      *latest* setters / patcher without taking them as effect deps.
 *   3. Re-using each ref the consumer hands us (taskRecordMapRef,
 *      activeHistoryIdRef, uploadJobToRecordRef, uploadJobToTargetRef,
 *      uploadInflightRef) verbatim — the hook never replaces them, so
 *      writes from outside this hook (dispatch-time mappings, "重跑",
 *      etc.) remain visible to the listener.
 *
 * P1 fixes preserved verbatim
 * ---------------------------
 *   • TERMINAL arrays for both process and upload streams (a single
 *     terminal status fans out to the dedup-map cleanup branches).
 *   • `recId` fallback chain `taskRecordMapRef.get(taskId) ||
 *     activeHistoryIdRef.current` — defensive for tasks not dispatched
 *     through one of the typed entry points.
 *   • `uploadJobToTargetRef` routing for the R-54 "fold upload result
 *     into the *processing* HistoryRecord" path, with `p.recordId`
 *     preferred over the local target map (newer backends echo the
 *     recordId through every progress event).
 *   • Per-record in-flight counter (`uploadInflightRef`) decremented on
 *     every terminal upload event; `setUploadResult(recId)` fires only
 *     when the counter drops to 0 so the centre result modal opens
 *     exactly once per batch (per spec: "完成时弹中央面板").
 *   • Log buffer capped at 300 lines (sliding window) to keep
 *     localStorage-adjacent state from growing unbounded.
 */
import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import type {
  TaskProgress,
  SniffProgress,
  UploadProgress
} from '../../shared/types';
import {
  mergeProgressIntoRecord,
  mergeUploadIntoRecord,
  type HistoryRecord,
  type UploadRefForHistory
} from './useHistory';

/**
 * Surface area on `window.giftk` that this hook actually touches.
 *
 * We deliberately do NOT depend on the full preload `GifToolkitApi` type
 * here — every callsite passes a partial mock in tests, and the
 * production consumer (App.tsx) reads `window.giftk` which already
 * conforms. Narrowing keeps the hook trivially mockable.
 */
export interface IpcEventsApi {
  onProgress: (cb: (p: TaskProgress) => void) => () => void;
  onLog: (cb: (line: string) => void) => () => void;
  onSniffProgress: (cb: (p: SniffProgress) => void) => () => void;
  onUploadProgress?: (cb: (p: UploadProgress) => void) => () => void;
}

/** Routing target for an upload job's R-54 sniff-history fold. */
export interface UploadTarget {
  sniffRecId?: string;
  filePath?: string;
}

export interface IpcEventsDeps {
  /** The preload bridge. `undefined` is tolerated (renderer test envs). */
  giftk: IpcEventsApi | undefined;
  /** Mutator for any HistoryRecord (process + sniff). */
  patchHistory: (id: string, mutate: (r: HistoryRecord) => HistoryRecord) => void;
  /** taskId → owning HistoryRecord.id (dispatch-time mapping). */
  taskRecordMapRef: MutableRefObject<Map<string, string>>;
  /** Fallback recId when a task wasn't routed through a typed entry point. */
  activeHistoryIdRef: MutableRefObject<string | null>;
  /** Folder for upload-history record progress (jobId-keyed inside). */
  applyUploadProgress: (recordId: string, progress: UploadProgress) => void;
  /** jobId → upload-history record id (recId). */
  uploadJobToRecordRef: MutableRefObject<Map<string, string>>;
  /** jobId → R-54 sniff-history fold target. */
  uploadJobToTargetRef: MutableRefObject<Map<string, UploadTarget>>;
  /** recId → remaining-non-terminal job count. */
  uploadInflightRef: MutableRefObject<Map<string, number>>;
  setProgress: (
    updater: (prev: Record<string, TaskProgress>) => Record<string, TaskProgress>
  ) => void;
  setLogs: (updater: (prev: string[]) => string[]) => void;
  setSniffProgress: (p: SniffProgress) => void;
  setUploadResult: (recordId: string) => void;
}

/** Terminal statuses for the per-task process stream. */
const TASK_TERMINAL: TaskProgress['status'][] = ['done', 'failed', 'cancelled', 'skipped'];
/** Terminal statuses for the upload stream. */
const UPLOAD_TERMINAL: UploadProgress['status'][] = ['done', 'failed', 'cancelled'];

/** R-08 — sliding log window cap (must match the original inline value). */
const LOG_BUFFER_CAP = 300;

export function useIpcEvents(deps: IpcEventsDeps): void {
  // Mirror deps in a ref so the mount-once effect always reads the
  // latest setters / patcher / refs without re-subscribing. This
  // matches the original App.tsx contract: the effect ran exactly
  // once, and every callback read the latest closure via React's
  // ref/setter identity stability.
  const depsRef = useRef(deps);
  depsRef.current = deps;

  useEffect(() => {
    const { giftk } = depsRef.current;
    if (!giftk) return;

    const off1 = giftk.onProgress((p) => {
      const d = depsRef.current;
      d.setProgress((prev) => ({ ...prev, [p.taskId]: p }));
      // R-27 — fold the same emit into the OWNING history record so a
      // user who opens the history panel mid-batch sees outputs / status
      // accumulate live. We resolve the record id by taskId first
      // (dispatch-time mapping); fall back to activeHistoryIdRef only
      // when the task wasn't dispatched through one of our typed
      // entry points (defensive — should never happen in practice).
      const recId =
        d.taskRecordMapRef.current.get(p.taskId) || d.activeHistoryIdRef.current;
      if (recId) {
        d.patchHistory(recId, (r) => mergeProgressIntoRecord(r, p));
      }
      if (TASK_TERMINAL.includes(p.status)) {
        d.taskRecordMapRef.current.delete(p.taskId);
      }
    });

    const off2 = giftk.onLog((line) => {
      depsRef.current.setLogs((prev) => {
        const next = [...prev, line];
        return next.length > LOG_BUFFER_CAP ? next.slice(-LOG_BUFFER_CAP) : next;
      });
    });

    const off3 = giftk.onSniffProgress((p) => {
      depsRef.current.setSniffProgress(p);
    });

    // R-45 — fold upload progress into the upload-history record that
    // owns each jobId. Terminal events decrement an in-flight counter
    // per record; when the counter reaches 0 we surface the central
    // result modal (per spec: "完成时弹中央面板").
    const off4 = typeof giftk.onUploadProgress === 'function'
      ? giftk.onUploadProgress((p: UploadProgress) => {
          const d = depsRef.current;
          const recId = d.uploadJobToRecordRef.current.get(p.jobId);
          if (!recId) return;
          d.applyUploadProgress(recId, p);
          // R-54 — fold the upload result into the *processing*
          // HistoryRecord so 嗅探历史 详情面板 can show 「☁ 已上传 /
          // 复制 url / 复制 markdown」 next to each output. We only
          // patch on terminal events to keep localStorage write
          // pressure low — transient `uploading` percent changes
          // are persisted only in the upload-history record.
          if (UPLOAD_TERMINAL.includes(p.status)) {
            // Prefer the recordId echoed back from main (carried by
            // UploadJob.recordId → UploadProgress.recordId). Fall
            // back to the renderer's own jobId → target map for
            // pre-R-54 backends or odd reconnect cases.
            const target = d.uploadJobToTargetRef.current.get(p.jobId);
            const sniffRecId = p.recordId || target?.sniffRecId;
            const filePath = target?.filePath;
            if (sniffRecId && filePath && p.backend) {
              const ref: UploadRefForHistory = {
                url: p.url || '',
                markdown: p.markdown,
                status: p.status,
                uploadedAt: Date.now(),
                backend: p.backend,
                fileHash: p.fileHash,
                reused: p.reused
              };
              d.patchHistory(sniffRecId, (rec) => mergeUploadIntoRecord(rec, filePath, ref));
            }
          }
          if (UPLOAD_TERMINAL.includes(p.status)) {
            d.uploadJobToRecordRef.current.delete(p.jobId);
            d.uploadJobToTargetRef.current.delete(p.jobId);
            const remaining = (d.uploadInflightRef.current.get(recId) ?? 0) - 1;
            if (remaining <= 0) {
              d.uploadInflightRef.current.delete(recId);
              d.setUploadResult(recId);
            } else {
              d.uploadInflightRef.current.set(recId, remaining);
            }
          }
        })
      : () => { /* noop */ };

    return () => {
      off1();
      off2();
      off3();
      off4();
    };
    // Mount-once contract: deps are read via depsRef on every event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
