/**
 * R-27 → R-28 → R-34 — UI tests for the history panel.
 *
 * The panel is intentionally pure; we feed it fixtures and observe
 * the DOM + callback invocations. No localStorage involved.
 *
 * Critical UX invariants (post-R-34):
 *   - Empty state shows the educational hint.
 *   - Toolbar shows "{N} / 30" and clear-button is gated on confirm().
 *   - Clicking a row fires onOpenDetail(rec) — the inline expand was
 *     replaced by the HistoryDetailModal, so this is now the only
 *     click path for "view items / re-run".
 *   - Per-row actions: 打开目录 (only with outputDir) + 删除 — both
 *     stop propagation so they never accidentally open the detail.
 *   - Cover is a fixed decorative SVG icon — independent of the
 *     record's items (no IPC, no <Thumb/>, no <img src=poster>).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HistoryPanel } from '../../src/renderer/components/HistoryPanel';
import { makeHistoryRecord, type HistoryRecord } from '../../src/renderer/components/useHistory';
import { DEFAULT_OPTIONS } from '../../src/shared/types';
import type { SniffedMedia } from '../../src/shared/types';

const videoMedia: SniffedMedia = {
  id: 'v-1',
  kind: 'video',
  url: 'https://x.test/clip.mp4',
  pageUrl: 'https://x.test/p',
  source: 'video-tag'
};
const imageMedia: SniffedMedia = {
  id: 'i-1',
  kind: 'image',
  url: 'https://x.test/pic.png',
  pageUrl: 'https://x.test/p',
  source: 'img-tag'
};
const unresolvedEmbed: SniffedMedia = {
  id: 'e-1',
  kind: 'video',
  url: 'https://vimeo.com/12345',
  pageUrl: 'https://x.test/p',
  source: 'iframe-embed',
  requiresExternalDownload: true,
  embedHost: 'vimeo.com'
};

function fixture(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    ...makeHistoryRecord({
      id: 'rec-1',
      createdAt: 1700000000000,
      pageUrl: 'https://x.test/p',
      title: '示例文章',
      items: [videoMedia, imageMedia, unresolvedEmbed],
      options: DEFAULT_OPTIONS,
      outputDir: '/Users/me/giftk/示例'
    }),
    ...overrides
  };
}

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('HistoryPanel (R-28)', () => {
  it('shows the empty-state hint when there are no records', () => {
    render(
      <HistoryPanel
        history={[]}
        onOpenDetail={() => undefined}
        onOpenOutputDir={() => undefined}
        onRemove={() => undefined}
        onClear={() => undefined}
      />
    );
    expect(screen.getByText('还没有历史记录')).toBeInTheDocument();
    expect(screen.queryByText(/清空历史/)).not.toBeInTheDocument();
  });

  it('renders toolbar count "N / 30" and a clear-history button', () => {
    render(
      <HistoryPanel
        history={[fixture(), fixture({ id: 'rec-2' })]}
        onOpenDetail={() => undefined}
        onOpenOutputDir={() => undefined}
        onRemove={() => undefined}
        onClear={() => undefined}
      />
    );
    expect(screen.getByText('2 / 30')).toBeInTheDocument();
    expect(screen.getByText('清空历史')).toBeInTheDocument();
  });

  it('only fires onClear after confirm() returns true', () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const onClear = vi.fn();
    render(
      <HistoryPanel
        history={[fixture()]}
        onOpenDetail={() => undefined}
        onOpenOutputDir={() => undefined}
        onRemove={() => undefined}
        onClear={onClear}
      />
    );
    confirmSpy.mockReturnValueOnce(false);
    fireEvent.click(screen.getByText('清空历史'));
    expect(onClear).not.toHaveBeenCalled();
    confirmSpy.mockReturnValueOnce(true);
    fireEvent.click(screen.getByText('清空历史'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('fires onOpenDetail when the row head is clicked', () => {
    const onOpenDetail = vi.fn();
    const rec = fixture();
    render(
      <HistoryPanel
        history={[rec]}
        onOpenDetail={onOpenDetail}
        onOpenOutputDir={() => undefined}
        onRemove={() => undefined}
        onClear={() => undefined}
      />
    );
    fireEvent.click(screen.getByText('示例文章'));
    expect(onOpenDetail).toHaveBeenCalledTimes(1);
    expect(onOpenDetail.mock.calls[0][0].id).toBe('rec-1');
  });

  it('opens the per-record output directory and does NOT trigger onOpenDetail', () => {
    const onOpenOutputDir = vi.fn();
    const onOpenDetail = vi.fn();
    render(
      <HistoryPanel
        history={[fixture({ outputDir: '/Users/me/x' })]}
        onOpenDetail={onOpenDetail}
        onOpenOutputDir={onOpenOutputDir}
        onRemove={() => undefined}
        onClear={() => undefined}
      />
    );
    fireEvent.click(screen.getByText('打开目录'));
    expect(onOpenOutputDir).toHaveBeenCalledWith('/Users/me/x');
    // R-28: per-row actions stop propagation so the row's onClick never fires.
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it('hides 打开目录 button when no outputDir is set', () => {
    render(
      <HistoryPanel
        history={[fixture({ outputDir: undefined })]}
        onOpenDetail={() => undefined}
        onOpenOutputDir={() => undefined}
        onRemove={() => undefined}
        onClear={() => undefined}
      />
    );
    expect(screen.queryByText('打开目录')).not.toBeInTheDocument();
  });

  it('forwards 删除 to onRemove with the record id and stops row click', () => {
    const onRemove = vi.fn();
    const onOpenDetail = vi.fn();
    render(
      <HistoryPanel
        history={[fixture()]}
        onOpenDetail={onOpenDetail}
        onOpenOutputDir={() => undefined}
        onRemove={onRemove}
        onClear={() => undefined}
      />
    );
    fireEvent.click(screen.getByText('删除'));
    expect(onRemove).toHaveBeenCalledWith('rec-1');
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it('does NOT call onRemove if the per-record confirm() is cancelled', () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const onRemove = vi.fn();
    render(
      <HistoryPanel
        history={[fixture()]}
        onOpenDetail={() => undefined}
        onOpenOutputDir={() => undefined}
        onRemove={onRemove}
        onClear={() => undefined}
      />
    );
    confirmSpy.mockReturnValueOnce(false);
    fireEvent.click(screen.getByText('删除'));
    expect(onRemove).not.toHaveBeenCalled();
  });
});

/**
 * R-34 — fixed cover policy.
 *
 * The previous policy ran a `pickCover` selector that, depending on
 * the items, either fetched an HTTP poster URL or routed through the
 * <Thumb/> IPC bridge (which downloads media and runs ffmpeg). Both
 * paths were costly and the user feedback was "the picture is wrong"
 * for embeds / unresolved URLs. We now render a static decorative
 * cover for every record — this test pins that contract so a future
 * refactor doesn't accidentally reintroduce the dynamic pipeline.
 */
describe('HistoryPanel cover (R-34, fixed)', () => {
  it('renders the static .hist-card-cover-fixed element regardless of items', () => {
    const { container } = render(
      <HistoryPanel
        history={[
          fixture({ id: 'r-with-poster', items: [{ ...videoMedia, poster: 'https://x.test/p.jpg' }] }),
          fixture({ id: 'r-with-embed', items: [unresolvedEmbed] }),
          fixture({ id: 'r-empty', items: [] })
        ]}
        onOpenDetail={() => undefined}
        onOpenOutputDir={() => undefined}
        onRemove={() => undefined}
        onClear={() => undefined}
      />
    );
    const fixedCovers = container.querySelectorAll('.hist-card-cover-fixed');
    expect(fixedCovers).toHaveLength(3);
    // No Thumb-bridge images, no poster <img> tags, ever.
    expect(container.querySelector('.hist-card-poster')).toBeNull();
    expect(container.querySelector('.card-thumb')).toBeNull();
  });
});
