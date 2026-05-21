/**
 * P1.2 regression — opening a PreviewModal MUST NOT mutate the global
 * ProcessOptions. The auto-populated `startSec/endSec` (from
 * `onLoadedMetadata`) and any `cropRect` adjustments must flow into the
 * `previewOverride` state instead, so that:
 *   1. Closing the modal without "单独处理本项" leaves the next batch run
 *      free to surface BatchSegmentModal for long videos.
 *   2. A crop drawn for media A doesn't bleed into the batch processing of
 *      media B / C / D.
 *
 * This file pins the contract by checking which callback PreviewModal calls
 * for each interaction, not by spinning up the whole App.
 */
import { act, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PreviewModal, type PreviewOverride } from '../../src/renderer/components/PreviewModal';
import { DEFAULT_OPTIONS } from '../../src/shared/types';
import type { SniffedMedia } from '../../src/shared/types';

const mkVideo = (overrides: Partial<SniffedMedia> = {}): SniffedMedia => ({
  id: 'v-iso-1',
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

describe('PreviewModal global-options isolation (P1.2)', () => {
  it('onLoadedMetadata writes to override, not to global onChangeOptions', () => {
    const onChangeOverride = vi.fn<[PreviewOverride], void>();
    const onChangeOptions = vi.fn();

    render(
      <PreviewModal
        media={mkVideo()}
        baseOptions={{ ...DEFAULT_OPTIONS }}
        previewOverride={{}}
        onChangeOverride={onChangeOverride}
        onChangeOptions={onChangeOptions}
        onRequestPreview={() => undefined}
        previewing={false}
        preview={null}
        onClose={() => undefined}
      />
    );

    const video = document.querySelector('video') as HTMLVideoElement;
    act(() => fireLoadedMetadata(video, 50));

    // The auto-populated start/end window must land on the override callback.
    const overrideCall = onChangeOverride.mock.calls.find(
      ([arg]) => arg && (arg.startSec !== undefined || arg.endSec !== undefined)
    );
    expect(overrideCall, 'expected onChangeOverride to receive auto start/end').toBeTruthy();
    expect(overrideCall![0].startSec).toBe(0);
    // R-22 fix — the modal no longer clamps endSec to maxSegmentSec
    // (which made the segment picker pointless). It now keeps the full
    // [0..duration] range and uses selectedSegments=[0] to express
    // "default to the first segment only" for long videos.
    expect(overrideCall![0].endSec).toBe(50);
    expect(overrideCall![0].selectedSegments).toEqual([0]);

    // And onChangeOptions (global) must NEVER receive a payload that mutates
    // the per-media fields. The strictest contract: don't call it at all on
    // mount + onLoadedMetadata. The fallback assertion below is defensive in
    // case a future refactor needs to call it for a benign reason.
    expect(onChangeOptions).not.toHaveBeenCalled();
    for (const [arg] of onChangeOptions.mock.calls) {
      expect(arg.startSec).toBe(DEFAULT_OPTIONS.startSec);
      expect(arg.endSec).toBe(DEFAULT_OPTIONS.endSec);
      expect(arg.cropRect).toBe(DEFAULT_OPTIONS.cropRect);
    }
  });

  it('media-id switch resets the override but never touches global options', () => {
    const onChangeOverride = vi.fn<[PreviewOverride], void>();
    const onChangeOptions = vi.fn();

    const { rerender } = render(
      <PreviewModal
        media={mkVideo({ id: 'a' })}
        baseOptions={{ ...DEFAULT_OPTIONS }}
        previewOverride={{ cropRect: { x: 0, y: 0, w: 100, h: 100 }, startSec: 5, endSec: 15 }}
        onChangeOverride={onChangeOverride}
        onChangeOptions={onChangeOptions}
        onRequestPreview={() => undefined}
        previewing={false}
        preview={null}
        onClose={() => undefined}
      />
    );

    onChangeOverride.mockClear();
    onChangeOptions.mockClear();

    rerender(
      <PreviewModal
        media={mkVideo({ id: 'b' })}
        baseOptions={{ ...DEFAULT_OPTIONS }}
        previewOverride={{ cropRect: { x: 0, y: 0, w: 100, h: 100 }, startSec: 5, endSec: 15 }}
        onChangeOverride={onChangeOverride}
        onChangeOptions={onChangeOptions}
        onRequestPreview={() => undefined}
        previewing={false}
        preview={null}
        onClose={() => undefined}
      />
    );

    // Reset must clear the override (cropRect / startSec / endSec /
    // selectedSegments → undefined). R-22 fix added selectedSegments
    // to the reset payload so a previous media's pick can't bleed into
    // the next media's chip defaults.
    expect(onChangeOverride).toHaveBeenCalledWith({
      cropRect: undefined,
      startSec: undefined,
      endSec: undefined,
      selectedSegments: undefined
    });
    // And the global options must remain untouched on a media switch.
    expect(onChangeOptions).not.toHaveBeenCalled();
  });

  it('"单独处理本项" forwards the override to onProcessOne for THIS media only', () => {
    const onChangeOverride = vi.fn();
    const onChangeOptions = vi.fn();
    const onProcessOne = vi.fn();
    const previewOverride: PreviewOverride = {
      cropRect: { x: 10, y: 20, w: 300, h: 200 },
      startSec: 2,
      endSec: 8
    };

    const { container } = render(
      <PreviewModal
        media={mkVideo({ id: 'one' })}
        baseOptions={{ ...DEFAULT_OPTIONS }}
        previewOverride={previewOverride}
        onChangeOverride={onChangeOverride}
        onChangeOptions={onChangeOptions}
        onRequestPreview={() => undefined}
        previewing={false}
        preview={null}
        onClose={() => undefined}
        onProcessOne={onProcessOne}
      />
    );

    const buttons = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[];
    const processBtn = buttons.find((b) => b.textContent?.includes('单独处理本项'));
    expect(processBtn, 'expected to find "单独处理本项" button').toBeTruthy();
    fireEvent.click(processBtn!);

    expect(onProcessOne).toHaveBeenCalledTimes(1);
    const [mediaArg, overrideArg] = onProcessOne.mock.calls[0];
    expect(mediaArg.id).toBe('one');
    expect(overrideArg).toEqual(previewOverride);
    // Importantly, the global setter must remain untouched throughout this
    // path — the override travels alongside the dispatch instead.
    expect(onChangeOptions).not.toHaveBeenCalled();
  });
});
