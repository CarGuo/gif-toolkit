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

  // R-28 #3 — when App seeds a `pending` row immediately on dispatch,
  // the table must render the row right away (no longer empty), with
  // a 0% bar and the "已加入队列" message. This is the visible
  // contract that fixes the user's "批量处理时,有已解析的视频,它
  // 应该立刻出现在进度列表里" complaint.
  it('renders a pending row immediately with 0% bar and queued message', () => {
    const m = mkMedia('a');
    const progress = {
      a: { taskId: 'a', status: 'pending' as const, percent: 0, message: '已加入队列' }
    };
    render(<TaskTable items={[m]} progress={progress} />);
    // Empty placeholder is gone.
    expect(screen.queryByText(/开始批处理后这里会出现进度/)).toBeNull();
    // Message visible.
    expect(screen.getByText(/已加入队列/)).toBeInTheDocument();
    // Bar at 0%.
    const bar = document.querySelector('.bar') as HTMLElement;
    expect(bar.style.width).toBe('0%');
  });
});

/**
 * R-26 — spec failures (errorCode === 'ASPECT_RATIO_OUT_OF_RANGE') must
 * render a "强制允许" button instead of "重试". Re-trying a spec
 * violation verbatim is meaningless; the user wants an *override*
 * button. Runtime / network / transcode failures still get the original
 * "重试" button.
 */
describe('TaskTable R-26 force-allow vs retry split', () => {
  it('renders 强制允许 (and NOT 重试) when errorCode is ASPECT_RATIO_OUT_OF_RANGE', () => {
    const m = mkMedia('a');
    const progress = {
      a: mkProgress('a', 'failed', {
        error: 'aspect ratio out of range: 1080x646',
        errorCode: 'ASPECT_RATIO_OUT_OF_RANGE',
        errorMeta: { origW: 1080, origH: 646, minSide: 450, maxSide: 800, shortSideAtMax: 299 }
      })
    };
    render(
      <TaskTable
        items={[m]}
        progress={progress}
        onRetry={vi.fn()}
        onForceAllow={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: /强制允许/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^重试$/ })).toBeNull();
  });

  it('renders 重试 (and NOT 强制允许) for runtime failures', () => {
    const m = mkMedia('a');
    const progress = {
      a: mkProgress('a', 'failed', { error: 'ffmpeg exit 1: network timeout' })
    };
    render(
      <TaskTable
        items={[m]}
        progress={progress}
        onRetry={vi.fn()}
        onForceAllow={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: /^重试$/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /强制允许/ })).toBeNull();
  });

  it('calls onForceAllow with the media when the button is clicked', () => {
    const m = mkMedia('a');
    const onForceAllow = vi.fn();
    const onRetry = vi.fn();
    render(
      <TaskTable
        items={[m]}
        progress={{
          a: mkProgress('a', 'failed', { errorCode: 'ASPECT_RATIO_OUT_OF_RANGE' })
        }}
        onRetry={onRetry}
        onForceAllow={onForceAllow}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /强制允许/ }));
    expect(onForceAllow).toHaveBeenCalledTimes(1);
    expect(onForceAllow).toHaveBeenCalledWith(m);
    // Critical: a spec failure must not also trigger onRetry — we want a
    // single deliberate action, never a double-fire.
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('falls back to nothing when errorCode is set but onForceAllow is missing', () => {
    // Defensive: if a host renders TaskTable without wiring onForceAllow,
    // we must NOT silently render the "重试" button as a fallback —
    // that would re-create the original UX bug R-26 set out to fix.
    const m = mkMedia('a');
    render(
      <TaskTable
        items={[m]}
        progress={{
          a: mkProgress('a', 'failed', { errorCode: 'ASPECT_RATIO_OUT_OF_RANGE' })
        }}
        onRetry={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: /强制允许/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^重试$/ })).toBeNull();
  });
});

describe('TaskTable manual-optimize button (R-33)', () => {
  it('renders 手动优化 only on done rows whose warning indicates over-target', () => {
    const items = [mkMedia('a'), mkMedia('b'), mkMedia('c'), mkMedia('d')];
    const progress = {
      a: mkProgress('a', 'done', { warning: 'final size 8.2MB exceeds hard target 5.0MB' }),
      b: mkProgress('b', 'done', { warning: 'did not reach soft target 1.5MB; saved at 3.2MB' }),
      c: mkProgress('c', 'done'), // no warning -> no button
      d: mkProgress('d', 'failed', { warning: 'exceeds hard target' }) // not done -> no button
    };
    render(
      <TaskTable
        items={items}
        progress={progress}
        onManualOptimize={vi.fn()}
      />
    );
    expect(screen.getAllByRole('button', { name: /手动优化/ })).toHaveLength(2);
  });

  it('does not render 手动优化 when onManualOptimize is missing', () => {
    const items = [mkMedia('a')];
    const progress = {
      a: mkProgress('a', 'done', { warning: 'final size 8.2MB exceeds hard target 5.0MB' })
    };
    render(<TaskTable items={items} progress={progress} />);
    expect(screen.queryByRole('button', { name: /手动优化/ })).toBeNull();
  });

  it('calls onManualOptimize with media + progress when clicked', () => {
    const m = mkMedia('a');
    const p = mkProgress('a', 'done', { warning: 'exceeds hard target', currentSizeMB: 7.3 });
    const cb = vi.fn();
    render(<TaskTable items={[m]} progress={{ a: p }} onManualOptimize={cb} />);
    fireEvent.click(screen.getByRole('button', { name: /手动优化/ }));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(m, expect.objectContaining({ warning: 'exceeds hard target' }));
  });
});

// R-43.2 — per-row cancel button. Visible only while the task is in a
// non-terminal status; firing onCancelOne disables the button to absorb
// double-clicks while the IPC round-trip is in flight.
describe('TaskTable per-row cancel button (R-43.2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows ✕ 取消 only for non-terminal rows', () => {
    const m1 = mkMedia('running');
    const m2 = mkMedia('done');
    const m3 = mkMedia('failed');
    const m4 = mkMedia('cancelled');
    render(
      <TaskTable
        items={[m1, m2, m3, m4]}
        progress={{
          running: mkProgress('running', 'compressing'),
          done: mkProgress('done', 'done', { percent: 100 }),
          failed: mkProgress('failed', 'failed', { error: 'boom' }),
          cancelled: mkProgress('cancelled', 'cancelled', { percent: 100 })
        }}
        onCancelOne={vi.fn()}
      />
    );
    const cancelBtns = screen.getAllByRole('button', { name: '取消任务' });
    expect(cancelBtns).toHaveLength(1);
  });

  it('does not render ✕ 取消 when onCancelOne is omitted (read-only view)', () => {
    const m = mkMedia('a');
    render(
      <TaskTable
        items={[m]}
        progress={{ a: mkProgress('a', 'compressing') }}
      />
    );
    expect(screen.queryByRole('button', { name: '取消任务' })).toBeNull();
  });

  it('calls onCancelOne with the matching media; double-click is absorbed', async () => {
    const m = mkMedia('a');
    let resolve: (() => void) | null = null;
    const cb = vi.fn().mockImplementation(
      () => new Promise<void>((r) => { resolve = r; })
    );
    render(
      <TaskTable
        items={[m]}
        progress={{ a: mkProgress('a', 'compressing') }}
        onCancelOne={cb}
      />
    );
    const btn = screen.getByRole('button', { name: '取消任务' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(m);
    resolve!();
  });
});
