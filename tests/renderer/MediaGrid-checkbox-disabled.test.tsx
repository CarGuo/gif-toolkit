/**
 * R-28 #1 — embed videos that have NOT yet been resolved by yt-dlp
 * cannot be ticked. Without this guard the user could "select" an
 * embed, see it counted in the "开始批处理 (N / 共选 M)" badge, hit
 * 开始批处理, and then be quietly dropped from the dispatch list by
 * the `processable` filter. We assert the contract end-to-end:
 *   - `disabled` attribute on the input.
 *   - tooltip text on the wrapping label so the affordance is
 *     self-explanatory.
 *   - clicking the checkbox does not invoke onToggle.
 *   - resolved embed (resolved !== undefined) becomes interactive
 *     again.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MediaGrid } from '../../src/renderer/components/MediaGrid';
import type { SniffedMedia } from '../../src/shared/types';

const baseEmbed: SniffedMedia = {
  id: 'e-1',
  url: 'https://www.youtube.com/watch?v=abc',
  kind: 'video',
  source: 'iframe',
  pageUrl: 'https://example.com/post',
  requiresExternalDownload: true,
  embedHost: 'youtube'
};

const plainVideo: SniffedMedia = {
  id: 'v-1',
  url: 'https://x.test/clip.mp4',
  kind: 'video',
  source: 'video-tag',
  pageUrl: 'https://example.com/post'
};

describe('MediaGrid R-28 #1 — embed checkbox disable', () => {
  it('disables checkbox + adds tooltip when embed is unresolved', () => {
    const onToggle = vi.fn();
    render(
      <MediaGrid
        items={[baseEmbed]}
        selected={new Set()}
        onToggle={onToggle}
        onOpen={() => undefined}
      />
    );
    const cb = document.querySelector('.card-check input[type="checkbox"]') as HTMLInputElement;
    expect(cb).toBeTruthy();
    expect(cb.disabled).toBe(true);
    const label = cb.closest('label.card-check') as HTMLLabelElement;
    expect(label.title).toMatch(/解析直链|解析中/);
    fireEvent.click(cb);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('shows the resolving-state tooltip when isResolving returns true', () => {
    render(
      <MediaGrid
        items={[baseEmbed]}
        selected={new Set()}
        onToggle={() => undefined}
        onOpen={() => undefined}
        isResolving={(id) => id === 'e-1'}
      />
    );
    const label = document.querySelector('label.card-check') as HTMLLabelElement;
    expect(label.title).toContain('解析中');
  });

  it('keeps a plain (non-embed) video checkbox enabled and clickable', () => {
    const onToggle = vi.fn();
    render(
      <MediaGrid
        items={[plainVideo]}
        selected={new Set()}
        onToggle={onToggle}
        onOpen={() => undefined}
      />
    );
    const cb = document.querySelector('.card-check input[type="checkbox"]') as HTMLInputElement;
    expect(cb.disabled).toBe(false);
    fireEvent.click(cb);
    expect(onToggle).toHaveBeenCalledWith('v-1');
  });

  it('re-enables checkbox once an embed is resolved', () => {
    const resolved: SniffedMedia = {
      ...baseEmbed,
      resolved: {
        url: 'https://r.test/x.mp4',
        source: 'ytdlp',
        extractor: 'youtube',
        durationSec: 12,
        width: 1280,
        height: 720
      }
    };
    const onToggle = vi.fn();
    render(
      <MediaGrid
        items={[resolved]}
        selected={new Set()}
        onToggle={onToggle}
        onOpen={() => undefined}
      />
    );
    const cb = document.querySelector('.card-check input[type="checkbox"]') as HTMLInputElement;
    expect(cb.disabled).toBe(false);
    fireEvent.click(cb);
    expect(onToggle).toHaveBeenCalledWith('e-1');
  });
});
