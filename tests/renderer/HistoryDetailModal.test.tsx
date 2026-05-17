/**
 * R-28 #2 — HistoryDetailModal: confirm the modal renders the
 * record-scoped UI and wires its callbacks correctly.
 *
 * Critical UX invariants:
 *   - Renders the record title in the header.
 *   - Mounts MediaGrid with the record's items.
 *   - 重跑选中 button calls onBatchFromRecord(rec, processable, opts)
 *     with the user's edited options + only the processable subset.
 *   - 处理此项 on a card calls onProcessOneFromRecord(rec, media).
 *   - onClose is called when ESC is pressed (without an open card).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { HistoryDetailModal } from '../../src/renderer/components/HistoryDetailModal';
import { makeHistoryRecord, type HistoryRecord } from '../../src/renderer/components/useHistory';
import { DEFAULT_OPTIONS } from '../../src/shared/types';
import type { SniffedMedia } from '../../src/shared/types';

const video: SniffedMedia = {
  id: 'v-1',
  url: 'https://x.test/clip.mp4',
  kind: 'video',
  source: 'video-tag',
  pageUrl: 'https://x.test/p'
};
const image: SniffedMedia = {
  id: 'i-1',
  url: 'https://x.test/pic.png',
  kind: 'image',
  source: 'img-tag',
  pageUrl: 'https://x.test/p'
};

function makeRec(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    ...makeHistoryRecord({
      id: 'rec-1',
      createdAt: 1700000000000,
      pageUrl: 'https://x.test/p',
      title: '示例文章',
      items: [video, image],
      options: DEFAULT_OPTIONS,
      outputDir: '/Users/me/giftk/示例'
    }),
    ...overrides
  };
}

describe('HistoryDetailModal', () => {
  it('renders the record title and item count', () => {
    render(
      <HistoryDetailModal
        rec={makeRec()}
        progress={{}}
        isProcessing={() => false}
        onProcessOneFromRecord={() => undefined}
        onBatchFromRecord={() => undefined}
        onCancel={() => undefined}
        onOpenOutputDir={() => undefined}
        onClose={() => undefined}
        logs={[]}
      />
    );
    expect(screen.getAllByText('示例文章').length).toBeGreaterThan(0);
    expect(screen.getByText(/媒体清单 \(2\)/)).toBeInTheDocument();
  });

  it('calls onBatchFromRecord with only processable items (image excluded)', () => {
    const onBatchFromRecord = vi.fn();
    const rec = makeRec();
    render(
      <HistoryDetailModal
        rec={rec}
        progress={{}}
        isProcessing={() => false}
        onProcessOneFromRecord={() => undefined}
        onBatchFromRecord={onBatchFromRecord}
        onCancel={() => undefined}
        onOpenOutputDir={() => undefined}
        onClose={() => undefined}
        logs={[]}
      />
    );
    // Default selection preselects video only (image is non-processable).
    const btn = screen.getByRole('button', { name: /重跑选中/ });
    fireEvent.click(btn);
    expect(onBatchFromRecord).toHaveBeenCalledTimes(1);
    const [recArg, mediasArg] = onBatchFromRecord.mock.calls[0];
    expect(recArg.id).toBe('rec-1');
    expect(mediasArg.map((m: SniffedMedia) => m.id)).toEqual(['v-1']);
  });

  it('calls onClose when ESC is pressed', () => {
    const onClose = vi.fn();
    render(
      <HistoryDetailModal
        rec={makeRec()}
        progress={{}}
        isProcessing={() => false}
        onProcessOneFromRecord={() => undefined}
        onBatchFromRecord={() => undefined}
        onCancel={() => undefined}
        onOpenOutputDir={() => undefined}
        onClose={onClose}
        logs={[]}
      />
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onOpenOutputDir when 打开目录 in header is clicked', () => {
    const onOpenOutputDir = vi.fn();
    render(
      <HistoryDetailModal
        rec={makeRec({ outputDir: '/tmp/out' })}
        progress={{}}
        isProcessing={() => false}
        onProcessOneFromRecord={() => undefined}
        onBatchFromRecord={() => undefined}
        onCancel={() => undefined}
        onOpenOutputDir={onOpenOutputDir}
        onClose={() => undefined}
        logs={[]}
      />
    );
    fireEvent.click(screen.getByText('打开目录'));
    expect(onOpenOutputDir).toHaveBeenCalledWith('/tmp/out');
  });

  it('hides 打开目录 in header when record has no outputDir', () => {
    render(
      <HistoryDetailModal
        rec={makeRec({ outputDir: undefined })}
        progress={{}}
        isProcessing={() => false}
        onProcessOneFromRecord={() => undefined}
        onBatchFromRecord={() => undefined}
        onCancel={() => undefined}
        onOpenOutputDir={() => undefined}
        onClose={() => undefined}
        logs={[]}
      />
    );
    expect(screen.queryByText('打开目录')).not.toBeInTheDocument();
  });
});
