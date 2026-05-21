// @vitest-environment happy-dom
/**
 * Tests for useProcessDispatch
 * (src/renderer/components/useProcessDispatch.ts).
 *
 * What we lock in
 * ---------------
 *  • dispatchBatch happy path — `processable` is converted to
 *    ProcessTask[], `giftk.startBatch` is called once, the resulting
 *    `outputDir` is patched onto the active record AND surfaced via
 *    `setLastBatchDir`. The R-22 segment fallback fires for long
 *    videos without an explicit user pick.
 *  • dispatchBatch busy rejection — when startBatch rejects with
 *    'busy', the renderer's eagerly-seeded `pending` rows are rolled
 *    back to whatever was there before (R-29 P1-E) and the
 *    taskRecordMap is fully cleared (R-29 P1-I unbind).
 *  • dispatchBatch perIdSelection wins over R-22 fallback — even when
 *    the long-video fallback would normally inject `[0]`, an explicit
 *    selection from the BatchSegmentModal beats it.
 *  • runDispatch zero-tasks — logs the "全部任务被跳过" line and
 *    returns without calling startBatch.
 *  • onProcessOne happy path with override.forceAllowSmallSide —
 *    forwards the flag into the dispatched task's options (R-26).
 *  • onProcessOne image kind — short-circuits with a "image 不支持
 *    处理" log line; startBatch is never called.
 *  • onProcessOne unresolved embed — short-circuits with the
 *    "未解析直链" log line; startBatch is never called.
 *  • onReprocessFromHistory pins to rec.id (NOT activeHistoryIdRef) —
 *    proves the R-27 #4.1 fix that home-view writes can't bleed into
 *    the historical record.
 *  • onReprocessFromHistory busy rejection restores prevSnapshot —
 *    R-29 P1-E rollback for the .catch() branch.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  useProcessDispatch,
  type ProcessDispatchDeps
} from '../../src/renderer/components/useProcessDispatch';
import type {
  BatchStartResult,
  ProcessOptions,
  ProcessTask,
  SniffedMedia,
  TaskProgress
} from '../../src/shared/types';
import { DEFAULT_OPTIONS } from '../../src/shared/types';
import type { HistoryRecord } from '../../src/renderer/components/useHistory';

const makeMedia = (id: string, overrides: Partial<SniffedMedia> = {}): SniffedMedia => ({
  id,
  url: `https://media.test/${id}.mp4`,
  kind: 'video',
  source: 'video',
  pageUrl: 'https://host.test/page',
  width: 1920,
  height: 1080,
  durationSec: 10,
  ...overrides
});

const makeOk = (overrides: Partial<BatchStartResult> = {}): BatchStartResult => ({
  ok: true,
  outputDir: '/tmp/out/sub',
  ...overrides
});

const makeRecord = (overrides: Partial<HistoryRecord> = {}): HistoryRecord => ({
  id: 'rec-1',
  pageUrl: 'https://host.test/page',
  title: 'page',
  createdAt: Date.now(),
  items: [],
  options: { ...DEFAULT_OPTIONS, outDir: '/tmp/out' },
  outputDir: '',
  outputsByTaskId: {},
  taskStatus: {},
  ...overrides
});

interface Handles {
  deps: ProcessDispatchDeps;
  startBatch: ReturnType<typeof vi.fn>;
  patchHistory: ReturnType<typeof vi.fn>;
  setLogs: ReturnType<typeof vi.fn>;
  setProgress: ReturnType<typeof vi.fn>;
  setProcessingOne: ReturnType<typeof vi.fn>;
  setLastBatchDir: ReturnType<typeof vi.fn>;
  taskRecordMapRef: { current: Map<string, string> };
  recordOutputDirRef: { current: Map<string, string> };
  activeHistoryIdRef: { current: string | null };
}

interface MakeDepsOpts {
  processable?: SniffedMedia[];
  progress?: Record<string, TaskProgress>;
  options?: ProcessOptions;
  result?: { pageUrl: string; items: SniffedMedia[]; warnings: string[]; title?: string } | null;
  history?: HistoryRecord[];
  baseOutputDir?: string;
  outputDir?: string;
  activeHistoryId?: string | null;
  startBatchImpl?: (
    tasks: ProcessTask[],
    pageTitle?: string,
    outputDirOverride?: string,
    sessionId?: string
  ) => Promise<BatchStartResult>;
}

const makeDeps = (opts: MakeDepsOpts = {}): Handles => {
  const startBatch = vi.fn(opts.startBatchImpl ?? (async () => makeOk()));
  const patchHistory = vi.fn();
  const setLogs = vi.fn();
  const setProgress = vi.fn();
  const setProcessingOne = vi.fn();
  const setLastBatchDir = vi.fn();
  const taskRecordMapRef = { current: new Map<string, string>() };
  const recordOutputDirRef = { current: new Map<string, string>() };
  const activeHistoryIdRef = { current: opts.activeHistoryId ?? null };

  return {
    startBatch,
    patchHistory,
    setLogs,
    setProgress,
    setProcessingOne,
    setLastBatchDir,
    taskRecordMapRef,
    recordOutputDirRef,
    activeHistoryIdRef,
    deps: {
      giftk: { startBatch },
      options: opts.options ?? { ...DEFAULT_OPTIONS, outDir: '/tmp/out' },
      baseOutputDir: opts.baseOutputDir ?? '/tmp/out',
      outputDir: opts.outputDir ?? '/tmp/out',
      result: opts.result ?? null,
      history: opts.history ?? [],
      processable: opts.processable ?? [],
      progress: opts.progress ?? {},
      patchHistory,
      setLogs,
      setProgress,
      setProcessingOne,
      setLastBatchDir,
      activeHistoryIdRef,
      taskRecordMapRef,
      recordOutputDirRef
    }
  };
};

describe('useProcessDispatch', () => {
  it('dispatchBatch happy path: builds tasks, calls startBatch, patches outputDir on record', async () => {
    const m1 = makeMedia('m1', { durationSec: 5 });
    const m2 = makeMedia('m2', { durationSec: 8 });
    const handles = makeDeps({
      processable: [m1, m2],
      activeHistoryId: 'rec-1',
      history: [makeRecord({ id: 'rec-1', sessionId: 'sess-A' })]
    });
    const { result } = renderHook(() => useProcessDispatch(handles.deps));

    await act(async () => {
      await result.current.dispatchBatch(null);
    });

    expect(handles.startBatch).toHaveBeenCalledTimes(1);
    const call = handles.startBatch.mock.calls[0];
    const tasks: ProcessTask[] = call[0];
    expect(tasks.map((t) => t.id)).toEqual(['m1', 'm2']);
    expect(call[3]).toBe('sess-A');
    expect(handles.setLastBatchDir).toHaveBeenCalledWith('/tmp/out/sub');
    expect(handles.patchHistory).toHaveBeenCalledTimes(1);
    expect(handles.patchHistory.mock.calls[0][0]).toBe('rec-1');
    const patched = handles.patchHistory.mock.calls[0][1](makeRecord({ id: 'rec-1' }));
    expect(patched.outputDir).toBe('/tmp/out/sub');
    expect(handles.taskRecordMapRef.current.get('m1')).toBe('rec-1');
    expect(handles.recordOutputDirRef.current.get('rec-1')).toBe('/tmp/out/sub');
  });

  it('dispatchBatch busy rejection rolls back progress and clears taskRecordMap', async () => {
    const m1 = makeMedia('m1');
    const prevDone: TaskProgress = {
      taskId: 'm1', status: 'done', percent: 100, message: 'old'
    };
    const handles = makeDeps({
      processable: [m1],
      activeHistoryId: 'rec-1',
      progress: { m1: prevDone },
      startBatchImpl: async () => { throw new Error('busy'); }
    });
    const { result } = renderHook(() => useProcessDispatch(handles.deps));

    await act(async () => {
      await result.current.dispatchBatch(null);
    });

    const busyLog = handles.setLogs.mock.calls
      .map((c) => c[0]([] as string[]))
      .find((arr: string[]) => arr.some((l) => l.includes('[busy]')));
    expect(busyLog).toBeDefined();
    expect(handles.taskRecordMapRef.current.has('m1')).toBe(false);

    const seedCall = handles.setProgress.mock.calls[0][0]({});
    expect(seedCall.m1.status).toBe('pending');

    const rollbackUpdater = handles.setProgress.mock.calls[1][0];
    const rolled = rollbackUpdater({ m1: { ...seedCall.m1 } });
    expect(rolled.m1).toEqual(prevDone);
  });

  it('dispatchBatch perIdSelection wins over R-22 segment [0] fallback', async () => {
    const longVideo = makeMedia('m1', { durationSec: 300 });
    const handles = makeDeps({
      processable: [longVideo],
      activeHistoryId: 'rec-1'
    });
    const { result } = renderHook(() => useProcessDispatch(handles.deps));

    await act(async () => {
      await result.current.dispatchBatch({ m1: [2, 3] });
    });

    const tasks: ProcessTask[] = handles.startBatch.mock.calls[0][0];
    expect(tasks[0].options.selectedSegments).toEqual([2, 3]);
  });

  it('dispatchBatch applies R-22 [0] fallback when no perIdSelection and video is long', async () => {
    const longVideo = makeMedia('m1', { durationSec: 300 });
    const handles = makeDeps({
      processable: [longVideo],
      activeHistoryId: 'rec-1'
    });
    const { result } = renderHook(() => useProcessDispatch(handles.deps));

    await act(async () => {
      await result.current.dispatchBatch(null);
    });

    const tasks: ProcessTask[] = handles.startBatch.mock.calls[0][0];
    expect(tasks[0].options.selectedSegments).toEqual([0]);
  });

  it('runDispatch zero-tasks logs and returns without calling startBatch', async () => {
    const handles = makeDeps({});
    const { result } = renderHook(() => useProcessDispatch(handles.deps));

    await act(async () => {
      await result.current.runDispatch([]);
    });

    expect(handles.startBatch).not.toHaveBeenCalled();
    const log = handles.setLogs.mock.calls
      .map((c) => c[0]([] as string[]))
      .find((arr: string[]) => arr.some((l) => l.includes('全部任务被跳过')));
    expect(log).toBeDefined();
  });

  it('onProcessOne happy path with override.forceAllowSmallSide passes flag through', async () => {
    const m1 = makeMedia('m1', { durationSec: 5 });
    const handles = makeDeps({
      activeHistoryId: 'rec-1',
      history: [makeRecord({ id: 'rec-1', sessionId: 'sess-X' })]
    });
    const { result } = renderHook(() => useProcessDispatch(handles.deps));

    await act(async () => {
      await result.current.onProcessOne(m1, { forceAllowSmallSide: true });
    });

    expect(handles.startBatch).toHaveBeenCalledTimes(1);
    const tasks: ProcessTask[] = handles.startBatch.mock.calls[0][0];
    expect(tasks[0].options.forceAllowSmallSide).toBe(true);
    expect(handles.setLastBatchDir).toHaveBeenCalledWith('/tmp/out/sub');
    expect(handles.taskRecordMapRef.current.get('m1')).toBe('rec-1');
  });

  it('onProcessOne image kind is skipped and never calls startBatch', async () => {
    const img = makeMedia('img1', { kind: 'image', url: 'https://media.test/img1.png' });
    const handles = makeDeps({});
    const { result } = renderHook(() => useProcessDispatch(handles.deps));

    await act(async () => {
      await result.current.onProcessOne(img);
    });

    expect(handles.startBatch).not.toHaveBeenCalled();
    const log = handles.setLogs.mock.calls
      .map((c) => c[0]([] as string[]))
      .find((arr: string[]) => arr.some((l) => l.includes('image 不支持处理')));
    expect(log).toBeDefined();
  });

  it('onProcessOne unresolved embed is skipped and never calls startBatch', async () => {
    const embed = makeMedia('e1', {
      kind: 'video',
      source: 'iframe-embed',
      requiresExternalDownload: true,
      embedHost: 'vimeo.com'
    });
    const handles = makeDeps({});
    const { result } = renderHook(() => useProcessDispatch(handles.deps));

    await act(async () => {
      await result.current.onProcessOne(embed);
    });

    expect(handles.startBatch).not.toHaveBeenCalled();
    const log = handles.setLogs.mock.calls
      .map((c) => c[0]([] as string[]))
      .find((arr: string[]) => arr.some((l) => l.includes('未解析直链')));
    expect(log).toBeDefined();
  });

  it('onReprocessFromHistory pins to rec.id, NOT activeHistoryIdRef', async () => {
    const m1 = makeMedia('m1', { durationSec: 5 });
    const rec = makeRecord({
      id: 'history-rec-7',
      sessionId: 'sess-hist',
      outputDir: '/tmp/out/hist'
    });
    const handles = makeDeps({
      activeHistoryId: 'home-rec-99'
    });
    const { result } = renderHook(() => useProcessDispatch(handles.deps));

    await act(async () => {
      result.current.onReprocessFromHistory(rec, m1);
    });

    expect(handles.taskRecordMapRef.current.get('m1')).toBe('history-rec-7');
    expect(handles.activeHistoryIdRef.current).toBe('home-rec-99');

    await waitFor(() => {
      expect(handles.startBatch).toHaveBeenCalledTimes(1);
    });
    const call = handles.startBatch.mock.calls[0];
    expect(call[2]).toBe('/tmp/out/hist');
    expect(call[3]).toBe('sess-hist');

    await waitFor(() => {
      expect(handles.patchHistory).toHaveBeenCalledTimes(1);
    });
    expect(handles.patchHistory.mock.calls[0][0]).toBe('history-rec-7');
  });

  it('onReprocessFromHistory busy rejection restores prevSnapshot and unbinds', async () => {
    const m1 = makeMedia('m1', { durationSec: 5 });
    const rec = makeRecord({ id: 'history-rec-7' });
    const prevFailed: TaskProgress = {
      taskId: 'm1', status: 'failed', percent: 100, message: 'previous fail'
    };
    const handles = makeDeps({
      progress: { m1: prevFailed },
      startBatchImpl: async () => { throw new Error('busy'); }
    });
    const { result } = renderHook(() => useProcessDispatch(handles.deps));

    await act(async () => {
      result.current.onReprocessFromHistory(rec, m1);
    });

    await waitFor(() => {
      expect(handles.taskRecordMapRef.current.has('m1')).toBe(false);
    });

    const busyLog = handles.setLogs.mock.calls
      .map((c) => c[0]([] as string[]))
      .find((arr: string[]) => arr.some((l) => l.includes('[busy]')));
    expect(busyLog).toBeDefined();

    const seed = handles.setProgress.mock.calls[0][0]({});
    expect(seed.m1.status).toBe('pending');
    const rollback = handles.setProgress.mock.calls[1][0];
    const rolled = rollback({ m1: seed.m1 });
    expect(rolled.m1).toEqual(prevFailed);
  });

  it('onProcessOne busy rejection deletes the seeded pending row when no prevSnapshot existed', async () => {
    const m1 = makeMedia('m1', { durationSec: 5 });
    const handles = makeDeps({
      activeHistoryId: 'rec-1',
      startBatchImpl: async () => { throw new Error('busy'); }
    });
    const { result } = renderHook(() => useProcessDispatch(handles.deps));

    await act(async () => {
      await result.current.onProcessOne(m1);
    });

    expect(handles.startBatch).toHaveBeenCalledTimes(1);
    expect(handles.taskRecordMapRef.current.has('m1')).toBe(false);
    const seed = handles.setProgress.mock.calls[0][0]({});
    expect(seed.m1.status).toBe('pending');
    const rollback = handles.setProgress.mock.calls[1][0];
    const rolled = rollback({ m1: seed.m1 });
    expect(rolled.m1).toBeUndefined();
  });
});
