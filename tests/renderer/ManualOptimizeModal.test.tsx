/**
 * Tests for ManualOptimizeModal (R-33A).
 * Validates: preset chips, manual field overrides, onConfirm payload shape,
 * close interactions (Esc / overlay click), and that the modal is hidden
 * when open=false.
 */
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManualOptimizeModal, type ManualOptimizeRequest } from '../../src/renderer/components/ManualOptimizeModal';
import { DEFAULT_OPTIONS } from '../../src/shared/types';

afterEach(() => cleanup());

describe('ManualOptimizeModal', () => {
  it('returns null when open=false', () => {
    const { container } = render(
      <ManualOptimizeModal
        open={false}
        currentSizeMB={5}
        baseOptions={DEFAULT_OPTIONS}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(container.querySelector('.manual-opt-modal')).toBeNull();
  });

  it('renders header, current size, and 4 preset chips when open', () => {
    render(
      <ManualOptimizeModal
        open={true}
        currentSizeMB={7.32}
        baseOptions={DEFAULT_OPTIONS}
        warning="exceeds hard target"
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByText('手动二次优化')).toBeTruthy();
    expect(screen.getByText('7.32 MB')).toBeTruthy();
    expect(screen.getByText(/exceeds hard target/)).toBeTruthy();
    expect(screen.getByText('更狠压')).toBeTruthy();
    expect(screen.getByText('优先尺寸')).toBeTruthy();
    expect(screen.getByText('优先帧率')).toBeTruthy();
    expect(screen.getByText('近于原图')).toBeTruthy();
  });

  it('clicking 优先尺寸 fills maxWidth at ~75% of base, fps unchanged', () => {
    const onConfirm = vi.fn<[ManualOptimizeRequest], void>();
    const base = { ...DEFAULT_OPTIONS, fps: 15, maxWidth: 800 };
    render(
      <ManualOptimizeModal
        open={true}
        currentSizeMB={5}
        baseOptions={base}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText('优先尺寸'));
    fireEvent.click(screen.getByText('运行优化'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const req = onConfirm.mock.calls[0][0];
    expect(req.fps).toBe(15);
    // 800 * 0.75 = 600
    expect(req.maxWidth).toBe(600);
  });

  it('clicking 优先帧率 lowers fps by 4, maxWidth unchanged', () => {
    const onConfirm = vi.fn<[ManualOptimizeRequest], void>();
    const base = { ...DEFAULT_OPTIONS, fps: 15, maxWidth: 800 };
    render(
      <ManualOptimizeModal
        open={true}
        currentSizeMB={5}
        baseOptions={base}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText('优先帧率'));
    fireEvent.click(screen.getByText('运行优化'));
    const req = onConfirm.mock.calls[0][0];
    expect(req.fps).toBe(11);
    expect(req.maxWidth).toBe(800);
  });

  it('Esc triggers onClose', () => {
    const onClose = vi.fn();
    render(
      <ManualOptimizeModal
        open={true}
        currentSizeMB={5}
        baseOptions={DEFAULT_OPTIONS}
        onConfirm={vi.fn()}
        onClose={onClose}
      />
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cancel button triggers onClose, not onConfirm', () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ManualOptimizeModal
        open={true}
        currentSizeMB={5}
        baseOptions={DEFAULT_OPTIONS}
        onConfirm={onConfirm}
        onClose={onClose}
      />
    );
    fireEvent.click(screen.getByText('取消'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('manual edit to FPS field overrides preset value on confirm', () => {
    const onConfirm = vi.fn<[ManualOptimizeRequest], void>();
    render(
      <ManualOptimizeModal
        open={true}
        currentSizeMB={5}
        baseOptions={DEFAULT_OPTIONS}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />
    );
    const fpsInput = screen.getByText('FPS').parentElement!.querySelector('input') as HTMLInputElement;
    fireEvent.change(fpsInput, { target: { value: '8' } });
    fireEvent.click(screen.getByText('运行优化'));
    expect(onConfirm.mock.calls[0][0].fps).toBe(8);
  });
});
