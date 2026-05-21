/**
 * useWorkspaces — manages a list of "嗅探 workspaces" (browser-tab style).
 *
 * Why this exists
 * ---------------
 * Previously the home page's React state (URL, sniff result, selection,
 * processing options, per-task progress, preview overrides, embed-resolve
 * state, in-memory logs) was a single global blob. Each new sniff
 * overwrote the previous one in-place — so the user could not keep
 * multiple work-in-progress sessions open in parallel: switching to a
 * different page lost the selection, the partial progress, the per-media
 * preview tweaks, etc.
 *
 * This hook turns that single blob into an array of independent
 * `Workspace` snapshots, one per active sniff session, plus a notion of
 * "the currently active workspace". The home page reads from / writes to
 * the active workspace via the setters returned by the hook, so
 * consumers don't need to know about the array.
 *
 * Design choices
 * --------------
 *  • State container, not store: this is a single useReducer-like
 *    `useState<{ list: Workspace[]; activeId: string | null }>` plus a
 *    suite of `setX` shims. We deliberately did NOT use `useReducer` /
 *    Redux / Zustand — the call shape from App.tsx still needs to look
 *    like `setSelected((prev) => …)` so we don't have to rewrite
 *    thousands of lines.
 *  • Updates land on `activeId` only, except for the IPC routing helpers
 *    (`patchWsByHistoryId`, `patchAnyWs`) which cross-cut by historyId
 *    so a background `process:progress` event for ws-A doesn't bleed
 *    into ws-B even when ws-B is currently active.
 *  • Refs (sniffReqId, activeHistoryId mirror) live alongside this
 *    hook — they are advisory cancellation tokens, not state. We DO
 *    surface `activeHistoryId` as a derived value off the active
 *    workspace so the rest of the app keeps treating it like a single
 *    pointer.
 *  • Reuse-blank-tab vs always-new-tab: per the product decision, when
 *    the user starts a new sniff and the active tab is "blank" (no URL
 *    submitted yet AND no result), we reuse it instead of creating a
 *    new tab. The `claimWorkspaceForSniff()` helper encapsulates this.
 *  • No persistence (this iteration): closed tabs are dropped from
 *    memory; the underlying HistoryRecord is already in SQLite via
 *    useHistory, so users can resurrect a session through the history
 *    panel. Restart = clean slate. A future iteration could add a
 *    `workspaces` table; for now we keep the surface minimal.
 *  • inflight detection: a workspace is considered "busy" if any
 *    progress entry's status is in {downloading, converting,
 *    compressing, uploading, queued} or the processingOne set is
 *    non-empty. The home page uses this for the close-tab confirm
 *    dialog ("有 N 个任务正在跑,关闭吗?").
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  ProcessOptions,
  ResolvedMedia,
  SniffResult,
  SniffedMedia,
  TaskProgress
} from '../../shared/types';
import { DEFAULT_OPTIONS } from '../../shared/types';
import type { PreviewOverride } from './PreviewModal';

/**
 * The full per-tab state. Mirrors the fields that used to live as
 * top-level useState in App.tsx, plus a small amount of bookkeeping
 * (`id`, `historyId`, `title`, `createdAt`).
 */
export interface Workspace {
  /** Stable internal id; never displayed to the user. */
  readonly id: string;
  /**
   * Owned HistoryRecord id (one-to-one). Set when the sniff completes
   * and the home page calls `setHistoryId`. Null until then.
   */
  historyId: string | null;
  /** URL the user typed into the sniff input. May be empty in a fresh tab. */
  url: string;
  /** Current sniff result; null if a sniff has not run or returned 0 items. */
  result: SniffResult | null;
  /** True while a sniff network call is in flight. */
  sniffing: boolean;
  selected: Set<string>;
  options: ProcessOptions;
  progress: Record<string, TaskProgress>;
  processingOne: Set<string>;
  previewOverrides: Record<string, PreviewOverride>;
  resolvedMap: Record<string, ResolvedMedia>;
  resolvingSet: Set<string>;
  resolveErrorMap: Record<string, string>;
  /**
   * In-memory log lines. This is the SAME buffer that ProgressDock's
   * LogOverlay reads — kept per workspace so logs from sniff A don't
   * leak into sniff B's overlay.
   */
  logs: string[];
  createdAt: number;
}

let workspaceSeq = 0;
const newWorkspaceId = (): string => {
  workspaceSeq += 1;
  return `ws-${Date.now().toString(36)}-${workspaceSeq}`;
};

/** Construct a fresh, empty workspace. */
const blankWorkspace = (): Workspace => ({
  id: newWorkspaceId(),
  historyId: null,
  url: '',
  result: null,
  sniffing: false,
  selected: new Set(),
  options: { ...DEFAULT_OPTIONS },
  progress: {},
  processingOne: new Set(),
  previewOverrides: {},
  resolvedMap: {},
  resolvingSet: new Set(),
  resolveErrorMap: {},
  logs: [],
  createdAt: Date.now()
});

/**
 * What "blank" means for the reuse-on-new-sniff heuristic. A workspace
 * is blank if it has not yet produced a sniff result — i.e. the user
 * opened a tab but never finished a sniff in it. Once a sniff has
 * populated `result`, starting another sniff opens a NEW tab so the
 * existing work is preserved.
 *
 * R-WS-2026-05-21 — `url` is intentionally NOT part of this predicate.
 * Typing a URL into the input is just a pre-sniff staging state; the
 * user's mental model is "I just typed an address into THIS tab, now
 * sniff THIS tab". Including url in isBlank caused the bug where
 * filling the URL input + clicking 真 Chrome 嗅探 spawned a second tab.
 */
const isBlank = (w: Workspace): boolean =>
  w.result === null && !w.sniffing;

/**
 * "Busy" used by the close-tab confirm dialog. We treat any non-terminal
 * progress entry plus any active processingOne entry as "in flight".
 * Terminal statuses are { done, failed, skipped, cancelled } — anything
 * else (pending / downloading / probing / segmenting / converting /
 * compressing) means the task is still running.
 */
const isBusy = (w: Workspace): boolean => {
  if (w.processingOne.size > 0) return true;
  for (const p of Object.values(w.progress)) {
    if (
      p.status !== 'done' &&
      p.status !== 'failed' &&
      p.status !== 'skipped' &&
      p.status !== 'cancelled'
    ) {
      return true;
    }
  }
  return false;
};

/**
 * Display label for a tab. Prefer the sniff result's `title`, fall back
 * to the URL's hostname, then the raw URL, then a generic "新工作区".
 * Trimmed to a sane width so a long Bilibili title doesn't blow out the
 * tab strip; the full title is on the tab's `title` attribute (tooltip).
 */
export const workspaceLabel = (w: Workspace): string => {
  const raw = w.result?.title?.trim()
    || (() => {
      try { return new URL(w.url).hostname; } catch { return ''; }
    })()
    || w.url.trim()
    || '新工作区';
  return raw.length > 28 ? `${raw.slice(0, 27)}…` : raw;
};

/** Public API surface for App.tsx. */
export interface UseWorkspacesApi {
  workspaces: Workspace[];
  activeWs: Workspace;
  activeWsId: string;
  /** Switch to a tab by id; no-op if id unknown. */
  switchTo: (id: string) => void;
  /** Open a fresh tab and activate it. */
  openNew: () => string;
  /**
   * Close a tab. If `id` is the active tab and other tabs exist, the
   * neighbour to the left becomes active (or the right if there isn't
   * one). If we close the LAST tab, a fresh blank tab is created so
   * the home page never has to handle a "no workspaces at all" branch.
   */
  close: (id: string) => void;
  /**
   * Idempotent helper used at sniff start: if the current active tab is
   * blank, claim it for this sniff (returns its id); otherwise open a
   * new tab and return its id. Either way the caller gets back the id
   * it should associate with the upcoming HistoryRecord.
   */
  claimForSniff: () => string;
  /** Patch the active workspace. */
  patchActive: (
    patch: Partial<Workspace> | ((cur: Workspace) => Partial<Workspace>)
  ) => void;
  /** Patch a workspace by id (used by IPC routing). */
  patchById: (
    id: string,
    patch: Partial<Workspace> | ((cur: Workspace) => Partial<Workspace>)
  ) => void;
  /**
   * Patch the workspace whose `historyId === recordId`. This is the
   * primary way `process:progress` events route into the right tab.
   * Returns true if a workspace was found.
   */
  patchByHistoryId: (
    recordId: string,
    patch: Partial<Workspace> | ((cur: Workspace) => Partial<Workspace>)
  ) => boolean;
  /** True iff the workspace has any inflight task. */
  isBusy: (w: Workspace) => boolean;
}

/**
 * The hook itself. Always seeds with a single blank workspace so
 * `activeWs` is never null — eliminates a class of "what if no tab is
 * selected?" branches in the consumer.
 */
export function useWorkspaces(): UseWorkspacesApi {
  const [list, setList] = useState<Workspace[]>(() => [blankWorkspace()]);
  const [activeId, setActiveId] = useState<string>(() => list[0].id);
  // Mirror of the latest list/active id, so callbacks stay stable
  // (they don't need to be reborn when state changes).
  const listRef = useRef(list);
  const activeIdRef = useRef(activeId);
  listRef.current = list;
  activeIdRef.current = activeId;

  const switchTo = useCallback((id: string) => {
    if (!listRef.current.some((w) => w.id === id)) return;
    setActiveId(id);
  }, []);

  const openNew = useCallback((): string => {
    const ws = blankWorkspace();
    setList((cur) => [...cur, ws]);
    setActiveId(ws.id);
    return ws.id;
  }, []);

  const close = useCallback((id: string) => {
    setList((cur) => {
      const idx = cur.findIndex((w) => w.id === id);
      if (idx === -1) return cur;
      const next = cur.slice(0, idx).concat(cur.slice(idx + 1));
      // Never leave the user with zero tabs — always reseed.
      if (next.length === 0) {
        const fresh = blankWorkspace();
        // NOTE: we update activeId in a follow-up setActiveId call
        // below; the setList callback should be pure w.r.t. list only.
        return [fresh];
      }
      return next;
    });
    // Adjust activeId AFTER the list mutation. Because setState calls
    // are batched in React 18, the reads inside this updater see the
    // latest queued list when committed.
    setActiveId((curActive) => {
      const list = listRef.current;
      const idx = list.findIndex((w) => w.id === id);
      // If we just closed a non-active tab, no change.
      if (curActive !== id) return curActive;
      // We're closing the active one. Pick its left neighbour (or
      // right if none). After setList commits there's at least one
      // tab; we look it up by index.
      const targetIdx = idx > 0 ? idx - 1 : 0;
      // We can't see the post-commit list here; just compute from the
      // pre-commit list minus the removed entry. The new list at
      // `targetIdx` is well-defined.
      const survivors = list.filter((w) => w.id !== id);
      if (survivors.length === 0) {
        // We will have reseeded with a blank ws in setList — but its
        // id was minted fresh inside setList. We can't retrieve it
        // synchronously here, so set activeId on the *next* render by
        // matching "first item". The tabs render layer is already
        // tolerant to this 1-frame mismatch.
        return curActive;
      }
      return survivors[Math.min(targetIdx, survivors.length - 1)].id;
    });
  }, []);

  const claimForSniff = useCallback((): string => {
    const list = listRef.current;
    const active = list.find((w) => w.id === activeIdRef.current);
    if (active && isBlank(active)) return active.id;
    // Otherwise open a fresh tab.
    const ws = blankWorkspace();
    setList((cur) => [...cur, ws]);
    setActiveId(ws.id);
    return ws.id;
  }, []);

  const applyPatch = useCallback(
    (
      id: string,
      patch: Partial<Workspace> | ((cur: Workspace) => Partial<Workspace>)
    ): boolean => {
      let found = false;
      setList((cur) => {
        const idx = cur.findIndex((w) => w.id === id);
        if (idx === -1) return cur;
        found = true;
        const merged = typeof patch === 'function' ? patch(cur[idx]) : patch;
        const next = cur.slice();
        next[idx] = { ...cur[idx], ...merged };
        return next;
      });
      return found;
    },
    []
  );

  const patchActive = useCallback(
    (patch: Partial<Workspace> | ((cur: Workspace) => Partial<Workspace>)) => {
      applyPatch(activeIdRef.current, patch);
    },
    [applyPatch]
  );

  const patchById = useCallback(
    (
      id: string,
      patch: Partial<Workspace> | ((cur: Workspace) => Partial<Workspace>)
    ) => {
      applyPatch(id, patch);
    },
    [applyPatch]
  );

  const patchByHistoryId = useCallback(
    (
      recordId: string,
      patch: Partial<Workspace> | ((cur: Workspace) => Partial<Workspace>)
    ): boolean => {
      const target = listRef.current.find((w) => w.historyId === recordId);
      if (!target) return false;
      applyPatch(target.id, patch);
      return true;
    },
    [applyPatch]
  );

  const activeWs = useMemo<Workspace>(
    () => list.find((w) => w.id === activeId) ?? list[0],
    [list, activeId]
  );

  return {
    workspaces: list,
    activeWs,
    activeWsId: activeWs.id,
    switchTo,
    openNew,
    close,
    claimForSniff,
    patchActive,
    patchById,
    patchByHistoryId,
    isBusy
  };
}

/**
 * Re-export for tests / TaskTable consumers that need to type
 * arguments at the boundary. Nothing else uses this directly.
 */
export type { SniffedMedia };
