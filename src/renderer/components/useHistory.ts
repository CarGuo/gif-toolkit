/**
 * R-27 — Persistent history of sniff sessions and batch outputs.
 *
 * Why: every "嗅探" + "批处理" round produces a transient (in-memory)
 * snapshot of {pageUrl, items, options, outputDir, per-task outputs}.
 * Today the user can only see the *current* run; once they sniff a new
 * URL the previous result is gone, even though the produced files are
 * still on disk. R-27 surfaces those old runs, allows opening their
 * output folder, and re-running individual media items without
 * re-sniffing.
 *
 * R-80 — Storage moved from localStorage to a main-process SQLite
 * store. The hook still owns an in-memory mirror so callers can read
 * the current array synchronously (App.tsx folds progress events
 * into a record many times per second; awaiting an IPC round-trip on
 * each emit would crater the renderer). Mutations are optimistic +
 * fire-and-forget IPC. Initial load is async — `isLoading` stays
 * true until the first `db:history:readAll` resolves.
 *
 * High-frequency mutations (a streaming progress feed) are funneled
 * through a per-record-id 250ms-idle queue so we don't hit
 * `db:history:upsert` once per emit. Each upsert is a DELETE + re-
 * INSERT of the items / outputs / status / uploads child rows, so
 * coalescing is mandatory for sane DB load. Pre-R-80 the same code
 * path debounced localStorage.setItem with the same window.
 *
 * Failures during read/write are silently swallowed: history is a
 * convenience feature, never a hard dependency.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ProcessOptions,
  SniffedMedia,
  TaskProgress,
  TaskStatus,
  UploadBackend,
  UploadStatus
} from '../../shared/types';
import { DEFAULT_OPTIONS } from '../../shared/types';
import { reportDbError } from './dbErrorBus';

export const HISTORY_STORAGE_KEY = 'giftk.history.v1';
export const HISTORY_MAX_ENTRIES = 30;

/**
 * R-79b / R-80 — schema version. The on-disk SQLite migrations
 * (`src/main/db/migrations/`) are the source of truth post-R-80; this
 * constant survives because it's still re-exported in tests and
 * because the preload-side bootstrap import keys off it when reading
 * the legacy localStorage envelope. Bumping this number alone has no
 * runtime effect today — schema evolution lives in main-side
 * migration scripts.
 */
export const HISTORY_SCHEMA_VERSION = 1;

/**
 * R-54 — One upload's outcome, indexed inside HistoryRecord by the
 * absolute output file path. Lets the 嗅探历史 detail panel show
 * 「☁ 已上传 / 复制 url / 复制 markdown」 next to each produced file
 * without requiring a cross-store join into UploadHistoryRecord.
 *
 * Why duplicate the upload-history info here instead of joining?
 *  - The two histories evolve at different cadences (the upload
 *    history can be cleared independently).
 *  - The 嗅探 detail panel pre-existed and the user explicitly asked
 *    for in-place rendering, not for a "see upload history tab" link.
 *  - Storing the URL by *output path* makes it correct under file
 *    moves (we keep the absolute path on disk verbatim).
 */
export interface UploadRefForHistory {
  url: string;
  markdown?: string;
  status: UploadStatus;
  uploadedAt: number;
  backend: UploadBackend;
  /** sha256 of the uploaded bytes — surfaced for UI debug only. */
  fileHash?: string;
  /** True if the URL was reused via hash-cache hit. */
  reused?: boolean;
}

/**
 * One record per *sniff* session. A sniff that is followed by zero or
 * more batches still produces exactly one record; subsequent batches on
 * the same SniffResult append to the *same* record's outputs map.
 */
export interface HistoryRecord {
  /** Renderer-generated id, stable across reloads. */
  id: string;
  /** Wall-clock when the sniff finished, used purely for sort and
   *  display — NOT a security boundary. */
  createdAt: number;
  pageUrl: string;
  title?: string;
  /** Snapshot of the sniff result's items at the time of recording.
   *  Includes resolved embeds (we splice in the resolvedMap before
   *  saving). */
  items: SniffedMedia[];
  /** Snapshot of the global ProcessOptions used for the most recent
   *  batch on this record (or DEFAULT_OPTIONS if no batch ran yet). */
  options: ProcessOptions;
  /** Output sub-directory of the most recent batch dispatched against
   *  this record. Empty string when no batch has been dispatched. */
  outputDir?: string;
  /** Per-task accumulated output file paths. Keyed by task id (which is
   *  the SniffedMedia id). */
  outputsByTaskId: Record<string, string[]>;
  /** Per-task most-recent status (done / failed / cancelled / etc.). */
  taskStatus: Record<string, TaskStatus>;
  /**
   * R-54 — Per-output-file upload result. Keyed by the absolute path
   * on disk (same string the renderer stores in `outputsByTaskId`).
   * `undefined` (or missing key) means「该产物尚未上传 / 上传失败已
   * 删除记录」。Pre-R-54 records simply lack the field; readAll
   * tolerates that by defaulting to `{}`.
   */
  uploadsByOutputPath?: Record<string, UploadRefForHistory>;
}

function genId(): string {
  // 32 bits of entropy + ms timestamp is plenty for a per-user log.
  const r = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `hist-${Date.now()}-${r}`;
}

/**
 * R-80 — best-effort parse of one row from the DB. Drops entries
 * missing required shape so a partially corrupted blob doesn't
 * crash the panel. Also normalises optional sub-objects
 * (outputsByTaskId / taskStatus / options) so mergeProgressIntoRecord
 * can safely index them later.
 *
 * The defensive shape is intentionally identical to the pre-R-80
 * `readAll()` per-row parser — same fixtures keep passing in the
 * unit tests post-DB migration.
 */
function parseRecord(e: unknown): HistoryRecord | null {
  if (!e || typeof e !== 'object') return null;
  const r = e as Partial<HistoryRecord>;
  if (typeof r.id !== 'string' || typeof r.pageUrl !== 'string' || !Array.isArray(r.items)) {
    return null;
  }
  return {
    id: r.id,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
    pageUrl: r.pageUrl,
    title: typeof r.title === 'string' ? r.title : undefined,
    items: r.items as SniffedMedia[],
    options: (r.options && typeof r.options === 'object' ? r.options : DEFAULT_OPTIONS) as ProcessOptions,
    outputDir: typeof r.outputDir === 'string' ? r.outputDir : undefined,
    outputsByTaskId:
      r.outputsByTaskId && typeof r.outputsByTaskId === 'object'
        ? (r.outputsByTaskId as Record<string, string[]>)
        : {},
    taskStatus:
      r.taskStatus && typeof r.taskStatus === 'object'
        ? (r.taskStatus as Record<string, TaskStatus>)
        : {},
    uploadsByOutputPath:
      r.uploadsByOutputPath && typeof r.uploadsByOutputPath === 'object'
        ? (r.uploadsByOutputPath as Record<string, UploadRefForHistory>)
        : undefined
  };
}

export interface UseHistoryApi {
  history: HistoryRecord[];
  /** R-80 — true while the initial DB read is in flight. App.tsx
   *  defers the on-mount `registerOutputDir` rehydration until this
   *  flips to false, since the loop walks `history` and would no-op
   *  on the empty-during-load list otherwise. */
  isLoading: boolean;
  /** Push a new record OR replace an existing one for the same pageUrl
   *  ROUND. We replace when the new record's id matches; we push when
   *  the id is new. The most recent entry is at index 0. Returns the
   *  effective record id after the operation. */
  pushOrReplace(rec: HistoryRecord): string;
  /** Mutate a record in place (used for streaming progress updates). */
  patch(id: string, mutator: (r: HistoryRecord) => HistoryRecord): void;
  /** Remove a single record. */
  remove(id: string): void;
  /** Wipe everything (with the user's confirmation in the UI). */
  clear(): void;
  /** R-34 — force-resync from the persistent store.
   *  Use case: the history tab is opened and the user expects to see
   *  the *current* truth, including any (a) in-flight progress that
   *  the 250ms debounce hasn't flushed yet, and (b) external mutations
   *  (other windows / tools) that wrote to the same DB.
   *  We flush our pending in-memory upserts to disk first so we never
   *  overwrite newer-in-memory rows with stale-on-disk rows, then we
   *  reread. If the readback is a strict subset of memory we keep
   *  memory; only the presence of new ids triggers an authoritative
   *  swap. */
  reload(): void;
  /** R-80 hardening (H5) — synchronously cancel the debounce timer
   *  and forward every queued upsert / remove to the DB. The returned
   *  Promise resolves when ALL of the queued IPC operations settle.
   *  Used by the `db:flushBeforeQuit` lifecycle hook so a window that
   *  closes mid-batch doesn't drop the trailing progress emit. */
  flushPending(): Promise<void>;
}

/**
 * React hook that wraps the SQLite-backed list. Memoised getters are
 * intentionally NOT used — the array is small enough (capped at 30)
 * that callers can map over it directly.
 */
export function useHistory(): UseHistoryApi {
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const mountedRef = useRef<boolean>(true);
  // R-80 — coalesce upsert IPC calls per recordId. A streaming
  // progress feed (`mergeProgressIntoRecord` on every TaskProgress
  // emit) would otherwise hit `db:history:upsert` once per emit,
  // doing a full DELETE + re-INSERT of the items / outputs / status /
  // uploads child rows. We keep a per-record latest-value queue and
  // flush after a 250ms idle window — same shape as
  // useUploadHistory's debounce, same reasoning as the pre-R-80
  // localStorage debounce.
  const upsertQueueRef = useRef<Map<string, HistoryRecord>>(new Map());
  // Pending deletes are tracked separately so a delete + immediate
  // re-add (rare but possible during reload) can cancel the delete
  // instead of running both serially.
  const removeQueueRef = useRef<Set<string>>(new Set());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushPending = useCallback(async (): Promise<void> => {
    const upserts = upsertQueueRef.current;
    const removals = removeQueueRef.current;
    upsertQueueRef.current = new Map();
    removeQueueRef.current = new Set();
    flushTimerRef.current = null;
    const api = typeof window !== 'undefined' ? window.giftk?.db?.history : undefined;
    if (!api) return;
    // Order: removes first, then upserts. A user-driven delete is
    // higher-priority signal than the trailing edge of a debounced
    // patch on the *same* id (we'd cancel the upsert on remove
    // anyway, but the explicit ordering keeps the serial DB log
    // easy to reason about).
    //
    // R-80 hardening (H5) — flushPending now returns a Promise that
    // resolves after every queued IPC settles. Callers that need a
    // synchronous fire-and-forget can simply ignore the returned
    // promise (existing call sites do exactly that). The
    // `db:flushBeforeQuit` hook awaits this promise so the renderer
    // doesn't tear down with in-flight upserts.
    const tasks: Array<Promise<unknown>> = [];
    for (const id of removals) {
      tasks.push(api.remove(id).catch((err) => reportDbError('history', 'remove', err)));
    }
    for (const rec of upserts.values()) {
      tasks.push(api.upsert(rec).catch((err) => reportDbError('history', 'upsert', err)));
    }
    await Promise.all(tasks);
  }, []);

  const schedule = useCallback(() => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(flushPending, 250);
  }, [flushPending]);

  const enqueueUpsert = useCallback((rec: HistoryRecord): void => {
    // A previously-queued remove on the same id is superseded by an
    // upsert (re-pushing a record after deleting it from another
    // window is the only realistic path to this branch).
    removeQueueRef.current.delete(rec.id);
    upsertQueueRef.current.set(rec.id, rec);
    schedule();
  }, [schedule]);

  const enqueueRemove = useCallback((id: string): void => {
    upsertQueueRef.current.delete(id);
    removeQueueRef.current.add(id);
    schedule();
  }, [schedule]);

  // R-80 — initial DB load. History is convenience-only so a bridge
  // / IPC failure leaves the in-memory list empty rather than
  // crashing the panel.
  useEffect(() => {
    mountedRef.current = true;
    const api = typeof window !== 'undefined' ? window.giftk?.db?.history : undefined;
    if (!api) {
      setIsLoading(false);
      return () => {
        mountedRef.current = false;
        if (flushTimerRef.current) {
          clearTimeout(flushTimerRef.current);
          flushTimerRef.current = null;
        }
      };
    }
    api
      .readAll()
      .then((rows) => {
        if (!mountedRef.current) return;
        const out: HistoryRecord[] = [];
        for (const r of rows) {
          const rec = parseRecord(r);
          if (rec) out.push(rec);
        }
        out.sort((a, b) => b.createdAt - a.createdAt);
        setHistory(out.slice(0, HISTORY_MAX_ENTRIES));
      })
      .catch((err) => {
        // First failure surfaces a one-shot toast via dbErrorBus; the
        // panel still renders with an empty list (graceful fallback)
        // rather than blocking on the IPC error.
        reportDbError('history', 'readAll', err);
      })
      .finally(() => {
        if (mountedRef.current) setIsLoading(false);
      });
    return () => {
      mountedRef.current = false;
      // Flush any pending upserts on unmount so a brief panel close
      // mid-batch doesn't lose the most recent progress emit.
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
        void flushPending();
      }
    };
  }, [flushPending]);

  const pushOrReplace = useCallback((rec: HistoryRecord): string => {
    setHistory((prev) => {
      const idx = prev.findIndex((r) => r.id === rec.id);
      let next: HistoryRecord[];
      if (idx >= 0) {
        next = [...prev];
        next[idx] = rec;
      } else {
        next = [rec, ...prev];
      }
      // Sort by createdAt desc to keep the visible order stable even
      // when callers replace older records.
      next.sort((a, b) => b.createdAt - a.createdAt);
      // Cap.
      if (next.length > HISTORY_MAX_ENTRIES) {
        next = next.slice(0, HISTORY_MAX_ENTRIES);
      }
      return next;
    });
    enqueueUpsert(rec);
    return rec.id;
  }, [enqueueUpsert]);

  const patch = useCallback((id: string, mutator: (r: HistoryRecord) => HistoryRecord): void => {
    setHistory((prev) => {
      const idx = prev.findIndex((r) => r.id === id);
      if (idx < 0) return prev;
      const next = [...prev];
      const updated = mutator(prev[idx]);
      next[idx] = updated;
      // We schedule the upsert from inside the functional updater so
      // the queued payload reflects the *post-mutation* shape. Doing
      // it after the setHistory call would race with React's batching.
      enqueueUpsert(updated);
      return next;
    });
  }, [enqueueUpsert]);

  const remove = useCallback((id: string): void => {
    setHistory((prev) => prev.filter((r) => r.id !== id));
    enqueueRemove(id);
  }, [enqueueRemove]);

  const clear = useCallback((): void => {
    setHistory([]);
    upsertQueueRef.current.clear();
    removeQueueRef.current.clear();
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const api = typeof window !== 'undefined' ? window.giftk?.db?.history : undefined;
    if (api) {
      api.clear().catch((err) => reportDbError('history', 'clear', err));
    }
  }, []);

  const reload = useCallback((): void => {
    // R-34 / R-80 — async re-pull from the DB. We flush any pending
    // upserts first so the readback can't observe stale-on-disk rows
    // for ids that memory has newer values for. The async then-block
    // checks mountedRef to avoid setState on an unmounted hook.
    //
    // Heuristic (unchanged from R-34): if the DB has at least one
    // record that memory lacks (by id), we treat that as evidence of
    // an external write (another window / a manual db edit) and
    // adopt the readback wholesale. Otherwise memory is at least as
    // fresh and we leave it alone — the trailing 250ms flush is
    // about to push it through anyway.
    void flushPending();
    const api = typeof window !== 'undefined' ? window.giftk?.db?.history : undefined;
    if (!api) return;
    api
      .readAll()
      .then((rows) => {
        if (!mountedRef.current) return;
        const fresh: HistoryRecord[] = [];
        for (const r of rows) {
          const rec = parseRecord(r);
          if (rec) fresh.push(rec);
        }
        fresh.sort((a, b) => b.createdAt - a.createdAt);
        setHistory((prev) => {
          const prevIds = new Set(prev.map((r) => r.id));
          const diskHasNewIds = fresh.some((r) => !prevIds.has(r.id));
          if (!diskHasNewIds) return prev;
          return fresh.slice(0, HISTORY_MAX_ENTRIES);
        });
      })
      .catch((err) => reportDbError('history', 'readAll', err));
  }, [flushPending]);

  return { history, isLoading, pushOrReplace, patch, remove, clear, reload, flushPending };
}

/**
 * Pure helper — given a TaskProgress emit, fold it into a record.
 * Extracted so we can unit-test the merge logic without spinning up
 * the full hook + DOM.
 */
export function mergeProgressIntoRecord(
  rec: HistoryRecord,
  p: TaskProgress
): HistoryRecord {
  const prevOutputs = rec.outputsByTaskId[p.taskId] || [];
  const nextOutputs =
    Array.isArray(p.outputs) && p.outputs.length > 0
      ? Array.from(new Set([...prevOutputs, ...p.outputs]))
      : prevOutputs;
  // R-27 #2 (post-review): once a task reaches ANY terminal status
  // (done / failed / cancelled / skipped) we freeze the value — this
  // includes terminal-over-terminal writes, e.g. a `cancelAll` sweep
  // racing in after a `done` emit MUST NOT downgrade the row.
  const TERMINAL: TaskStatus[] = ['done', 'failed', 'cancelled', 'skipped'];
  const prevStatus = rec.taskStatus[p.taskId];
  // R-29 (P1-G): skip writing a brand-new `pending` row into the
  // record. Reasoning: the renderer seeds `pending` rows in the
  // *transient* progress map for instant TaskTable feedback (R-28
  // #3), but the persisted history record is the long-term truth and
  // a `pending` taskStatus that never advances (e.g. user cancels
  // before main starts the task, or main rejects with `busy`) would
  // leave the history row permanently in "pending" with no way to
  // recover. We accept `pending` only when there's already a
  // (non-terminal) prior status to overwrite — which means main has
  // really started emitting for this task. First-write `pending` is
  // dropped; the next non-pending emit (`running` / a terminal) will
  // become the first persisted status.
  if (prevStatus === undefined && p.status === 'pending') {
    if (nextOutputs === prevOutputs) {
      // Nothing meaningful to record yet — keep the record untouched
      // so React skips the re-render.
      return rec;
    }
    return {
      ...rec,
      outputsByTaskId: { ...rec.outputsByTaskId, [p.taskId]: nextOutputs }
    };
  }
  const nextStatus =
    prevStatus && TERMINAL.includes(prevStatus) ? prevStatus : p.status;
  return {
    ...rec,
    outputsByTaskId: { ...rec.outputsByTaskId, [p.taskId]: nextOutputs },
    taskStatus: { ...rec.taskStatus, [p.taskId]: nextStatus }
  };
}

/**
 * Pure factory — produce a new HistoryRecord from a fresh sniff result
 * and the current options. Splits creation out of the hook so tests
 * can construct fixtures predictably.
 */
export function makeHistoryRecord(args: {
  pageUrl: string;
  title?: string;
  items: SniffedMedia[];
  options: ProcessOptions;
  outputDir?: string;
  /** Override id — only used by tests; production callers should let
   *  it default. */
  id?: string;
  createdAt?: number;
}): HistoryRecord {
  return {
    id: args.id || genId(),
    createdAt: args.createdAt ?? Date.now(),
    pageUrl: args.pageUrl,
    title: args.title,
    items: args.items,
    options: args.options,
    outputDir: args.outputDir,
    outputsByTaskId: {},
    taskStatus: {}
  };
}

/**
 * R-54 — Pure helper: fold a single upload's `done` / `failed` /
 * `cancelled` outcome into a HistoryRecord at the given output file
 * path. Only persists `done` (with a url) and terminal `failed` /
 * `cancelled` rows — transient `uploading` / `pending` events are
 * skipped to avoid thrashing localStorage on every byte progress.
 *
 * Idempotent: calling twice with the same final state is a no-op.
 * Terminal-wins: a `done` record is never downgraded to `failed` by
 * a later retry that only succeeded once (we keep whichever has a
 * url).
 */
export function mergeUploadIntoRecord(
  rec: HistoryRecord,
  outputPath: string,
  ref: UploadRefForHistory
): HistoryRecord {
  if (!outputPath) return rec;
  const TERMINAL_FOR_UPLOAD: UploadStatus[] = ['done', 'failed', 'cancelled'];
  if (!TERMINAL_FOR_UPLOAD.includes(ref.status)) return rec;
  const prev = rec.uploadsByOutputPath?.[outputPath];
  // Terminal-wins: a previously successful upload should not be
  // overwritten by a later failed retry (rare race, but possible if
  // the user manually re-uploads after a transient failure cleaned
  // the row).
  if (prev && prev.status === 'done' && ref.status !== 'done') return rec;
  // Idempotent: same final state — return same reference so React
  // skips the re-render.
  if (
    prev &&
    prev.status === ref.status &&
    prev.url === ref.url &&
    prev.markdown === ref.markdown &&
    prev.fileHash === ref.fileHash &&
    prev.reused === ref.reused
  ) {
    return rec;
  }
  return {
    ...rec,
    uploadsByOutputPath: {
      ...(rec.uploadsByOutputPath || {}),
      [outputPath]: ref
    }
  };
}
