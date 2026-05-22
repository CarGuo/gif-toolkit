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
 * R-COMPRESS-V1 wave 1 — sniff history card「☁ 上传 N」pill becomes
 * a clickable button when the record has at least one done upload AND
 * the panel is given an onJumpToUploadHistory callback. Clicking it
 * routes to the upload-history tab without also opening the detail
 * modal (the underlying card click). Three regressions guarded:
 *
 *   1. With `uploadedDone === 0` (no uploads yet) the upload pill stays
 *      a plain <span> — i.e. NOT a <button> — so the user never sees a
 *      dead-end clickable affordance.
 *   2. With `uploadedDone > 0` AND callback provided the upload pill
 *      becomes a <button>, clicking it fires onJumpToUploadHistory(rec)
 *      exactly once and does NOT also fire onOpenDetail (the surrounding
 *      card click).
 *   3. With `uploadedDone > 0` but NO onJumpToUploadHistory prop the
 *      pill stays a <span> — feature is opt-in, callers that haven't
 *      wired the route yet keep the old behavior.
 */
describe('HistoryPanel — sniff→upload jump (R-COMPRESS-V1)', () => {
  function fixtureWithUpload(): HistoryRecord {
    const rec = fixture();
    // Mark the video task done with one output, then attach a done upload
    // for that output. uploadedDone counter on the card scans this map.
    rec.taskStatus = { 'v-1': 'done' };
    rec.outputsByTaskId = { 'v-1': ['/out/clip.gif'] };
    rec.uploadsByOutputPath = {
      '/out/clip.gif': {
        url: 'https://cdn.test/clip.gif',
        status: 'done',
        uploadedAt: 1700000001000,
        backend: 'github'
      }
    };
    return rec;
  }

  it('keeps upload pill non-clickable when uploadedDone === 0', () => {
    render(
      <HistoryPanel
        history={[fixture()]}
        onOpenDetail={() => undefined}
        onOpenOutputDir={() => undefined}
        onRemove={() => undefined}
        onClear={() => undefined}
        onJumpToUploadHistory={() => undefined}
      />
    );
    // Upload pill exists (every card renders three stages) but is a span.
    const uploadPills = document.querySelectorAll('.hist-stage-upload');
    expect(uploadPills.length).toBe(1);
    expect(uploadPills[0].tagName).toBe('SPAN');
  });

  it('upload pill is a clickable button + jump fires + no onOpenDetail', () => {
    const onJumpToUploadHistory = vi.fn();
    const onOpenDetail = vi.fn();
    const rec = fixtureWithUpload();
    render(
      <HistoryPanel
        history={[rec]}
        onOpenDetail={onOpenDetail}
        onOpenOutputDir={() => undefined}
        onRemove={() => undefined}
        onClear={() => undefined}
        onJumpToUploadHistory={onJumpToUploadHistory}
      />
    );
    const pill = document.querySelector('button.hist-stage.hist-stage-upload');
    expect(pill).toBeTruthy();
    expect(pill?.classList.contains('is-clickable')).toBe(true);
    fireEvent.click(pill!);
    expect(onJumpToUploadHistory).toHaveBeenCalledTimes(1);
    expect(onJumpToUploadHistory.mock.calls[0][0].id).toBe(rec.id);
    // Critical: must not also bubble to the surrounding card onClick
    // (which would open HistoryDetailModal). stopPropagation in the
    // button handler is what guarantees this.
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it('upload pill stays non-clickable when no onJumpToUploadHistory prop is given', () => {
    render(
      <HistoryPanel
        history={[fixtureWithUpload()]}
        onOpenDetail={() => undefined}
        onOpenOutputDir={() => undefined}
        onRemove={() => undefined}
        onClear={() => undefined}
      />
    );
    const pill = document.querySelector('.hist-stage-upload');
    expect(pill?.tagName).toBe('SPAN');
  });
});

describe('HistoryPanel stage stepper (R-WS-90 P5g)', () => {
  /**
   * R-WS-90 P5g — three-stage status stepper on each card:
   *   ✦ 嗅探 → ⚙ 处理 → ☁ 上传
   * The stepper reads three independent signals already present on
   * the HistoryRecord (no extra IPC):
   *   - sniff   : items.length > 0
   *   - process : any taskStatus value === 'done' || 'failed'
   *   - upload  : any uploadsByOutputPath entry with
   *               status === 'done' && url非空
   * The user signed off "只嗅探 / 有处理过 / 有上传 要能一眼看出来",
   * so we pin three orthogonal scenarios + the data-reached-stage
   * marker that the CSS keys off for ambient tinting.
   */
  it('shows only the sniff stage as active when no batch has run', () => {
    const { container } = render(
      <HistoryPanel
        history={[fixture()]}
        onOpenDetail={() => undefined}
        onOpenOutputDir={() => undefined}
        onRemove={() => undefined}
        onClear={() => undefined}
      />
    );
    const card = container.querySelector('.hist-card') as HTMLElement;
    expect(card.getAttribute('data-reached-stage')).toBe('sniff');
    expect(card.querySelector('.hist-stage-sniff')?.classList.contains('is-active')).toBe(true);
    expect(card.querySelector('.hist-stage-process')?.classList.contains('is-active')).toBe(false);
    expect(card.querySelector('.hist-stage-upload')?.classList.contains('is-active')).toBe(false);
  });

  it('lights up the process stage when at least one task reached a terminal status', () => {
    const rec = fixture({
      taskStatus: { 'v-1': 'done', 'i-1': 'failed' }
    });
    const { container } = render(
      <HistoryPanel
        history={[rec]}
        onOpenDetail={() => undefined}
        onOpenOutputDir={() => undefined}
        onRemove={() => undefined}
        onClear={() => undefined}
      />
    );
    const card = container.querySelector('.hist-card') as HTMLElement;
    expect(card.getAttribute('data-reached-stage')).toBe('process');
    expect(card.querySelector('.hist-stage-process')?.classList.contains('is-active')).toBe(true);
    expect(card.querySelector('.hist-stage-upload')?.classList.contains('is-active')).toBe(false);
  });

  it('lights up the upload stage and ribbons the card once any output is uploaded', () => {
    const rec = fixture({
      taskStatus: { 'v-1': 'done' },
      outputsByTaskId: { 'v-1': ['/Users/me/out/clip.gif'] },
      uploadsByOutputPath: {
        '/Users/me/out/clip.gif': {
          url: 'https://cdn.example.com/clip.gif',
          status: 'done',
          uploadedAt: 1700000001000,
          backend: 'github'
        }
      }
    });
    const { container } = render(
      <HistoryPanel
        history={[rec]}
        onOpenDetail={() => undefined}
        onOpenOutputDir={() => undefined}
        onRemove={() => undefined}
        onClear={() => undefined}
      />
    );
    const card = container.querySelector('.hist-card') as HTMLElement;
    expect(card.getAttribute('data-reached-stage')).toBe('upload');
    expect(card.querySelector('.hist-stage-upload')?.classList.contains('is-active')).toBe(true);
    expect(card.querySelector('.hist-stage-process')?.classList.contains('is-active')).toBe(true);
    expect(card.querySelector('.hist-stage-sniff')?.classList.contains('is-active')).toBe(true);
  });

  it('treats a failed/cancelled upload as NOT reaching the upload stage', () => {
    // 关键边界:upload status 必须是 'done' 且 url 非空才算"已上传",
    // 'failed' / 'cancelled' 仅计入失败计数,不点亮第三段。
    const rec = fixture({
      taskStatus: { 'v-1': 'done' },
      outputsByTaskId: { 'v-1': ['/Users/me/out/clip.gif'] },
      uploadsByOutputPath: {
        '/Users/me/out/clip.gif': {
          url: '',
          status: 'failed',
          uploadedAt: 1700000001000,
          backend: 'github'
        }
      }
    });
    const { container } = render(
      <HistoryPanel
        history={[rec]}
        onOpenDetail={() => undefined}
        onOpenOutputDir={() => undefined}
        onRemove={() => undefined}
        onClear={() => undefined}
      />
    );
    const card = container.querySelector('.hist-card') as HTMLElement;
    expect(card.getAttribute('data-reached-stage')).toBe('process');
    expect(card.querySelector('.hist-stage-upload')?.classList.contains('is-active')).toBe(false);
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

/**
 * R-84 — Pagination.
 *
 * The history panel now exposes a 「← 上一页 / 第 X / Y 页 / 下一页 →」
 * + jump-to-page input strip when the record count exceeds the page
 * size. We pin three properties:
 *   1. With <= pageSize records, the pager strip is NOT rendered.
 *   2. With > pageSize records, only the first `pageSize` are visible
 *      until the user pages forward.
 *   3. Removing the only record on the last page auto-walks back to
 *      the previous page (paginateHistory's safePage clamp).
 */
describe('HistoryPanel pagination (R-84)', () => {
  function manyRecords(n: number): HistoryRecord[] {
    return Array.from({ length: n }, (_, i) =>
      fixture({ id: `rec-${i + 1}`, title: `示例文章 #${i + 1}` })
    );
  }

  it('does not render the pager strip when records fit a single page', () => {
    const { container } = render(
      <HistoryPanel
        history={manyRecords(3)}
        pageSize={5}
        onOpenDetail={() => undefined}
        onOpenOutputDir={() => undefined}
        onRemove={() => undefined}
        onClear={() => undefined}
      />
    );
    expect(container.querySelector('.hist-pager')).toBeNull();
  });

  it('paginates: only the first page is visible until ▶ is clicked', () => {
    render(
      <HistoryPanel
        history={manyRecords(7)}
        pageSize={3}
        onOpenDetail={() => undefined}
        onOpenOutputDir={() => undefined}
        onRemove={() => undefined}
        onClear={() => undefined}
      />
    );
    // page 1 of 3 (ceil(7/3) = 3)
    expect(screen.getByText('示例文章 #1')).toBeInTheDocument();
    expect(screen.getByText('示例文章 #3')).toBeInTheDocument();
    expect(screen.queryByText('示例文章 #4')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('下一页'));
    expect(screen.getByText('示例文章 #4')).toBeInTheDocument();
    expect(screen.getByText('示例文章 #6')).toBeInTheDocument();
    expect(screen.queryByText('示例文章 #1')).not.toBeInTheDocument();
  });

  it('jump-to-page input clamps and navigates', () => {
    render(
      <HistoryPanel
        history={manyRecords(10)}
        pageSize={3}
        onOpenDetail={() => undefined}
        onOpenOutputDir={() => undefined}
        onRemove={() => undefined}
        onClear={() => undefined}
      />
    );
    const jump = screen.getByLabelText('跳转到页码') as HTMLInputElement;
    // 10 / 3 = 4 pages. Asking for 99 must clamp to 4.
    fireEvent.change(jump, { target: { value: '99' } });
    expect(screen.getByText('示例文章 #10')).toBeInTheDocument();
    expect(screen.queryByText('示例文章 #1')).not.toBeInTheDocument();
  });
});
