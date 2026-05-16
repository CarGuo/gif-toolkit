/**
 * R-26 (#1) — when an embed is mid-resolve we must NOT show a static
 * "解析中…" label that makes the user think the app froze, and the
 * chip must NOT be styled red. Both are direct user complaints from
 * round 43 ("放一个红色感叹号太敏感了,换成黄色比较合理"). This file
 * locks the new contract:
 *
 *   1. The resolving chip uses class "card-embed-tag resolving"
 *      (which now maps to amber in styles.css — verified separately).
 *   2. The chip starts on the FIRST stage label ("联系视频站点…") and
 *      advances over time.
 *   3. role="status" + aria-live="polite" so screen readers announce
 *      progress without spamming.
 *   4. NOT shown for failed (retry) or resolved (✓) cases — those are
 *      different chips with their own classes.
 */
import { act, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaGrid } from '../../src/renderer/components/MediaGrid';
import type { SniffedMedia } from '../../src/shared/types';

const mkEmbed = (id: string, host = 'youtube'): SniffedMedia => ({
  id,
  url: `https://www.${host}.com/watch?v=${id}`,
  kind: 'video',
  source: 'iframe',
  pageUrl: 'https://example.com/article',
  requiresExternalDownload: true,
  embedHost: host
});

describe('MediaGrid R-26 resolving chip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts on the first stage label when isResolving', () => {
    const m = mkEmbed('vid1');
    render(
      <MediaGrid
        items={[m]}
        selected={new Set()}
        onToggle={vi.fn()}
        onOpen={vi.fn()}
        isResolving={() => true}
        resolveErrorMap={{}}
      />
    );
    expect(screen.getByText('联系视频站点…')).toBeTruthy();
    // Sanity: the live-region role is set so a11y tooling can pick it up.
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('advances through stages on a 1.5s tick', () => {
    const m = mkEmbed('vid1');
    render(
      <MediaGrid
        items={[m]}
        selected={new Set()}
        onToggle={vi.fn()}
        onOpen={vi.fn()}
        isResolving={() => true}
        resolveErrorMap={{}}
      />
    );
    expect(screen.getByText('联系视频站点…')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(screen.getByText('提取视频信息…')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(screen.getByText('匹配最佳格式…')).toBeTruthy();
  });

  it('saturates on the last stage so a slow resolve does not loop', () => {
    const m = mkEmbed('vid1');
    render(
      <MediaGrid
        items={[m]}
        selected={new Set()}
        onToggle={vi.fn()}
        onOpen={vi.fn()}
        isResolving={() => true}
        resolveErrorMap={{}}
      />
    );
    act(() => {
      // 30s — way past the last stage timing.
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText('准备直链…')).toBeTruthy();
    // Older stage labels must NOT be visible — that would mean the timer
    // wrapped back to stage 0 and looked like a restart.
    expect(screen.queryByText('联系视频站点…')).toBeNull();
  });

  it('renders the resolving chip with the amber "resolving" class, not the bare blue tag', () => {
    const m = mkEmbed('vid1');
    const { container } = render(
      <MediaGrid
        items={[m]}
        selected={new Set()}
        onToggle={vi.fn()}
        onOpen={vi.fn()}
        isResolving={() => true}
        resolveErrorMap={{}}
      />
    );
    // The chip is the only .card-embed-tag.resolving in the tree.
    const chip = container.querySelector('.card-embed-tag.resolving');
    expect(chip).not.toBeNull();
    // The amber spinner is a sibling element — its presence means we used
    // the new ResolvingChip path, not the old static "⏳ 解析中…" string.
    expect(container.querySelector('.card-embed-spinner')).not.toBeNull();
  });

  it('does NOT render the resolving chip when resolveError is set', () => {
    const m = mkEmbed('vid1');
    render(
      <MediaGrid
        items={[m]}
        selected={new Set()}
        onToggle={vi.fn()}
        onOpen={vi.fn()}
        isResolving={() => false}
        resolveErrorMap={{ vid1: 'yt-dlp returned 1' }}
        onRetryResolve={vi.fn()}
      />
    );
    expect(screen.queryByText(/联系视频站点…/)).toBeNull();
    // Failure path keeps the existing "↻ 重试解析" button.
    expect(screen.getByRole('button', { name: '重试解析' })).toBeTruthy();
  });
});
