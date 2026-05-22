/**
 * R-TB-CHAIN Phase 2.1 — useToolboxChain hook unit tests.
 *
 * Coverage matrix
 * ---------------
 * 1. Initial state: no chain, no steps, isRunning=false.
 * 2. start() rejects when bridge / inputPath / drafts are missing.
 * 3. start() allocates deterministic step ids (`${chainId}-s${i+1}`),
 *    flips isRunning=true, and surfaces outputDir from the bridge
 *    response.
 * 4. progress events for foreign taskIds are ignored.
 * 5. per-step progress events update steps[i].progress and toggle
 *    `settled` on terminal status.
 * 6. 'awaiting-input' populates `awaitingInput`, does NOT mark the
 *    step settled, and carries the previous-step output.
 * 7. resume() translates 1-based emit stepIndex to 0-based IPC,
 *    clears awaitingInput, and forwards the patch to the bridge.
 * 8. resume() with no active pause returns ok=false without IPC.
 * 9. terminal step 'done' on stepIndex===totalSteps flips
 *    finalStatus='done' and isRunning=false.
 * 10. step 'failed' captures error string + finalStatus='failed' +
 *     isRunning=false.
 * 11. cancel() invokes bridge and forces finalStatus='cancelled'.
 * 12. reset() returns the hook to initial state without invoking
 *     the bridge.
 * 13. defensive: start() rejects a second concurrent invocation.
 *
 * The hook subscribes to `process:progress` once on mount; we use
 * the same `__emit` shim that useToolbox tests use to drive events.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useToolboxChain } from '../../src/renderer/components/useToolboxChain';
import type {
  ChainStepDraft,
  TaskProgress,
  ToolboxChainStartResult
} from '../../src/shared/types';

type ProgressListener = (p: TaskProgress) => void;

interface FakeGiftk {
  onProgress: (cb: ProgressListener) => () => void;
  startToolboxChain: ReturnType<typeof vi.fn>;
  resumeToolboxChain: ReturnType<typeof vi.fn>;
  cancelToolboxChain: ReturnType<typeof vi.fn>;
  __emit: (p: TaskProgress) => void;
}

function installFakeGiftk(): FakeGiftk {
  const listeners: ProgressListener[] = [];
  const fake: FakeGiftk = {
    onProgress: (cb) => {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    startToolboxChain: vi.fn(
      async (payload: { chainId: string }): Promise<ToolboxChainStartResult> => ({
        ok: true,
        chainId: payload.chainId,
        outputDir: `/tmp/toolbox/chain-2026/${payload.chainId}`
      })
    ),
    resumeToolboxChain: vi.fn(async () => ({ ok: true })),
    cancelToolboxChain: vi.fn(async () => ({ ok: true })),
    __emit: (p) => listeners.forEach((l) => l(p))
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).giftk = fake as any;
  return fake;
}

function draft(draftId: string, kind: ChainStepDraft['kind']): ChainStepDraft {
  return { draftId, kind, params: {}, valid: true };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useToolboxChain (R-TB-CHAIN Phase 2.1)', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).giftk;
  });

  it('returns sensible initial state with no chain', () => {
    installFakeGiftk();
    const { result } = renderHook(() => useToolboxChain());
    expect(result.current.chainId).toBeNull();
    expect(result.current.steps).toEqual([]);
    expect(result.current.isRunning).toBe(false);
    expect(result.current.finalStatus).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.awaitingInput).toBeNull();
    expect(result.current.outputDir).toBeNull();
  });

  it('start() rejects without a bridge', async () => {
    // Don't install giftk.
    const { result } = renderHook(() => useToolboxChain());
    await act(async () => {
      const r = await result.current.start({
        inputPath: '/in.gif',
        drafts: [draft('d1', 'gif-optimize')]
      });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/bridge unavailable/);
    });
    expect(result.current.isRunning).toBe(false);
  });

  it('start() rejects empty inputPath / drafts', async () => {
    installFakeGiftk();
    const { result } = renderHook(() => useToolboxChain());
    await act(async () => {
      expect(
        (await result.current.start({ inputPath: '', drafts: [draft('d1', 'gif-optimize')] })).ok
      ).toBe(false);
      expect(
        (await result.current.start({ inputPath: '/in.gif', drafts: [] })).ok
      ).toBe(false);
    });
  });

  it('start() allocates deterministic step ids and flips isRunning', async () => {
    const fake = installFakeGiftk();
    const { result } = renderHook(() => useToolboxChain());
    await act(async () => {
      const r = await result.current.start({
        inputPath: '/in.gif',
        drafts: [draft('d1', 'gif-optimize'), draft('d2', 'crop')]
      });
      expect(r.ok).toBe(true);
      expect(r.chainId).toBeDefined();
    });
    expect(result.current.isRunning).toBe(true);
    expect(result.current.steps).toHaveLength(2);
    const cid = result.current.chainId!;
    expect(result.current.steps[0].id).toBe(`${cid}-s1`);
    expect(result.current.steps[1].id).toBe(`${cid}-s2`);
    expect(result.current.outputDir).toContain(cid);
    expect(fake.startToolboxChain).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: cid,
        inputPath: '/in.gif',
        steps: [
          expect.objectContaining({ id: `${cid}-s1`, kind: 'gif-optimize' }),
          expect.objectContaining({ id: `${cid}-s2`, kind: 'crop' })
        ]
      })
    );
  });

  it('ignores progress for foreign taskIds', async () => {
    const fake = installFakeGiftk();
    const { result } = renderHook(() => useToolboxChain());
    await act(async () => {
      await result.current.start({
        inputPath: '/in.gif',
        drafts: [draft('d1', 'gif-optimize')]
      });
    });
    act(() => {
      fake.__emit({
        taskId: 'someone-elses-task',
        status: 'done',
        percent: 100,
        stepIndex: 1,
        totalSteps: 1
      });
    });
    expect(result.current.steps[0].progress).toBeUndefined();
    expect(result.current.steps[0].settled).toBe(false);
    expect(result.current.finalStatus).toBeNull();
    expect(result.current.isRunning).toBe(true);
  });

  it('per-step progress updates the step view and settles on done', async () => {
    const fake = installFakeGiftk();
    const { result } = renderHook(() => useToolboxChain());
    await act(async () => {
      await result.current.start({
        inputPath: '/in.gif',
        drafts: [draft('d1', 'gif-optimize'), draft('d2', 'gif-resize')]
      });
    });
    const cid = result.current.chainId!;
    act(() => {
      fake.__emit({
        taskId: `${cid}-s1`,
        status: 'compressing',
        percent: 50,
        stepIndex: 1,
        totalSteps: 2
      });
    });
    expect(result.current.steps[0].progress?.percent).toBe(50);
    expect(result.current.steps[0].settled).toBe(false);

    act(() => {
      fake.__emit({
        taskId: `${cid}-s1`,
        status: 'done',
        percent: 100,
        stepIndex: 1,
        totalSteps: 2,
        outputs: ['/tmp/out1.gif']
      });
    });
    // Step 1 is settled, but the chain is not done yet (step 1 != total).
    expect(result.current.steps[0].settled).toBe(true);
    expect(result.current.finalStatus).toBeNull();
    expect(result.current.isRunning).toBe(true);
  });

  it('awaiting-input populates the pause window without settling the step', async () => {
    const fake = installFakeGiftk();
    const { result } = renderHook(() => useToolboxChain());
    await act(async () => {
      await result.current.start({
        inputPath: '/in.gif',
        drafts: [draft('d1', 'gif-optimize'), draft('d2', 'crop')]
      });
    });
    const cid = result.current.chainId!;
    act(() => {
      fake.__emit({
        taskId: `${cid}-s2`,
        status: 'awaiting-input',
        percent: 0,
        stepIndex: 2,
        totalSteps: 2,
        outputs: ['/tmp/step1.gif']
      });
    });
    expect(result.current.awaitingInput).toEqual({
      stepIndex: 2,
      totalSteps: 2,
      stepId: `${cid}-s2`,
      previousOutput: '/tmp/step1.gif'
    });
    expect(result.current.steps[1].settled).toBe(false);
    expect(result.current.isRunning).toBe(true);
  });

  it('resume() translates 1-based emit to 0-based IPC and clears the pause', async () => {
    const fake = installFakeGiftk();
    const { result } = renderHook(() => useToolboxChain());
    await act(async () => {
      await result.current.start({
        inputPath: '/in.gif',
        drafts: [draft('d1', 'gif-optimize'), draft('d2', 'crop')]
      });
    });
    const cid = result.current.chainId!;
    act(() => {
      fake.__emit({
        taskId: `${cid}-s2`,
        status: 'awaiting-input',
        percent: 0,
        stepIndex: 2,
        totalSteps: 2,
        outputs: ['/tmp/step1.gif']
      });
    });
    await act(async () => {
      const r = await result.current.resume({ cropX: 5, cropY: 5, cropW: 100, cropH: 80 });
      expect(r.ok).toBe(true);
    });
    expect(fake.resumeToolboxChain).toHaveBeenCalledWith(
      cid,
      1, // 0-based: emit was stepIndex=2 → IPC stepIndex=1
      { cropX: 5, cropY: 5, cropW: 100, cropH: 80 }
    );
    expect(result.current.awaitingInput).toBeNull();
  });

  it('resume() with no active pause returns ok=false without IPC', async () => {
    const fake = installFakeGiftk();
    const { result } = renderHook(() => useToolboxChain());
    await act(async () => {
      await result.current.start({
        inputPath: '/in.gif',
        drafts: [draft('d1', 'crop')]
      });
    });
    await act(async () => {
      const r = await result.current.resume({ cropX: 1 });
      expect(r.ok).toBe(false);
    });
    expect(fake.resumeToolboxChain).not.toHaveBeenCalled();
  });

  it("terminal 'done' on the last step flips finalStatus and isRunning", async () => {
    const fake = installFakeGiftk();
    const { result } = renderHook(() => useToolboxChain());
    await act(async () => {
      await result.current.start({
        inputPath: '/in.gif',
        drafts: [draft('d1', 'gif-optimize'), draft('d2', 'gif-resize')]
      });
    });
    const cid = result.current.chainId!;
    act(() => {
      fake.__emit({ taskId: `${cid}-s1`, status: 'done', percent: 100, stepIndex: 1, totalSteps: 2 });
      fake.__emit({ taskId: `${cid}-s2`, status: 'done', percent: 100, stepIndex: 2, totalSteps: 2 });
    });
    expect(result.current.finalStatus).toBe('done');
    expect(result.current.isRunning).toBe(false);
  });

  it("step 'failed' captures the error and stops the chain", async () => {
    const fake = installFakeGiftk();
    const { result } = renderHook(() => useToolboxChain());
    await act(async () => {
      await result.current.start({
        inputPath: '/in.gif',
        drafts: [draft('d1', 'gif-optimize'), draft('d2', 'gif-resize')]
      });
    });
    const cid = result.current.chainId!;
    act(() => {
      fake.__emit({
        taskId: `${cid}-s1`,
        status: 'failed',
        percent: 100,
        stepIndex: 1,
        totalSteps: 2,
        error: 'boom'
      });
    });
    expect(result.current.error).toBe('boom');
    expect(result.current.finalStatus).toBe('failed');
    expect(result.current.isRunning).toBe(false);
  });

  it('cancel() invokes the bridge and forces finalStatus to cancelled', async () => {
    const fake = installFakeGiftk();
    const { result } = renderHook(() => useToolboxChain());
    await act(async () => {
      await result.current.start({
        inputPath: '/in.gif',
        drafts: [draft('d1', 'gif-optimize')]
      });
    });
    await act(async () => {
      await result.current.cancel();
    });
    expect(fake.cancelToolboxChain).toHaveBeenCalledWith(result.current.chainId);
    expect(result.current.isRunning).toBe(false);
    expect(result.current.finalStatus).toBe('cancelled');
  });

  it('reset() returns to initial state without touching the bridge', async () => {
    const fake = installFakeGiftk();
    const { result } = renderHook(() => useToolboxChain());
    await act(async () => {
      await result.current.start({
        inputPath: '/in.gif',
        drafts: [draft('d1', 'gif-optimize')]
      });
    });
    expect(result.current.chainId).not.toBeNull();
    act(() => {
      result.current.reset();
    });
    expect(result.current.chainId).toBeNull();
    expect(result.current.steps).toEqual([]);
    expect(result.current.isRunning).toBe(false);
    expect(fake.cancelToolboxChain).not.toHaveBeenCalled();
  });

  it('start() rejects a second concurrent invocation', async () => {
    const fake = installFakeGiftk();
    // Make the bridge slow so we can race two starts.
    fake.startToolboxChain.mockImplementation(
      async (payload: { chainId: string }) =>
        new Promise<ToolboxChainStartResult>((resolve) =>
          setTimeout(
            () => resolve({ ok: true, chainId: payload.chainId, outputDir: `/tmp/${payload.chainId}` }),
            20
          )
        )
    );
    const { result } = renderHook(() => useToolboxChain());
    let firstResult: { ok: boolean } | null = null;
    let secondResult: { ok: boolean; error?: string } | null = null;
    await act(async () => {
      const p1 = result.current.start({
        inputPath: '/in.gif',
        drafts: [draft('d1', 'gif-optimize')]
      });
      // Yield once so the first start sets isRunning before the
      // second invocation observes state.
      await Promise.resolve();
      const p2 = result.current.start({
        inputPath: '/in.gif',
        drafts: [draft('d2', 'gif-resize')]
      });
      [firstResult, secondResult] = await Promise.all([p1, p2]);
    });
    await flush();
    expect(firstResult!.ok).toBe(true);
    expect(secondResult!.ok).toBe(false);
    expect(secondResult!.error).toMatch(/already running/);
  });
});
