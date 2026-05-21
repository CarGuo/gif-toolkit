// @vitest-environment happy-dom
/**
 * Tests for useSniffSession
 * (src/renderer/components/useSniffSession.ts).
 *
 * What we lock in
 * ---------------
 *  • runEmbed happy path — `giftk.sniff` is called, the success branch
 *    flips every workspace setter (setSniffing/setResult/…), creates a
 *    HistoryRecord via `pushOrReplace`, points `activeHistoryIdRef` at
 *    the new id, calls `ws.patchById(wsId, { historyId })`, and pushes
 *    the URL into the sniff-history LRU.
 *  • runEmbed stale-guard — if a NEW sniff bumps `sniffReqId` while the
 *    first IPC promise is still pending, the resolve of the FIRST call
 *    must NOT call setResult / pushOrReplace / addSniffHistory (myId !==
 *    sniffReqId.current short-circuits before any state mutation).
 *  • runEmbed timeout branch — when the IPC never resolves within
 *    SNIFF_TIMEOUT_MS, the watchdog bumps `sniffReqId.current` itself
 *    and writes the timeout warning into setResult.
 *  • runWebview('system-chrome') — forwards `useRealChromeProfile` as
 *    the third arg via the `chromeOpts` slot, sets `activeSniffMode` to
 *    'system-chrome', and clears it back to null in the finally block.
 *  • runOffline picker-cancel — when `giftk.importOfflinePage` resolves
 *    null (user cancelled the OS file picker), the run silently bails:
 *    no setResult, no pushOrReplace, but the sniffing flags still
 *    drain in the finally block.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  useSniffSession,
  type SniffSessionDeps,
  type SniffSessionGiftk
} from '../../src/renderer/components/useSniffSession';
import type {
  ProcessOptions,
  SniffResult,
  SniffedMedia
} from '../../src/shared/types';
import type { HistoryRecord } from '../../src/renderer/components/useHistory';
import type { UseWorkspacesApi, Workspace } from '../../src/renderer/components/useWorkspaces';

const SNIFF_TIMEOUT_MS = 60_000;

const makeMedia = (id: string, overrides: Partial<SniffedMedia> = {}): SniffedMedia => ({
  id,
  url: `https://cdn.test/${id}.mp4`,
  kind: 'video',
  source: 'video-tag',
  pageUrl: 'https://host.test/page',
  requiresExternalDownload: false,
  ...overrides
});

const makeResult = (
  pageUrl: string,
  items: SniffedMedia[],
  overrides: Partial<SniffResult> = {}
): SniffResult => ({
  pageUrl,
  items,
  warnings: [],
  ...overrides
});

const makeOptions = (): ProcessOptions => ({
  fps: 12,
  maxSide: 480,
  maxSegmentSec: 8,
  loop: true,
  preserveAspect: true,
  optimizeLevel: 'balanced',
  dither: 'auto',
  shortSideFloor: 240,
  softTargetMb: 5,
  hardTargetMb: 10,
  concurrency: 3
} as ProcessOptions);

interface DepsHandles {
  deps: SniffSessionDeps;
  giftk: {
    sniff: ReturnType<typeof vi.fn>;
    sniffWithSystemChrome: ReturnType<typeof vi.fn>;
    importOfflinePage: ReturnType<typeof vi.fn>;
  };
  ws: UseWorkspacesApi;
  patchByIdMock: ReturnType<typeof vi.fn>;
  setSniffing: ReturnType<typeof vi.fn>;
  setSniffProgress: ReturnType<typeof vi.fn>;
  setResult: ReturnType<typeof vi.fn>;
  setSelected: ReturnType<typeof vi.fn>;
  setActiveSniffMode: ReturnType<typeof vi.fn>;
  setLogs: ReturnType<typeof vi.fn>;
  pushOrReplace: ReturnType<typeof vi.fn>;
  addSniffHistory: ReturnType<typeof vi.fn>;
  makeHistoryRecord: ReturnType<typeof vi.fn>;
  resetEmbedResolve: ReturnType<typeof vi.fn>;
  activeHistoryIdRef: { current: string | null };
}

function makeDeps(opts: {
  url?: string;
  result?: SniffResult | null;
  useRealChromeProfile?: boolean;
  sniffImpl?: (url: string) => Promise<SniffResult>;
  systemChromeImpl?: (
    url: string,
    extra?: { includeStaticImages?: boolean },
    chromeOpts?: { useRealProfile?: boolean }
  ) => Promise<SniffResult>;
  offlineImpl?: (
    absPath?: string,
    extra?: { includeStaticImages?: boolean }
  ) => Promise<SniffResult | null>;
} = {}): DepsHandles {
  const sniff = vi.fn(opts.sniffImpl ?? (async (u: string) => makeResult(u, [makeMedia('a')])));
  const sniffWithSystemChrome = vi.fn(
    opts.systemChromeImpl ?? (async (u: string) => makeResult(u, [makeMedia('s')]))
  );
  const importOfflinePage = vi.fn(
    opts.offlineImpl ?? (async () => makeResult('file:///offline', [makeMedia('o')]))
  );
  const giftk: SniffSessionGiftk = {
    sniff,
    sniffWithSystemChrome,
    importOfflinePage
  };

  // Hand-rolled minimal ws stub. Only the methods the hook actually
  // calls are wired; everything else is a no-op so a stray invocation
  // surfaces as a test-time TypeError.
  const patchByIdMock = vi.fn();
  const ws = {
    workspaces: [] as Workspace[],
    activeWs: { id: 'ws-1' } as unknown as Workspace,
    activeWsId: 'ws-1',
    switchTo: vi.fn(),
    openNew: vi.fn(() => 'ws-1'),
    close: vi.fn(),
    claimForSniff: vi.fn(() => 'ws-1'),
    patchActive: vi.fn(),
    patchById: patchByIdMock,
    patchByHistoryId: vi.fn(() => false),
    isBusy: vi.fn(() => false)
  } as unknown as UseWorkspacesApi;

  const setUrlError = vi.fn();
  const setSniffing = vi.fn();
  const setSniffProgress = vi.fn();
  const setResult = vi.fn();
  const setSelected = vi.fn();
  const setActiveId = vi.fn();
  const setPreview = vi.fn();
  const setLogs = vi.fn();
  const setActiveSniffMode = vi.fn();
  const resetEmbedResolve = vi.fn();
  const pushOrReplace = vi.fn();
  const addSniffHistory = vi.fn();
  const makeHistoryRecord = vi.fn(
    (input: { pageUrl: string; items: SniffedMedia[] }): HistoryRecord => ({
      id: `rec-${input.pageUrl}`,
      sniffedAt: 0,
      pageUrl: input.pageUrl,
      items: input.items,
      options: makeOptions(),
      tasks: {},
      uploadsByOutputPath: {}
    } as HistoryRecord)
  );
  const activeHistoryIdRef = { current: null as string | null };

  const deps: SniffSessionDeps = {
    giftk,
    ws,
    url: opts.url ?? 'https://host.test/page',
    result: opts.result ?? null,
    useRealChromeProfile: opts.useRealChromeProfile ?? false,
    options: makeOptions(),
    setUrlError,
    setSniffing,
    setSniffProgress,
    setResult,
    setSelected,
    setActiveId,
    setPreview,
    setLogs,
    setActiveSniffMode,
    resetEmbedResolve,
    activeHistoryIdRef,
    makeHistoryRecord,
    pushOrReplace,
    addSniffHistory,
    SNIFF_TIMEOUT_MS
  };

  return {
    deps,
    giftk: { sniff, sniffWithSystemChrome, importOfflinePage },
    ws,
    patchByIdMock,
    setSniffing,
    setSniffProgress,
    setResult,
    setSelected,
    setActiveSniffMode,
    setLogs,
    pushOrReplace,
    addSniffHistory,
    makeHistoryRecord,
    resetEmbedResolve,
    activeHistoryIdRef
  };
}

describe('useSniffSession', () => {
  // Helper: find a patchById call that matches both the wsId and a
  // predicate over its patch payload. Returns undefined if none.
  const findPatch = (
    mock: ReturnType<typeof vi.fn>,
    wsId: string,
    pred: (patch: Record<string, unknown>) => boolean
  ): Record<string, unknown> | undefined => {
    const c = mock.mock.calls.find(
      ([id, patch]) => id === wsId && patch && typeof patch === 'object' && pred(patch as Record<string, unknown>)
    );
    return c ? (c[1] as Record<string, unknown>) : undefined;
  };

  it('runEmbed happy path: calls giftk.sniff, creates HistoryRecord, drains flags', async () => {
    const r = makeResult('https://host.test/page', [makeMedia('a'), makeMedia('b')]);
    const handles = makeDeps({ sniffImpl: async () => r });
    const { result } = renderHook(() => useSniffSession(handles.deps));

    await act(async () => {
      await result.current.runEmbed();
    });

    expect(handles.giftk.sniff).toHaveBeenCalledTimes(1);
    const sniffCall = handles.giftk.sniff.mock.calls[0];
    expect(sniffCall[0]).toBe('https://host.test/page');
    // R-WS-90 P4 — sniff IPC now carries opts.sessionId so the main
    // process can stamp it onto SniffProgress events for routing.
    expect(sniffCall[1]).toEqual(expect.objectContaining({
      sessionId: expect.any(String)
    }));
    const mintedSessionId = (sniffCall[1] as { sessionId: string }).sessionId;
    // R-WS-89 — lifecycle flags now go through patchById(wsId, …)
    // instead of the active-shim setX. Verify the sniffing:true open
    // patch and the sniffing:false drain patch both targeted ws-1.
    // R-WS-90 P4 — the open patch must also carry sniffSessionId so
    // close(wsId) can cancel via that token.
    const openPatch = findPatch(handles.patchByIdMock, 'ws-1', (p) => p.sniffing === true);
    expect(openPatch).toBeDefined();
    expect(openPatch?.sniffSessionId).toBe(mintedSessionId);
    expect(handles.resetEmbedResolve).toHaveBeenCalled();
    // Result patch — the success branch must patch ws-1 with the
    // resolved SniffResult and an auto-select Set of its video/gif ids.
    const resultPatch = findPatch(handles.patchByIdMock, 'ws-1', (p) => 'result' in p && (p.result as SniffResult)?.pageUrl === r.pageUrl);
    expect(resultPatch).toBeDefined();
    expect(resultPatch?.result).toEqual(r);
    const sel = resultPatch?.selected as Set<string> | undefined;
    expect(sel).toBeInstanceOf(Set);
    expect(sel?.has('a') && sel?.has('b')).toBe(true);
    // History record + workspace pin.
    expect(handles.pushOrReplace).toHaveBeenCalledTimes(1);
    const rec = handles.pushOrReplace.mock.calls[0][0] as HistoryRecord;
    expect(handles.activeHistoryIdRef.current).toBe(rec.id);
    expect(handles.patchByIdMock).toHaveBeenCalledWith('ws-1', { historyId: rec.id });
    // Sniff history LRU.
    expect(handles.addSniffHistory).toHaveBeenCalledWith({
      url: r.pageUrl,
      title: undefined,
      itemCount: 2
    });
    // Finally block flips sniffing → false (also via patchById).
    // R-WS-90 P4 — finally also clears sniffSessionId so close(wsId)
    // doesn't mistakenly cancel after the run ended.
    const sniffOff = findPatch(handles.patchByIdMock, 'ws-1', (p) => p.sniffing === false);
    expect(sniffOff).toBeDefined();
    expect(sniffOff?.sniffSessionId).toBeNull();
  });

  it('runEmbed stale-guard: a second runEmbed bumps sniffReqId so the first resolve no-ops', async () => {
    let release1: (r: SniffResult) => void = () => undefined;
    const slow = new Promise<SniffResult>((res) => { release1 = res; });
    const handles = makeDeps({
      sniffImpl: vi.fn()
        // First call hangs until we release it manually.
        .mockImplementationOnce(() => slow)
        // Second call resolves instantly with a different result.
        .mockImplementationOnce(async () => makeResult('https://host.test/page', [makeMedia('z')]))
    });
    const { result } = renderHook(() => useSniffSession(handles.deps));

    // Kick off first run; do NOT await — it's still pending.
    let firstRun: Promise<void> = Promise.resolve();
    await act(async () => {
      firstRun = result.current.runEmbed();
    });
    const myIdAfterFirst = result.current.sniffReqId.current;
    expect(myIdAfterFirst).toBe(1);

    // Kick off second run — bumps sniffReqId to 2 BEFORE the first
    // resolves. The second call's sniff impl returns synchronously.
    await act(async () => {
      await result.current.runEmbed();
    });
    expect(result.current.sniffReqId.current).toBe(2);

    // Now release the first call. Its `myId === 1` no longer matches
    // sniffReqId.current === 2, so EVERY post-await branch must bail
    // BEFORE re-running setResult / pushOrReplace / addSniffHistory.
    // R-WS-89 — same contract via patchByIdMock now.
    handles.patchByIdMock.mockClear();
    handles.pushOrReplace.mockClear();
    handles.addSniffHistory.mockClear();
    await act(async () => {
      release1(makeResult('https://host.test/page', [makeMedia('stale')]));
      await firstRun;
    });

    // The stale resolve must NOT touch any per-ws state.
    expect(handles.patchByIdMock).not.toHaveBeenCalled();
    expect(handles.pushOrReplace).not.toHaveBeenCalled();
    expect(handles.addSniffHistory).not.toHaveBeenCalled();
  });

  it('runEmbed timeout branch: watchdog bumps sniffReqId and writes the timeout warning', async () => {
    vi.useFakeTimers();
    try {
      const neverResolves = new Promise<SniffResult>(() => { /* hang */ });
      const handles = makeDeps({ sniffImpl: () => neverResolves });
      const { result } = renderHook(() => useSniffSession(handles.deps));

      // Fire and don't await — the IPC will never resolve.
      let pending: Promise<void> = Promise.resolve();
      act(() => {
        pending = result.current.runEmbed();
      });
      void pending;
      expect(result.current.sniffReqId.current).toBe(1);

      // Advance just past the 60s window so the watchdog fires.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SNIFF_TIMEOUT_MS + 10);
      });

      // Watchdog should have:
      //  1) bumped sniffReqId.current itself (1 → 2)
      //  2) patched ws-1 with sniffing:false + a timeout warning result
      // R-WS-89 — patchById, not setX.
      expect(result.current.sniffReqId.current).toBe(2);
      const timeoutPatch = findPatch(handles.patchByIdMock, 'ws-1', (p) =>
        p.sniffing === false &&
        'result' in p &&
        Array.isArray((p.result as SniffResult)?.warnings) &&
        ((p.result as SniffResult).warnings?.[0] ?? '').includes('嗅探超时')
      );
      expect(timeoutPatch).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('runWebview(\'system-chrome\') forwards useRealChromeProfile via the third arg', async () => {
    const r = makeResult('https://host.test/sc', [makeMedia('sc')]);
    const handles = makeDeps({
      useRealChromeProfile: true,
      systemChromeImpl: async () => r
    });
    const { result } = renderHook(() => useSniffSession(handles.deps));

    await act(async () => {
      await result.current.runWebview('system-chrome');
    });

    expect(handles.giftk.sniffWithSystemChrome).toHaveBeenCalledTimes(1);
    const call = handles.giftk.sniffWithSystemChrome.mock.calls[0];
    expect(call[0]).toBe('https://host.test/page');
    // R-WS-90 P4 — opts is no longer undefined; it carries sessionId.
    expect(call[1]).toEqual(expect.objectContaining({
      sessionId: expect.any(String)
    }));
    expect(call[2]).toEqual({ useRealProfile: true });
    // Active mode flips system-chrome → null across the lifecycle
    // (this remains a global flag, still on the shim setter).
    expect(handles.setActiveSniffMode).toHaveBeenCalledWith('system-chrome');
    expect(handles.setActiveSniffMode).toHaveBeenLastCalledWith(null);
    // Result patch — R-WS-89 — must land via patchById on ws-1.
    const resultPatch = findPatch(handles.patchByIdMock, 'ws-1', (p) => 'result' in p && (p.result as SniffResult)?.pageUrl === r.pageUrl);
    expect(resultPatch).toBeDefined();
    expect(resultPatch?.result).toEqual(r);
  });

  it('runOffline picker-cancel: r === null silently bails', async () => {
    const handles = makeDeps({ offlineImpl: async () => null });
    const { result } = renderHook(() => useSniffSession(handles.deps));

    await act(async () => {
      await result.current.runOffline();
    });

    // Happy-path side-effects MUST NOT have fired. The cancelled
    // picker bails BEFORE any result patch (the only patches we
    // expect on ws-1 are the open patch and the finally drain).
    const happyResultPatch = findPatch(handles.patchByIdMock, 'ws-1', (p) =>
      'result' in p && (p.result as SniffResult | null) !== null && Array.isArray((p.result as SniffResult).items) && (p.result as SniffResult).items.length > 0
    );
    expect(happyResultPatch).toBeUndefined();
    expect(handles.pushOrReplace).not.toHaveBeenCalled();
    // But the lifecycle flags still drain in the finally block.
    await waitFor(() => {
      const sniffOff = findPatch(handles.patchByIdMock, 'ws-1', (p) => p.sniffing === false);
      expect(sniffOff).toBeDefined();
      expect(handles.setActiveSniffMode).toHaveBeenLastCalledWith(null);
    });
  });

  it('R-WS-89 cross-tab isolation: runWebview keeps writing to the wsId it claimed even after the user switches tabs mid-flight', async () => {
    // Scenario the user reported on 2026-05-21:
    //   1. Sniff URL_A in workspace ws-A (claimForSniff returns ws-A).
    //   2. While that sniff is still loading, the user kicks off a
    //      sniff for URL_B which claims a fresh ws-B AND flips active
    //      to ws-B (claimForSniff's documented behaviour).
    //   3. The user then switches tab back to ws-A — but ws-A still
    //      has no result, because the resolve of sniff_A used the
    //      active-shim setResult which wrote into ws-B (the active
    //      tab at the moment the promise resolved), overwriting B's
    //      half-finished state and leaving A blank.
    //
    // The fix: every per-workspace mutation in run* must target the
    // wsId captured locally at claim time via ws.patchById(wsId, …),
    // never via the active-shim setX. This test pins that contract
    // for runWebview specifically (runEmbed/runOffline are pinned in
    // their own happy-path cases via the same patchByIdMock checks).

    let releaseA: (r: SniffResult) => void = () => undefined;
    const slowA = new Promise<SniffResult>((res) => { releaseA = res; });
    let releaseB: (r: SniffResult) => void = () => undefined;
    const slowB = new Promise<SniffResult>((res) => { releaseB = res; });

    const sniffWithWebview = vi.fn()
      .mockImplementationOnce(() => slowA)
      .mockImplementationOnce(() => slowB);

    const patchByIdMock = vi.fn();
    let activeWsId = 'ws-A';
    const claimForSniff = vi.fn(() => {
      // Mimic real claimForSniff: first call returns the existing
      // blank ws (ws-A); second call opens a new ws-B AND flips
      // active to ws-B.
      if (claimForSniff.mock.calls.length === 1) {
        activeWsId = 'ws-A';
        return 'ws-A';
      }
      activeWsId = 'ws-B';
      return 'ws-B';
    });

    const ws = {
      workspaces: [] as Workspace[],
      get activeWs() { return { id: activeWsId } as unknown as Workspace; },
      get activeWsId() { return activeWsId; },
      switchTo: vi.fn((id: string) => { activeWsId = id; }),
      openNew: vi.fn(),
      close: vi.fn(),
      claimForSniff,
      patchActive: vi.fn(),
      patchById: patchByIdMock,
      patchByHistoryId: vi.fn(() => false),
      isBusy: vi.fn(() => false)
    } as unknown as UseWorkspacesApi;

    const giftk: SniffSessionGiftk = {
      sniff: vi.fn(),
      sniffWithWebview: sniffWithWebview as unknown as SniffSessionGiftk['sniffWithWebview'],
      importOfflinePage: vi.fn()
    };

    const setSniffing = vi.fn();
    const setResult = vi.fn();
    const setSelected = vi.fn();
    const activeHistoryIdRef = { current: null as string | null };
    const deps: SniffSessionDeps = {
      giftk,
      ws,
      url: 'https://host.test/A',
      result: null,
      useRealChromeProfile: false,
      options: makeOptions(),
      setUrlError: vi.fn(),
      setSniffing,
      setSniffProgress: vi.fn(),
      setResult,
      setSelected,
      setActiveId: vi.fn(),
      setPreview: vi.fn(),
      setLogs: vi.fn(),
      setActiveSniffMode: vi.fn(),
      resetEmbedResolve: vi.fn(),
      activeHistoryIdRef,
      makeHistoryRecord: vi.fn((input: { pageUrl: string; items: SniffedMedia[] }): HistoryRecord => ({
        id: `rec-${input.pageUrl}`,
        sniffedAt: 0,
        pageUrl: input.pageUrl,
        items: input.items,
        options: makeOptions(),
        tasks: {},
        uploadsByOutputPath: {}
      } as HistoryRecord)),
      pushOrReplace: vi.fn(),
      addSniffHistory: vi.fn(),
      SNIFF_TIMEOUT_MS
    };

    const { result, rerender } = renderHook(
      (props: SniffSessionDeps) => useSniffSession(props),
      { initialProps: deps }
    );

    // Step 1: kick off sniff A on ws-A.
    let runA: Promise<void> = Promise.resolve();
    await act(async () => { runA = result.current.runWebview('embed'); });
    expect(claimForSniff).toHaveBeenCalledTimes(1);
    expect(activeWsId).toBe('ws-A');

    // Step 2: while A is still pending, kick off sniff B on ws-B.
    // claimForSniff flips active → ws-B internally.
    const depsForB: SniffSessionDeps = { ...deps, url: 'https://host.test/B' };
    rerender(depsForB);
    let runB: Promise<void> = Promise.resolve();
    await act(async () => { runB = result.current.runWebview('embed'); });
    expect(claimForSniff).toHaveBeenCalledTimes(2);
    expect(activeWsId).toBe('ws-B');

    // Step 3: user switches tab back to ws-A while B is still pending.
    activeWsId = 'ws-A';

    // Now resolve A first, then B. Snapshot the patchById call list so
    // we can inspect it after both runs settle.
    patchByIdMock.mockClear();
    await act(async () => {
      releaseA(makeResult('https://host.test/A', [makeMedia('a')]));
      releaseB(makeResult('https://host.test/B', [makeMedia('b')]));
      await runA;
      await runB;
    });

    // The CONTRACT: every per-ws write that happened after both
    // resolves landed must carry an explicit wsId — and the result
    // payload of A must have been written to ws-A, not the
    // currently-active ws-B (and vice versa for B).
    const calls = patchByIdMock.mock.calls;
    const aResultCall = calls.find(
      ([id, patch]) =>
        id === 'ws-A' &&
        patch &&
        typeof patch === 'object' &&
        'result' in patch &&
        (patch.result as SniffResult)?.pageUrl === 'https://host.test/A'
    );
    const bResultCall = calls.find(
      ([id, patch]) =>
        id === 'ws-B' &&
        patch &&
        typeof patch === 'object' &&
        'result' in patch &&
        (patch.result as SniffResult)?.pageUrl === 'https://host.test/B'
    );
    expect(aResultCall, "ws-A's result must be patched into ws-A even though active is ws-B").toBeDefined();
    expect(bResultCall, "ws-B's result must be patched into ws-B").toBeDefined();

    // Negative side: A's result must NEVER have been patched into
    // ws-B and vice versa (that's exactly the original bug).
    const aWrittenIntoB = calls.find(
      ([id, patch]) =>
        id === 'ws-B' &&
        patch &&
        typeof patch === 'object' &&
        'result' in patch &&
        (patch.result as SniffResult)?.pageUrl === 'https://host.test/A'
    );
    const bWrittenIntoA = calls.find(
      ([id, patch]) =>
        id === 'ws-A' &&
        patch &&
        typeof patch === 'object' &&
        'result' in patch &&
        (patch.result as SniffResult)?.pageUrl === 'https://host.test/B'
    );
    expect(aWrittenIntoB, "A's result leaked into B (R-WS-89 regression)").toBeUndefined();
    expect(bWrittenIntoA, "B's result leaked into A (R-WS-89 regression)").toBeUndefined();
  });

  it('R-WS-90 P4 T7 concurrent sniff isolation: two in-flight sniffs mint distinct sessionIds and route results to their own wsId', async () => {
    // P4 T7 — when two sniffs are in flight at once, each mints its
    // own sessionId; the IPC carries opts.sessionId so the main
    // process can route progress events back to the right tab; and
    // the resolve branch patches the result onto the wsId captured
    // at claim time, never the currently-active ws. This is the
    // multi-tab analog of R-WS-89's cross-tab isolation but pinned
    // specifically on the sessionId routing token.
    let releaseA: (r: SniffResult) => void = () => undefined;
    const slowA = new Promise<SniffResult>((res) => { releaseA = res; });
    let releaseB: (r: SniffResult) => void = () => undefined;
    const slowB = new Promise<SniffResult>((res) => { releaseB = res; });

    const sniff = vi.fn()
      .mockImplementationOnce(() => slowA)
      .mockImplementationOnce(() => slowB);

    const patchByIdMock = vi.fn();
    let activeWsId = 'ws-A';
    const claimForSniff = vi.fn(() => {
      if (claimForSniff.mock.calls.length === 1) {
        activeWsId = 'ws-A';
        return 'ws-A';
      }
      activeWsId = 'ws-B';
      return 'ws-B';
    });

    const ws = {
      workspaces: [] as Workspace[],
      get activeWs() { return { id: activeWsId } as unknown as Workspace; },
      get activeWsId() { return activeWsId; },
      switchTo: vi.fn((id: string) => { activeWsId = id; }),
      openNew: vi.fn(),
      close: vi.fn(),
      claimForSniff,
      patchActive: vi.fn(),
      patchById: patchByIdMock,
      patchByHistoryId: vi.fn(() => false),
      isBusy: vi.fn(() => false)
    } as unknown as UseWorkspacesApi;

    const giftk: SniffSessionGiftk = {
      sniff: sniff as unknown as SniffSessionGiftk['sniff'],
      sniffWithWebview: vi.fn(),
      importOfflinePage: vi.fn()
    };

    const baseDeps: SniffSessionDeps = {
      giftk,
      ws,
      url: 'https://host.test/A',
      result: null,
      useRealChromeProfile: false,
      options: makeOptions(),
      setUrlError: vi.fn(),
      setSniffing: vi.fn(),
      setSniffProgress: vi.fn(),
      setResult: vi.fn(),
      setSelected: vi.fn(),
      setActiveId: vi.fn(),
      setPreview: vi.fn(),
      setLogs: vi.fn(),
      setActiveSniffMode: vi.fn(),
      resetEmbedResolve: vi.fn(),
      activeHistoryIdRef: { current: null as string | null },
      makeHistoryRecord: vi.fn((input: { pageUrl: string; items: SniffedMedia[] }): HistoryRecord => ({
        id: `rec-${input.pageUrl}`,
        sniffedAt: 0,
        pageUrl: input.pageUrl,
        items: input.items,
        options: makeOptions(),
        tasks: {},
        uploadsByOutputPath: {}
      } as HistoryRecord)),
      pushOrReplace: vi.fn(),
      addSniffHistory: vi.fn(),
      SNIFF_TIMEOUT_MS
    };

    const { result, rerender } = renderHook(
      (props: SniffSessionDeps) => useSniffSession(props),
      { initialProps: baseDeps }
    );

    let runA: Promise<void> = Promise.resolve();
    await act(async () => { runA = result.current.runEmbed(); });
    rerender({ ...baseDeps, url: 'https://host.test/B' });
    let runB: Promise<void> = Promise.resolve();
    await act(async () => { runB = result.current.runEmbed(); });

    // Both sniff IPC calls fired with distinct, non-empty sessionIds.
    expect(sniff).toHaveBeenCalledTimes(2);
    const optsA = sniff.mock.calls[0][1] as { sessionId: string };
    const optsB = sniff.mock.calls[1][1] as { sessionId: string };
    expect(optsA.sessionId).toEqual(expect.any(String));
    expect(optsB.sessionId).toEqual(expect.any(String));
    expect(optsA.sessionId.length).toBeGreaterThan(0);
    expect(optsB.sessionId.length).toBeGreaterThan(0);
    expect(optsA.sessionId).not.toBe(optsB.sessionId);

    // The open-patch for each ws stamped its corresponding sessionId
    // onto the workspace, so close(wsId) can cancel via that token.
    const openA = patchByIdMock.mock.calls.find(
      ([id, patch]) => id === 'ws-A' && (patch as { sniffSessionId?: string } | undefined)?.sniffSessionId === optsA.sessionId
    );
    const openB = patchByIdMock.mock.calls.find(
      ([id, patch]) => id === 'ws-B' && (patch as { sniffSessionId?: string } | undefined)?.sniffSessionId === optsB.sessionId
    );
    expect(openA, 'ws-A open patch must carry its sessionId').toBeDefined();
    expect(openB, 'ws-B open patch must carry its sessionId').toBeDefined();

    // Resolve in reverse order to maximise cross-talk pressure: B
    // first while active is ws-B, then A while active is still ws-B.
    patchByIdMock.mockClear();
    await act(async () => {
      releaseB(makeResult('https://host.test/B', [makeMedia('b')]));
      await runB;
    });
    // Switch active back to ws-A (user clicks tab) — A still pending.
    activeWsId = 'ws-A';
    await act(async () => {
      releaseA(makeResult('https://host.test/A', [makeMedia('a')]));
      await runA;
    });

    const calls = patchByIdMock.mock.calls;
    const aResultCall = calls.find(
      ([id, patch]) =>
        id === 'ws-A' &&
        (patch as { result?: SniffResult } | undefined)?.result?.pageUrl === 'https://host.test/A'
    );
    const bResultCall = calls.find(
      ([id, patch]) =>
        id === 'ws-B' &&
        (patch as { result?: SniffResult } | undefined)?.result?.pageUrl === 'https://host.test/B'
    );
    expect(aResultCall).toBeDefined();
    expect(bResultCall).toBeDefined();

    // The drain patch for each run must clear its OWN sniffSessionId.
    const drainA = calls.find(
      ([id, patch]) => id === 'ws-A' && (patch as { sniffing?: boolean } | undefined)?.sniffing === false
    );
    const drainB = calls.find(
      ([id, patch]) => id === 'ws-B' && (patch as { sniffing?: boolean } | undefined)?.sniffing === false
    );
    expect((drainA?.[1] as { sniffSessionId?: string | null } | undefined)?.sniffSessionId).toBeNull();
    expect((drainB?.[1] as { sniffSessionId?: string | null } | undefined)?.sniffSessionId).toBeNull();
  });

  it('runOffline picker-cancel (R-WS-89 patchById form): r === null silently bails', async () => {
    // Companion to the L378 happy-path picker-cancel test; this one
    // pins the same contract through the patchById channel rather
    // than via the legacy setSniffing shim, since R-WS-89 moved
    // every per-ws lifecycle flag onto patchById.
    const handles = makeDeps({ offlineImpl: async () => null });
    const { result } = renderHook(() => useSniffSession(handles.deps));

    await act(async () => {
      await result.current.runOffline();
    });

    // Happy-path side-effects MUST NOT have fired — no result patch
    // with a non-null SniffResult was ever issued for ws-1.
    const happyResultPatch = findPatch(handles.patchByIdMock, 'ws-1', (p) =>
      'result' in p &&
      (p.result as SniffResult | null) !== null &&
      Array.isArray((p.result as SniffResult).items) &&
      (p.result as SniffResult).items.length > 0
    );
    expect(happyResultPatch).toBeUndefined();
    expect(handles.pushOrReplace).not.toHaveBeenCalled();

    // But the lifecycle flags still drain in the finally block via
    // patchById, including sniffSessionId cleared back to null.
    await waitFor(() => {
      const drainPatch = findPatch(handles.patchByIdMock, 'ws-1', (p) => p.sniffing === false);
      expect(drainPatch).toBeDefined();
      expect(drainPatch?.sniffSessionId).toBeNull();
      expect(handles.setActiveSniffMode).toHaveBeenLastCalledWith(null);
    });
  });
});
