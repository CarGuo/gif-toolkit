/**
 * R-32 — DOM tests for the recently-sniffed-URL popover.
 *
 * Covers the user-visible interactions:
 *   1. Renders one row per entry with title + url + meta.
 *   2. Click a row → onPick(url).
 *   3. Click the per-row ✕ → onRemove(url) and does NOT also fire onPick.
 *   4. Esc fires onClose.
 *   5. Click outside fires onClose.
 *   6. Click the footer 清空 → window.confirm + onClear.
 *   7. Empty state renders the "(无解析历史)" hint and no clear button.
 *   8. open=false renders nothing (no leaked DOM).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SniffHistoryPicker } from '../../src/renderer/components/SniffHistoryPicker';
import type { SniffHistoryEntry } from '../../src/renderer/components/useSniffHistory';

const sample: SniffHistoryEntry[] = [
  { url: 'https://a.test/post', title: 'Post A', ts: Date.now() - 60_000, itemCount: 5 },
  { url: 'https://b.test/post', title: 'Post B', ts: Date.now() - 60 * 60_000, itemCount: 0 }
];

beforeEach(() => {
  cleanup();
});

describe('<SniffHistoryPicker />', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(
      <SniffHistoryPicker
        open={false}
        entries={sample}
        onPick={() => undefined}
        onRemove={() => undefined}
        onClear={() => undefined}
        onClose={() => undefined}
      />
    );
    expect(container.querySelector('.sniff-hist-popover')).toBeNull();
  });

  it('renders one row per entry with url+title+counts', () => {
    render(
      <SniffHistoryPicker
        open
        entries={sample}
        onPick={() => undefined}
        onRemove={() => undefined}
        onClear={() => undefined}
        onClose={() => undefined}
      />
    );
    expect(screen.getByText('Post A')).toBeInTheDocument();
    expect(screen.getByText('Post B')).toBeInTheDocument();
    expect(screen.getByText('https://a.test/post')).toBeInTheDocument();
    expect(screen.getByText(/5 项/)).toBeInTheDocument();
    expect(screen.getByText(/0 项/)).toBeInTheDocument();
  });

  it('clicking a row fires onPick with that entry url', () => {
    const onPick = vi.fn();
    render(
      <SniffHistoryPicker
        open
        entries={sample}
        onPick={onPick}
        onRemove={() => undefined}
        onClear={() => undefined}
        onClose={() => undefined}
      />
    );
    fireEvent.click(screen.getByText('Post A'));
    expect(onPick).toHaveBeenCalledWith('https://a.test/post');
  });

  it('clicking the row ✕ fires onRemove only (does NOT also fire onPick)', () => {
    const onPick = vi.fn();
    const onRemove = vi.fn();
    render(
      <SniffHistoryPicker
        open
        entries={sample}
        onPick={onPick}
        onRemove={onRemove}
        onClear={() => undefined}
        onClose={() => undefined}
      />
    );
    const removeBtns = screen.getAllByLabelText(/从解析历史中删除/);
    fireEvent.click(removeBtns[0]);
    expect(onRemove).toHaveBeenCalledWith('https://a.test/post');
    expect(onPick).not.toHaveBeenCalled();
  });

  it('Esc fires onClose', () => {
    const onClose = vi.fn();
    render(
      <SniffHistoryPicker
        open
        entries={sample}
        onPick={() => undefined}
        onRemove={() => undefined}
        onClear={() => undefined}
        onClose={onClose}
      />
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('click outside fires onClose', () => {
    const onClose = vi.fn();
    const { container } = render(
      <div>
        <div data-testid="outside" />
        <SniffHistoryPicker
          open
          entries={sample}
          onPick={() => undefined}
          onRemove={() => undefined}
          onClear={() => undefined}
          onClose={onClose}
        />
      </div>
    );
    // Mousedown must be on a node not inside the popover.
    const outside = container.querySelector('[data-testid="outside"]') as HTMLElement;
    fireEvent.mouseDown(outside);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('清空 button confirms and calls onClear', () => {
    const onClear = vi.fn();
    const orig = window.confirm;
    window.confirm = vi.fn().mockReturnValue(true);
    try {
      render(
        <SniffHistoryPicker
          open
          entries={sample}
          onPick={() => undefined}
          onRemove={() => undefined}
          onClear={onClear}
          onClose={() => undefined}
        />
      );
      fireEvent.click(screen.getByText('清空'));
      expect(window.confirm).toHaveBeenCalled();
      expect(onClear).toHaveBeenCalledTimes(1);
    } finally {
      window.confirm = orig;
    }
  });

  it('empty entries renders the "(无解析历史)" hint and no clear button', () => {
    render(
      <SniffHistoryPicker
        open
        entries={[]}
        onPick={() => undefined}
        onRemove={() => undefined}
        onClear={() => undefined}
        onClose={() => undefined}
      />
    );
    expect(screen.getByText('(无解析历史)')).toBeInTheDocument();
    expect(screen.queryByText('清空')).toBeNull();
  });
});
