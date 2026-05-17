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
 * Storage strategy
 * ----------------
 * - localStorage key `giftk.history.v1` (versioned for future schema
 *   evolution).
 * - Hard cap 30 entries (FIFO eviction). The cap is intentionally
 *   small to keep us under the ~5MB localStorage quota even if every
 *   sniff yields ~50 media items with thumbnails (we DON'T store
 *   thumbnail bytes — only the urls).
 * - Failures during read/write are silently swallowed: history is a
 *   convenience feature, never a hard dependency.
 *
 * Mutations are batched through a reducer so concurrent updates from
 * multiple progress events can't lose entries. We also debounce writes
 * so a stream of progress events doesn't thrash localStorage.
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  ProcessOptions,
  SniffedMedia,
  TaskProgress,
  TaskStatus,
  UploadBackend,
  UploadStatus
} from '../../shared/types';
import { DEFAULT_OPTIONS } from '../../shared/types';

export const HISTORY_STORAGE_KEY = 'giftk.history.v1';
export const HISTORY_MAX_ENTRIES = 30;

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

function readAll(): HistoryRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive: drop entries missing required shape so a partially
    // corrupted blob doesn't crash the panel. Also normalise optional
    // sub-objects (outputsByTaskId / taskStatus / options) so
    // mergeProgressIntoRecord can safely index them later.
    const out: HistoryRecord[] = [];
    for (const e of parsed) {
      if (!e || typeof e !== 'object') continue;
      const r = e as Partial<HistoryRecord>;
      if (typeof r.id !== 'string' || typeof r.pageUrl !== 'string' || !Array.isArray(r.items)) {
        continue;
      }
      out.push({
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
      });
    }
    return out;
  } catch {
    return [];
  }
}

function writeAll(list: HistoryRecord[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // QuotaExceeded / TypeError on circular refs etc. — silently drop.
    // Best-effort recovery: nuke the key once so the next setItem with
    // an even smaller list has a clean slate.
    try {
      window.localStorage.removeItem(HISTORY_STORAGE_KEY);
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(list));
    } catch {
      // Truly out of room or storage disabled (privacy mode); the
      // in-memory copy is still authoritative for this session.
    }
  }
}

export interface UseHistoryApi {
  history: HistoryRecord[];
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
  /** R-34 — force-resync from localStorage.
   *  Use case: the history tab is opened and the user expects to see
   *  the *current* truth, including any (a) in-flight progress that
   *  the 250ms debounce hasn't flushed yet, and (b) external mutations
   *  from another renderer/tab/window that wrote to the same key.
   *  We flush our in-memory state to disk first so we never overwrite
   *  newer-in-memory rows with stale-on-disk rows, then we reread.
   *  If readback === current, we skip the setState to avoid a wasted
   *  re-render. */
  reload(): void;
}

/**
 * React hook that wraps the localStorage-backed list. Memoised getters
 * are intentionally NOT used — the array is small enough that callers
 * can map over it directly.
 */
export function useHistory(): UseHistoryApi {
  const [history, setHistory] = useState<HistoryRecord[]>(() => readAll());

  // R-27 (post-review): debounce persistence so a high-frequency
  // progress stream doesn't synchronously hit localStorage.setItem on
  // every emit. setItem on a 30-record blob is ~tens of KB synchronous
  // disk write that competes with the renderer's main thread; a 250ms
  // trailing-edge debounce gives ~4 writes/sec at most while still
  // surviving an unexpected reload (the next mount reads back from
  // disk; in-flight changes within 250ms of a crash are accepted as
  // lost — history is a convenience feature, never a hard dependency).
  useEffect(() => {
    const t = setTimeout(() => writeAll(history), 250);
    return () => clearTimeout(t);
  }, [history]);

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
    return rec.id;
  }, []);

  const patch = useCallback((id: string, mutator: (r: HistoryRecord) => HistoryRecord): void => {
    setHistory((prev) => {
      const idx = prev.findIndex((r) => r.id === id);
      if (idx < 0) return prev;
      const next = [...prev];
      next[idx] = mutator(prev[idx]);
      return next;
    });
  }, []);

  const remove = useCallback((id: string): void => {
    setHistory((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const clear = useCallback((): void => {
    setHistory([]);
  }, []);

  const reload = useCallback((): void => {
    // R-34 — implemented inside a functional setHistory so the
    // updater's `prev` is guaranteed to be the most recent state
    // React knows about, even when reload is called in the same act
    // batch as a previous setHistory call. Capturing `history` from
    // the surrounding closure (or via a useEffect-synced ref) would
    // observe a stale snapshot in that scenario.
    //
    // Two real-world scenarios drive the merge logic:
    //
    //   A. EXTERNAL writer (another renderer / window) updated the
    //      key while we were mounted. Disk is the freshest source of
    //      truth — adopt it.
    //
    //   B. IN-MEMORY state is newer than disk because the 250ms
    //      debounce hasn't fired yet (e.g. the user clicks 历史
    //      immediately after a progress emit). Adopting disk here
    //      would drop the in-flight update. We instead flush memory
    //      to disk and keep the same state object.
    //
    // Heuristic: if disk has at least one record that the in-memory
    // list lacks (by id), we treat that as evidence of an external
    // write and adopt disk wholesale. Otherwise we trust memory and
    // flush it through. This keeps the API a no-op for the common
    // single-renderer case while still surfacing external changes.
    setHistory((prev) => {
      const fresh = readAll();
      const prevIds = new Set(prev.map((r) => r.id));
      const diskHasNewIds = fresh.some((r) => !prevIds.has(r.id));
      if (!diskHasNewIds) {
        // Memory is at least as fresh as disk — flush and return prev
        // so React skips the re-render.
        writeAll(prev);
        return prev;
      }
      // Disk had ids we've never seen — treat as authoritative.
      return fresh;
    });
  }, []);

  return { history, pushOrReplace, patch, remove, clear, reload };
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
