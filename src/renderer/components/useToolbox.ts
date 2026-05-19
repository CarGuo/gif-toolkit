import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskProgress, ToolboxJob, ToolboxKind, ToolboxParams } from '../../shared/types';
import { TOOLBOX_INPUT_EXTENSIONS } from '../../shared/types';
import { readVersionedStorage, writeVersionedStorage } from './storageSchema';

/**
 * R-35 / R-39 — useToolbox.
 *
 * Manages a flat list of toolbox jobs (one per local input file) plus a
 * map of taskId → latest TaskProgress event. The hook is intentionally
 * thin — render-side ToolboxPanel does all the layout, and main-side
 * processor reuses the existing `process:progress` IPC channel so we
 * piggy-back on the same listener that powers TaskTable on home.
 *
 * R-39 additions:
 *   - When a job reaches a terminal status (`done` / `failed` /
 *     `cancelled` / `skipped`) it is *moved out* of `jobs` into a
 *     persistent `toolboxHistory` log. This solves the UX issue where
 *     the queue grew indefinitely as the user processed more files; the
 *     queue is now strictly the "to do" list.
 *   - The history is persisted to `localStorage` under
 *     `giftk.toolbox.history.v1` so it survives reload / restart.
 *   - Each entry remembers the source input path, the kind, the chosen
 *     params, the resulting output path(s) and a timestamp so the panel
 *     can show "completed at 14:32 · GIF Resize · clip.mp4 → clip.gif"
 *     and let the user click to reveal the output in Finder/Explorer.
 */

export interface ToolboxJobView extends ToolboxJob {
  /** Display-only filename derived from inputPath. */
  displayName: string;
}

/** R-39 — A single completed (or failed) toolbox run. */
export interface ToolboxHistoryEntry {
  id: string;
  kind: ToolboxKind;
  inputPath: string;
  /** Display-only filename derived from inputPath. */
  displayName: string;
  /** Output file paths (typically 1; gif-optimize may emit aux files). */
  outputs: string[];
  /** Snapshot of the params used at the time the job ran, useful for
   *  history rows showing "GIF Resize · 480px" etc. */
  params: ToolboxParams;
  /** Final status; `done` is the happy path, the rest are kept so the
   *  history works as an audit log for failures too. */
  status: 'done' | 'failed' | 'cancelled' | 'skipped';
  /** Optional human-readable error string for non-`done` entries. */
  error?: string;
  /** Unix epoch ms when the job settled. */
  finishedAt: number;
}

export const TOOLBOX_HISTORY_STORAGE_KEY = 'giftk.toolbox.history.v1';
const TOOLBOX_HISTORY_LIMIT = 200;

/**
 * R-79b — see [storageSchema.ts](./storageSchema.ts) for the full
 * version-contract rationale. Currently version 1 with no migrations
 * defined; the existing on-disk shape *is* v1 and legacy bare-array
 * blobs are accepted as v0 by the shared reader.
 */
export const TOOLBOX_HISTORY_SCHEMA_VERSION = 1;
const TOOLBOX_HISTORY_MIGRATORS: ReadonlyArray<(prev: unknown[]) => unknown[]> = [];

export interface UseToolboxResult {
  kind: ToolboxKind;
  /** R-41 — `setKind` can be called with a second arg `{ confirm }` so
   *  the caller can intercept incompatible-queue switches (e.g. when
   *  the queued .mp4s would all be dropped because the new tool only
   *  accepts .gif/.webp). The hook calls `confirm(droppedCount)` and
   *  aborts the switch if it returns false. Without the option we
   *  preserve the old "silent drop" behaviour for backwards-compat. */
  setKind: (k: ToolboxKind, opts?: { confirm?: (droppedCount: number) => boolean }) => boolean;
  params: ToolboxParams;
  setParams: (p: ToolboxParams | ((prev: ToolboxParams) => ToolboxParams)) => void;
  jobs: ToolboxJobView[];
  addJobsFromPaths: (paths: string[]) => void;
  removeJob: (id: string) => void;
  clearJobs: () => void;
  progress: Record<string, TaskProgress>;
  /** Last batch's output directory (populated after a successful start). */
  lastOutputDir: string | null;
  isRunning: boolean;
  start: () => Promise<{ ok: boolean; error?: string }>;
  cancel: () => Promise<void>;
  /** R-39 — completed runs, newest first. */
  toolboxHistory: ToolboxHistoryEntry[];
  removeHistoryEntry: (id: string) => void;
  clearToolboxHistory: () => void;
}

/** Default params per kind. Mirrors processor.ts defaults so the renderer
 *  preview values match what main will actually use. */
export function defaultParamsFor(kind: ToolboxKind): ToolboxParams {
  switch (kind) {
    case 'video-to-gif':
      return { fps: 12, width: 800 };
    case 'video-to-webp':
      return { fps: 15, width: 800, quality: 75, loop: 0 };
    case 'gif-resize':
      return { targetWidth: 480 };
    case 'gif-optimize':
      return { method: 'lossy', lossy: 80, colors: 128, dropEveryN: 2 };
    case 'trim':
      // No defaults — leaving startSec/endSec undefined lets the user
      // pick the range explicitly. Main-side falls back to (0, EOF).
      return {};
    case 'speed':
      return { speedFactor: 1 };
    case 'reverse':
      // 'mute' is the safest default: most reverse-clip use-cases don't
      // want backwards-talking audio, and this avoids the corner case
      // where the source has no audio stream at all.
      return { reverseAudioMode: 'mute' };
    case 'rotate':
      return { rotateDegrees: 90, flipH: false, flipV: false };
    case 'crop':
      // Crop has no defaults — the rect comes from the user's drag on the
      // preview canvas. Until they draw, the panel's Start button stays
      // disabled (renderer enforces single-file + cropX/Y/W/H presence).
      return {};
    case 'gif-webp-convert':
      // R-42 — When entering the tool with no queued file, default the
      // target to 'webp' (the most common ezgif use-case is "shrink my
      // gif to webp"). Once a file is queued the ToolboxPanel flips
      // this default to the *opposite* of the input extension via a
      // dedicated effect, so dropping a .webp re-defaults to 'gif'.
      return { targetFormat: 'webp' };
    default:
      return {};
  }
}

function basenameFromPath(p: string): string {
  const m = /[^/\\]+$/.exec(p);
  return m ? m[0] : p;
}

let counter = 0;
function genJobId(): string {
  counter += 1;
  return `tb_${Date.now().toString(36)}_${counter}_${Math.random().toString(36).slice(2, 8)}`;
}

/** R-39 — best-effort load. Treats every parse / shape error as "no
 *  history" so a corrupted entry never blocks the panel from booting.
 *  R-79b — read goes through the shared envelope helper; legacy bare
 *  arrays are still accepted as v0. */
function loadHistoryFromStorage(): ToolboxHistoryEntry[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  const { payload } = readVersionedStorage<unknown>({
    key: TOOLBOX_HISTORY_STORAGE_KEY,
    currentVersion: TOOLBOX_HISTORY_SCHEMA_VERSION,
    migrators: TOOLBOX_HISTORY_MIGRATORS
  });
  try {
    return payload.filter((e): e is ToolboxHistoryEntry => {
      if (!e || typeof e !== 'object') return false;
      const x = e as Record<string, unknown>;
      return typeof x.id === 'string' &&
        typeof x.kind === 'string' &&
        typeof x.inputPath === 'string' &&
        typeof x.displayName === 'string' &&
        Array.isArray(x.outputs) &&
        typeof x.finishedAt === 'number' &&
        (x.status === 'done' || x.status === 'failed' || x.status === 'cancelled' || x.status === 'skipped');
    });
  } catch {
    return [];
  }
}

function saveHistoryToStorage(list: ToolboxHistoryEntry[]): void {
  writeVersionedStorage({
    key: TOOLBOX_HISTORY_STORAGE_KEY,
    currentVersion: TOOLBOX_HISTORY_SCHEMA_VERSION,
    payload: list
  });
}

const TERMINAL: ReadonlySet<TaskProgress['status']> = new Set([
  'done', 'failed', 'cancelled', 'skipped'
]);

export function useToolbox(): UseToolboxResult {
  const [kind, setKindInner] = useState<ToolboxKind>('video-to-gif');
  const [params, setParamsInner] = useState<ToolboxParams>(() => defaultParamsFor('video-to-gif'));
  const [jobs, setJobs] = useState<ToolboxJobView[]>([]);
  // R-41 — Mirror the latest `jobs` array into a ref so synchronous
  // helpers like setKind() can compute the queue diff (incompatible
  // count) without relying on functional setState semantics — under
  // act() / strict-mode batching, React may defer the functional
  // updater past the synchronous setKind body, which means the
  // confirm() callback wouldn't fire. The ref is updated via the
  // `jobsRef.current = jobs` assignment below (see useEffect).
  const jobsRef = useRef<ToolboxJobView[]>([]);
  jobsRef.current = jobs;
  const [progress, setProgress] = useState<Record<string, TaskProgress>>({});
  const [lastOutputDir, setLastOutputDir] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [toolboxHistory, setToolboxHistory] = useState<ToolboxHistoryEntry[]>(() => loadHistoryFromStorage());
  // Track ids the toolbox owns so we can ignore unrelated `process:progress`
  // events flowing through the same IPC channel (e.g. from a home-tab batch).
  const ownedIdsRef = useRef<Set<string>>(new Set());
  // Snapshot of jobs at start time, keyed by id, so the migration step
  // (jobs → history) can read displayName/params/inputPath even after
  // we've already removed the row from `jobs`.
  const jobSnapshotsRef = useRef<Map<string, ToolboxJobView>>(new Map());
  // Param snapshot per id — main-side may mutate kind/params over time
  // (rare but allowed in future versions); the snapshot freezes the
  // value the user actually saw when they hit Start.
  const paramSnapshotsRef = useRef<Map<string, { kind: ToolboxKind; params: ToolboxParams }>>(new Map());
  // Ids already migrated to history this render cycle, to make the
  // jobs→history transition idempotent under React's strict mode + the
  // possibility of the same `done` event firing twice.
  const migratedIdsRef = useRef<Set<string>>(new Set());

  const setKind = useCallback((
    k: ToolboxKind,
    opts?: { confirm?: (droppedCount: number) => boolean }
  ): boolean => {
    // R-41 — Compute the queue diff *before* mutating state so we can
    // ask the user before silently dropping rows. The previous
    // implementation always dropped incompatible items and the user
    // would get no feedback ("where did my files go?"). We capture a
    // synchronous snapshot of `jobs` via a flushSync-style functional
    // setState that returns the previous value unchanged — this is
    // safe because React invokes the functional updater immediately
    // when setState is called outside an event/render commit phase
    // (verified in the unit tests).
    const allowed = new Set<string>(
      TOOLBOX_INPUT_EXTENSIONS[k].map((e) => e.toLowerCase())
    );
    const isCompatible = (p: string): boolean => {
      const dot = p.lastIndexOf('.');
      if (dot < 0) return false;
      return allowed.has(p.slice(dot).toLowerCase());
    };
    const snapshot: ToolboxJobView[] = jobsRef.current;
    let droppedCount = 0;
    for (const j of snapshot) if (!isCompatible(j.inputPath)) droppedCount += 1;

    if (droppedCount > 0 && opts?.confirm && !opts.confirm(droppedCount)) {
      return false;
    }

    setKindInner(k);
    setParamsInner(defaultParamsFor(k));
    // R-38 — keep already-queued jobs across kind switches whenever the
    // new kind's input-extension whitelist is compatible. Previously we
    // wiped jobs unconditionally, which felt punitive when a user just
    // wanted to flip from "Speed" to "Trim" with the same .mp4.
    setJobs((prev) => prev.filter((j) => isCompatible(j.inputPath)));
    setProgress({});
    setLastOutputDir(null);
    return true;
  }, []);

  const setParams = useCallback(
    (p: ToolboxParams | ((prev: ToolboxParams) => ToolboxParams)): void => {
      setParamsInner((prev) => (typeof p === 'function' ? (p as (x: ToolboxParams) => ToolboxParams)(prev) : p));
    },
    []
  );

  const addJobsFromPaths = useCallback((paths: string[]): void => {
    if (!Array.isArray(paths) || paths.length === 0) return;
    setJobs((prev) => {
      // R-40 — Filter incoming paths against the *current* kind's
      // extension whitelist. Previously addJobsFromPaths admitted any
      // string and relied on the picker dialog's filter alone, which
      // meant drag-and-drop could smuggle a .mp4 into a GIF-only tool
      // (e.g. Reverse). The setKind path already does the equivalent
      // filter for queued items; doing it here too gives the user a
      // single, consistent rule: "the queue may only ever contain
      // files that the current tool supports".
      const allowed = new Set<string>(
        TOOLBOX_INPUT_EXTENSIONS[kind].map((e) => e.toLowerCase())
      );
      const seen = new Set(prev.map((j) => j.inputPath));
      const next = [...prev];
      for (const raw of paths) {
        if (typeof raw !== 'string' || !raw) continue;
        if (seen.has(raw)) continue;
        const dot = raw.lastIndexOf('.');
        if (dot < 0) continue;
        if (!allowed.has(raw.slice(dot).toLowerCase())) continue;
        seen.add(raw);
        next.push({
          id: genJobId(),
          // R-43 H-2 — was hardcoded to 'video-to-gif', which polluted
          // the history kind label whenever a job's paramSnapshot wasn't
          // available (e.g. a settle that beats start()'s snapshot
          // write). Use the current kind closure so the row reflects
          // the active tool from the moment it enters the queue.
          kind,
          inputPath: raw,
          params: {},
          displayName: basenameFromPath(raw)
        });
      }
      return next;
    });
  }, [kind]);

  const removeJob = useCallback((id: string): void => {
    setJobs((prev) => prev.filter((j) => j.id !== id));
    setProgress((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const clearJobs = useCallback((): void => {
    setJobs([]);
    setProgress({});
  }, []);

  const removeHistoryEntry = useCallback((id: string): void => {
    setToolboxHistory((prev) => {
      const next = prev.filter((e) => e.id !== id);
      saveHistoryToStorage(next);
      return next;
    });
  }, []);

  const clearToolboxHistory = useCallback((): void => {
    setToolboxHistory(() => {
      saveHistoryToStorage([]);
      return [];
    });
  }, []);

  // R-39 — promote terminal-status progress events into history entries.
  // We do this in the same listener that records progress so the order of
  // operations is deterministic: progress event → history insert → row
  // removal. Idempotent via migratedIdsRef.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.giftk) return;
    const off = window.giftk.onProgress((p) => {
      if (!ownedIdsRef.current.has(p.taskId)) return;
      setProgress((prev) => ({ ...prev, [p.taskId]: p }));

      if (!TERMINAL.has(p.status)) return;
      if (migratedIdsRef.current.has(p.taskId)) return;
      const snap = jobSnapshotsRef.current.get(p.taskId);
      if (!snap) return;
      migratedIdsRef.current.add(p.taskId);
      const paramSnap = paramSnapshotsRef.current.get(p.taskId);
      const entry: ToolboxHistoryEntry = {
        id: p.taskId,
        kind: paramSnap?.kind ?? snap.kind,
        inputPath: snap.inputPath,
        displayName: snap.displayName,
        outputs: Array.isArray(p.outputs) ? p.outputs.slice() : [],
        params: paramSnap?.params ?? snap.params,
        status: p.status as ToolboxHistoryEntry['status'],
        error: p.error,
        finishedAt: Date.now()
      };
      setToolboxHistory((prev) => {
        // Replace any pre-existing entry with the same id (defensive).
        const filtered = prev.filter((e) => e.id !== entry.id);
        const next = [entry, ...filtered].slice(0, TOOLBOX_HISTORY_LIMIT);
        saveHistoryToStorage(next);
        return next;
      });
      // Drop the row from the queue so the user sees a strict "to-do".
      setJobs((prev) => prev.filter((j) => j.id !== p.taskId));
      setProgress((prev) => {
        if (!prev[p.taskId]) return prev;
        const next = { ...prev };
        delete next[p.taskId];
        return next;
      });
    });
    return () => {
      try { off(); } catch { /* ignore */ }
    };
  }, []);

  // Auto-flip isRunning to false when every owned job has settled.
  useEffect(() => {
    if (!isRunning) return;
    const owned = Array.from(ownedIdsRef.current);
    if (owned.length === 0) return;
    // After R-39 a settled job is removed from `progress` (and `jobs`)
    // and surfaces in `toolboxHistory` instead. The hook flips off as
    // soon as every owned id has either been migrated to history or is
    // missing from progress (e.g. cancelled mid-flight).
    const historyIds = new Set(toolboxHistory.map((e) => e.id));
    const allSettled = owned.every((id) => historyIds.has(id) || migratedIdsRef.current.has(id));
    if (allSettled) {
      setIsRunning(false);
    }
  }, [progress, isRunning, toolboxHistory]);

  const start = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (typeof window === 'undefined' || !window.giftk) {
      return { ok: false, error: 'giftk bridge unavailable' };
    }
    if (jobs.length === 0) return { ok: false, error: 'no jobs to run' };
    // Promote the renderer-side per-tool params onto each ToolboxJob and
    // override its kind to the currently-selected toolbox kind. The hook
    // intentionally keeps params at the form level so the user can tweak
    // once and apply to all queued files.
    const payload: ToolboxJob[] = jobs.map((j) => ({
      id: j.id,
      kind,
      inputPath: j.inputPath,
      params
    }));
    ownedIdsRef.current = new Set(payload.map((j) => j.id));
    // Snapshot job rows + params so the history-migration step can read
    // them after we've already removed the row from `jobs`.
    jobSnapshotsRef.current = new Map(jobs.map((j) => [j.id, j]));
    paramSnapshotsRef.current = new Map(jobs.map((j) => [j.id, { kind, params }]));
    migratedIdsRef.current = new Set();
    setProgress({});
    setIsRunning(true);
    try {
      const res = await window.giftk.startToolbox(payload);
      setLastOutputDir(res.outputDir);
      return { ok: true };
    } catch (e) {
      setIsRunning(false);
      return { ok: false, error: (e as Error).message || String(e) };
    }
  }, [jobs, kind, params]);

  const cancel = useCallback(async (): Promise<void> => {
    if (typeof window === 'undefined' || !window.giftk) return;
    try {
      await window.giftk.cancelAll();
    } finally {
      setIsRunning(false);
    }
  }, []);

  return {
    kind,
    setKind,
    params,
    setParams,
    jobs,
    addJobsFromPaths,
    removeJob,
    clearJobs,
    progress,
    lastOutputDir,
    isRunning,
    start,
    cancel,
    toolboxHistory,
    removeHistoryEntry,
    clearToolboxHistory
  };
}
