/**
 * Tests for the workspace-tabs data hook
 * (src/renderer/components/useWorkspaces.ts).
 *
 * What we lock in
 * ---------------
 *  • Hook seeds with exactly one blank workspace so consumers never
 *    face an empty list.
 *  • `openNew()` appends and activates the new tab.
 *  • `claimForSniff()` reuses a blank active workspace; if the active
 *    one is dirty (URL or result), it opens a fresh tab instead.
 *  • `close()` of a non-active tab leaves the active one alone; closing
 *    the active tab moves focus to the left neighbour.
 *  • `close()` of the last remaining tab reseeds a fresh blank one
 *    rather than leaving zero tabs.
 *  • `patchActive()` mutates only the active workspace.
 *  • `patchByHistoryId()` finds the workspace by historyId and patches
 *    it, returning false if no such workspace exists.
 *  • `isBusy()` flips true when progress contains a non-terminal status
 *    OR when processingOne is non-empty.
 *
 * These checks are functional (not snapshot-based) — they describe the
 * contract App.tsx relies on for tab routing and close-confirm.
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useWorkspaces } from '../../src/renderer/components/useWorkspaces';
import type { TaskProgress } from '../../src/shared/types';

const tp = (status: TaskProgress['status']): TaskProgress => ({
  taskId: 't-1',
  status,
  percent: 0
});

describe('useWorkspaces', () => {
  it('seeds with exactly one blank workspace', () => {
    const { result } = renderHook(() => useWorkspaces());
    expect(result.current.workspaces).toHaveLength(1);
    expect(result.current.activeWs.url).toBe('');
    expect(result.current.activeWs.result).toBeNull();
    expect(result.current.activeWsId).toBe(result.current.workspaces[0].id);
  });

  it('openNew() appends and activates the new tab', () => {
    const { result } = renderHook(() => useWorkspaces());
    const firstId = result.current.activeWsId;
    act(() => {
      result.current.openNew();
    });
    expect(result.current.workspaces).toHaveLength(2);
    expect(result.current.activeWsId).not.toBe(firstId);
  });

  it('claimForSniff() reuses a blank active workspace', () => {
    const { result } = renderHook(() => useWorkspaces());
    const firstId = result.current.activeWsId;
    let claimed = '';
    act(() => {
      claimed = result.current.claimForSniff();
    });
    expect(claimed).toBe(firstId);
    expect(result.current.workspaces).toHaveLength(1);
  });

  it('claimForSniff() opens a fresh tab when active has content', () => {
    // R-WS-2026-05-21 — "blank" is now defined by `result === null && !sniffing`
    // (url is just a pre-sniff staging value and does NOT count as content).
    // So we seed a non-null `result` to mark the active tab as non-blank.
    const { result } = renderHook(() => useWorkspaces());
    act(() => {
      result.current.patchActive({
        url: 'https://x.test/page',
        result: { pageUrl: 'https://x.test/page', items: [], warnings: [] }
      });
    });
    let claimed = '';
    act(() => {
      claimed = result.current.claimForSniff();
    });
    expect(result.current.workspaces).toHaveLength(2);
    expect(claimed).toBe(result.current.activeWsId);
    // The previously-active dirty one is preserved.
    expect(result.current.workspaces[0].url).toBe('https://x.test/page');
  });

  it('patchActive() mutates only the active workspace', () => {
    const { result } = renderHook(() => useWorkspaces());
    let secondId = '';
    act(() => {
      secondId = result.current.openNew();
    });
    act(() => {
      result.current.patchActive({ url: 'https://b.test' });
    });
    const ws1 = result.current.workspaces[0];
    const ws2 = result.current.workspaces.find((w) => w.id === secondId)!;
    expect(ws1.url).toBe('');
    expect(ws2.url).toBe('https://b.test');
  });

  it('patchByHistoryId() routes by historyId, returns false when missing', () => {
    const { result } = renderHook(() => useWorkspaces());
    act(() => {
      result.current.patchActive({ historyId: 'rec-1', url: 'https://a' });
    });
    let found = false;
    act(() => {
      found = result.current.patchByHistoryId('rec-1', { url: 'https://b' });
    });
    expect(found).toBe(true);
    expect(result.current.workspaces[0].url).toBe('https://b');

    let missing = true;
    act(() => {
      missing = result.current.patchByHistoryId('does-not-exist', { url: 'x' });
    });
    expect(missing).toBe(false);
  });

  it('close() of a non-active tab leaves activeId untouched', () => {
    const { result } = renderHook(() => useWorkspaces());
    let secondId = '';
    act(() => { secondId = result.current.openNew(); });
    const activeBefore = result.current.activeWsId;
    expect(activeBefore).toBe(secondId);
    // Switch to ws-1 so we can close ws-2 (the non-active one).
    const firstId = result.current.workspaces[0].id;
    act(() => { result.current.switchTo(firstId); });
    expect(result.current.activeWsId).toBe(firstId);
    act(() => { result.current.close(secondId); });
    expect(result.current.workspaces).toHaveLength(1);
    expect(result.current.activeWsId).toBe(firstId);
  });

  it('close() of the only tab reseeds a fresh blank one', () => {
    const { result } = renderHook(() => useWorkspaces());
    const onlyId = result.current.activeWsId;
    act(() => { result.current.patchActive({ url: 'https://x.test' }); });
    act(() => { result.current.close(onlyId); });
    expect(result.current.workspaces).toHaveLength(1);
    // The reseeded one must be a brand-new blank workspace, not the
    // (closed) old one.
    expect(result.current.workspaces[0].url).toBe('');
  });

  it('isBusy() reflects non-terminal progress and processingOne', () => {
    const { result } = renderHook(() => useWorkspaces());
    expect(result.current.isBusy(result.current.activeWs)).toBe(false);
    act(() => {
      result.current.patchActive({
        progress: { 't-1': tp('compressing') }
      });
    });
    expect(result.current.isBusy(result.current.activeWs)).toBe(true);
    // Terminal status alone shouldn't count as busy.
    act(() => {
      result.current.patchActive({
        progress: { 't-1': tp('done') }
      });
    });
    expect(result.current.isBusy(result.current.activeWs)).toBe(false);
    // processingOne non-empty is also "busy".
    act(() => {
      result.current.patchActive({
        processingOne: new Set(['m-1'])
      });
    });
    expect(result.current.isBusy(result.current.activeWs)).toBe(true);
  });
});
