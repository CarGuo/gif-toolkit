/**
 * R-TB-CHAIN-V2 Phase 2.1 — useToolboxLineage unit tests.
 *
 * The lineage hook is the renderer-side state model for the
 * progressive (one-step-at-a-time) toolbox chain. The user keeps
 * picking the next kind based on what came out of the previous
 * step, like ezgif's "edit further" flow.
 *
 * We cover (≥10 cases):
 *   1. reset(inputPath) seeds a single root node and focusIndex=0.
 *   2. nextKindOptions on a .gif root excludes video-to-* kinds.
 *   3. nextKindOptions on an .mp4 root includes only video-to-* kinds.
 *   4. runNextStep before reset rejects with a clear error.
 *   5. runNextStep happy path: appends a derived node, focuses it,
 *      records params/kind/chainId.
 *   6. runNextStep concurrency: a second call while the first is
 *      in-flight rejects with "step already running" and does not
 *      issue a second IPC.
 *   7. runNextStep failure terminal emit rejects the promise,
 *      surfaces error, and does NOT mutate the lineage.
 *   8. cancel() invokes cancelToolboxChain with the in-flight id
 *      and rejects the pending runNextStep promise.
 *   9. focusNode(prev) + runNextStep BRANCHES — the abandoned tail
 *      is dropped, the new node lands at branchFromIndex+1.
 *  10. Foreign progress emits (different chainId) are ignored —
 *      lineage stays unchanged.
 *  11. After two successful steps, nextKindOptions reflects the
 *      latest (focused) node's path extension.
 *  12. reset() while a step is in-flight rejects the pending promise
 *      with the abandon message and clears state.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { TaskProgress } from '../../src/shared/types';
import { useToolboxLineage } from '../../src/renderer/components/useToolboxLineage';

type ProgressListener = (p: TaskProgress) => void;

interface FakeBridge {
  onProgress: (cb: ProgressListener) => () => void;
  startToolboxChain: ReturnType<typeof vi.fn>;
  cancelToolboxChain: ReturnType<typeof vi.fn>;
  __emit: (p: TaskProgress) => void;
}

function installBridge(): FakeBridge {
  const listeners: ProgressListener[] = [];
  const fake: FakeBridge = {
    onProgress: (cb) => {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    startToolboxChain: vi.fn(async (payload: { chainId: string }) => ({
      ok: true, chainId: payload.chainId, outputDir: '/tmp/x'
    })),
    cancelToolboxChain: vi.fn(async () => ({ ok: true })),
    __emit: (p) => { for (const l of listeners.slice()) l(p); }
  };
  (window as unknown as { giftk: FakeBridge }).giftk = fake;
  return fake;
}

beforeEach(() => {
  delete (window as unknown as { giftk?: unknown }).giftk;
  vi.restoreAllMocks();
});

describe('useToolboxLineage', () => {
  it('reset seeds a single root node at focusIndex=0', () => {
    installBridge();
    const { result } = renderHook(() => useToolboxLineage());
    act(() => { result.current.reset('/in/clip.mp4'); });
    expect(result.current.nodes).toHaveLength(1);
    expect(result.current.nodes[0]).toMatchObject({
      nodeId: 'root', path: '/in/clip.mp4', kind: null, chainId: null
    });
    expect(result.current.focusIndex).toBe(0);
    expect(result.current.focus?.path).toBe('/in/clip.mp4');
  });

  it('nextKindOptions on .gif excludes video-to-* kinds', () => {
    installBridge();
    const { result } = renderHook(() => useToolboxLineage());
    act(() => { result.current.reset('/in/anim.gif'); });
    expect(result.current.nextKindOptions).not.toContain('video-to-gif');
    expect(result.current.nextKindOptions).not.toContain('video-to-webp');
    expect(result.current.nextKindOptions).toContain('gif-resize');
    expect(result.current.nextKindOptions).toContain('gif-optimize');
    expect(result.current.nextKindOptions).toContain('crop');
    expect(result.current.nextKindOptions).toContain('gif-webp-convert');
  });

  it('nextKindOptions on .mp4 contains only video-to-* kinds', () => {
    installBridge();
    const { result } = renderHook(() => useToolboxLineage());
    act(() => { result.current.reset('/in/clip.mp4'); });
    expect(result.current.nextKindOptions.slice().sort())
      .toEqual(['video-to-gif', 'video-to-webp']);
  });

  it('runNextStep before reset rejects with helpful error', async () => {
    installBridge();
    const { result } = renderHook(() => useToolboxLineage());
    await act(async () => {
      await expect(
        result.current.runNextStep('gif-resize', { width: 320 })
      ).rejects.toThrow(/lineage not initialised/);
    });
    expect(typeof result.current.error).toBe('string');
    expect(result.current.error).toMatch(/lineage not initialised/);
  });

  it('happy path: runNextStep appends a derived node and focuses it', async () => {
    const bridge = installBridge();
    const { result } = renderHook(() => useToolboxLineage());
    act(() => { result.current.reset('/in/clip.mp4'); });

    let runPromise!: Promise<unknown>;
    act(() => {
      runPromise = result.current.runNextStep('video-to-gif', { fps: 12 });
    });
    await waitFor(() => {
      expect(bridge.startToolboxChain).toHaveBeenCalledTimes(1);
    });
    const callArg = bridge.startToolboxChain.mock.calls[0][0] as {
      chainId: string; inputPath: string;
      steps: Array<{ id: string; kind: string }>;
    };
    expect(callArg.inputPath).toBe('/in/clip.mp4');
    expect(callArg.steps).toHaveLength(1);
    expect(callArg.steps[0].kind).toBe('video-to-gif');
    expect(callArg.steps[0].id).toBe(`${callArg.chainId}-s1`);
    expect(result.current.isRunning).toBe(true);

    act(() => {
      bridge.__emit({
        taskId: `${callArg.chainId}-s1`,
        status: 'done',
        percent: 100,
        outputs: ['/out/clip.gif']
      });
    });
    await act(async () => { await runPromise; });

    expect(result.current.nodes).toHaveLength(2);
    expect(result.current.nodes[1]).toMatchObject({
      kind: 'video-to-gif',
      path: '/out/clip.gif',
      params: { fps: 12 },
      chainId: callArg.chainId
    });
    expect(result.current.focusIndex).toBe(1);
    expect(result.current.isRunning).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('rejects a concurrent runNextStep with "step already running"', async () => {
    const bridge = installBridge();
    const { result } = renderHook(() => useToolboxLineage());
    act(() => { result.current.reset('/in/clip.mp4'); });

    let firstP!: Promise<unknown>;
    act(() => {
      firstP = result.current.runNextStep('video-to-gif', { fps: 12 });
    });
    await waitFor(() => expect(bridge.startToolboxChain).toHaveBeenCalledTimes(1));
    // attempt a second concurrent run — must be rejected synchronously.
    // Wrap in act() because the synchronous setError that the hook
    // performs before throwing schedules a React state update.
    await act(async () => {
      await expect(
        result.current.runNextStep('video-to-webp', {})
      ).rejects.toThrow(/already running/);
    });
    expect(bridge.startToolboxChain).toHaveBeenCalledTimes(1);

    // Drain the first one so the test doesn't leak a pending promise.
    const firstCall = bridge.startToolboxChain.mock.calls[0][0] as { chainId: string };
    act(() => {
      bridge.__emit({
        taskId: `${firstCall.chainId}-s1`,
        status: 'done',
        percent: 100,
        outputs: ['/out/x.gif']
      });
    });
    await act(async () => { await firstP; });
  });

  it('failure terminal emit rejects and does not mutate the lineage', async () => {
    const bridge = installBridge();
    const { result } = renderHook(() => useToolboxLineage());
    act(() => { result.current.reset('/in/clip.mp4'); });

    let runP!: Promise<unknown>;
    act(() => {
      runP = result.current.runNextStep('video-to-gif', { fps: 12 });
    });
    await waitFor(() => expect(bridge.startToolboxChain).toHaveBeenCalledTimes(1));
    const arg = bridge.startToolboxChain.mock.calls[0][0] as { chainId: string };

    act(() => {
      bridge.__emit({
        taskId: `${arg.chainId}-s1`,
        status: 'failed',
        percent: 0,
        error: 'ffmpeg blew up'
      });
    });
    await expect(runP).rejects.toThrow(/ffmpeg blew up/);
    expect(result.current.nodes).toHaveLength(1);
    expect(result.current.focusIndex).toBe(0);
    expect(result.current.error).toMatch(/ffmpeg blew up/);
    expect(result.current.isRunning).toBe(false);
  });

  it('cancel() addresses the in-flight chainId and rejects the pending promise', async () => {
    const bridge = installBridge();
    const { result } = renderHook(() => useToolboxLineage());
    act(() => { result.current.reset('/in/clip.mp4'); });

    let runP!: Promise<unknown>;
    act(() => {
      runP = result.current.runNextStep('video-to-gif', { fps: 12 });
    });
    // Pre-attach a swallowing handler so the (eventual) rejection
    // raised synchronously by cancel() doesn't trip Vitest's unhandled
    // rejection tracker before our `expect(runP).rejects` arrives.
    const tail = runP.catch((e: Error) => e);
    await waitFor(() => expect(bridge.startToolboxChain).toHaveBeenCalledTimes(1));
    const arg = bridge.startToolboxChain.mock.calls[0][0] as { chainId: string };

    await act(async () => { await result.current.cancel(); });
    expect(bridge.cancelToolboxChain).toHaveBeenCalledWith(arg.chainId);
    const err = await tail;
    expect((err as Error).message).toMatch(/cancelled/);
    expect(result.current.isRunning).toBe(false);
    expect(result.current.nodes).toHaveLength(1);
  });

  it('focusNode(prev) then runNextStep BRANCHES off the focused node and drops the abandoned tail', async () => {
    const bridge = installBridge();
    const { result } = renderHook(() => useToolboxLineage());
    act(() => { result.current.reset('/in/clip.mp4'); });

    // step 1: clip.mp4 -> step1.gif
    let p1!: Promise<unknown>;
    act(() => { p1 = result.current.runNextStep('video-to-gif', { fps: 12 }); });
    await waitFor(() => expect(bridge.startToolboxChain).toHaveBeenCalledTimes(1));
    const c1 = bridge.startToolboxChain.mock.calls[0][0] as { chainId: string };
    act(() => {
      bridge.__emit({
        taskId: `${c1.chainId}-s1`, status: 'done', percent: 100,
        outputs: ['/out/step1.gif']
      });
    });
    await act(async () => { await p1; });

    // step 2: step1.gif -> step2.gif
    let p2!: Promise<unknown>;
    act(() => { p2 = result.current.runNextStep('gif-resize', { width: 320 }); });
    await waitFor(() => expect(bridge.startToolboxChain).toHaveBeenCalledTimes(2));
    const c2 = bridge.startToolboxChain.mock.calls[1][0] as { chainId: string };
    act(() => {
      bridge.__emit({
        taskId: `${c2.chainId}-s1`, status: 'done', percent: 100,
        outputs: ['/out/step2.gif']
      });
    });
    await act(async () => { await p2; });
    expect(result.current.nodes).toHaveLength(3);
    expect(result.current.focusIndex).toBe(2);

    // user goes back to step1.gif (index 1) and branches into a different kind
    act(() => { result.current.focusNode('n1'); });
    expect(result.current.focusIndex).toBe(1);
    // tail still visible in lineage UNTIL the branch actually fires;
    // see the V2 spec note on "abandoned tail dropped on branch".

    let p3!: Promise<unknown>;
    act(() => { p3 = result.current.runNextStep('gif-optimize', {}); });
    await waitFor(() => expect(bridge.startToolboxChain).toHaveBeenCalledTimes(3));
    const c3 = bridge.startToolboxChain.mock.calls[2][0] as { chainId: string; inputPath: string };
    expect(c3.inputPath).toBe('/out/step1.gif');
    act(() => {
      bridge.__emit({
        taskId: `${c3.chainId}-s1`, status: 'done', percent: 100,
        outputs: ['/out/step1-opt.gif']
      });
    });
    await act(async () => { await p3; });

    // After branch: lineage = [root, n1 (step1.gif), <new> (step1-opt.gif)]
    expect(result.current.nodes).toHaveLength(3);
    expect(result.current.nodes[2].path).toBe('/out/step1-opt.gif');
    expect(result.current.nodes[2].kind).toBe('gif-optimize');
    expect(result.current.focusIndex).toBe(2);
  });

  it('foreign progress emits (different chainId) are ignored', async () => {
    const bridge = installBridge();
    const { result } = renderHook(() => useToolboxLineage());
    act(() => { result.current.reset('/in/clip.mp4'); });

    let runP!: Promise<unknown>;
    act(() => { runP = result.current.runNextStep('video-to-gif', { fps: 12 }); });
    await waitFor(() => expect(bridge.startToolboxChain).toHaveBeenCalledTimes(1));

    // Emit a stray 'done' from an unrelated chainId — must NOT settle our promise.
    act(() => {
      bridge.__emit({
        taskId: 'someother-chain-s1', status: 'done', percent: 100,
        outputs: ['/out/foreign.gif']
      });
    });
    expect(result.current.isRunning).toBe(true);
    expect(result.current.nodes).toHaveLength(1);

    // Now drain the real one.
    const arg = bridge.startToolboxChain.mock.calls[0][0] as { chainId: string };
    act(() => {
      bridge.__emit({
        taskId: `${arg.chainId}-s1`, status: 'done', percent: 100,
        outputs: ['/out/real.gif']
      });
    });
    await act(async () => { await runP; });
    expect(result.current.nodes).toHaveLength(2);
    expect(result.current.nodes[1].path).toBe('/out/real.gif');
  });

  it('nextKindOptions follows the focused node after each successful step', async () => {
    const bridge = installBridge();
    const { result } = renderHook(() => useToolboxLineage());
    act(() => { result.current.reset('/in/clip.mp4'); });
    expect(result.current.nextKindOptions.slice().sort())
      .toEqual(['video-to-gif', 'video-to-webp']);

    let p1!: Promise<unknown>;
    act(() => { p1 = result.current.runNextStep('video-to-gif', { fps: 12 }); });
    await waitFor(() => expect(bridge.startToolboxChain).toHaveBeenCalledTimes(1));
    const c1 = bridge.startToolboxChain.mock.calls[0][0] as { chainId: string };
    act(() => {
      bridge.__emit({
        taskId: `${c1.chainId}-s1`, status: 'done', percent: 100,
        outputs: ['/out/clip.gif']
      });
    });
    await act(async () => { await p1; });

    // Now focused on a .gif — video-to-* must drop out.
    expect(result.current.nextKindOptions).not.toContain('video-to-gif');
    expect(result.current.nextKindOptions).not.toContain('video-to-webp');
    expect(result.current.nextKindOptions).toContain('gif-resize');
    expect(result.current.nextKindOptions).toContain('crop');
  });

  it('reset() while a step is in-flight rejects the pending promise', async () => {
    const bridge = installBridge();
    const { result } = renderHook(() => useToolboxLineage());
    act(() => { result.current.reset('/in/clip.mp4'); });

    let runP!: Promise<unknown>;
    act(() => { runP = result.current.runNextStep('video-to-gif', { fps: 12 }); });
    const tail = runP.catch((e: Error) => e);
    await waitFor(() => expect(bridge.startToolboxChain).toHaveBeenCalledTimes(1));

    act(() => { result.current.reset('/in/other.mp4'); });
    const err = await tail;
    expect((err as Error).message).toMatch(/abandoned/);
    expect(result.current.nodes).toHaveLength(1);
    expect(result.current.nodes[0].path).toBe('/in/other.mp4');
    expect(result.current.isRunning).toBe(false);
  });
});
