/**
 * Tests for the segment-picker UI added to PreviewPanel.tsx (R-22).
 * Guards: long videos default to processing only segment #0; "全选" / "仅
 * 第 1 段" buttons; checkbox toggles propagate via onChangeOptions.
 *
 * happy-dom's <video> doesn't probe metadata on its own, so we fire the
 * `loadedMetadata` event manually with a stubbed currentTarget.duration.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PreviewPanel } from '../../src/renderer/components/PreviewPanel';
import { DEFAULT_OPTIONS } from '../../src/shared/types';
import type { ProcessOptions, SniffedMedia } from '../../src/shared/types';

const mkVideo = (overrides: Partial<SniffedMedia> = {}): SniffedMedia => ({
  id: 'v1',
  url: 'https://example.com/clip.mp4',
  kind: 'video',
  source: 'video-tag',
  pageUrl: 'https://example.com/page',
  ...overrides
});

const fireLoadedMetadata = (videoEl: HTMLVideoElement, duration: number): void => {
  // happy-dom doesn't compute these; stamp the values the component reads.
  Object.defineProperty(videoEl, 'duration', { configurable: true, value: duration });
  Object.defineProperty(videoEl, 'videoWidth', { configurable: true, value: 1280 });
  Object.defineProperty(videoEl, 'videoHeight', { configurable: true, value: 720 });
  fireEvent.loadedMetadata(videoEl);
};

describe('PreviewPanel segment picker (R-22)', () => {
  it('hides the picker for short videos (range ≤ maxSegmentSec)', () => {
    const onChange = vi.fn();
    render(
      <PreviewPanel
        media={mkVideo()}
        options={{ ...DEFAULT_OPTIONS }}
        onChangeOptions={onChange}
        onRequestPreview={() => undefined}
        previewing={false}
        preview={null}
      />
    );
    const video = document.querySelector('video') as HTMLVideoElement;
    expect(video).not.toBeNull();
    act(() => fireLoadedMetadata(video, 12)); // 12s ≤ default 20s

    expect(screen.queryByText(/分段选择/)).toBeNull();
  });

  it('shows N segment chips for a long video and pre-selects #1 by default', () => {
    let opts: ProcessOptions = { ...DEFAULT_OPTIONS };
    const onChange = vi.fn((next: ProcessOptions) => { opts = next; });
    const { rerender } = render(
      <PreviewPanel
        media={mkVideo()}
        options={opts}
        onChangeOptions={onChange}
        onRequestPreview={() => undefined}
        previewing={false}
        preview={null}
      />
    );
    const video = document.querySelector('video') as HTMLVideoElement;
    act(() => fireLoadedMetadata(video, 50)); // 50s with cap 20 → 3 segments
    rerender(
      <PreviewPanel
        media={mkVideo()}
        options={opts}
        onChangeOptions={onChange}
        onRequestPreview={() => undefined}
        previewing={false}
        preview={null}
      />
    );

    expect(screen.getByText(/分段选择/)).toBeTruthy();
    const chips = screen.getAllByLabelText(/segment \d+/);
    expect(chips.length).toBe(3);

    // Default selection: only #1 ticked. The onLoadedMetadata callback already
    // wrote selectedSegments=[0] into options, so only the first chip is
    // checked.
    expect((chips[0] as HTMLInputElement).checked).toBe(true);
    expect((chips[1] as HTMLInputElement).checked).toBe(false);
    expect((chips[2] as HTMLInputElement).checked).toBe(false);
  });

  it('"全选" button writes every index back to options', () => {
    let opts: ProcessOptions = { ...DEFAULT_OPTIONS };
    const onChange = vi.fn((next: ProcessOptions) => { opts = next; });
    const { rerender } = render(
      <PreviewPanel
        media={mkVideo()}
        options={opts}
        onChangeOptions={onChange}
        onRequestPreview={() => undefined}
        previewing={false}
        preview={null}
      />
    );
    const video = document.querySelector('video') as HTMLVideoElement;
    act(() => fireLoadedMetadata(video, 50));
    rerender(
      <PreviewPanel
        media={mkVideo()}
        options={opts}
        onChangeOptions={onChange}
        onRequestPreview={() => undefined}
        previewing={false}
        preview={null}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    expect(opts.selectedSegments).toEqual([0, 1, 2]);
  });

  it('toggling a chip flips its index in selectedSegments', () => {
    let opts: ProcessOptions = { ...DEFAULT_OPTIONS };
    const onChange = vi.fn((next: ProcessOptions) => { opts = next; });
    const { rerender } = render(
      <PreviewPanel
        media={mkVideo()}
        options={opts}
        onChangeOptions={onChange}
        onRequestPreview={() => undefined}
        previewing={false}
        preview={null}
      />
    );
    const video = document.querySelector('video') as HTMLVideoElement;
    act(() => fireLoadedMetadata(video, 50));
    rerender(
      <PreviewPanel
        media={mkVideo()}
        options={opts}
        onChangeOptions={onChange}
        onRequestPreview={() => undefined}
        previewing={false}
        preview={null}
      />
    );

    // Default = [0]. Click #2 → [0, 1].
    const chip2 = screen.getByLabelText('segment 2') as HTMLInputElement;
    fireEvent.click(chip2);
    expect(opts.selectedSegments).toEqual([0, 1]);
  });

  it('chip start/end labels reflect equal-sized splits', () => {
    let opts: ProcessOptions = { ...DEFAULT_OPTIONS };
    const onChange = vi.fn((next: ProcessOptions) => { opts = next; });
    const { rerender } = render(
      <PreviewPanel
        media={mkVideo()}
        options={opts}
        onChangeOptions={onChange}
        onRequestPreview={() => undefined}
        previewing={false}
        preview={null}
      />
    );
    const video = document.querySelector('video') as HTMLVideoElement;
    act(() => fireLoadedMetadata(video, 60)); // 60s/20s = 3 segments of 20s each
    rerender(
      <PreviewPanel
        media={mkVideo()}
        options={opts}
        onChangeOptions={onChange}
        onRequestPreview={() => undefined}
        previewing={false}
        preview={null}
      />
    );

    // Verify the second chip shows 20.0–40.0s.
    const chip2 = screen.getByLabelText('segment 2');
    const label = chip2.closest('label') as HTMLElement;
    expect(within(label).getByText('20.0–40.0s')).toBeTruthy();
  });
});
