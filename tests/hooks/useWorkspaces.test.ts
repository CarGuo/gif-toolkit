// @vitest-environment happy-dom
/**
 * Tests for useWorkspaces (src/renderer/components/useWorkspaces.ts).
 *
 * Why this test file
 * ------------------
 * R-WS-89 ("切换 tab 后 A workspace 里的内容就看不到了") was caused by
 * useSniffSession writing through the active-shim instead of via
 * `patchById(wsId, …)` while async work was in flight. The root-cause
 * fix landed in useSniffSession (per-ws `sniffReqMap` + patchById
 * targeting), but the OTHER half of the contract — `claimForSniff`
 * may flip `active` when the previous active ws already has a result,
 * and `close(wsId)` must route a per-session sniff:cancel — has no
 * direct test coverage today. This file pins those contracts so
 * future refactors of useWorkspaces can't regress them.
 *
 * Pinned contracts
 * ----------------
 *  • blank-tab seed: a fresh hook always has exactly one workspace,
 *    and `activeWsId` matches its id.
 *  • claimForSniff (blank active): re-uses the active ws and DOES NOT
 *    flip active.
 *  • claimForSniff (active has result): opens a new ws AND flips
 *    active to the new one — this is the active-drift behaviour the
 *    R-WS-89 fix in useSniffSession has to defend against.
 *  • patchById is targeted: writes never leak into the sibling ws.
 *  • patchByHistoryId routes by HistoryRecord.id, regardless of which
 *    tab is active right now (this is the primary process:progress
 *    routing path).
 *  • close(wsId) on an in-flight sniff calls
 *    `window.giftk.cancelSniff({ sessionId })` — the renderer half of
 *    R-WS-90 P2's per-session abort wiring.
 *  • close(wsId) is no-op-safe when sniffing is false / sessionId is
 *    null (legacy / already-finished sniffs).
 *  • close(lastTab) reseeds a fresh blank ws so the home page never
 *    sees zero tabs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useWorkspaces } from '../../src/renderer/components/useWorkspaces';
import type { SniffResult } from '../../src/shared/types';

const stubResult = (pageUrl: string): SniffResult => ({
  pageUrl,
  items: [],
  warnings: []
});

describe('useWorkspaces', () => {
  beforeEach(() => {
    // Stub the preload bridge that close() reaches through.
    (window as unknown as { giftk?: { cancelSniff?: (opts?: unknown) => Promise<void> } }).giftk = {
      cancelSniff: vi.fn(async () => undefined)
    };
  });

  afterEach(() => {
    delete (window as unknown as { giftk?: unknown }).giftk;
  });

  it('seeds with exactly one blank workspace, activeWsId matches', () => {
    const { result } = renderHook(() => useWorkspaces());
    expect(result.current.workspaces).toHaveLength(1);
    const w = result.current.workspaces[0];
    expect(result.current.activeWsId).toBe(w.id);
    expect(w.url).toBe('');
    expect(w.result).toBeNull();
    expect(w.sniffing).toBe(false);
    expect(w.sniffSessionId).toBeNull();
  });

  it('claimForSniff(blank active): reuses active id, does NOT flip active', () => {
    const { result } = renderHook(() => useWorkspaces());
    const ws0 = result.current.workspaces[0];

    let claimed = '';
    act(() => { claimed = result.current.claimForSniff(); });

    expect(claimed).toBe(ws0.id);
    expect(result.current.activeWsId).toBe(ws0.id);
    expect(result.current.workspaces).toHaveLength(1);
  });

  it('claimForSniff(active has result): opens a new ws AND flips active', () => {
    const { result } = renderHook(() => useWorkspaces());
    const ws0 = result.current.workspaces[0];

    // Populate the first ws with a result (so it is no longer blank).
    act(() => {
      result.current.patchById(ws0.id, { result: stubResult('https://a.test/x'), url: 'https://a.test/x' });
    });

    let claimed = '';
    act(() => { claimed = result.current.claimForSniff(); });

    // A new ws was created and active was flipped to it — the exact
    // active-drift behaviour useSniffSession's per-ws stale-guard
    // (R-WS-89 fix) must tolerate.
    expect(claimed).not.toBe(ws0.id);
    expect(result.current.workspaces).toHaveLength(2);
    expect(result.current.activeWsId).toBe(claimed);
    // The original tab's data is preserved.
    const survivor = result.current.workspaces.find((w) => w.id === ws0.id);
    expect(survivor?.result?.pageUrl).toBe('https://a.test/x');
  });

  it('patchById is targeted: a write to ws-A does not leak into ws-B', () => {
    const { result } = renderHook(() => useWorkspaces());
    const wsA = result.current.workspaces[0];
    let wsBid = '';
    act(() => { wsBid = result.current.openNew(); });

    act(() => {
      result.current.patchById(wsA.id, {
        url: 'https://a.test/x',
        result: stubResult('https://a.test/x')
      });
    });

    const a = result.current.workspaces.find((w) => w.id === wsA.id)!;
    const b = result.current.workspaces.find((w) => w.id === wsBid)!;
    expect(a.url).toBe('https://a.test/x');
    expect(a.result?.pageUrl).toBe('https://a.test/x');
    // The R-WS-89 contract: B is untouched.
    expect(b.url).toBe('');
    expect(b.result).toBeNull();
  });

  it('patchByHistoryId routes by HistoryRecord.id even when a different tab is active', () => {
    const { result } = renderHook(() => useWorkspaces());
    const wsA = result.current.workspaces[0];
    let wsBid = '';
    act(() => { wsBid = result.current.openNew(); });

    // Pin a historyId on ws-A while ws-B is currently active.
    act(() => {
      result.current.patchById(wsA.id, { historyId: 'rec-A' });
    });
    expect(result.current.activeWsId).toBe(wsBid);

    // Route a patch via historyId — should land on ws-A despite B
    // being active. This is the contract `process:progress` events
    // depend on (each task carries its recordId, not the active tab).
    let routed = false;
    act(() => {
      routed = result.current.patchByHistoryId('rec-A', { url: 'https://routed.test/x' });
    });

    expect(routed).toBe(true);
    const a = result.current.workspaces.find((w) => w.id === wsA.id)!;
    expect(a.url).toBe('https://routed.test/x');
    // ws-B unchanged.
    const b = result.current.workspaces.find((w) => w.id === wsBid)!;
    expect(b.url).toBe('');
  });

  it('patchByHistoryId returns false when no workspace owns the recordId', () => {
    const { result } = renderHook(() => useWorkspaces());
    let routed = true;
    act(() => {
      routed = result.current.patchByHistoryId('rec-nonexistent', { url: 'noop' });
    });
    expect(routed).toBe(false);
  });

  it('close(wsId) on an in-flight sniff calls cancelSniff({ sessionId }) — R-WS-90 P2 contract', () => {
    const cancelSniff = vi.fn(async () => undefined);
    (window as unknown as { giftk: { cancelSniff: typeof cancelSniff } }).giftk = { cancelSniff };

    const { result } = renderHook(() => useWorkspaces());
    const wsA = result.current.workspaces[0];

    // Mark ws-A as sniffing with a known sessionId.
    act(() => {
      result.current.patchById(wsA.id, { sniffing: true, sniffSessionId: 'sid-AAA' });
    });

    // Open ws-B so close(wsA) doesn't trigger the "last tab" reseed
    // path (which is tested separately).
    act(() => { result.current.openNew(); });

    act(() => { result.current.close(wsA.id); });

    expect(cancelSniff).toHaveBeenCalledTimes(1);
    expect(cancelSniff).toHaveBeenCalledWith({ sessionId: 'sid-AAA' });
  });

  it('close(wsId) when sniffing=false does NOT call cancelSniff', () => {
    const cancelSniff = vi.fn(async () => undefined);
    (window as unknown as { giftk: { cancelSniff: typeof cancelSniff } }).giftk = { cancelSniff };

    const { result } = renderHook(() => useWorkspaces());
    const wsA = result.current.workspaces[0];
    act(() => { result.current.openNew(); });

    act(() => { result.current.close(wsA.id); });
    expect(cancelSniff).not.toHaveBeenCalled();
  });

  it('close(wsId) when sniffSessionId is null does NOT call cancelSniff (legacy / already-finished)', () => {
    const cancelSniff = vi.fn(async () => undefined);
    (window as unknown as { giftk: { cancelSniff: typeof cancelSniff } }).giftk = { cancelSniff };

    const { result } = renderHook(() => useWorkspaces());
    const wsA = result.current.workspaces[0];
    act(() => {
      // sniffing is true but sessionId never got pinned (legacy
      // renderer path). close() must not crash and must not fire
      // cancelSniff with an undefined sessionId.
      result.current.patchById(wsA.id, { sniffing: true, sniffSessionId: null });
    });
    act(() => { result.current.openNew(); });

    act(() => { result.current.close(wsA.id); });
    expect(cancelSniff).not.toHaveBeenCalled();
  });

  it('close(lastTab) reseeds with a fresh blank workspace — home page never sees zero tabs', () => {
    const { result } = renderHook(() => useWorkspaces());
    const wsA = result.current.workspaces[0];

    act(() => { result.current.close(wsA.id); });

    expect(result.current.workspaces).toHaveLength(1);
    // The reseeded ws is fresh (different id from the closed one).
    expect(result.current.workspaces[0].id).not.toBe(wsA.id);
    expect(result.current.workspaces[0].url).toBe('');
    expect(result.current.workspaces[0].result).toBeNull();
  });

  it('close(non-active wsId) keeps the current active id unchanged', () => {
    const { result } = renderHook(() => useWorkspaces());
    const wsA = result.current.workspaces[0];
    let wsBid = '';
    act(() => { wsBid = result.current.openNew(); });
    expect(result.current.activeWsId).toBe(wsBid);

    // Close ws-A while ws-B is active — active stays on ws-B.
    act(() => { result.current.close(wsA.id); });

    expect(result.current.activeWsId).toBe(wsBid);
    expect(result.current.workspaces).toHaveLength(1);
  });

  it('switchTo(unknown id) is a no-op', () => {
    const { result } = renderHook(() => useWorkspaces());
    const before = result.current.activeWsId;
    act(() => { result.current.switchTo('does-not-exist'); });
    expect(result.current.activeWsId).toBe(before);
  });
});
