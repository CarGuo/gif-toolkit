// @vitest-environment happy-dom
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChainStepRow } from '../../src/renderer/components/ChainStepRow';
import type { ChainStepRowProps } from '../../src/renderer/components/ChainStepRow';
import type {
  ChainStepDraft,
  TaskProgress,
  ToolboxKind
} from '../../src/shared/types';

const KIND_OPTIONS: ReadonlyArray<{ kind: ToolboxKind; label: string }> = [
  { kind: 'gif-resize', label: 'GIF Resize' },
  { kind: 'gif-optimize', label: 'GIF Optimize' },
  { kind: 'crop', label: 'Crop' },
  { kind: 'trim', label: 'Trim' }
];

function makeDraft(overrides: Partial<ChainStepDraft> = {}): ChainStepDraft {
  return {
    draftId: 'd-1',
    kind: 'gif-resize',
    params: { targetWidth: 128 },
    valid: true,
    ...overrides
  };
}

function renderRow(overrides: Partial<ChainStepRowProps> = {}) {
  const props: ChainStepRowProps = {
    index: 0,
    total: 2,
    draft: makeDraft(),
    progress: undefined,
    isRunning: false,
    kindOptions: KIND_OPTIONS,
    onKindChange: vi.fn(),
    onParamsChange: vi.fn(),
    onRemove: vi.fn(),
    onMoveUp: vi.fn(),
    onMoveDown: vi.fn(),
    ...overrides
  };
  return { props, ...render(<ChainStepRow {...props} />) };
}

describe('ChainStepRow', () => {
  it('renders gif-resize draft with targetWidth=128 in input', () => {
    renderRow();
    const input = screen.getByLabelText('targetWidth') as HTMLInputElement;
    expect(input.value).toBe('128');
    expect(screen.getByText('Step 1')).toBeInTheDocument();
  });

  it('emits onParamsChange with targetWidth when input changes', () => {
    const onParamsChange = vi.fn();
    renderRow({ onParamsChange });
    fireEvent.change(screen.getByLabelText('targetWidth'), {
      target: { value: '256' }
    });
    expect(onParamsChange).toHaveBeenCalledWith(
      expect.objectContaining({ targetWidth: 256 })
    );
  });

  it('renders the pause hint for crop drafts', () => {
    renderRow({ draft: makeDraft({ kind: 'crop', params: {} }) });
    expect(
      screen.getByText('运行到此步时会暂停并弹出选区编辑窗')
    ).toBeInTheDocument();
  });

  it('shows lossy input when gif-optimize method=lossy', () => {
    renderRow({
      draft: makeDraft({
        kind: 'gif-optimize',
        params: { method: 'lossy', lossy: 80 }
      })
    });
    const lossy = screen.getByLabelText('lossy') as HTMLInputElement;
    expect(lossy.value).toBe('80');
  });

  it('does NOT show lossy input when gif-optimize method=wechat-safe', () => {
    renderRow({
      draft: makeDraft({
        kind: 'gif-optimize',
        params: { method: 'wechat-safe' }
      })
    });
    expect(screen.queryByLabelText('lossy')).toBeNull();
  });

  it('disables remove button and kind select when isRunning=true', () => {
    renderRow({ isRunning: true });
    const remove = screen.getByLabelText('step-1-remove') as HTMLButtonElement;
    const kind = screen.getByLabelText('step-1-kind') as HTMLSelectElement;
    expect(remove.disabled).toBe(true);
    expect(kind.disabled).toBe(true);
  });

  it('disables move-up when index=0', () => {
    renderRow({ index: 0, total: 3 });
    const up = screen.getByLabelText('step-1-move-up') as HTMLButtonElement;
    const down = screen.getByLabelText('step-1-move-down') as HTMLButtonElement;
    expect(up.disabled).toBe(true);
    expect(down.disabled).toBe(false);
  });

  it('disables move-down when index=total-1', () => {
    renderRow({ index: 2, total: 3 });
    const up = screen.getByLabelText('step-3-move-up') as HTMLButtonElement;
    const down = screen.getByLabelText('step-3-move-down') as HTMLButtonElement;
    expect(up.disabled).toBe(false);
    expect(down.disabled).toBe(true);
  });

  it('renders progress percent when progress is provided', () => {
    const progress: TaskProgress = {
      taskId: 'c-1-s1',
      status: 'converting',
      percent: 42
    };
    renderRow({ progress });
    expect(screen.getByText('42%')).toBeInTheDocument();
    expect(screen.getByText('converting')).toBeInTheDocument();
  });

  it('invokes onRemove / onMoveUp / onMoveDown on click', () => {
    const onRemove = vi.fn();
    const onMoveUp = vi.fn();
    const onMoveDown = vi.fn();
    renderRow({ index: 1, total: 3, onRemove, onMoveUp, onMoveDown });
    fireEvent.click(screen.getByLabelText('step-2-remove'));
    fireEvent.click(screen.getByLabelText('step-2-move-up'));
    fireEvent.click(screen.getByLabelText('step-2-move-down'));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onMoveUp).toHaveBeenCalledTimes(1);
    expect(onMoveDown).toHaveBeenCalledTimes(1);
  });
});
