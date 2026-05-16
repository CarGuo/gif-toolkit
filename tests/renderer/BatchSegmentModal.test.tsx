/**
 * Tests for the BatchSegmentModal added in R-23. The modal lists every
 * long video that the user is about to batch-process and lets them pick
 * which segments to convert before any work is dispatched. These tests
 * cover the user-facing contract: default selection, per-video toggling,
 * total counter, confirm + cancel behaviour.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BatchSegmentModal, type BatchSegmentEntry } from '../../src/renderer/components/BatchSegmentModal';
import type { SniffedMedia } from '../../src/shared/types';

const mkMedia = (id: string, url: string): SniffedMedia => ({
  id,
  url,
  kind: 'video',
  source: 'video-tag',
  pageUrl: 'https://example.com/page'
});

describe('BatchSegmentModal (R-23)', () => {
  const entries: BatchSegmentEntry[] = [
    { media: mkMedia('a', 'https://example.com/a.mp4'), durationSec: 60 }, // 3 segs @ 20s
    { media: mkMedia('b', 'https://example.com/b.mp4'), durationSec: 50 }  // 3 segs (16.67s ea)
  ];

  it('lists one row per entry with the right segment count', () => {
    render(
      <BatchSegmentModal
        entries={entries}
        maxSegmentSec={20}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />
    );
    // 3 segments × 2 entries = 6 chips total.
    expect(screen.getAllByLabelText(/segment \d+/).length).toBe(6);
  });

  it('defaults the per-entry selection to [0] and shows total = entry count', () => {
    const onConfirm = vi.fn();
    render(
      <BatchSegmentModal
        entries={entries}
        maxSegmentSec={20}
        onConfirm={onConfirm}
        onCancel={() => undefined}
      />
    );
    // Confirm button label includes "(2 段)" — 2 entries × 1 default each.
    const btn = screen.getByRole('button', { name: /开始处理/ });
    expect(btn.textContent).toContain('2 段');

    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledWith({ a: [0], b: [0] });
  });

  it('selecting all in entry "a" updates only that entry on confirm', () => {
    const onConfirm = vi.fn();
    render(
      <BatchSegmentModal
        entries={entries}
        maxSegmentSec={20}
        onConfirm={onConfirm}
        onCancel={() => undefined}
      />
    );
    // The first row's "全选" button.
    const allBtns = screen.getAllByRole('button', { name: '全选' });
    expect(allBtns.length).toBe(2);
    fireEvent.click(allBtns[0]);

    // Now total = 3 (entry a) + 1 (entry b) = 4 segments.
    const btn = screen.getByRole('button', { name: /开始处理/ });
    expect(btn.textContent).toContain('4 段');

    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledWith({ a: [0, 1, 2], b: [0] });
  });

  it('cancel button calls onCancel without dispatching', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <BatchSegmentModal
        entries={entries}
        maxSegmentSec={20}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('clicking the backdrop also cancels', () => {
    const onCancel = vi.fn();
    const { container } = render(
      <BatchSegmentModal
        entries={entries}
        maxSegmentSec={20}
        onConfirm={() => undefined}
        onCancel={onCancel}
      />
    );
    const backdrop = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop); // target === currentTarget
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('toggling an empty-selection chip falls back to [0] in the confirmed payload', () => {
    const onConfirm = vi.fn();
    render(
      <BatchSegmentModal
        entries={entries}
        maxSegmentSec={20}
        onConfirm={onConfirm}
        onCancel={() => undefined}
      />
    );
    // In entry a, untick the only checked chip. The picker reports
    // `undefined`, but the modal normalises that to [0] so we never
    // dispatch a video with zero segments.
    const allChips = screen.getAllByLabelText('segment 1');
    expect(allChips.length).toBe(2); // one per entry row
    fireEvent.click(allChips[0]); // untick entry a's segment 1

    fireEvent.click(screen.getByRole('button', { name: /开始处理/ }));
    expect(onConfirm).toHaveBeenCalledWith({ a: [0], b: [0] });
  });
});
