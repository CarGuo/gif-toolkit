// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderer/components/CropBox', () => ({
  CropBox: ({ onChange }: { onChange: (r: { x: number; y: number; w: number; h: number }) => void }) => (
    <button data-testid="mock-set-rect" onClick={() => onChange({ x: 10, y: 20, w: 100, h: 50 })}>
      set
    </button>
  )
}));

import { CropPauseModal } from '../../src/renderer/components/CropPauseModal';

const baseAwaiting = {
  stepIndex: 2,
  totalSteps: 3,
  stepId: 'a',
  previousOutput: '/tmp/chain/step-1-trim.gif'
};

describe('CropPauseModal', () => {
  it('renders nothing when awaiting is null', () => {
    const { container } = render(
      <CropPauseModal awaiting={null} onResume={vi.fn()} onCancel={vi.fn()} />
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders header with step counter and previousOutput path', () => {
    render(
      <CropPauseModal awaiting={baseAwaiting} onResume={vi.fn()} onCancel={vi.fn()} />
    );
    expect(screen.getByText(/Step 2 \/ 3/)).toBeTruthy();
    expect(screen.getByText('/tmp/chain/step-1-trim.gif')).toBeTruthy();
  });

  it('继续 button is disabled before a rect is selected', () => {
    render(
      <CropPauseModal awaiting={baseAwaiting} onResume={vi.fn()} onCancel={vi.fn()} />
    );
    const btn = screen.getByRole('button', { name: /继续/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('after rect is set, 继续 forwards rounded crop patch to onResume', async () => {
    const onResume = vi.fn();
    render(
      <CropPauseModal awaiting={baseAwaiting} onResume={onResume} onCancel={vi.fn()} />
    );
    fireEvent.click(screen.getByTestId('mock-set-rect'));
    const btn = screen.getByRole('button', { name: /继续/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onResume).toHaveBeenCalledWith({
      cropX: 10,
      cropY: 20,
      cropW: 100,
      cropH: 50
    });
  });

  it('clicking 取消链路 invokes onCancel', () => {
    const onCancel = vi.fn();
    render(
      <CropPauseModal awaiting={baseAwaiting} onResume={vi.fn()} onCancel={onCancel} />
    );
    fireEvent.click(screen.getByRole('button', { name: '取消链路' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('switching awaiting.stepId resets internal rect (继续 disabled again)', () => {
    const { rerender } = render(
      <CropPauseModal awaiting={baseAwaiting} onResume={vi.fn()} onCancel={vi.fn()} />
    );
    fireEvent.click(screen.getByTestId('mock-set-rect'));
    let btn = screen.getByRole('button', { name: /继续/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);

    rerender(
      <CropPauseModal
        awaiting={{ ...baseAwaiting, stepId: 'b' }}
        onResume={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    btn = screen.getByRole('button', { name: /继续/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});
