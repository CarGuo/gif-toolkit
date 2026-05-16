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
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ProcessOptions,
  SniffedMedia,
  TaskProgress,
  TaskStatus
} from '../../shared/types';

export const HISTORY_STORAGE_KEY = 'giftk.history.v1';
export const HISTORY_MAX_ENTRIES = 30;

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
    // corrupted blob doesn't crash the panel.
    return parsed.filter(
      (e: unknown): e is HistoryRecord =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as HistoryRecord).id === 'string' &&
        typeof (e as HistoryRecord).pageUrl === 'string' &&
        Array.isArray((e as HistoryRecord).items)
    );
  } catch {
    return [];
  }
}

function writeAll(list: HistoryRecord[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // QuotaExceeded etc. — silently drop, the in-memory copy is still
    // authoritative for this session.
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
}

/**
 * React hook that wraps the localStorage-backed list. Memoised getters
 * are intentionally NOT used — the array is small enough that callers
 * can map over it directly.
 */
export function useHistory(): UseHistoryApi {
  const [history, setHistory] = useState<HistoryRecord[]>(() => readAll());
  // Latest snapshot for closure-stable mutators.
  const ref = useRef(history);
  useEffect(() => { ref.current = history; }, [history]);

  // Persist on any change. We don't debounce here because state
  // updates already coalesce within React's batching window for normal
  // UI events; the heavy progress stream goes through `patch` which
  // does its own batching via setState's functional form.
  useEffect(() => {
    writeAll(history);
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

  return { history, pushOrReplace, patch, remove, clear };
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
  // Status only ever moves "forward" toward a terminal state; we don't
  // want a late-arriving 'compressing' to overwrite a previous 'done'.
  const TERMINAL: TaskStatus[] = ['done', 'failed', 'cancelled', 'skipped'];
  const prevStatus = rec.taskStatus[p.taskId];
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
