/**
 * R-27 — UI tests for the history panel.
 *
 * The panel is intentionally pure; we feed it fixtures and observe
 * the DOM + callback invocations. No localStorage involved.
 *
 * Critical UX invariants:
 *   - Empty state shows the educational hint.
 *   - Toolbar shows "{N} / 30" and clear-button is gated on confirm().
 *   - Row collapses/expands on click; expansion reveals media table.
 *   - "打开目录" only appears when outputDir is set.
 *   - "重跑" is disabled for images and for embeds without resolved
 *     direct link, with a clear tooltip explaining why.
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
  // Reset confirm() default to "yes" — individual tests can override.
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('HistoryPanel', () => {
  it('shows the empty-state hint when there are no records', () => {
    render(
      <HistoryPanel
        history={[]}
        onOpenOutputDir={() => undefined}
        onReprocessOne={() => undefined}
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
        onOpenOutputDir={() => undefined}
        onReprocessOne={() => undefined}
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
        onOpenOutputDir={() => undefined}
        onReprocessOne={() => undefined}
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

  it('expands a row on click and reveals media items', () => {
    render(
      <HistoryPanel
        history={[fixture()]}
        onOpenOutputDir={() => undefined}
        onReprocessOne={() => undefined}
        onRemove={() => undefined}
        onClear={() => undefined}
      />
    );
    // Collapsed: table not yet rendered.
    expect(screen.queryByRole('columnheader', { name: '媒体' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('示例文章'));
    expect(screen.getByRole('columnheader', { name: '媒体' })).toBeInTheDocument();
    // All three items rendered.
    expect(screen.getAllByText('重跑')).toHaveLength(3);
  });

  it('disables 重跑 for images and unresolved embeds, enables it for plain video', () => {
    const onReprocessOne = vi.fn();
    render(
      <HistoryPanel
        history={[fixture()]}
        onOpenOutputDir={() => undefined}
        onReprocessOne={onReprocessOne}
        onRemove={() => undefined}
        onClear={() => undefined}
      />
    );
    fireEvent.click(screen.getByText('示例文章'));
    const buttons = screen.getAllByText('重跑') as HTMLButtonElement[];
    // Order matches items[]: video (enabled), image (disabled), unresolved embed (disabled).
    expect(buttons[0].disabled).toBe(false);
    expect(buttons[1].disabled).toBe(true);
    expect(buttons[1].title).toContain('image');
    expect(buttons[2].disabled).toBe(true);
    expect(buttons[2].title).toContain('embed');

    fireEvent.click(buttons[0]);
    expect(onReprocessOne).toHaveBeenCalledTimes(1);
    expect(onReprocessOne.mock.calls[0][1].id).toBe('v-1');
  });

  it('opens the per-record output directory via onOpenOutputDir', () => {
    const onOpenOutputDir = vi.fn();
    render(
      <HistoryPanel
        history={[fixture({ outputDir: '/Users/me/x' })]}
        onOpenOutputDir={onOpenOutputDir}
        onReprocessOne={() => undefined}
        onRemove={() => undefined}
        onClear={() => undefined}
      />
    );
    fireEvent.click(screen.getByText('示例文章'));
    fireEvent.click(screen.getByText('打开目录'));
    expect(onOpenOutputDir).toHaveBeenCalledWith('/Users/me/x');
  });

  it('hides 打开目录 button when no outputDir is set', () => {
    render(
      <HistoryPanel
        history={[fixture({ outputDir: undefined })]}
        onOpenOutputDir={() => undefined}
        onReprocessOne={() => undefined}
        onRemove={() => undefined}
        onClear={() => undefined}
      />
    );
    fireEvent.click(screen.getByText('示例文章'));
    expect(screen.queryByText('打开目录')).not.toBeInTheDocument();
    expect(screen.getByText('尚未批处理')).toBeInTheDocument();
  });

  it('forwards 删除此条 to onRemove with the record id', () => {
    const onRemove = vi.fn();
    render(
      <HistoryPanel
        history={[fixture()]}
        onOpenOutputDir={() => undefined}
        onReprocessOne={() => undefined}
        onRemove={onRemove}
        onClear={() => undefined}
      />
    );
    fireEvent.click(screen.getByText('示例文章'));
    fireEvent.click(screen.getByText('删除此条'));
    expect(onRemove).toHaveBeenCalledWith('rec-1');
  });
});
