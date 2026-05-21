/**
 * useUploadOrchestrator — extracts the renderer-side upload glue that
 * previously lived inline in App.tsx (the mount-once
 * `uploadGetSettings` effect, the `onUploadOne` / `onUploadAll`
 * callbacks, the `uploadAllStats / uploadAllReady / uploadAllTitle`
 * derived state, and the `onSaveUploadSettings` callback).
 *
 * Why this hook exists separately from useUploadDispatch
 * ------------------------------------------------------
 * useUploadDispatch (Step 5) owns the IPC roundtrip and the renderer
 * routing-table maintenance: it eagerly populates
 * `uploadJobToRecordRef / uploadJobToTargetRef / uploadInflightRef`
 * BEFORE awaiting `uploadStart` (P1 #4 race fix), seeds placeholder
 * UploadHistoryItems with deterministic `${recId}-${i}` jobIds, opens
 * the result modal on success, rolls back on failure. That is the
 * lower-level "actually push these N files to main" primitive.
 *
 * useUploadOrchestrator is the layer ABOVE that: it is renderer-side
 * glue that decides WHICH outputs are eligible for a given user
 * gesture and exposes derived UX hints to the toolbar:
 *
 *   • `onUploadOne` — single-row 📤 button: pick the FIRST output of
 *     a row (typically the .gif) and hand it to dispatchUpload. Skip
 *     gracefully when the row has no outputs yet.
 *   • `onUploadAll` — global 「⚡ 上传所有产物」: walk every row whose
 *     progress is `done` AND has at least one output, plan the batch,
 *     and forward the plan to dispatchUpload. The empty-plan branch
 *     is intentionally NOT short-circuited here: dispatchUpload owns
 *     the "no uploadable products" log line + early return so the
 *     UX message stays consistent with mid-flight failures.
 *   • `uploadAllStats / uploadAllReady / uploadAllTitle` — derived
 *     UX state used by JSX `disabled` and `title` attributes on the
 *     upload-all toolbar button so the user understands *which*
 *     condition is failing instead of being silently disabled.
 *   • `onSaveUploadSettings` — settings-modal save handler. Pushes
 *     the new configs to main, then re-pulls so the renderer mirror
 *     reflects the masked secrets main now persists.
 *   • mount-once effect — load persisted upload settings on first
 *     render. Rejection is swallowed (`.catch(() => { /* ignore *\/ })`)
 *     because a missing settings file is the normal first-run state.
 *
 * Why "deps" instead of owning everything
 * ---------------------------------------
 * `uploadConfigs` state and the routing refs (`uploadJobToTargetRef`,
 * `uploadJobToRecordRef`, `uploadInflightRef`) are deliberately kept
 * in App.tsx because useUploadDispatch and useIpcEvents read from
 * them too. Owning them here would force a re-architecture of the
 * IPC listener. Instead the hook accepts an `UploadOrchestratorDeps`
 * bag — a small set of values + setters the consumer wires through.
 *
 * depsRef + mount-once pattern
 * ----------------------------
 * Mirrors the sibling hook `useEmbedResolve`: deps are mirrored into
 * a `depsRef` so the four `useCallback`s have empty dep lists and
 * keep stable identities across renders. The derived state
 * (`uploadAllStats / Ready / Title`) is recomputed each render via
 * `useMemo` keyed on `[items, progress, uploadConfigs]` so toolbar
 * disabled/title attributes update without forcing children to
 * remount.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type {
  SniffedMedia,
  TaskProgress,
  UploadConfigs
} from '../../shared/types';
import { isUploadConfigured } from './useUploadHistory';

/**
 * Minimal slice of the preload API surface this hook depends on.
 * Declared structurally so tests can pass `vi.fn()` mocks without
 * reaching for the full GifToolkitApi shape.
 */
export interface UploadOrchestratorGiftkApi {
  uploadGetSettings?: () => Promise<UploadConfigs>;
  uploadSetSettings?: (c: UploadConfigs) => Promise<{ ok: boolean }>;
}

export interface UploadOrchestratorDeps {
  /** The preload bridge (or `undefined` if running outside Electron). */
  giftk: UploadOrchestratorGiftkApi | undefined;
  /**
   * The lower-level dispatch primitive from useUploadDispatch.
   * Receives a planned `[{ media, filePath }]` list and handles the
   * IPC + routing-table dance.
   */
  dispatchUpload: (
    plan: Array<{ media: SniffedMedia; filePath: string }>,
    opts?: { sniffRecId?: string | null }
  ) => Promise<void>;
  /** All sniffed media in the active workspace. */
  items: SniffedMedia[];
  /** id → TaskProgress map (drives the per-row done/outputs gates). */
  progress: Record<string, TaskProgress>;
  /** Persisted upload backend configs; null until first hydration. */
  uploadConfigs: UploadConfigs | null;
  /** Setter so the mount-once effect + onSaveUploadSettings can hydrate. */
  setUploadConfigs: React.Dispatch<React.SetStateAction<UploadConfigs | null>>;
  /** Append to the rolling renderer log buffer (capped at 300). */
  setLogs: React.Dispatch<React.SetStateAction<string[]>>;
}

export interface UploadAllStats {
  /** Every item in `items` has reached the `done` status. */
  allDone: boolean;
  /** At least one done row has `outputs[0]`. */
  hasUploadable: boolean;
  /** The active backend has all required fields. */
  configured: boolean;
  total: number;
  doneCount: number;
}

export interface UseUploadOrchestratorApi {
  onUploadOne: (media: SniffedMedia, p: TaskProgress) => Promise<void>;
  onUploadAll: () => Promise<void>;
  onSaveUploadSettings: (next: UploadConfigs) => Promise<void>;
  uploadAllStats: UploadAllStats;
  uploadAllReady: boolean;
  uploadAllTitle: string;
}

export function useUploadOrchestrator(
  deps: UploadOrchestratorDeps
): UseUploadOrchestratorApi {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const onUploadOne = useCallback(async (
    media: SniffedMedia,
    p: TaskProgress
  ): Promise<void> => {
    const { dispatchUpload, setLogs } = depsRef.current;
    const out = p.outputs?.[0];
    if (!out) {
      setLogs((prev) => [...prev, `[upload] 跳过:任务 ${media.id} 没有可用输出`].slice(-300));
      return;
    }
    await dispatchUpload([{ media, filePath: out }]);
  }, []);

  const onUploadAll = useCallback(async (): Promise<void> => {
    const { items, progress, dispatchUpload } = depsRef.current;
    const plan: Array<{ media: SniffedMedia; filePath: string }> = [];
    for (const m of items) {
      const p = progress[m.id];
      if (!p || p.status !== 'done') continue;
      const out = p.outputs?.[0];
      if (!out) continue;
      plan.push({ media: m, filePath: out });
    }
    await dispatchUpload(plan);
  }, []);

  const onSaveUploadSettings = useCallback(async (next: UploadConfigs): Promise<void> => {
    const { giftk, setUploadConfigs } = depsRef.current;
    if (!giftk || typeof giftk.uploadSetSettings !== 'function') return;
    await giftk.uploadSetSettings(next);
    if (typeof giftk.uploadGetSettings === 'function') {
      const fresh = await giftk.uploadGetSettings();
      setUploadConfigs(fresh);
    }
  }, []);

  const { items, progress, uploadConfigs } = deps;
  const uploadAllStats = useMemo<UploadAllStats>(() => {
    if (items.length === 0) {
      return { allDone: false, hasUploadable: false, configured: isUploadConfigured(uploadConfigs), total: 0, doneCount: 0 };
    }
    let doneCount = 0;
    let hasUploadable = false;
    for (const m of items) {
      const p = progress[m.id];
      if (p && p.status === 'done') {
        doneCount += 1;
        if (p.outputs && p.outputs.length > 0) hasUploadable = true;
      }
    }
    return {
      allDone: doneCount === items.length,
      hasUploadable,
      configured: isUploadConfigured(uploadConfigs),
      total: items.length,
      doneCount
    };
  }, [items, progress, uploadConfigs]);

  const uploadAllReady = uploadAllStats.allDone && uploadAllStats.hasUploadable;
  const uploadAllTitle = useMemo<string>(() => {
    if (items.length === 0) return '当前没有可上传的产物';
    if (!uploadAllStats.configured) return '当前图床尚未配置完整,先去「📤 上传设置」里配置一个可用图床';
    if (!uploadAllStats.allDone) return `还有任务未完成 (${uploadAllStats.doneCount}/${uploadAllStats.total}),所有产物都搞定了才能点击`;
    if (!uploadAllStats.hasUploadable) return '所有任务都完成,但没有可上传的输出文件';
    return '把所有已完成任务的产物上传到当前默认图床(可在「📤 上传设置」中切换)';
  }, [items.length, uploadAllStats]);

  useEffect(() => {
    const { giftk, setUploadConfigs } = depsRef.current;
    if (!giftk || typeof giftk.uploadGetSettings !== 'function') return;
    giftk.uploadGetSettings().then(setUploadConfigs).catch(() => { /* ignore */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    onUploadOne,
    onUploadAll,
    onSaveUploadSettings,
    uploadAllStats,
    uploadAllReady,
    uploadAllTitle
  };
}
