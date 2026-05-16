/**
 * Tests for the retry / detail-modal interactions added to TaskTable.tsx.
 * These guard SC-15..SC-20 (failed → manually re-runnable; double-click is
 * absorbed; warnings open a copyable diagnostic dialog).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskTable } from '../../src/renderer/components/TaskTable';
import type { SniffedMedia, TaskProgress, TaskStatus } from '../../src/shared/types';

const mkMedia = (id: string, url = `https://x.com/${id}.gif`): SniffedMedia => ({
  id,
  url,
  kind: 'gif',
  source: 'pattern',
  pageUrl: 'https://x.com/page'
});

const mkProgress = (id: string, status: TaskStatus, over: Partial<TaskProgress> = {}): TaskProgress => ({
  taskId: id,
  status,
  percent: status === 'done' ? 100 : 50,
  ...over
});

describe('TaskTable retry button', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not render any retry button when onRetry is missing', () => {
    const m = mkMedia('a');
    render(<TaskTable items={[m]} progress={{ a: mkProgress('a', 'failed') }} />);
    expect(screen.queryByRole('button', { name: /重试/ })).toBeNull();
  });

  it('renders 重试 for failed and cancelled rows but not for done/processing', () => {
    const items = [mkMedia('a'), mkMedia('b'), mkMedia('c'), mkMedia('d')];
    const progress = {
      a: mkProgress('a', 'failed'),
      b: mkProgress('b', 'cancelled'),
      c: mkProgress('c', 'done'),
      d: mkProgress('d', 'compressing')
    };
    render(<TaskTable items={items} progress={progress} onRetry={vi.fn()} />);
    expect(screen.getAllByRole('button', { name: /重试/ })).toHaveLength(2);
  });

  it('calls onRetry with the media on click', () => {
    const m = mkMedia('a');
    const onRetry = vi.fn();
    render(<TaskTable items={[m]} progress={{ a: mkProgress('a', 'failed') }} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: /重试/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(m);
  });

  it('disables the button immediately after click to suppress double-fires', async () => {
    const m = mkMedia('a');
    const onRetry = vi.fn(() => Promise.resolve());
    render(<TaskTable items={[m]} progress={{ a: mkProgress('a', 'failed') }} onRetry={onRetry} />);
    const btn = screen.getByRole('button', { name: /重试/ });
    fireEvent.click(btn);
    fireEvent.click(btn); // second click should be absorbed
    fireEvent.click(btn);
    // Flush microtasks so the promise resolves but we keep fake timers in
    // control of the 1.5s release window.
    await Promise.resolve();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('TaskTable warning detail modal', () => {
  it('shows phase failures when the warning chip is clicked', () => {
    const m = mkMedia('a');
    const progress = {
      a: mkProgress('a', 'done', {
        warning: 'soft target missed',
        phaseFailures: ['gifsicle exit 1: out of memory', 'fps fallback to 8']
      })
    };
    render(<TaskTable items={[m]} progress={progress} />);
    fireEvent.click(screen.getByText(/soft target missed/));
    expect(screen.getByText(/gifsicle exit 1: out of memory/)).toBeTruthy();
    expect(screen.getByText(/fps fallback to 8/)).toBeTruthy();
  });

  it('renders a discreet "查看诊断" link when there is no warning but phase failures exist', () => {
    const m = mkMedia('a');
    const progress = {
      a: mkProgress('a', 'done', {
        phaseFailures: ['transient ffmpeg warning']
      })
    };
    render(<TaskTable items={[m]} progress={progress} />);
    fireEvent.click(screen.getByText(/查看诊断/));
    expect(screen.getByText(/transient ffmpeg warning/)).toBeTruthy();
  });

  it('closes when the user clicks 关闭', () => {
    const m = mkMedia('a');
    const progress = {
      a: mkProgress('a', 'failed', { error: 'boom', phaseFailures: ['x'] })
    };
    render(<TaskTable items={[m]} progress={progress} />);
    // Open via the diagnostic link
    fireEvent.click(screen.getByText(/查看诊断/));
    expect(screen.getByText(/Phase failures \(1\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.queryByText(/Phase failures \(1\)/)).toBeNull();
  });

  it('uses navigator.clipboard.writeText when 复制 is clicked', () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });
    const m = mkMedia('a');
    const progress = {
      a: mkProgress('a', 'failed', { error: 'boom', phaseFailures: ['x', 'y'] })
    };
    render(<TaskTable items={[m]} progress={progress} />);
    fireEvent.click(screen.getByText(/查看诊断/));
    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain('Error: boom');
    expect(writeText.mock.calls[0][0]).toContain('Phase failures (2)');
  });
});

describe('TaskTable empty state', () => {
  it('shows the placeholder when no items have progress yet', () => {
    render(<TaskTable items={[mkMedia('a')]} progress={{}} />);
    expect(screen.getByText(/任务列表/)).toBeTruthy();
  });
});
