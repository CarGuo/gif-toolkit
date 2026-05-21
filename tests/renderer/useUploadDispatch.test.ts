/**
 * Tests for useUploadDispatch
 * (src/renderer/components/useUploadDispatch.ts).
 *
 * What we lock in
 * ---------------
 *  • Empty plan: early return + a log line, no IPC call, no recId
 *    minted, no routing-table mutation.
 *  • Unconfigured backend: opens 「📤 上传设置」 modal, logs hint, no
 *    IPC call.
 *  • P1 (#4) race fix CORE: the three routing tables + in-flight
 *    counter MUST be populated BEFORE the `uploadStart` Promise
 *    resolves. We assert this by inspecting them inside the
 *    fake `uploadStart` BEFORE we resolve it.
 *  • Mismatch defensive branch: if main re-mints jobIds, the renderer
 *    wipes the eagerly-seeded entries and re-routes by the echoed
 *    ids; items[].jobId is rewritten in place.
 *  • Catch rollback: a rejected `uploadStart` rolls back all three
 *    tables and the in-flight counter.
 *  • Terminal `setUploadResult(recId)` fires immediately on success
 *    (R-73 — modal-on-dispatch).
 *  • sessionId pin: when sniffRecId is given, the payload's
 *    `sessionId` is looked up from the processing-history record.
 */
// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  useUploadDispatch,
  type UploadDispatchDeps,
  type UploadDispatchGiftkApi
} from '../../src/renderer/components/useUploadDispatch';
import type {
  SniffedMedia,
  UploadBackend,
  UploadConfigs,
  UploadHistoryItem,
  UploadStartPayload,
  UploadStartResult
} from '../../src/shared/types';
import type { HistoryRecord } from '../../src/renderer/components/useHistory';
import { DEFAULT_OPTIONS } from '../../src/shared/types';

const makeMedia = (id: string): SniffedMedia => ({
  id,
  url: `https://cdn.test/${id}.gif`,
  kind: 'gif',
  source: 'img-tag',
  pageUrl: 'https://host.test/page'
});

const makeConfigs = (): UploadConfigs => ({
  active: 'customWeb',
  customWeb: {
    url: 'https://upload.test/api',
    urlPath: '$.data.url'
  }
});

const makeHistoryRecord = (id: string, sessionId?: string): HistoryRecord => ({
  id,
  createdAt: 1700000000000,
  pageUrl: 'https://host.test/page',
  items: [],
  options: DEFAULT_OPTIONS,
  outputsByTaskId: {},
  taskStatus: {},
  sessionId
});

interface DepsHandles {
  deps: UploadDispatchDeps;
  uploadStart: ReturnType<typeof vi.fn>;
  startUploadRecord: ReturnType<typeof vi.fn>;
  setLogs: ReturnType<typeof vi.fn>;
  setUploadResult: ReturnType<typeof vi.fn>;
  setUploadSettingsOpen: ReturnType<typeof vi.fn>;
  uploadJobToRecordRef: { current: Map<string, string> };
  uploadJobToTargetRef: { current: Map<string, { sniffRecId?: string; filePath: string }> };
  uploadInflightRef: { current: Map<string, number> };
  activeHistoryIdRef: { current: string | null };
}

interface MakeDepsOpts {
  uploadConfigs?: UploadConfigs | null;
  history?: HistoryRecord[];
  activeHistoryId?: string | null;
  recId?: string;
  uploadStartImpl?: (payload: UploadStartPayload) => Promise<UploadStartResult>;
  giftkUndefined?: boolean;
}

const makeDeps = (opts: MakeDepsOpts = {}): DepsHandles => {
  const recId = opts.recId ?? 'rec-1';
  const uploadStart = vi.fn(opts.uploadStartImpl
    ?? (async (payload: UploadStartPayload): Promise<UploadStartResult> => ({
      ok: true,
      jobIds: payload.jobs.map((j) => j.id),
      sessionId: payload.sessionId ?? 'session-fresh'
    })));
  const startUploadRecord = vi.fn(
    (_args: { backend: UploadBackend; items: UploadHistoryItem[] }): string => recId
  );
  const setLogs = vi.fn();
  const setUploadResult = vi.fn();
  const setUploadSettingsOpen = vi.fn();

  const uploadJobToRecordRef = { current: new Map<string, string>() };
  const uploadJobToTargetRef = { current: new Map<string, { sniffRecId?: string; filePath: string }>() };
  const uploadInflightRef = { current: new Map<string, number>() };
  const activeHistoryIdRef = { current: opts.activeHistoryId ?? null };

  const giftk: UploadDispatchGiftkApi | undefined = opts.giftkUndefined
    ? undefined
    : { uploadStart };

  const deps: UploadDispatchDeps = {
    giftk,
    uploadConfigs: opts.uploadConfigs === undefined ? makeConfigs() : opts.uploadConfigs,
    history: opts.history ?? [],
    startUploadRecord,
    activeHistoryIdRef,
    uploadJobToRecordRef,
    uploadJobToTargetRef,
    uploadInflightRef,
    setLogs,
    setUploadResult,
    setUploadSettingsOpen
  };
  return {
    deps,
    uploadStart,
    startUploadRecord,
    setLogs,
    setUploadResult,
    setUploadSettingsOpen,
    uploadJobToRecordRef,
    uploadJobToTargetRef,
    uploadInflightRef,
    activeHistoryIdRef
  };
};

describe('useUploadDispatch', () => {
  it('empty plan returns early, logs hint, never calls uploadStart or startUploadRecord', async () => {
    const handles = makeDeps();
    const { result } = renderHook(() => useUploadDispatch(handles.deps));

    await act(async () => {
      await result.current.dispatchUpload([]);
    });

    expect(handles.uploadStart).not.toHaveBeenCalled();
    expect(handles.startUploadRecord).not.toHaveBeenCalled();
    expect(handles.setUploadResult).not.toHaveBeenCalled();
    expect(handles.setUploadSettingsOpen).not.toHaveBeenCalled();
    // setLogs called once with the empty-plan hint.
    expect(handles.setLogs).toHaveBeenCalledTimes(1);
    const updater = handles.setLogs.mock.calls[0][0] as (p: string[]) => string[];
    expect(updater([])[0]).toContain('没有可上传的产物');
  });

  it('unconfigured backend opens the settings modal and bails before IPC', async () => {
    const handles = makeDeps({ uploadConfigs: null });
    const { result } = renderHook(() => useUploadDispatch(handles.deps));

    await act(async () => {
      await result.current.dispatchUpload([
        { media: makeMedia('m1'), filePath: '/out/a.gif' }
      ]);
    });

    expect(handles.setUploadSettingsOpen).toHaveBeenCalledTimes(1);
    expect(handles.setUploadSettingsOpen).toHaveBeenCalledWith(true);
    expect(handles.uploadStart).not.toHaveBeenCalled();
    expect(handles.startUploadRecord).not.toHaveBeenCalled();
    const updater = handles.setLogs.mock.calls[0][0] as (p: string[]) => string[];
    expect(updater([])[0]).toContain('上传设置');
  });

  it('P1 (#4) race fix: routing tables + in-flight counter are populated BEFORE uploadStart resolves', async () => {
    // Capture refs at the moment uploadStart is called — the whole
    // point of the P1 (#4) fix is that hash-cache hits in main can
    // emit `done` synchronously before `await uploadStart(...)`
    // resolves, so the maps MUST already be seeded by then.
    let snapshot: {
      record: Array<[string, string]>;
      target: Array<[string, { sniffRecId?: string; filePath: string }]>;
      inflight: Array<[string, number]>;
      payloadJobIds: string[];
    } | null = null;

    const handles = makeDeps({
      recId: 'rec-race',
      uploadStartImpl: async (payload) => {
        snapshot = {
          record: Array.from(handles.uploadJobToRecordRef.current.entries()),
          target: Array.from(handles.uploadJobToTargetRef.current.entries()),
          inflight: Array.from(handles.uploadInflightRef.current.entries()),
          payloadJobIds: payload.jobs.map((j) => j.id)
        };
        return {
          ok: true,
          jobIds: payload.jobs.map((j) => j.id),
          sessionId: 'session-x'
        };
      }
    });

    const { result } = renderHook(() => useUploadDispatch(handles.deps));

    const plan = [
      { media: makeMedia('m1'), filePath: '/out/a.gif' },
      { media: makeMedia('m2'), filePath: '/sub/b.gif' }
    ];

    await act(async () => {
      await result.current.dispatchUpload(plan);
    });

    expect(snapshot).not.toBeNull();
    const snap = snapshot!;
    // jobIds were minted BEFORE the IPC call (sent in the payload).
    expect(snap.payloadJobIds).toEqual(['rec-race-0', 'rec-race-1']);
    // All three routing tables already carry the full jobIds.
    expect(snap.record).toEqual([
      ['rec-race-0', 'rec-race'],
      ['rec-race-1', 'rec-race']
    ]);
    expect(snap.target).toEqual([
      ['rec-race-0', { sniffRecId: undefined, filePath: '/out/a.gif' }],
      ['rec-race-1', { sniffRecId: undefined, filePath: '/sub/b.gif' }]
    ]);
    // In-flight counter pre-seeded to fullJobIds.length (2).
    expect(snap.inflight).toEqual([['rec-race', 2]]);

    // startUploadRecord was called with placeholder items whose jobIds
    // have already been promoted to the full `${recId}-${i}` form by
    // the time the consumer would fetch the record back from
    // useUploadHistory (we mutate items[] in place after assigning
    // recId). The MUT input items array is captured by ref:
    const startArgs = handles.startUploadRecord.mock.calls[0][0] as {
      backend: UploadBackend;
      items: UploadHistoryItem[];
    };
    expect(startArgs.backend).toBe('customWeb');
    // Even though startUploadRecord saw raw "0"/"1" jobIds at call time,
    // the array reference was patched in place to the full ids by the
    // dispatcher, which is what useUploadHistory then persists.
    expect(startArgs.items.map((it) => it.jobId)).toEqual(['rec-race-0', 'rec-race-1']);
    expect(startArgs.items.map((it) => it.fileName)).toEqual(['a.gif', 'b.gif']);
    expect(startArgs.items.every((it) => it.status === 'pending')).toBe(true);
  });

  it('mismatch branch: when main re-mints jobIds, routing tables are wiped and re-routed', async () => {
    const handles = makeDeps({
      recId: 'rec-mm',
      uploadStartImpl: async (_payload) => ({
        ok: true,
        // Main re-minted ids — the defensive branch must fire.
        jobIds: ['srv-a', 'srv-b'],
        sessionId: 'session-y'
      })
    });

    const { result } = renderHook(() => useUploadDispatch(handles.deps));

    const plan = [
      { media: makeMedia('m1'), filePath: '/out/a.gif' },
      { media: makeMedia('m2'), filePath: '/out/b.gif' }
    ];

    await act(async () => {
      await result.current.dispatchUpload(plan);
    });

    // Old `${recId}-${i}` keys must be GONE.
    expect(handles.uploadJobToRecordRef.current.has('rec-mm-0')).toBe(false);
    expect(handles.uploadJobToRecordRef.current.has('rec-mm-1')).toBe(false);
    expect(handles.uploadJobToTargetRef.current.has('rec-mm-0')).toBe(false);
    expect(handles.uploadJobToTargetRef.current.has('rec-mm-1')).toBe(false);
    // Echoed ids must be present, mapped to recId.
    expect(handles.uploadJobToRecordRef.current.get('srv-a')).toBe('rec-mm');
    expect(handles.uploadJobToRecordRef.current.get('srv-b')).toBe('rec-mm');
    expect(handles.uploadJobToTargetRef.current.get('srv-a')).toEqual({
      sniffRecId: undefined,
      filePath: '/out/a.gif'
    });
    expect(handles.uploadJobToTargetRef.current.get('srv-b')).toEqual({
      sniffRecId: undefined,
      filePath: '/out/b.gif'
    });
    // In-flight counter reset to echoed.length (2).
    expect(handles.uploadInflightRef.current.get('rec-mm')).toBe(2);
    // items[] mutated in place to carry echoed ids.
    const startArgs = handles.startUploadRecord.mock.calls[0][0] as {
      items: UploadHistoryItem[];
    };
    expect(startArgs.items.map((it) => it.jobId)).toEqual(['srv-a', 'srv-b']);
    // Still opens the modal on success.
    expect(handles.setUploadResult).toHaveBeenCalledWith('rec-mm');
  });

  it('catch branch rolls back routing tables + in-flight counter on uploadStart rejection', async () => {
    const handles = makeDeps({
      recId: 'rec-fail',
      uploadStartImpl: async () => { throw new Error('network down'); }
    });

    const { result } = renderHook(() => useUploadDispatch(handles.deps));

    await act(async () => {
      await result.current.dispatchUpload([
        { media: makeMedia('m1'), filePath: '/out/a.gif' },
        { media: makeMedia('m2'), filePath: '/out/b.gif' }
      ]);
    });

    // Routing tables fully drained for our jobIds.
    expect(handles.uploadJobToRecordRef.current.size).toBe(0);
    expect(handles.uploadJobToTargetRef.current.size).toBe(0);
    // In-flight counter for recId removed entirely.
    expect(handles.uploadInflightRef.current.has('rec-fail')).toBe(false);
    // Modal NOT opened on failure path.
    expect(handles.setUploadResult).not.toHaveBeenCalled();
    // Failure log line emitted.
    const failLine = handles.setLogs.mock.calls
      .map((c) => (c[0] as (p: string[]) => string[])([]))
      .map((arr) => arr[0])
      .find((line) => typeof line === 'string' && line.includes('派发失败'));
    expect(failLine).toBeDefined();
    expect(failLine).toContain('network down');
  });

  it('terminal setUploadResult(recId) fires immediately on success (R-73 modal-on-dispatch)', async () => {
    const handles = makeDeps({ recId: 'rec-modal' });

    const { result } = renderHook(() => useUploadDispatch(handles.deps));

    await act(async () => {
      await result.current.dispatchUpload([
        { media: makeMedia('m1'), filePath: '/out/a.gif' }
      ]);
    });

    expect(handles.setUploadResult).toHaveBeenCalledTimes(1);
    expect(handles.setUploadResult).toHaveBeenCalledWith('rec-modal');
    // The dispatched-N log line is also present.
    const dispatchLine = handles.setLogs.mock.calls
      .map((c) => (c[0] as (p: string[]) => string[])([]))
      .map((arr) => arr[0])
      .find((line) => typeof line === 'string' && line.includes('已派发'));
    expect(dispatchLine).toBeDefined();
    expect(dispatchLine).toContain('1 个上传任务');
  });

  it('sessionId pin: payload.sessionId comes from history[sniffRecId].sessionId when sniffRecId is provided', async () => {
    const history: HistoryRecord[] = [
      makeHistoryRecord('hist-A', 'session-A'),
      makeHistoryRecord('hist-B', 'session-B')
    ];
    let capturedPayload: UploadStartPayload | null = null;
    const handles = makeDeps({
      history,
      recId: 'rec-pin',
      uploadStartImpl: async (payload) => {
        capturedPayload = payload;
        return {
          ok: true,
          jobIds: payload.jobs.map((j) => j.id),
          sessionId: payload.sessionId ?? 'fallback'
        };
      }
    });

    const { result } = renderHook(() => useUploadDispatch(handles.deps));

    await act(async () => {
      await result.current.dispatchUpload(
        [{ media: makeMedia('m1'), filePath: '/out/a.gif' }],
        { sniffRecId: 'hist-B' }
      );
    });

    expect(capturedPayload).not.toBeNull();
    const payload = capturedPayload!;
    expect(payload.sessionId).toBe('session-B');
    // recordId echoed onto every job is the resolved sniffRecId.
    expect(payload.jobs.every((j) => j.recordId === 'hist-B')).toBe(true);
    // Target table also pins sniffRecId.
    expect(handles.uploadJobToTargetRef.current.get('rec-pin-0')).toEqual({
      sniffRecId: 'hist-B',
      filePath: '/out/a.gif'
    });
  });

  it('sessionId pin (default): falls back to activeHistoryIdRef.current when opts.sniffRecId is omitted', async () => {
    const history: HistoryRecord[] = [makeHistoryRecord('hist-active', 'session-active')];
    let capturedPayload: UploadStartPayload | null = null;
    const handles = makeDeps({
      history,
      activeHistoryId: 'hist-active',
      recId: 'rec-default',
      uploadStartImpl: async (payload) => {
        capturedPayload = payload;
        return {
          ok: true,
          jobIds: payload.jobs.map((j) => j.id),
          sessionId: payload.sessionId ?? 'fallback'
        };
      }
    });

    const { result } = renderHook(() => useUploadDispatch(handles.deps));

    await act(async () => {
      // No opts → falls back to activeHistoryIdRef.current.
      await result.current.dispatchUpload([
        { media: makeMedia('m1'), filePath: '/out/a.gif' }
      ]);
    });

    expect(capturedPayload).not.toBeNull();
    expect(capturedPayload!.sessionId).toBe('session-active');
    expect(capturedPayload!.jobs[0].recordId).toBe('hist-active');
  });

  it('uploadStart returns ok:false → treated as failure, rollback fires, no modal', async () => {
    const handles = makeDeps({
      recId: 'rec-okfalse',
      uploadStartImpl: async () => ({
        ok: false,
        jobIds: [],
        sessionId: ''
      })
    });

    const { result } = renderHook(() => useUploadDispatch(handles.deps));

    await act(async () => {
      await result.current.dispatchUpload([
        { media: makeMedia('m1'), filePath: '/out/a.gif' }
      ]);
    });

    expect(handles.uploadJobToRecordRef.current.size).toBe(0);
    expect(handles.uploadJobToTargetRef.current.size).toBe(0);
    expect(handles.uploadInflightRef.current.has('rec-okfalse')).toBe(false);
    expect(handles.setUploadResult).not.toHaveBeenCalled();
  });
});
