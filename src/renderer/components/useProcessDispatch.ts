/**
 * useProcessDispatch — extracts the four startBatch-wrapping callbacks
 * (runDispatch / dispatchBatch / onProcessOne / onReprocessFromHistory
 * / onBatchFromRecord) that previously lived inline in App.tsx
 * (lines 680-1752 of the original blob).
 *
 * Why this hook exists
 * --------------------
 * Every entry point that talks to `giftk.startBatch` shares the same
 * dense ritual:
 *
 *   1. R-29 (P1-I) — pin `taskId → recordId` in `taskRecordMapRef`
 *      BEFORE awaiting startBatch so the very first `process:progress`
 *      event from main is routed to the correct history record. Doing
 *      this AFTER the await opened a race where fast machines / small
 *      queues could drop the first emit onto a stale activeHistoryId.
 *
 *   2. R-29 (P1-E) — snapshot any prior `progress[id]` entry before
 *      seeding the row to `pending`. A busy/error rejection from main
 *      must restore the snapshot (or delete the seed if no snapshot
 *      existed) instead of nuking a previous done/failed row.
 *
 *   3. R-29 (dirfix) — if this record already minted a sub-directory
 *      via a prior dispatch, reuse it via `recordOutputDirRef` so a
 *      single-process / retry / re-run lands alongside its siblings
 *      instead of carving out its own folder.
 *
 *   4. R-27 (post-review #2.1/#3.1) — when patching the history record
 *      with the freshly-resolved outputDir, persist the *effective*
 *      per-task options (incl. R-22 [0] segment fallback / R-26
 *      forceAllowSmallSide / R-79 / R-81 / P1.2 cropRect overrides),
 *      NOT the raw form options.
 *
 * The five callbacks differ only in HOW they build the `tasks[]` array
 * and WHICH record id they pin to (active vs. historical). Folding the
 * shared ritual into a single hook means App.tsx no longer has to
 * spell it out four times, and the renderer-side tests can exercise
 * the busy-rollback / preflight / R-22 fallback contracts without
 * spinning up the entire home page.
 *
 * Why "deps" instead of owning everything
 * ---------------------------------------
 * Like useEmbedResolve, dispatch is intrinsically coupled to App-level
 * state owned by other hooks (`history` from useHistory, `progress`
 * from useWorkspaces, the per-record refs maintained alongside
 * useIpcEvents). Owning them here would force re-implementing half of
 * App.tsx. Instead the hook accepts a `ProcessDispatchDeps` bag — a
 * small set of values/setters/refs the consumer wires through. We
 * mirror them all in `depsRef.current` so every callback can keep
 * an empty `useCallback` deps list (mount-once stable identity) while
 * still seeing fresh App state on every invocation. This matches the
 * `depsRef + mount-once` shape sibling hooks (useEmbedResolve,
 * useUploadDispatch) already use.
 *
 * useCallback deps list
 * ---------------------
 * All five callbacks use `useCallback(..., [])`. Per-call freshness is
 * routed through `depsRef.current` exactly like useEmbedResolve. The
 * lint-disable comment on each callback is the same shape as the rest
 * of App.tsx's hand-rolled callbacks.
 */
import { useCallback, useRef } from 'react';
import type {
  ProcessOptions,
  ProcessTask,
  SniffResult,
  SniffedMedia,
  TaskProgress,
  BatchStartResult
} from '../../shared/types';
import type { GifOptimizeLevel, GifDither } from '../../shared/types/process';
import { evaluateSizeGuard } from '../../shared/sizeGuard';
import type { HistoryRecord } from './useHistory';

/**
 * Minimal slice of the preload API surface this hook depends on.
 * Declared structurally so tests can hand in a `vi.fn()` without
 * reaching for the full GifToolkitApi shape.
 */
export interface ProcessDispatchGiftkApi {
  startBatch: (
    tasks: ProcessTask[],
    pageTitle?: string,
    outputDirOverride?: string,
    sessionId?: string
  ) => Promise<BatchStartResult>;
}

export interface ProcessDispatchDeps {
  /** The preload bridge (or `undefined` if running outside Electron). */
  giftk: ProcessDispatchGiftkApi | undefined;
  options: ProcessOptions;
  baseOutputDir: string;
  outputDir: string;
  result: SniffResult | null;
  history: HistoryRecord[];
  /** Currently-selected, processable medias (filtered upstream). */
  processable: SniffedMedia[];
  /** Live per-task progress map (active workspace's). */
  progress: Record<string, TaskProgress>;
  /** Patch a history record in place (R-27). */
  patchHistory: (id: string, patch: (rec: HistoryRecord) => HistoryRecord) => void;
  setLogs: React.Dispatch<React.SetStateAction<string[]>>;
  setProgress: React.Dispatch<React.SetStateAction<Record<string, TaskProgress>>>;
  setProcessingOne: React.Dispatch<React.SetStateAction<Set<string>>>;
  setLastBatchDir: React.Dispatch<React.SetStateAction<string>>;
  /** Active home-record id ref (R-Workspaces). */
  activeHistoryIdRef: { current: string | null };
  /** taskId → recordId routing table (renderer-owned, R-27 #4.1). */
  taskRecordMapRef: { current: Map<string, string> };
  /** recordId → cached batch sub-directory (R-29 dirfix). */
  recordOutputDirRef: { current: Map<string, string> };
}

export interface ProcessOneOverride {
  forceAllowSmallSide?: boolean;
  reoptimizeFromGifPath?: string;
  maxBytes?: number;
  fps?: number;
  maxWidth?: number;
  softMaxBytes?: number;
  minSize?: number;
  speed?: number;
  lossyCeiling?: number;
  colorsFloor?: number;
  optimizeLevel?: GifOptimizeLevel;
  dither?: GifDither;
  cropRect?: ProcessOptions['cropRect'];
  startSec?: number;
  endSec?: number;
  selectedSegments?: number[];
}

export interface UseProcessDispatchApi {
  runDispatch: (tasks: ProcessTask[]) => Promise<void>;
  dispatchBatch: (
    perIdSelection: Record<string, number[]> | null,
    mediaListOverride?: SniffedMedia[]
  ) => Promise<void>;
  onProcessOne: (media: SniffedMedia, override?: ProcessOneOverride) => Promise<void>;
  onReprocessFromHistory: (rec: HistoryRecord, media: SniffedMedia) => void;
  onBatchFromRecord: (
    rec: HistoryRecord,
    medias: SniffedMedia[],
    opts: ProcessOptions
  ) => void;
}

export function useProcessDispatch(deps: ProcessDispatchDeps): UseProcessDispatchApi {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const runDispatch = useCallback(async (tasks: ProcessTask[]): Promise<void> => {
    const {
      giftk, options, baseOutputDir, outputDir, result, history,
      progress, patchHistory,
      setLogs, setProgress, setProcessingOne, setLastBatchDir,
      activeHistoryIdRef, taskRecordMapRef, recordOutputDirRef
    } = depsRef.current;
    if (!giftk) return;
    const dir = baseOutputDir || outputDir;
    if (tasks.length === 0) {
      setLogs((prev) => [...prev, `[batch] 全部任务被跳过,无可派发项`].slice(-300));
      return;
    }
    const recId = activeHistoryIdRef.current;
    if (recId) {
      for (const t of tasks) taskRecordMapRef.current.set(t.id, recId);
    }
    const prevSnapshots: Record<string, TaskProgress | undefined> = {};
    for (const t of tasks) {
      prevSnapshots[t.id] = progress[t.id];
    }
    setProgress((prev) => {
      const next = { ...prev };
      for (const t of tasks) {
        next[t.id] = {
          taskId: t.id,
          status: 'pending',
          percent: 0,
          message: '已加入队列'
        };
      }
      return next;
    });
    const truncated = tasks.filter((t) =>
      t.options.selectedSegments && t.options.selectedSegments.length === 1 && t.options.selectedSegments[0] === 0 &&
      ((t.media.resolved?.durationSec ?? t.media.durationSec ?? 0) > options.maxSegmentSec)
    );
    if (truncated.length > 0) {
      setLogs((prev) => [
        ...prev,
        `[batch] ${truncated.length} 个长视频已默认只处理第 1 段(0..${options.maxSegmentSec}s);如需更多段,请在预览中勾选`
      ].slice(-300));
    }
    try {
      const existingDir = recId ? recordOutputDirRef.current.get(recId) : undefined;
      const sid = recId ? history.find((h) => h.id === recId)?.sessionId : undefined;
      const r = await giftk.startBatch(tasks, result?.title, existingDir, sid);
      setProcessingOne((prev) => {
        const n = new Set(prev);
        for (const t of tasks) n.add(t.id);
        return n;
      });
      if (r?.outputDir) {
        setLastBatchDir(r.outputDir);
        setLogs((prev) => [...prev, `[batch] outputs -> ${r.outputDir}`].slice(-300));
        if (recId) {
          recordOutputDirRef.current.set(recId, r.outputDir);
          const repOpt = tasks[0]?.options ?? { ...options, outDir: dir };
          patchHistory(recId, (rec) => ({
            ...rec,
            outputDir: r.outputDir,
            options: { ...repOpt },
            sessionId: rec.sessionId ?? r.sessionId
          }));
        }
      }
    } catch (e) {
      const msg = (e as Error).message || '';
      if (msg === 'busy' || /\bbusy\b/i.test(msg)) {
        setLogs((prev) => [...prev, `[busy] 已有任务在跑,请先取消或等待`].slice(-300));
      } else {
        setLogs((prev) => [...prev, `[error] startBatch: ${msg}`].slice(-300));
      }
      setProgress((prev) => {
        const next = { ...prev };
        for (const t of tasks) {
          if (next[t.id]?.status !== 'pending') continue;
          const snap = prevSnapshots[t.id];
          if (snap) {
            next[t.id] = snap;
          } else {
            delete next[t.id];
          }
        }
        return next;
      });
      for (const t of tasks) {
        taskRecordMapRef.current.delete(t.id);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dispatchBatch = useCallback(async (
    perIdSelection: Record<string, number[]> | null,
    mediaListOverride?: SniffedMedia[]
  ): Promise<void> => {
    const {
      giftk, options, baseOutputDir, outputDir, processable, setLogs
    } = depsRef.current;
    if (!giftk) return;
    const dir = baseOutputDir || outputDir;
    const sourceList = mediaListOverride ?? processable;
    const tasks: ProcessTask[] = sourceList.map((m) => {
      const opt: ProcessOptions = { ...options, outDir: dir };
      const dur = m.resolved?.durationSec ?? m.durationSec ?? 0;
      const tooLong = m.kind === 'video' && dur > options.maxSegmentSec;
      const userExplicit =
        opt.startSec !== undefined ||
        opt.endSec !== undefined ||
        (opt.selectedSegments && opt.selectedSegments.length > 0);
      if (perIdSelection && perIdSelection[m.id] && perIdSelection[m.id].length > 0) {
        opt.selectedSegments = perIdSelection[m.id];
      } else if (tooLong && !userExplicit) {
        opt.selectedSegments = [0];
      }
      return { id: m.id, media: m, options: opt };
    });
    if (tasks.length === 0) return;
    if (!options.forceAllowSmallSide) {
      let willFailCount = 0;
      let unknownCount = 0;
      for (const t of tasks) {
        const w = (t.media.resolved?.width || t.media.width || 0);
        const h = (t.media.resolved?.height || t.media.height || 0);
        const v = evaluateSizeGuard({ width: w, height: h }, t.options);
        if (v.state === 'will-fail') willFailCount++;
        else if (v.state === 'unknown') unknownCount++;
      }
      if (willFailCount > 0 || unknownCount > 0) {
        setLogs((prev) => [
          ...prev,
          `[batch-preflight] ${tasks.length} 项预检:可能不达标 ${willFailCount} 项 / 尺寸未知 ${unknownCount} 项(将由处理器实际探测后判定);失败项可在底部「⚡ 强制全部失败项」一键放行`
        ].slice(-300));
      }
    }
    await runDispatch(tasks);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onProcessOne = useCallback(async (
    media: SniffedMedia,
    override?: ProcessOneOverride
  ): Promise<void> => {
    const {
      giftk, options, baseOutputDir, outputDir, result, history,
      progress, patchHistory,
      setLogs, setProgress, setProcessingOne, setLastBatchDir,
      activeHistoryIdRef, taskRecordMapRef, recordOutputDirRef
    } = depsRef.current;
    if (!giftk) return;
    if (media.kind === 'image') {
      setLogs((prev) => [...prev, `[single] 已跳过(image 不支持处理): ${media.url}`].slice(-300));
      return;
    }
    if (media.requiresExternalDownload && !media.resolved) {
      setLogs((prev) => [...prev, `[single] 已跳过(${media.embedHost || '第三方'} 嵌入,未解析直链): ${media.url}`].slice(-300));
      return;
    }
    const dir = baseOutputDir || outputDir;
    const optBase: ProcessOptions = { ...options, outDir: dir };
    if (override?.forceAllowSmallSide) {
      optBase.forceAllowSmallSide = true;
    }
    if (override?.reoptimizeFromGifPath) {
      optBase.reoptimizeFromGifPath = override.reoptimizeFromGifPath;
      optBase.skipCompress = undefined;
      if (typeof override.maxBytes === 'number') {
        optBase.maxBytes = override.maxBytes;
        const softCap = Math.min(optBase.softMaxBytes, Math.round(override.maxBytes * 0.8));
        optBase.softMaxBytes = Math.max(100 * 1024, softCap);
      }
      if (typeof override.fps === 'number') optBase.fps = override.fps;
      if (typeof override.maxWidth === 'number') optBase.maxWidth = override.maxWidth;
      if (typeof override.softMaxBytes === 'number') {
        const cap = Math.min(optBase.maxBytes, override.softMaxBytes);
        optBase.softMaxBytes = Math.max(100 * 1024, cap);
      }
      if (typeof override.minSize === 'number') optBase.minSize = override.minSize;
      if (typeof override.speed === 'number') optBase.speed = override.speed;
      if (typeof override.lossyCeiling === 'number' && Number.isFinite(override.lossyCeiling)) {
        optBase.lossyCeiling = Math.max(0, Math.min(200, Math.round(override.lossyCeiling)));
      }
      if (typeof override.colorsFloor === 'number' && Number.isFinite(override.colorsFloor)) {
        optBase.colorsFloor = Math.max(2, Math.min(256, Math.round(override.colorsFloor)));
      }
      if (override.optimizeLevel === 1 || override.optimizeLevel === 2 || override.optimizeLevel === 3) {
        optBase.optimizeLevel = override.optimizeLevel;
      }
      if (override.dither === 'none' || override.dither === 'floyd-steinberg' || override.dither === 'ordered') {
        optBase.dither = override.dither;
      }
    }
    if (override) {
      if (override.cropRect !== undefined) optBase.cropRect = override.cropRect;
      if (override.startSec !== undefined) optBase.startSec = override.startSec;
      if (override.endSec !== undefined) optBase.endSec = override.endSec;
      if (override.selectedSegments && override.selectedSegments.length > 0) {
        optBase.selectedSegments = override.selectedSegments;
      }
    }
    const dur = media.resolved?.durationSec ?? media.durationSec ?? 0;
    const tooLong = media.kind === 'video' && dur > options.maxSegmentSec;
    const userPickedRange =
      optBase.startSec !== undefined ||
      optBase.endSec !== undefined ||
      (optBase.selectedSegments && optBase.selectedSegments.length > 0);
    if (tooLong && !userPickedRange) {
      optBase.selectedSegments = [0];
      setLogs((prev) => [
        ...prev,
        `[single] 长视频(${dur.toFixed(1)}s)默认只处理第 1 段(0..${options.maxSegmentSec}s);如需更多段,请在预览中勾选`
      ].slice(-300));
    }
    const tasks: ProcessTask[] = [
      { id: media.id, media, options: optBase }
    ];
    const recId = activeHistoryIdRef.current;
    if (recId) {
      taskRecordMapRef.current.set(media.id, recId);
    }
    const prevSnapshot = progress[media.id];
    setProgress((prev) => ({
      ...prev,
      [media.id]: {
        taskId: media.id,
        status: 'pending',
        percent: 0,
        message: '已加入队列'
      }
    }));
    try {
      const existingDir = recId ? recordOutputDirRef.current.get(recId) : undefined;
      const sid = recId ? history.find((h) => h.id === recId)?.sessionId : undefined;
      const r = await giftk.startBatch(tasks, result?.title, existingDir, sid);
      setProcessingOne((prev) => {
        const n = new Set(prev);
        n.add(media.id);
        return n;
      });
      if (r?.outputDir) {
        setLastBatchDir(r.outputDir);
        setLogs((prev) => [...prev, `[single] outputs -> ${r.outputDir}`].slice(-300));
        if (recId) {
          recordOutputDirRef.current.set(recId, r.outputDir);
          patchHistory(recId, (rec) => ({
            ...rec,
            outputDir: r.outputDir,
            options: { ...optBase },
            sessionId: rec.sessionId ?? r.sessionId
          }));
        }
      }
    } catch (e) {
      const msg = (e as Error).message || '';
      if (msg === 'busy' || /\bbusy\b/i.test(msg)) {
        setLogs((prev) => [...prev, `[busy] 已有任务在跑,请先取消或等待`].slice(-300));
      } else {
        setLogs((prev) => [...prev, `[error] startBatch(single): ${msg}`].slice(-300));
      }
      setProgress((prev) => {
        if (prev[media.id]?.status !== 'pending') return prev;
        const next = { ...prev };
        if (prevSnapshot) {
          next[media.id] = prevSnapshot;
        } else {
          delete next[media.id];
        }
        return next;
      });
      taskRecordMapRef.current.delete(media.id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onReprocessFromHistory = useCallback((
    rec: HistoryRecord,
    media: SniffedMedia
  ): void => {
    const {
      giftk, baseOutputDir, outputDir, progress, patchHistory,
      setLogs, setProgress, setProcessingOne, setLastBatchDir,
      taskRecordMapRef, recordOutputDirRef
    } = depsRef.current;
    if (!giftk) return;
    if (media.kind === 'image') return;
    if (media.requiresExternalDownload && !media.resolved) return;
    const dir = rec.options.outDir || baseOutputDir || outputDir;
    const optBase: ProcessOptions = { ...rec.options, outDir: dir };
    const tasks: ProcessTask[] = [{ id: media.id, media, options: optBase }];
    taskRecordMapRef.current.set(media.id, rec.id);
    const prevSnapshot = progress[media.id];
    setProgress((prev) => ({
      ...prev,
      [media.id]: {
        taskId: media.id,
        status: 'pending',
        percent: 0,
        message: '已加入队列'
      }
    }));
    setLogs((prev) => [
      ...prev,
      `[history] re-run "${shortDir(media.url)}" (record ${rec.id})`
    ].slice(-300));
    const existingDir = recordOutputDirRef.current.get(rec.id) || rec.outputDir;
    giftk.startBatch(tasks, rec.title, existingDir, rec.sessionId)
      .then((r) => {
        setProcessingOne((prev) => {
          const n = new Set(prev); n.add(media.id); return n;
        });
        if (r?.outputDir) {
          setLastBatchDir(r.outputDir);
          recordOutputDirRef.current.set(rec.id, r.outputDir);
          patchHistory(rec.id, (cur) => ({
            ...cur,
            outputDir: r.outputDir,
            options: { ...optBase },
            sessionId: cur.sessionId ?? r.sessionId
          }));
        }
      })
      .catch((e: Error) => {
        const msg = e?.message || '';
        if (/\bbusy\b/i.test(msg)) {
          setLogs((prev) => [...prev, `[busy] 已有任务在跑,请先取消或等待`].slice(-300));
        } else {
          setLogs((prev) => [...prev, `[error] history re-run: ${msg}`].slice(-300));
        }
        setProgress((prev) => {
          if (prev[media.id]?.status !== 'pending') return prev;
          const next = { ...prev };
          if (prevSnapshot) {
            next[media.id] = prevSnapshot;
          } else {
            delete next[media.id];
          }
          return next;
        });
        taskRecordMapRef.current.delete(media.id);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onBatchFromRecord = useCallback((
    rec: HistoryRecord,
    medias: SniffedMedia[],
    opts: ProcessOptions
  ): void => {
    const {
      giftk, baseOutputDir, outputDir, progress, patchHistory,
      setLogs, setProgress, setLastBatchDir,
      taskRecordMapRef, recordOutputDirRef
    } = depsRef.current;
    if (!giftk) return;
    if (medias.length === 0) return;
    const dir = rec.options.outDir || baseOutputDir || outputDir;
    const tasks: ProcessTask[] = medias.map((m) => {
      const opt: ProcessOptions = { ...opts, outDir: dir };
      const dur = m.resolved?.durationSec ?? m.durationSec ?? 0;
      const tooLong = m.kind === 'video' && dur > opt.maxSegmentSec;
      const userExplicit =
        opt.startSec !== undefined ||
        opt.endSec !== undefined ||
        (opt.selectedSegments && opt.selectedSegments.length > 0);
      if (tooLong && !userExplicit) {
        opt.selectedSegments = [0];
      }
      return { id: m.id, media: m, options: opt };
    });
    for (const t of tasks) {
      taskRecordMapRef.current.set(t.id, rec.id);
    }
    const prevSnapshots: Record<string, TaskProgress | undefined> = {};
    for (const t of tasks) {
      prevSnapshots[t.id] = progress[t.id];
    }
    setProgress((prev) => {
      const next = { ...prev };
      for (const t of tasks) {
        next[t.id] = {
          taskId: t.id,
          status: 'pending',
          percent: 0,
          message: '已加入队列'
        };
      }
      return next;
    });
    setLogs((prev) => [
      ...prev,
      `[history] batch re-run "${rec.title || rec.pageUrl}" (record ${rec.id}) ${tasks.length} 项`
    ].slice(-300));
    const existingDir = recordOutputDirRef.current.get(rec.id) || rec.outputDir;
    giftk.startBatch(tasks, rec.title, existingDir, rec.sessionId)
      .then((r) => {
        if (r?.outputDir) {
          setLastBatchDir(r.outputDir);
          recordOutputDirRef.current.set(rec.id, r.outputDir);
          patchHistory(rec.id, (cur) => ({
            ...cur,
            outputDir: r.outputDir,
            options: { ...tasks[0].options },
            sessionId: cur.sessionId ?? r.sessionId
          }));
        }
      })
      .catch((e: Error) => {
        const msg = e?.message || '';
        if (/\bbusy\b/i.test(msg)) {
          setLogs((prev) => [...prev, `[busy] 已有任务在跑,请先取消或等待`].slice(-300));
        } else {
          setLogs((prev) => [...prev, `[error] history batch re-run: ${msg}`].slice(-300));
        }
        setProgress((prev) => {
          const next = { ...prev };
          for (const t of tasks) {
            if (next[t.id]?.status !== 'pending') continue;
            const snap = prevSnapshots[t.id];
            if (snap) {
              next[t.id] = snap;
            } else {
              delete next[t.id];
            }
          }
          return next;
        });
        for (const t of tasks) {
          taskRecordMapRef.current.delete(t.id);
        }
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    runDispatch,
    dispatchBatch,
    onProcessOne,
    onReprocessFromHistory,
    onBatchFromRecord
  };
}

function shortDir(p: string): string {
  if (p.length <= 30) return p;
  return '…' + p.slice(p.length - 28);
}
