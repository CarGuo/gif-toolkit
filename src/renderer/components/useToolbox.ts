import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskProgress, ToolboxKind, ToolboxParams, ToolboxJob } from '../../shared/types';
import { TOOLBOX_INPUT_EXTENSIONS } from '../../shared/types';
import { reportDbError } from './dbErrorBus';
import {
  type ToolboxJobView,
  type ToolboxHistoryEntry,
  TOOLBOX_HISTORY_STORAGE_KEY,
  TOOLBOX_HISTORY_LIMIT,
  TOOLBOX_HISTORY_SCHEMA_VERSION,
  defaultParamsFor,
  basenameFromPath,
  genJobId,
  parseHistoryEntry,
  TERMINAL_STATUSES
} from './useToolboxHelpers';

/**
 * R-80 / R-35 / R-39 — useToolbox.
 *
 * Manages a flat list of toolbox jobs (one per local input file) plus a
 * map of taskId → latest TaskProgress event. Storage lives in a main-
 * process SQLite store (R-80); the hook keeps an in-memory mirror so
 * the panel renders synchronously, with optimistic fire-and-forget IPC
 * mutations and an async initial load gated on `isHistoryLoading`.
 *
 * Terminal jobs (done / failed / cancelled / skipped) move out of
 * `jobs` into a persistent `toolboxHistory` log. Each entry remembers
 * inputPath, kind, params, outputs and a timestamp so the panel can
 * render a clickable "completed at 14:32 · GIF Resize · clip.mp4 →
 * clip.gif" line.
 *
 * Pure / module-scope helpers (defaultParamsFor, genJobId, ToolboxJobView,
 * TERMINAL_STATUSES, etc.) live in [useToolboxHelpers.ts](./useToolboxHelpers.ts);
 * we re-export the public surface here for backwards-compat with the
 * many call sites that imported them directly from useToolbox.
 */

export {
  TOOLBOX_HISTORY_STORAGE_KEY,
  TOOLBOX_HISTORY_SCHEMA_VERSION,
  defaultParamsFor
};
export type { ToolboxJobView, ToolboxHistoryEntry };

export interface UseToolboxResult {
  kind: ToolboxKind;
  /** R-41 — `setKind({ confirm })` lets the caller intercept incompatible-
   *  queue switches (e.g. queued .mp4s when the new tool only accepts
   *  .gif/.webp). Returns false to abort. Without the option we preserve
   *  the legacy silent-drop behaviour. */
  setKind: (k: ToolboxKind, opts?: { confirm?: (droppedCount: number) => boolean }) => boolean;
  params: ToolboxParams;
  setParams: (p: ToolboxParams | ((prev: ToolboxParams) => ToolboxParams)) => void;
  jobs: ToolboxJobView[];
  addJobsFromPaths: (paths: string[]) => void;
  removeJob: (id: string) => void;
  clearJobs: () => void;
  /** R-TRIM-CROP-SINGLE — id of the queue row currently selected as
   *  Trim/Crop target. Auto-pinned; null = empty queue. */
  selectedJobId: string | null;
  /** R-TRIM-CROP-SINGLE — set the target; unknown ids are no-ops. */
  selectJob: (id: string | null) => void;
  progress: Record<string, TaskProgress>;
  /** Last batch's output directory (populated after a successful start). */
  lastOutputDir: string | null;
  isRunning: boolean;
  start: () => Promise<{ ok: boolean; error?: string }>;
  cancel: () => Promise<void>;
  /** R-39 — completed runs, newest first. */
  toolboxHistory: ToolboxHistoryEntry[];
  /** R-80 — true while the initial DB read is in flight. */
  isHistoryLoading: boolean;
  removeHistoryEntry: (id: string) => void;
  clearToolboxHistory: () => void;
  /** R-80 hardening — re-read the toolbox history list from the DB.
   *  Used post-bootstrap so a hook that mounted before the import
   *  finished surfaces freshly-imported rows. */
  reloadToolboxHistory: () => void;
  /** R-COMPRESS-V1 #5 — atomically prefill the toolbox from a sniff
   *  history "推荐预设" chip click. Clears the current queue + progress,
   *  sets `kind` and `params` to the preset values (replacing — NOT
   *  merging — the previous params so a chip click yields the exact
   *  intended config), then enqueues exactly one job sourced from
   *  `inputPath`. The caller (App.tsx) is responsible for switching
   *  the active tab to 工具箱 before calling so the user sees the
   *  result. The whole operation is synchronous and idempotent: a
   *  second click with the same args is a no-op except for re-seeding
   *  the queue with a fresh job id. */
  applyPreset: (args: { inputPath: string; kind: ToolboxKind; params: ToolboxParams }) => void;
}

export function useToolbox(): UseToolboxResult {
  const [kind, setKindInner] = useState<ToolboxKind>('video-to-gif');
  const [params, setParamsInner] = useState<ToolboxParams>(() => defaultParamsFor('video-to-gif'));
  // R-COMPRESS-V1.1 / R-86 — sticky per-kind params cache.
  //
  // Previously `setKind` reset params to `defaultParamsFor(k)` every
  // time the user switched tool, which silently discarded any chips /
  // tweaks the user had just configured (e.g. picking "目标体积 < 2MB"
  // on gif-optimize, then flipping to gif-resize to peek and back —
  // the budget selection was gone).
  //
  // We now keep one ToolboxParams per ToolboxKind in a ref-backed map
  // so each tool remembers its last-seen form state for the lifetime
  // of the hook. A ref (not state) is used on purpose: this cache is
  // only read inside `setKind` and `applyPreset`; rendering does not
  // depend on it (the visible `params` state still drives the panel),
  // so triggering a re-render on every keystroke would be wasted work.
  // Writes happen in three places: setKind (snapshot prev, restore
  // next), setParams (mirror live form state) and applyPreset (so a
  // preset survives a same-session round-trip away and back).
  const paramsByKindRef = useRef<Partial<Record<ToolboxKind, ToolboxParams>>>({});
  // Mirror the live `kind` into a ref so `setParams` can synchronously
  // attribute the new value to the *currently active* tool without
  // taking a stale closure on `kind` (setParams is a stable useCallback
  // with [] deps).
  const kindRef = useRef<ToolboxKind>(kind);
  kindRef.current = kind;
  // Seed the cache with the initial tool's params so the first
  // setKind() away preserves whatever the user touched before
  // switching (instead of snapshotting `undefined`).
  if (paramsByKindRef.current[kind] === undefined) {
    paramsByKindRef.current[kind] = params;
  }
  const [jobs, setJobs] = useState<ToolboxJobView[]>([]);
  // R-TRIM-CROP-SINGLE — Trim/Crop must operate on exactly one queued
  // file at a time; track via id (not path) to disambiguate duplicates.
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
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
  const [toolboxHistory, setToolboxHistory] = useState<ToolboxHistoryEntry[]>([]);
  const [isHistoryLoading, setIsHistoryLoading] = useState<boolean>(true);
  // R-80 — guard async DB reads against late resolution after unmount
  // (StrictMode double-invokes effects in dev). Checked before any
  // setState in the bootstrap then-block.
  const mountedRef = useRef<boolean>(true);
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
    // R-86 — sticky per-kind cache. Snapshot the params the user was
    // looking at under the *previous* kind, then restore (or seed) the
    // new kind's slot. We read prev via the functional setParamsInner
    // signature so we don't depend on a stale `params` closure.
    setParamsInner((prevParams) => {
      const prevKind = kindRef.current;
      paramsByKindRef.current[prevKind] = prevParams;
      const cached = paramsByKindRef.current[k];
      const nextParams = cached !== undefined ? cached : defaultParamsFor(k);
      paramsByKindRef.current[k] = nextParams;
      return nextParams;
    });
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
      setParamsInner((prev) => {
        const next = typeof p === 'function'
          ? (p as (x: ToolboxParams) => ToolboxParams)(prev)
          : p;
        // R-86 — mirror the live form value into the per-kind cache so
        // a subsequent setKind() round-trip restores exactly what the
        // user last saw. Attribute to `kindRef.current` (not a stale
        // closure on `kind`) because setParams is a stable callback.
        paramsByKindRef.current[kindRef.current] = next;
        return next;
      });
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
    setToolboxHistory((prev) => prev.filter((e) => e.id !== id));
    const api = typeof window !== 'undefined' ? window.giftk?.db?.toolboxHistory : undefined;
    if (api) {
      api.remove(id).catch((err) => reportDbError('toolboxHistory', 'remove', err));
    }
  }, []);

  const clearToolboxHistory = useCallback((): void => {
    setToolboxHistory([]);
    const api = typeof window !== 'undefined' ? window.giftk?.db?.toolboxHistory : undefined;
    if (api) {
      api.clear().catch((err) => reportDbError('toolboxHistory', 'clear', err));
    }
  }, []);

  // R-80 hardening — re-read the toolbox history from the DB. Shared
  // by both the initial load effect and the public `reloadToolboxHistory`
  // exposed for App.tsx's post-bootstrap refresh.
  const reloadToolboxHistory = useCallback((): void => {
    const api = typeof window !== 'undefined' ? window.giftk?.db?.toolboxHistory : undefined;
    if (!api) return;
    api
      .readAll()
      .then((rows) => {
        if (!mountedRef.current) return;
        const out: ToolboxHistoryEntry[] = [];
        for (const r of rows) {
          const e = parseHistoryEntry(r);
          if (e) out.push(e);
        }
        out.sort((a, b) => b.finishedAt - a.finishedAt);
        setToolboxHistory(out.slice(0, TOOLBOX_HISTORY_LIMIT));
      })
      .catch((err) => reportDbError('toolboxHistory', 'readAll', err));
  }, []);

  // R-80 — initial DB load. Toolbox history is convenience-only so a
  // bridge / IPC failure leaves the in-memory list empty rather than
  // crashing the panel.
  useEffect(() => {
    mountedRef.current = true;
    const api = typeof window !== 'undefined' ? window.giftk?.db?.toolboxHistory : undefined;
    if (!api) {
      setIsHistoryLoading(false);
      return () => {
        mountedRef.current = false;
      };
    }
    api
      .readAll()
      .then((rows) => {
        if (!mountedRef.current) return;
        const out: ToolboxHistoryEntry[] = [];
        for (const r of rows) {
          const e = parseHistoryEntry(r);
          if (e) out.push(e);
        }
        // newest-first (DB returns ordered, but defensive sort here
        // protects against future schema drift).
        out.sort((a, b) => b.finishedAt - a.finishedAt);
        setToolboxHistory(out.slice(0, TOOLBOX_HISTORY_LIMIT));
      })
      .catch((err) => reportDbError('toolboxHistory', 'readAll', err))
      .finally(() => {
        if (mountedRef.current) setIsHistoryLoading(false);
      });
    return () => {
      mountedRef.current = false;
    };
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

      if (!TERMINAL_STATUSES.has(p.status)) return;
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
        return next;
      });
      // R-80 — fire-and-forget DB upsert. Toolbox history is
      // convenience-only; an IPC failure leaves the in-memory list
      // intact and the next boot just won't see the row.
      const api = typeof window !== 'undefined' ? window.giftk?.db?.toolboxHistory : undefined;
      if (api) {
        api.upsert(entry).catch((err) => reportDbError('toolboxHistory', 'upsert', err));
      }
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
    // R-TRIM-CROP-SINGLE — Trim and Crop are inherently single-file
    // ops. Resolve the active row from selectedJobId (auto-pinned via
    // the effect below) and dispatch ONE; the rest of the queue stays.
    const isSingleKind = kind === 'trim' || kind === 'crop';
    const dispatched: ToolboxJobView[] = isSingleKind
      ? (() => {
          const sel = jobs.find((j) => j.id === selectedJobId) ?? jobs[0];
          return sel ? [sel] : [];
        })()
      : jobs;
    if (dispatched.length === 0) {
      return { ok: false, error: 'no job selected' };
    }
    // Promote the renderer-side per-tool params onto each ToolboxJob and
    // override its kind to the currently-selected toolbox kind. The hook
    // intentionally keeps params at the form level so the user can tweak
    // once and apply to all queued files.
    const payload: ToolboxJob[] = dispatched.map((j) => ({
      id: j.id,
      kind,
      inputPath: j.inputPath,
      params
    }));
    ownedIdsRef.current = new Set(payload.map((j) => j.id));
    // Snapshot job rows + params so the history-migration step can read
    // them after we've already removed the row from `jobs`.
    jobSnapshotsRef.current = new Map(dispatched.map((j) => [j.id, j]));
    paramSnapshotsRef.current = new Map(dispatched.map((j) => [j.id, { kind, params }]));
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
  }, [jobs, kind, params, selectedJobId]);

  const cancel = useCallback(async (): Promise<void> => {
    if (typeof window === 'undefined' || !window.giftk) return;
    try {
      await window.giftk.cancelAll();
    } finally {
      setIsRunning(false);
    }
  }, []);

  // R-TRIM-CROP-SINGLE — auto-pin selection: enter trim/crop → pin
  // jobs[0]; selected row removed → pin new head; non-single kinds → noop.
  useEffect(() => {
    if (kind !== 'trim' && kind !== 'crop') return;
    if (jobs.length === 0) {
      if (selectedJobId !== null) setSelectedJobId(null);
      return;
    }
    if (selectedJobId === null || !jobs.some((j) => j.id === selectedJobId)) {
      setSelectedJobId(jobs[0].id);
    }
  }, [kind, jobs, selectedJobId]);

  // R-TRIM-CROP-SINGLE — public selector, validates id against queue.
  const selectJob = useCallback((id: string | null): void => {
    if (id === null || jobsRef.current.some((j) => j.id === id)) {
      setSelectedJobId(id);
    }
  }, []);

  // R-COMPRESS-V1 #5 — sniff-history「推荐预设」chip → toolbox prefill.
  // The flow is intentionally surgical: clear whatever the user had
  // queued, set the preset kind+params verbatim (NOT merged with the
  // current params; a chip click means "I want exactly this config"),
  // then enqueue ONE job for the chosen input path. We bypass
  // `addJobsFromPaths` because that helper filters against the
  // CURRENT kind's whitelist via React-batched setState, which means
  // a same-tick "set kind to video-to-gif AND queue clip.mp4" race
  // would drop the job when the previous kind disallowed .mp4. By
  // building the row inline against the *new* kind we keep the chip
  // contract atomic and survivable across tab switches.
  const applyPreset = useCallback(
    (args: { inputPath: string; kind: ToolboxKind; params: ToolboxParams }): void => {
      const { inputPath, kind: nextKind, params: nextParams } = args;
      if (typeof inputPath !== 'string' || !inputPath) return;
      const dot = inputPath.lastIndexOf('.');
      if (dot < 0) return;
      const ext = inputPath.slice(dot).toLowerCase();
      const allowed = new Set<string>(
        TOOLBOX_INPUT_EXTENSIONS[nextKind].map((e) => e.toLowerCase())
      );
      if (!allowed.has(ext)) return;
      setKindInner(nextKind);
      setParamsInner(nextParams);
      // R-86 — a preset click means "I want exactly this config for
      // this tool"; record it in the sticky cache so that a subsequent
      // setKind() away-and-back doesn't silently regress to either the
      // pre-preset chip selection or the kind's static defaults.
      paramsByKindRef.current[nextKind] = nextParams;
      setProgress({});
      setLastOutputDir(null);
      setJobs([
        {
          id: genJobId(),
          kind: nextKind,
          inputPath,
          params: {},
          displayName: basenameFromPath(inputPath)
        }
      ]);
    },
    []
  );

  return {
    kind,
    setKind,
    params,
    setParams,
    jobs,
    addJobsFromPaths,
    removeJob,
    clearJobs,
    selectedJobId,
    selectJob,
    progress,
    lastOutputDir,
    isRunning,
    start,
    cancel,
    toolboxHistory,
    isHistoryLoading,
    removeHistoryEntry,
    clearToolboxHistory,
    reloadToolboxHistory,
    applyPreset
  };
}
