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
  it('runEmbed happy path: calls giftk.sniff, creates HistoryRecord, drains flags', async () => {
    const r = makeResult('https://host.test/page', [makeMedia('a'), makeMedia('b')]);
    const handles = makeDeps({ sniffImpl: async () => r });
    const { result } = renderHook(() => useSniffSession(handles.deps));

    await act(async () => {
      await result.current.runEmbed();
    });

    expect(handles.giftk.sniff).toHaveBeenCalledWith('https://host.test/page');
    // Lifecycle flags
    expect(handles.setSniffing).toHaveBeenCalledWith(true);
    expect(handles.resetEmbedResolve).toHaveBeenCalled();
    expect(handles.setResult).toHaveBeenCalledWith(r);
    // Auto-select non-embed video/gif rows.
    const lastSetSelected = handles.setSelected.mock.calls.at(-1)?.[0] as Set<string>;
    expect(lastSetSelected).toBeInstanceOf(Set);
    expect(lastSetSelected.has('a') && lastSetSelected.has('b')).toBe(true);
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
    // Finally block flips sniffing → false.
    expect(handles.setSniffing).toHaveBeenLastCalledWith(false);
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
    handles.setResult.mockClear();
    handles.pushOrReplace.mockClear();
    handles.addSniffHistory.mockClear();
    await act(async () => {
      release1(makeResult('https://host.test/page', [makeMedia('stale')]));
      await firstRun;
    });

    expect(handles.setResult).not.toHaveBeenCalled();
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
      //  2) flipped sniffing back to false
      //  3) written the timeout warning into setResult
      expect(result.current.sniffReqId.current).toBe(2);
      expect(handles.setSniffing).toHaveBeenLastCalledWith(false);
      const timeoutResult = handles.setResult.mock.calls
        .map((c) => c[0])
        .find((v) => v && typeof v === 'object' && 'warnings' in v && (v as SniffResult).warnings?.[0]?.includes('嗅探超时'));
      expect(timeoutResult).toBeDefined();
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
    expect(call[1]).toBeUndefined();
    expect(call[2]).toEqual({ useRealProfile: true });
    // Active mode flips system-chrome → null across the lifecycle.
    expect(handles.setActiveSniffMode).toHaveBeenCalledWith('system-chrome');
    expect(handles.setActiveSniffMode).toHaveBeenLastCalledWith(null);
    expect(handles.setResult).toHaveBeenCalledWith(r);
  });

  it('runOffline picker-cancel: r === null silently bails', async () => {
    const handles = makeDeps({ offlineImpl: async () => null });
    const { result } = renderHook(() => useSniffSession(handles.deps));

    await act(async () => {
      await result.current.runOffline();
    });

    // Happy-path side-effects MUST NOT have fired.
    expect(handles.setResult).not.toHaveBeenCalledWith(
      expect.objectContaining({ items: expect.any(Array) })
    );
    expect(handles.pushOrReplace).not.toHaveBeenCalled();
    // But the lifecycle flags still drain in the finally block.
    await waitFor(() => {
      expect(handles.setSniffing).toHaveBeenLastCalledWith(false);
      expect(handles.setActiveSniffMode).toHaveBeenLastCalledWith(null);
    });
  });
});
