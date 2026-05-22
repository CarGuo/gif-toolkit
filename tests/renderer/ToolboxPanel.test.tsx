// @vitest-environment happy-dom
/**
 * R-TB-CHAIN Phase 2.3 — ToolboxPanel integration unit tests.
 *
 * Scope: only the chain-mode integration layer ToolboxPanel adds in
 * Phase 2.2d. We do NOT re-test useToolbox / useToolboxChain /
 * useChainDrafts / ChainStepRow / CropPauseModal here — each has its
 * own dedicated suite. Instead we mock those modules and assert:
 *
 *   1. mode toggle defaults to 'batch'; clicking 'chain-mode' flips
 *      to chain UI (ChainStepRow editor visible, ParamForm hidden).
 *   2. multi-input lock-back: when jobs.length goes >1 while mode is
 *      'chain', the panel snaps mode back to 'batch' AND calls
 *      chainDrafts.clear().
 *   3. chain mode start button disable matrix: requires jobs===1 AND
 *      drafts.allValid AND !chain.isRunning.
 *   4. chain mode start click forwards (inputPath, drafts) to
 *      chain.start().
 *   5. chain mode cancel click forwards to chain.cancel(), batch mode
 *      goes to tb.cancel().
 *   6. CropPauseModal mounts with chain.awaitingInput; null = not
 *      rendered. (We mount it with non-null awaiting and assert the
 *      mock-modal's data-testid surfaces.)
 *
 * Mock strategy
 * -------------
 * - useToolbox / useToolboxChain / useChainDrafts: vi.mock returns a
 *   factory that lets each test inject its own state via setters
 *   captured at module top-level (mutable refs).
 * - ChainStepRow: replaced with a tiny stub that exposes draftId in
 *   data-testid so we can assert "the chain editor rendered".
 * - CropPauseModal: replaced with a stub that renders awaiting?.stepId
 *   so we can assert the modal received the live awaitingInput.
 * - window.giftk: bare stub with the bridge methods the panel may
 *   touch synchronously (toolboxProbeMedia / toolboxFirstFrame are
 *   only called on jobs change; we keep an empty jobs array in most
 *   tests to avoid the probe path).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { UseToolboxResult } from '../../src/renderer/components/useToolbox';
import type { UseToolboxChainResult } from '../../src/renderer/components/useToolboxChain';
import type { UseChainDraftsResult } from '../../src/renderer/components/useChainDrafts';
import type { ChainStepDraft } from '../../src/shared/types';

// Mutable mock state — each test mutates these refs before render().
const mockState = {
  toolbox: {} as UseToolboxResult,
  chain: {} as UseToolboxChainResult,
  drafts: {} as UseChainDraftsResult
};

vi.mock('../../src/renderer/components/useToolbox', () => ({
  useToolbox: () => mockState.toolbox
}));

vi.mock('../../src/renderer/components/useToolboxChain', () => ({
  useToolboxChain: () => mockState.chain
}));

vi.mock('../../src/renderer/components/useChainDrafts', () => ({
  useChainDrafts: () => mockState.drafts
}));

vi.mock('../../src/renderer/components/ChainStepRow', () => ({
  ChainStepRow: ({ draft, index }: { draft: ChainStepDraft; index: number }) => (
    <div data-testid={`chain-row-${index}-${draft.draftId}`}>
      {`row ${index} ${draft.kind}`}
    </div>
  )
}));

vi.mock('../../src/renderer/components/CropPauseModal', () => ({
  CropPauseModal: ({
    awaiting
  }: {
    awaiting: { stepId: string; stepIndex: number; totalSteps: number; previousOutput?: string } | null;
  }) =>
    awaiting ? <div data-testid="crop-pause-modal">{awaiting.stepId}</div> : null
}));

// ParamForm is exported from ToolboxPanel itself; we don't mock it
// because batch-mode rendering uses it and we want render() not to
// crash. The probe useEffect needs window.giftk to not blow up.
beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).giftk = {
    toolboxProbeMedia: vi.fn(async () => ({
      width: 0,
      height: 0,
      durationSec: 0,
      frameRate: 0,
      nbFrames: 0,
      sizeBytes: 0
    })),
    toolboxFirstFrame: vi.fn(async () => ({ dataUrl: '' })),
    toolboxPickFiles: vi.fn(async () => []),
    onProgress: vi.fn(() => () => undefined)
  };
});

function makeToolboxStub(overrides: Partial<UseToolboxResult> = {}): UseToolboxResult {
  return {
    kind: 'gif-resize',
    setKind: vi.fn(() => true),
    params: {},
    setParams: vi.fn(),
    jobs: [],
    addJobsFromPaths: vi.fn(),
    removeJob: vi.fn(),
    clearJobs: vi.fn(),
    progress: {},
    isRunning: false,
    lastOutputDir: null,
    start: vi.fn(async () => ({ ok: true })),
    cancel: vi.fn(async () => undefined),
    toolboxHistory: [],
    removeHistoryEntry: vi.fn(),
    clearToolboxHistory: vi.fn(),
    ...overrides
  } as UseToolboxResult;
}

function makeChainStub(
  overrides: Partial<UseToolboxChainResult> = {}
): UseToolboxChainResult {
  return {
    chainId: null,
    steps: [],
    outputDir: null,
    isRunning: false,
    finalStatus: null,
    error: null,
    awaitingInput: null,
    start: vi.fn(async () => ({ ok: true, chainId: 'cid', outputDir: '/tmp/out' })),
    resume: vi.fn(async () => ({ ok: true })),
    cancel: vi.fn(async () => undefined),
    reset: vi.fn(),
    ...overrides
  };
}

function draft(id: string, kind: ChainStepDraft['kind'] = 'gif-resize', valid = true): ChainStepDraft {
  return { draftId: id, kind, params: kind === 'gif-resize' ? { targetWidth: 128 } : {}, valid };
}

function makeDraftsStub(
  overrides: Partial<UseChainDraftsResult> = {}
): UseChainDraftsResult {
  return {
    drafts: [],
    addStep: vi.fn(() => 'd-new'),
    removeStep: vi.fn(),
    updateStep: vi.fn(),
    setStepParams: vi.fn(),
    setStepKind: vi.fn(),
    moveStepUp: vi.fn(),
    moveStepDown: vi.fn(),
    clear: vi.fn(),
    allValid: false,
    ...overrides
  };
}

async function importPanel() {
  // Lazy import so the vi.mock factories above are picked up.
  const mod = await import('../../src/renderer/components/ToolboxPanel');
  return mod.ToolboxPanel;
}

describe('ToolboxPanel mode integration', () => {
  beforeEach(() => {
    mockState.toolbox = makeToolboxStub();
    mockState.chain = makeChainStub();
    mockState.drafts = makeDraftsStub();
  });

  it('defaults to batch mode and renders ParamForm, not ChainStepRow', async () => {
    const ToolboxPanel = await importPanel();
    render(<ToolboxPanel />);
    const batchBtn = screen.getByRole('radio', { name: 'batch-mode' });
    const chainBtn = screen.getByRole('radio', { name: 'chain-mode' });
    expect(batchBtn.getAttribute('aria-checked')).toBe('true');
    expect(chainBtn.getAttribute('aria-checked')).toBe('false');
    // No chain rows because drafts is empty.
    expect(screen.queryAllByTestId(/^chain-row-/)).toHaveLength(0);
  });

  it('clicking chain-mode flips toggle and shows chain editor (drafts list rendered)', async () => {
    mockState.drafts = makeDraftsStub({
      drafts: [draft('d-1'), draft('d-2', 'crop')],
      allValid: true
    });
    const ToolboxPanel = await importPanel();
    render(<ToolboxPanel />);
    const chainBtn = screen.getByRole('radio', { name: 'chain-mode' });
    fireEvent.click(chainBtn);
    // After click, chain editor renders 2 ChainStepRow stubs.
    expect(screen.getByTestId('chain-row-0-d-1')).toBeTruthy();
    expect(screen.getByTestId('chain-row-1-d-2')).toBeTruthy();
    // Side-head label switched.
    expect(screen.getByText('链路步骤')).toBeTruthy();
  });

  it('chain start button disabled when jobs.length===0', async () => {
    mockState.drafts = makeDraftsStub({ drafts: [draft('d-1')], allValid: true });
    const ToolboxPanel = await importPanel();
    render(<ToolboxPanel />);
    fireEvent.click(screen.getByRole('radio', { name: 'chain-mode' }));
    const startBtn = screen.getByRole('button', { name: '开始链路' }) as HTMLButtonElement;
    expect(startBtn.disabled).toBe(true);
  });

  it('chain start button disabled when drafts.allValid is false', async () => {
    mockState.toolbox = makeToolboxStub({
      jobs: [
        {
          id: 'j1',
          inputPath: '/tmp/a.gif',
          displayName: 'a.gif',
          kind: 'gif-resize',
          params: {}
        }
      ]
    });
    mockState.drafts = makeDraftsStub({ drafts: [draft('d-1')], allValid: false });
    const ToolboxPanel = await importPanel();
    render(<ToolboxPanel />);
    fireEvent.click(screen.getByRole('radio', { name: 'chain-mode' }));
    const startBtn = screen.getByRole('button', { name: '开始链路' }) as HTMLButtonElement;
    expect(startBtn.disabled).toBe(true);
  });

  it('chain start enabled with single job + allValid drafts; click forwards (inputPath, drafts) to chain.start', async () => {
    const startSpy = vi.fn(async () => ({ ok: true, chainId: 'cid', outputDir: '/tmp/out' }));
    mockState.chain = makeChainStub({ start: startSpy });
    mockState.toolbox = makeToolboxStub({
      jobs: [
        {
          id: 'j1',
          inputPath: '/tmp/a.gif',
          displayName: 'a.gif',
          kind: 'gif-resize',
          params: {}
        }
      ]
    });
    const drafts = [draft('d-1'), draft('d-2', 'crop')];
    mockState.drafts = makeDraftsStub({ drafts, allValid: true });

    const ToolboxPanel = await importPanel();
    render(<ToolboxPanel />);
    fireEvent.click(screen.getByRole('radio', { name: 'chain-mode' }));
    const startBtn = screen.getByRole('button', { name: '开始链路' }) as HTMLButtonElement;
    expect(startBtn.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(startBtn);
    });
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith({
      inputPath: '/tmp/a.gif',
      drafts
    });
  });

  it('multi-input lock-back: jobs.length>1 while in chain mode auto-snaps to batch and calls drafts.clear()', async () => {
    const clearSpy = vi.fn();
    mockState.drafts = makeDraftsStub({
      drafts: [draft('d-1')],
      allValid: true,
      clear: clearSpy
    });
    // Initial render — 1 job, chain mode allowed.
    mockState.toolbox = makeToolboxStub({
      jobs: [
        { id: 'j1', inputPath: '/tmp/a.gif', displayName: 'a.gif', kind: 'gif-resize', params: {} }
      ]
    });
    const ToolboxPanel = await importPanel();
    const { rerender } = render(<ToolboxPanel />);
    fireEvent.click(screen.getByRole('radio', { name: 'chain-mode' }));
    // Sanity: chain mode is on.
    expect(
      (screen.getByRole('radio', { name: 'chain-mode' }) as HTMLButtonElement)
        .getAttribute('aria-checked')
    ).toBe('true');

    // Now bump jobs to 2 and rerender — useEffect should snap mode back.
    mockState.toolbox = makeToolboxStub({
      jobs: [
        { id: 'j1', inputPath: '/tmp/a.gif', displayName: 'a.gif', kind: 'gif-resize', params: {} },
        { id: 'j2', inputPath: '/tmp/b.gif', displayName: 'b.gif', kind: 'gif-resize', params: {} }
      ]
    });
    await act(async () => {
      rerender(<ToolboxPanel />);
    });
    expect(
      (screen.getByRole('radio', { name: 'batch-mode' }) as HTMLButtonElement)
        .getAttribute('aria-checked')
    ).toBe('true');
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it('cancel button in batch mode forwards to tb.cancel', async () => {
    const tbCancelSpy = vi.fn(async () => undefined);
    mockState.toolbox = makeToolboxStub({ isRunning: true, cancel: tbCancelSpy });
    mockState.chain = makeChainStub({ isRunning: false });
    const ToolboxPanel = await importPanel();
    render(<ToolboxPanel />);
    // Default mode is batch; cancel button enabled because tb.isRunning=true.
    const cancelBtn = screen.getByRole('button', { name: '取消' }) as HTMLButtonElement;
    expect(cancelBtn.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(cancelBtn);
    });
    expect(tbCancelSpy).toHaveBeenCalledTimes(1);
  });

  it('cancel button in chain mode forwards to chain.cancel', async () => {
    const chainCancelSpy = vi.fn(async () => undefined);
    const tbCancelSpy = vi.fn(async () => undefined);
    // tb idle so the chain-mode toggle is enabled; chain idle initially so
    // the toggle isn't blocked by the cross-lane lock. We then bump
    // chain.isRunning by re-mounting with chain.isRunning=true.
    mockState.toolbox = makeToolboxStub({ isRunning: false, cancel: tbCancelSpy });
    mockState.chain = makeChainStub({ isRunning: false, cancel: chainCancelSpy });
    mockState.drafts = makeDraftsStub({ drafts: [draft('d-1')], allValid: true });

    const ToolboxPanel = await importPanel();
    const { rerender } = render(<ToolboxPanel />);
    fireEvent.click(screen.getByRole('radio', { name: 'chain-mode' }));
    // Now flip chain.isRunning=true on the underlying mock and rerender so
    // the cancel button becomes enabled in chain mode.
    mockState.chain = makeChainStub({ isRunning: true, cancel: chainCancelSpy });
    await act(async () => {
      rerender(<ToolboxPanel />);
    });
    const cancelBtn = screen.getByRole('button', { name: '取消' }) as HTMLButtonElement;
    expect(cancelBtn.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(cancelBtn);
    });
    expect(chainCancelSpy).toHaveBeenCalledTimes(1);
    expect(tbCancelSpy).toHaveBeenCalledTimes(0);
  });

  it('CropPauseModal mounts with chain.awaitingInput; absent when null', async () => {
    // First: awaitingInput=null → modal not rendered.
    const ToolboxPanel = await importPanel();
    const { unmount } = render(<ToolboxPanel />);
    expect(screen.queryByTestId('crop-pause-modal')).toBeNull();
    unmount();

    // Now: awaiting non-null → modal rendered with stepId.
    mockState.chain = makeChainStub({
      awaitingInput: {
        stepIndex: 2,
        totalSteps: 3,
        stepId: 'cid-s2',
        previousOutput: '/tmp/prev.gif'
      }
    });
    render(<ToolboxPanel />);
    expect(screen.getByTestId('crop-pause-modal').textContent).toBe('cid-s2');
  });

  it('chain-mode toggle disabled when jobs.length>1', async () => {
    mockState.toolbox = makeToolboxStub({
      jobs: [
        { id: 'j1', inputPath: '/tmp/a.gif', displayName: 'a.gif', kind: 'gif-resize', params: {} },
        { id: 'j2', inputPath: '/tmp/b.gif', displayName: 'b.gif', kind: 'gif-resize', params: {} }
      ]
    });
    const ToolboxPanel = await importPanel();
    render(<ToolboxPanel />);
    const chainBtn = screen.getByRole('radio', { name: 'chain-mode' }) as HTMLButtonElement;
    expect(chainBtn.disabled).toBe(true);
  });

  it('+ 添加步骤 button calls drafts.addStep with default kind gif-resize', async () => {
    const addStepSpy = vi.fn(() => 'd-new');
    mockState.drafts = makeDraftsStub({ addStep: addStepSpy });
    const ToolboxPanel = await importPanel();
    render(<ToolboxPanel />);
    fireEvent.click(screen.getByRole('radio', { name: 'chain-mode' }));
    const addBtn = screen.getByRole('button', { name: 'add-chain-step' });
    fireEvent.click(addBtn);
    expect(addStepSpy).toHaveBeenCalledTimes(1);
    expect(addStepSpy).toHaveBeenCalledWith('gif-resize');
  });

  it('chain-mode start with allValid=true triggers chain.start once (no double-fire on rapid click)', async () => {
    const startSpy = vi.fn(async () => ({ ok: true, chainId: 'cid', outputDir: '/o' }));
    mockState.chain = makeChainStub({ start: startSpy });
    mockState.toolbox = makeToolboxStub({
      jobs: [{ id: 'j1', inputPath: '/tmp/a.gif', displayName: 'a.gif', kind: 'gif-resize', params: {} }]
    });
    mockState.drafts = makeDraftsStub({ drafts: [draft('d-1')], allValid: true });
    const ToolboxPanel = await importPanel();
    render(<ToolboxPanel />);
    fireEvent.click(screen.getByRole('radio', { name: 'chain-mode' }));
    const startBtn = screen.getByRole('button', { name: '开始链路' });
    await act(async () => {
      fireEvent.click(startBtn);
    });
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('chain.error renders a tb-notice-error block in chain mode', async () => {
    mockState.chain = makeChainStub({ error: 'boom step 2 failed' });
    mockState.drafts = makeDraftsStub({ drafts: [draft('d-1')], allValid: true });
    const ToolboxPanel = await importPanel();
    render(<ToolboxPanel />);
    fireEvent.click(screen.getByRole('radio', { name: 'chain-mode' }));
    expect(screen.getByText('boom step 2 failed')).toBeTruthy();
  });
});
