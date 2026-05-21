/**
 * Tests for useEmbedResolve
 * (src/renderer/components/useEmbedResolve.ts).
 *
 * What we lock in
 * ---------------
 *  • Initial state: all three maps/sets are empty.
 *  • Success path: resolveEmbed is invoked, resolvedMap gains the entry,
 *    addSelected fires, patchItemResolved fires exactly once with
 *    `(id, resolved)` (this is the P1 #5 single-source double-write
 *    contract — the consumer is responsible for splitting it across
 *    patchHistory + setResult), resolvingSet drains, two log lines
 *    are appended.
 *  • Failure path: a 'YT_DLP_UNAVAILABLE' error surfaces a friendly
 *    Chinese message in resolveErrorMap, resolvingSet drains, a
 *    "失败" log line is appended.
 *  • Guards (a): unknown id / already-resolved / currently-resolving
 *    skip the resolveEmbed call entirely.
 *  • Guards (b): items with requiresExternalDownload === false are
 *    skipped (the hook is for embeds only).
 *  • Auto-trigger: when `result` flips from null → populated, the
 *    effect fires resolveEmbed for every pending embed.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  useEmbedResolve,
  type EmbedResolveDeps
} from '../../src/renderer/components/useEmbedResolve';
import type { ResolvedMedia, SniffResult, SniffedMedia } from '../../src/shared/types';

const makeEmbed = (id: string, overrides: Partial<SniffedMedia> = {}): SniffedMedia => ({
  id,
  url: `https://embed.test/${id}`,
  kind: 'video',
  source: 'iframe-embed',
  pageUrl: 'https://host.test/page',
  requiresExternalDownload: true,
  embedHost: 'vimeo.com',
  ...overrides
});

const makeResolved = (overrides: Partial<ResolvedMedia> = {}): ResolvedMedia => ({
  url: 'https://cdn.test/stream.mp4',
  source: 'ytdlp',
  qualityLabel: '1080p',
  width: 1920,
  height: 1080,
  extractor: 'vimeo',
  ...overrides
});

const makeResult = (items: SniffedMedia[]): SniffResult => ({
  pageUrl: 'https://host.test/page',
  items,
  warnings: []
});

interface DepsHandles {
  deps: EmbedResolveDeps;
  resolveEmbed: ReturnType<typeof vi.fn>;
  appendLog: ReturnType<typeof vi.fn>;
  addSelected: ReturnType<typeof vi.fn>;
  patchItemResolved: ReturnType<typeof vi.fn>;
}

const makeDeps = (
  items: SniffedMedia[],
  result: SniffResult | null,
  resolveImpl: (m: SniffedMedia) => Promise<ResolvedMedia> = async () => makeResolved()
): DepsHandles => {
  const resolveEmbed = vi.fn(resolveImpl);
  const appendLog = vi.fn();
  const addSelected = vi.fn();
  const patchItemResolved = vi.fn();
  return {
    resolveEmbed,
    appendLog,
    addSelected,
    patchItemResolved,
    deps: {
      items,
      result,
      resolveEmbed,
      appendLog,
      addSelected,
      patchItemResolved
    }
  };
};

describe('useEmbedResolve', () => {
  it('initial state has empty resolvedMap / resolvingSet / resolveErrorMap', () => {
    const { deps } = makeDeps([], null);
    const { result } = renderHook(() => useEmbedResolve(deps));
    expect(result.current.resolvedMap).toEqual({});
    expect(result.current.resolvingSet.size).toBe(0);
    expect(result.current.resolveErrorMap).toEqual({});
    expect(result.current.isResolving('anything')).toBe(false);
  });

  it('success path: resolves, auto-selects, double-writes via patchItemResolved, logs twice', async () => {
    const item = makeEmbed('e1');
    const resolved = makeResolved({ qualityLabel: '720p', width: 1280, height: 720, extractor: 'vimeo' });
    const handles = makeDeps([item], null, async () => resolved);
    const { result } = renderHook(() => useEmbedResolve(handles.deps));

    await act(async () => {
      await result.current.onResolveEmbedById('e1');
    });

    expect(handles.resolveEmbed).toHaveBeenCalledTimes(1);
    expect(handles.resolveEmbed).toHaveBeenCalledWith(item);
    expect(result.current.resolvedMap).toEqual({ e1: resolved });
    // P1 (#5) — single double-write callback fires exactly once with (id, resolved).
    expect(handles.patchItemResolved).toHaveBeenCalledTimes(1);
    expect(handles.patchItemResolved).toHaveBeenCalledWith('e1', resolved);
    // Auto-select fires.
    expect(handles.addSelected).toHaveBeenCalledWith('e1');
    // resolvingSet drained on finally.
    expect(result.current.resolvingSet.size).toBe(0);
    expect(result.current.isResolving('e1')).toBe(false);
    // Two log lines: kickoff + success.
    expect(handles.appendLog.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(handles.appendLog.mock.calls[0][0]).toContain('[resolve] vimeo.com');
    const successLine = handles.appendLog.mock.calls.find((c) => String(c[0]).includes('✓'));
    expect(successLine?.[0]).toContain('720p');
    expect(successLine?.[0]).toContain('1280x720');
    expect(successLine?.[0]).toContain('vimeo');
  });

  it('failure path: YT_DLP_UNAVAILABLE maps to Chinese hint, errorMap populated, resolvingSet drains, logs failure', async () => {
    const item = makeEmbed('e2');
    const handles = makeDeps([item], null, async () => {
      throw new Error('YT_DLP_UNAVAILABLE');
    });
    const { result } = renderHook(() => useEmbedResolve(handles.deps));

    await act(async () => {
      await result.current.onResolveEmbedById('e2');
    });

    expect(result.current.resolvedMap).toEqual({});
    expect(result.current.resolveErrorMap.e2).toContain('yt-dlp 不可用');
    expect(result.current.resolvingSet.size).toBe(0);
    // patchItemResolved must NOT fire on failure.
    expect(handles.patchItemResolved).not.toHaveBeenCalled();
    expect(handles.addSelected).not.toHaveBeenCalled();
    const failLine = handles.appendLog.mock.calls.find((c) => String(c[0]).includes('失败'));
    expect(failLine).toBeDefined();
    expect(failLine?.[0]).toContain('yt-dlp 不可用');
  });

  it('guards: unknown id / already-resolved / currently-resolving short-circuit before calling resolveEmbed', async () => {
    const item = makeEmbed('e3');
    const handles = makeDeps([item], null, async () => makeResolved());
    const { result } = renderHook(() => useEmbedResolve(handles.deps));

    // Unknown id.
    await act(async () => {
      await result.current.onResolveEmbedById('nope');
    });
    expect(handles.resolveEmbed).not.toHaveBeenCalled();

    // Resolve once successfully.
    await act(async () => {
      await result.current.onResolveEmbedById('e3');
    });
    expect(handles.resolveEmbed).toHaveBeenCalledTimes(1);

    // Already-resolved → no second call.
    await act(async () => {
      await result.current.onResolveEmbedById('e3');
    });
    expect(handles.resolveEmbed).toHaveBeenCalledTimes(1);

    // Currently-resolving guard: hold the resolver promise open and
    // dispatch a second call before it settles.
    const item4 = makeEmbed('e4');
    let release: (v: ResolvedMedia) => void = () => undefined;
    const slow = new Promise<ResolvedMedia>((res) => { release = res; });
    const handles2 = makeDeps([item4], null, () => slow);
    const { result: r2 } = renderHook(() => useEmbedResolve(handles2.deps));

    let firstCall: Promise<void> = Promise.resolve();
    act(() => {
      firstCall = r2.current.onResolveEmbedById('e4');
    });
    // Second call while first is in flight — should bail at the
    // resolvingSet.has(id) guard without invoking resolveEmbed again.
    await act(async () => {
      await r2.current.onResolveEmbedById('e4');
    });
    expect(handles2.resolveEmbed).toHaveBeenCalledTimes(1);

    await act(async () => {
      release(makeResolved());
      await firstCall;
    });
  });

  it('guards: items with requiresExternalDownload === false are skipped', async () => {
    const item = makeEmbed('e5', { requiresExternalDownload: false });
    const handles = makeDeps([item], null);
    const { result } = renderHook(() => useEmbedResolve(handles.deps));

    await act(async () => {
      await result.current.onResolveEmbedById('e5');
    });
    expect(handles.resolveEmbed).not.toHaveBeenCalled();
    expect(result.current.resolvedMap).toEqual({});
  });

  it('auto-trigger: when result populates, resolveEmbed fires for every pending embed', async () => {
    const a = makeEmbed('a');
    const b = makeEmbed('b');
    const c = makeEmbed('c', { requiresExternalDownload: false }); // not an embed
    const items = [a, b, c];
    const handles = makeDeps(items, null, async (m) => makeResolved({ extractor: m.id }));

    const { rerender } = renderHook(
      (props: { result: SniffResult | null }) =>
        useEmbedResolve({ ...handles.deps, items, result: props.result }),
      { initialProps: { result: null } }
    );

    // No auto-fire yet.
    expect(handles.resolveEmbed).not.toHaveBeenCalled();

    // Flip result → populated.
    rerender({ result: makeResult(items) });

    // The effect schedules calls synchronously; the resolver itself is
    // async. Wait for both embeds to land.
    await waitFor(() => {
      expect(handles.resolveEmbed).toHaveBeenCalledTimes(2);
    });
    const calledIds = handles.resolveEmbed.mock.calls.map((c) => (c[0] as SniffedMedia).id).sort();
    expect(calledIds).toEqual(['a', 'b']);
  });

  it('reset() clears all three overlays atomically', async () => {
    // Build a state with a successful resolve AND an in-flight error
    // so we can assert the reset wipes both. We don't need to mutate
    // resolvingSet directly; the entry is enough to prove the contract.
    const item = makeEmbed('rst');
    const handles = makeDeps([item], null, async () => makeResolved({ qualityLabel: '480p' }));
    const { result } = renderHook(() => useEmbedResolve(handles.deps));

    // Seed resolvedMap via the success path.
    await act(async () => {
      await result.current.onResolveEmbedById('rst');
    });
    expect(Object.keys(result.current.resolvedMap)).toEqual(['rst']);

    act(() => {
      result.current.reset();
    });
    expect(result.current.resolvedMap).toEqual({});
    expect(result.current.resolvingSet.size).toBe(0);
    expect(result.current.resolveErrorMap).toEqual({});
  });
});
