/**
 * Tests for useIpcEvents
 * (src/renderer/components/useIpcEvents.ts).
 *
 * What we lock in
 * ---------------
 *  • The hook subscribes to all four channels on mount (and unsubscribes
 *    on unmount via the returned off-functions).
 *  • Process progress: setProgress is called with the (prev) updater,
 *    patchHistory routes via taskRecordMap → activeHistoryIdRef
 *    fallback, and TASK_TERMINAL statuses delete the dispatch mapping.
 *  • Log: lines append, capped at 300 (sliding window).
 *  • Sniff progress: setSniffProgress receives the emit verbatim.
 *  • Upload progress (terminal): applyUploadProgress fires, R-54 sniff
 *    history fold lands on patchHistory ONLY for terminal statuses,
 *    routing maps drain, in-flight counter reaches 0 → setUploadResult
 *    fires exactly once.
 *  • Upload progress (non-terminal "uploading"): only applyUploadProgress
 *    fires; the sniff fold + counter cleanup branches are SKIPPED.
 *  • Defensive: when giftk is undefined, the hook is a no-op.
 *  • Defensive: when onUploadProgress is missing, the hook still
 *    subscribes to the other three channels.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import {
  useIpcEvents,
  type IpcEventsApi,
  type IpcEventsDeps,
  type UploadTarget
} from '../../src/renderer/components/useIpcEvents';
import type {
  TaskProgress,
  SniffProgress,
  UploadProgress
} from '../../src/shared/types';
import type { HistoryRecord } from '../../src/renderer/components/useHistory';

type ProgressCb = (p: TaskProgress) => void;
type LogCb = (line: string) => void;
type SniffCb = (p: SniffProgress) => void;
type UploadCb = (p: UploadProgress) => void;

interface ApiHandles {
  api: IpcEventsApi;
  emitProgress: (p: TaskProgress) => void;
  emitLog: (line: string) => void;
  emitSniffProgress: (p: SniffProgress) => void;
  emitUploadProgress: (p: UploadProgress) => void;
  off1: ReturnType<typeof vi.fn>;
  off2: ReturnType<typeof vi.fn>;
  off3: ReturnType<typeof vi.fn>;
  off4: ReturnType<typeof vi.fn>;
}

function makeApi(opts: { withUpload?: boolean } = { withUpload: true }): ApiHandles {
  let progressCb: ProgressCb | null = null;
  let logCb: LogCb | null = null;
  let sniffCb: SniffCb | null = null;
  let uploadCb: UploadCb | null = null;
  const off1 = vi.fn();
  const off2 = vi.fn();
  const off3 = vi.fn();
  const off4 = vi.fn();
  const api: IpcEventsApi = {
    onProgress: (cb) => { progressCb = cb; return off1; },
    onLog: (cb) => { logCb = cb; return off2; },
    onSniffProgress: (cb) => { sniffCb = cb; return off3; }
  };
  if (opts.withUpload) {
    api.onUploadProgress = (cb) => { uploadCb = cb; return off4; };
  }
  return {
    api,
    emitProgress: (p) => progressCb?.(p),
    emitLog: (l) => logCb?.(l),
    emitSniffProgress: (p) => sniffCb?.(p),
    emitUploadProgress: (p) => uploadCb?.(p),
    off1, off2, off3, off4
  };
}

interface DepsHandles {
  deps: IpcEventsDeps;
  patchHistory: ReturnType<typeof vi.fn>;
  applyUploadProgress: ReturnType<typeof vi.fn>;
  setProgress: ReturnType<typeof vi.fn>;
  setLogs: ReturnType<typeof vi.fn>;
  setSniffProgress: ReturnType<typeof vi.fn>;
  setUploadResult: ReturnType<typeof vi.fn>;
  taskRecordMapRef: MutableRefObject<Map<string, string>>;
  activeHistoryIdRef: MutableRefObject<string | null>;
  uploadJobToRecordRef: MutableRefObject<Map<string, string>>;
  uploadJobToTargetRef: MutableRefObject<Map<string, UploadTarget>>;
  uploadInflightRef: MutableRefObject<Map<string, number>>;
}

function makeDeps(api: IpcEventsApi | undefined): DepsHandles {
  const taskRecordMapRef = { current: new Map<string, string>() };
  const activeHistoryIdRef = { current: null as string | null };
  const uploadJobToRecordRef = { current: new Map<string, string>() };
  const uploadJobToTargetRef = { current: new Map<string, UploadTarget>() };
  const uploadInflightRef = { current: new Map<string, number>() };
  const patchHistory = vi.fn<(id: string, mut: (r: HistoryRecord) => HistoryRecord) => void>();
  const applyUploadProgress = vi.fn();
  const setProgress = vi.fn();
  const setLogs = vi.fn();
  const setSniffProgress = vi.fn();
  const setUploadResult = vi.fn();
  return {
    deps: {
      giftk: api,
      patchHistory,
      taskRecordMapRef,
      activeHistoryIdRef,
      applyUploadProgress,
      uploadJobToRecordRef,
      uploadJobToTargetRef,
      uploadInflightRef,
      setProgress,
      setLogs,
      setSniffProgress,
      setUploadResult
    },
    patchHistory,
    applyUploadProgress,
    setProgress,
    setLogs,
    setSniffProgress,
    setUploadResult,
    taskRecordMapRef,
    activeHistoryIdRef,
    uploadJobToRecordRef,
    uploadJobToTargetRef,
    uploadInflightRef
  };
}

const tprog = (over: Partial<TaskProgress> = {}): TaskProgress => ({
  taskId: 't-1',
  status: 'running',
  percent: 50,
  ...over
});

describe('useIpcEvents', () => {
  it('subscribes on mount and unsubscribes on unmount (all 4 channels)', () => {
    const api = makeApi();
    const { deps } = makeDeps(api.api);
    const { unmount } = renderHook(() => useIpcEvents(deps));
    expect(api.off1).not.toHaveBeenCalled();
    unmount();
    expect(api.off1).toHaveBeenCalledTimes(1);
    expect(api.off2).toHaveBeenCalledTimes(1);
    expect(api.off3).toHaveBeenCalledTimes(1);
    expect(api.off4).toHaveBeenCalledTimes(1);
  });

  it('routes process progress via taskRecordMap and clears terminal status', () => {
    const api = makeApi();
    const handles = makeDeps(api.api);
    handles.taskRecordMapRef.current.set('t-1', 'rec-A');
    renderHook(() => useIpcEvents(handles.deps));
    api.emitProgress(tprog({ taskId: 't-1', status: 'running' }));
    expect(handles.setProgress).toHaveBeenCalledTimes(1);
    expect(handles.patchHistory).toHaveBeenCalledTimes(1);
    expect(handles.patchHistory.mock.calls[0][0]).toBe('rec-A');
    expect(handles.taskRecordMapRef.current.get('t-1')).toBe('rec-A');
    api.emitProgress(tprog({ taskId: 't-1', status: 'done' }));
    expect(handles.taskRecordMapRef.current.has('t-1')).toBe(false);
  });

  it('falls back to activeHistoryIdRef when taskRecordMap is empty', () => {
    const api = makeApi();
    const handles = makeDeps(api.api);
    handles.activeHistoryIdRef.current = 'rec-fallback';
    renderHook(() => useIpcEvents(handles.deps));
    api.emitProgress(tprog({ taskId: 't-orphan' }));
    expect(handles.patchHistory).toHaveBeenCalledTimes(1);
    expect(handles.patchHistory.mock.calls[0][0]).toBe('rec-fallback');
  });

  it('appends log lines and caps the buffer at 300', () => {
    const api = makeApi();
    const handles = makeDeps(api.api);
    renderHook(() => useIpcEvents(handles.deps));
    api.emitLog('hello');
    expect(handles.setLogs).toHaveBeenCalledTimes(1);
    const updater = handles.setLogs.mock.calls[0][0] as (prev: string[]) => string[];
    const big = Array.from({ length: 300 }, (_, i) => `L${i}`);
    const next = updater(big);
    expect(next).toHaveLength(300);
    expect(next[0]).toBe('L1');
    expect(next[299]).toBe('hello');
    const small = updater(['a', 'b']);
    expect(small).toEqual(['a', 'b', 'hello']);
  });

  it('forwards sniff progress verbatim', () => {
    const api = makeApi();
    const handles = makeDeps(api.api);
    renderHook(() => useIpcEvents(handles.deps));
    const sp: SniffProgress = { phase: 'discover', message: 'looking', percent: 10 } as SniffProgress;
    api.emitSniffProgress(sp);
    expect(handles.setSniffProgress).toHaveBeenCalledWith(sp);
  });

  it('upload terminal: folds R-54 + drains routing + opens modal when in-flight reaches 0', () => {
    const api = makeApi();
    const handles = makeDeps(api.api);
    handles.uploadJobToRecordRef.current.set('job-1', 'recU-1');
    handles.uploadJobToTargetRef.current.set('job-1', { sniffRecId: 'recS-1', filePath: '/out/a.gif' });
    handles.uploadInflightRef.current.set('recU-1', 1);
    renderHook(() => useIpcEvents(handles.deps));
    const up: UploadProgress = {
      jobId: 'job-1',
      status: 'done',
      backend: 'r2',
      url: 'https://cdn.test/a.gif',
      markdown: '![](https://cdn.test/a.gif)',
      fileHash: 'h1',
      reused: false,
      recordId: 'recS-1'
    } as UploadProgress;
    api.emitUploadProgress(up);
    expect(handles.applyUploadProgress).toHaveBeenCalledWith('recU-1', up);
    expect(handles.patchHistory).toHaveBeenCalledTimes(1);
    expect(handles.patchHistory.mock.calls[0][0]).toBe('recS-1');
    expect(handles.uploadJobToRecordRef.current.has('job-1')).toBe(false);
    expect(handles.uploadJobToTargetRef.current.has('job-1')).toBe(false);
    expect(handles.uploadInflightRef.current.has('recU-1')).toBe(false);
    expect(handles.setUploadResult).toHaveBeenCalledWith('recU-1');
  });

  it('upload non-terminal "uploading": only applyUploadProgress fires; no fold, no drain, no modal', () => {
    const api = makeApi();
    const handles = makeDeps(api.api);
    handles.uploadJobToRecordRef.current.set('job-2', 'recU-2');
    handles.uploadJobToTargetRef.current.set('job-2', { sniffRecId: 'recS-2', filePath: '/out/b.gif' });
    handles.uploadInflightRef.current.set('recU-2', 2);
    renderHook(() => useIpcEvents(handles.deps));
    const up: UploadProgress = {
      jobId: 'job-2',
      status: 'uploading',
      percent: 40,
      backend: 'r2'
    } as UploadProgress;
    api.emitUploadProgress(up);
    expect(handles.applyUploadProgress).toHaveBeenCalledWith('recU-2', up);
    expect(handles.patchHistory).not.toHaveBeenCalled();
    expect(handles.uploadJobToRecordRef.current.has('job-2')).toBe(true);
    expect(handles.uploadInflightRef.current.get('recU-2')).toBe(2);
    expect(handles.setUploadResult).not.toHaveBeenCalled();
  });

  it('upload terminal: when in-flight stays > 0, decrements counter without opening modal', () => {
    const api = makeApi();
    const handles = makeDeps(api.api);
    handles.uploadJobToRecordRef.current.set('job-A', 'recU-X');
    handles.uploadJobToRecordRef.current.set('job-B', 'recU-X');
    handles.uploadJobToTargetRef.current.set('job-A', { sniffRecId: 'recS-X', filePath: '/o/a.gif' });
    handles.uploadJobToTargetRef.current.set('job-B', { sniffRecId: 'recS-X', filePath: '/o/b.gif' });
    handles.uploadInflightRef.current.set('recU-X', 2);
    renderHook(() => useIpcEvents(handles.deps));
    api.emitUploadProgress({
      jobId: 'job-A', status: 'done', backend: 'r2', url: 'https://cdn/a',
      recordId: 'recS-X'
    } as UploadProgress);
    expect(handles.uploadInflightRef.current.get('recU-X')).toBe(1);
    expect(handles.setUploadResult).not.toHaveBeenCalled();
  });

  it('upload progress with unknown jobId is ignored (no recId match → early return)', () => {
    const api = makeApi();
    const handles = makeDeps(api.api);
    renderHook(() => useIpcEvents(handles.deps));
    api.emitUploadProgress({ jobId: 'phantom', status: 'done', backend: 'r2' } as UploadProgress);
    expect(handles.applyUploadProgress).not.toHaveBeenCalled();
    expect(handles.patchHistory).not.toHaveBeenCalled();
    expect(handles.setUploadResult).not.toHaveBeenCalled();
  });

  it('giftk undefined: hook is a no-op', () => {
    const handles = makeDeps(undefined);
    expect(() => renderHook(() => useIpcEvents(handles.deps))).not.toThrow();
  });

  it('missing onUploadProgress: still subscribes to the other three channels', () => {
    const api = makeApi({ withUpload: false });
    const handles = makeDeps(api.api);
    const { unmount } = renderHook(() => useIpcEvents(handles.deps));
    api.emitProgress(tprog());
    api.emitLog('x');
    api.emitSniffProgress({ phase: 'discover', message: '', percent: 0 } as SniffProgress);
    expect(handles.setProgress).toHaveBeenCalled();
    expect(handles.setLogs).toHaveBeenCalled();
    expect(handles.setSniffProgress).toHaveBeenCalled();
    unmount();
    expect(api.off1).toHaveBeenCalledTimes(1);
    expect(api.off2).toHaveBeenCalledTimes(1);
    expect(api.off3).toHaveBeenCalledTimes(1);
    expect(api.off4).not.toHaveBeenCalled();
  });
});
