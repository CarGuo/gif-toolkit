/**
 * R-25 (#1) regression: when a PreviewModal opens for a video, the bare
 * <video> element shows a black box from open until onLoadedMetadata
 * fires — which on real networks is several seconds. The "media-loading"
 * overlay must be visible during that window and disappear once the video
 * resolves a non-zero natural size. Keeping this contract in a test stops
 * a future refactor from silently removing the overlay.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { PreviewModal } from '../../src/renderer/components/PreviewModal';
import { DEFAULT_OPTIONS } from '../../src/shared/types';
import type { SniffedMedia } from '../../src/shared/types';

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

describe('PreviewModal media-loading overlay (R-25 #1)', () => {
  it('shows the loading overlay before metadata arrives', () => {
    render(
      <PreviewModal
        media={mkVideo()}
        baseOptions={{ ...DEFAULT_OPTIONS }}
        previewOverride={{}}
        onChangeOverride={() => undefined}
        onChangeOptions={() => undefined}
        onRequestPreview={() => undefined}
        previewing={false}
        preview={null}
        onClose={() => undefined}
      />
    );
    // role=status + aria-label="media-loading" lets accessible tooling find it.
    expect(screen.getByLabelText('media-loading')).toBeTruthy();
    // The Chinese label is the user-visible cue; lock that copy in too so
    // accidental wording flips break this test loudly.
    expect(screen.getByText(/正在加载视频元数据/)).toBeTruthy();
  });

  it('hides the overlay once onLoadedMetadata fires with a non-zero size', () => {
    render(
      <PreviewModal
        media={mkVideo()}
        baseOptions={{ ...DEFAULT_OPTIONS }}
        previewOverride={{}}
        onChangeOverride={() => undefined}
        onChangeOptions={() => undefined}
        onRequestPreview={() => undefined}
        previewing={false}
        preview={null}
        onClose={() => undefined}
      />
    );
    const video = document.querySelector('video') as HTMLVideoElement;
    act(() => fireLoadedMetadata(video, 12));
    expect(screen.queryByLabelText('media-loading')).toBeNull();
  });
});
