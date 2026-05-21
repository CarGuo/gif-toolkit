/**
 * Tests for the segment-picker UI moved from PreviewPanel into the actually
 * mounted PreviewModal (R-22 fix).
 *
 * Background: App.tsx renders <PreviewModal/>, not <PreviewPanel/>, so the
 * segment-pick chips that PreviewPanel.test.tsx exercised never reached the
 * user. PreviewModal also used to silently clamp `endSec = min(maxSegmentSec,
 * duration)` on metadata load — making the [start,end] range cover ONE
 * segment and rendering the picker pointless even if it had been there.
 *
 * These tests guard the new contract:
 *   • short videos (range ≤ maxSegmentSec) → no picker
 *   • 50s long video with cap 20 → 3 chips, default `selectedSegments=[0]`
 *   • 全选 button writes [0,1,2] back via `onChangeOverride`
 *   • toggling a chip flips its index
 *
 * happy-dom doesn't probe <video> metadata; we fire `loadedMetadata`
 * manually with a stubbed currentTarget.duration.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PreviewModal, type PreviewOverride } from '../../src/renderer/components/PreviewModal';
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
  Object.defineProperty(videoEl, 'duration', { configurable: true, value: duration });
  Object.defineProperty(videoEl, 'videoWidth', { configurable: true, value: 1280 });
  Object.defineProperty(videoEl, 'videoHeight', { configurable: true, value: 720 });
  fireEvent.loadedMetadata(videoEl);
};

interface RenderOpts {
  baseOptions?: ProcessOptions;
  override?: PreviewOverride;
  onChangeOverride?: (n: PreviewOverride) => void;
  onProcessOne?: (m: SniffedMedia, ov?: PreviewOverride) => void;
}

const renderModal = (opts: RenderOpts = {}) => {
  const onChangeOverride = opts.onChangeOverride ?? vi.fn();
  const onProcessOne = opts.onProcessOne ?? vi.fn();
  const utils = render(
    <PreviewModal
      media={mkVideo()}
      baseOptions={opts.baseOptions ?? { ...DEFAULT_OPTIONS }}
      previewOverride={opts.override ?? {}}
      onChangeOverride={onChangeOverride}
      onChangeOptions={vi.fn()}
      onRequestPreview={vi.fn()}
      previewing={false}
      preview={null}
      onClose={vi.fn()}
      onProcessOne={onProcessOne}
    />
  );
  return { ...utils, onChangeOverride, onProcessOne };
};

describe('PreviewModal segment picker (R-22)', () => {
  it('hides the picker for short videos (range ≤ maxSegmentSec)', () => {
    renderModal();
    const video = document.querySelector('video') as HTMLVideoElement;
    expect(video).not.toBeNull();
    act(() => fireLoadedMetadata(video, 12));
    expect(screen.queryByText(/分段选择/)).toBeNull();
  });

  it('shows 3 segment chips for a 50s video (cap 20) and pre-selects #0', () => {
    // Simulate the parent already received the onLoadedMetadata callback's
    // override write — feed that back through `previewOverride` so the
    // picker reads selectedSegments=[0]. This mirrors how App.tsx wires
    // `previewOverride` state through `setPreviewOverride`.
    let override: PreviewOverride = {};
    const onChangeOverride = vi.fn((next: PreviewOverride) => { override = next; });

    const { rerender } = renderModal({ override, onChangeOverride });
    const video = document.querySelector('video') as HTMLVideoElement;
    act(() => fireLoadedMetadata(video, 50));

    // After metadata load the modal should have written
    //   { startSec: 0, endSec: 50, selectedSegments: [0] }
    // back via onChangeOverride.
    expect(onChangeOverride).toHaveBeenCalled();
    expect(override).toMatchObject({
      startSec: 0,
      endSec: 50,
      selectedSegments: [0]
    });

    rerender(
      <PreviewModal
        media={mkVideo()}
        baseOptions={{ ...DEFAULT_OPTIONS }}
        previewOverride={override}
        onChangeOverride={onChangeOverride}
        onChangeOptions={vi.fn()}
        onRequestPreview={vi.fn()}
        previewing={false}
        preview={null}
        onClose={vi.fn()}
        onProcessOne={vi.fn()}
      />
    );

    expect(screen.getByText('分段选择')).toBeTruthy();
    const chips = screen.getAllByLabelText(/segment \d+/);
    expect(chips.length).toBe(3);
    expect((chips[0] as HTMLInputElement).checked).toBe(true);
    expect((chips[1] as HTMLInputElement).checked).toBe(false);
    expect((chips[2] as HTMLInputElement).checked).toBe(false);
  });

  it('"全选" button writes [0,1,2] back via onChangeOverride', () => {
    let override: PreviewOverride = {};
    const onChangeOverride = vi.fn((next: PreviewOverride) => { override = next; });

    const { rerender } = renderModal({ override, onChangeOverride });
    const video = document.querySelector('video') as HTMLVideoElement;
    act(() => fireLoadedMetadata(video, 50));
    rerender(
      <PreviewModal
        media={mkVideo()}
        baseOptions={{ ...DEFAULT_OPTIONS }}
        previewOverride={override}
        onChangeOverride={onChangeOverride}
        onChangeOptions={vi.fn()}
        onRequestPreview={vi.fn()}
        previewing={false}
        preview={null}
        onClose={vi.fn()}
        onProcessOne={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    expect(override.selectedSegments).toEqual([0, 1, 2]);
  });

  it('toggling a chip flips its index', () => {
    let override: PreviewOverride = {};
    const onChangeOverride = vi.fn((next: PreviewOverride) => { override = next; });

    const { rerender } = renderModal({ override, onChangeOverride });
    const video = document.querySelector('video') as HTMLVideoElement;
    act(() => fireLoadedMetadata(video, 50));
    rerender(
      <PreviewModal
        media={mkVideo()}
        baseOptions={{ ...DEFAULT_OPTIONS }}
        previewOverride={override}
        onChangeOverride={onChangeOverride}
        onChangeOptions={vi.fn()}
        onRequestPreview={vi.fn()}
        previewing={false}
        preview={null}
        onClose={vi.fn()}
        onProcessOne={vi.fn()}
      />
    );

    const chip2 = screen.getByLabelText('segment 2') as HTMLInputElement;
    fireEvent.click(chip2);
    expect(override.selectedSegments).toEqual([0, 1]);
  });
});
