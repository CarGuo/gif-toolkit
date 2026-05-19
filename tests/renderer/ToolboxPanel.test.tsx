/**
 * R-35 — ToolboxPanel render smoke tests.
 *
 * These cover only renderer-side wiring. We don't simulate the actual
 * processing pipeline (that lives in main and is tested via processor /
 * ffmpeg unit tests). Coverage:
 *   1. All four kind chips render and the active one is reflected in
 *      aria-selected.
 *   2. Clicking a chip swaps the params form (e.g. gif-optimize shows
 *      Lossy/Colors fields, gif-resize shows only target width).
 *   3. The 「选择文件」 button calls window.giftk.toolboxPickFiles with
 *      the current kind.
 *   4. The Start button is disabled when the queue is empty.
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ToolboxPanel } from '../../src/renderer/components/ToolboxPanel';

interface FakeGiftk {
  onProgress: ReturnType<typeof vi.fn>;
  toolboxPickFiles: ReturnType<typeof vi.fn>;
  startToolbox: ReturnType<typeof vi.fn>;
  cancelAll: ReturnType<typeof vi.fn>;
  openOutputDir: ReturnType<typeof vi.fn>;
}

function installFakeGiftk(): FakeGiftk {
  const fake: FakeGiftk = {
    onProgress: vi.fn(() => () => undefined),
    toolboxPickFiles: vi.fn(async () => [] as string[]),
    startToolbox: vi.fn(async () => ({ ok: true, outputDir: '/o' })),
    cancelAll: vi.fn(async () => undefined),
    openOutputDir: vi.fn(async () => undefined)
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).giftk = fake as any;
  return fake;
}

describe('ToolboxPanel', () => {
  beforeEach(() => {
    installFakeGiftk();
  });

  it('renders all ten kind chips, with video-to-gif active by default', () => {
    render(<ToolboxPanel />);
    const v2g = screen.getByRole('tab', { name: 'Video → GIF' });
    expect(v2g).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Video → WebP' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'GIF Resize' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'GIF Optimize' })).toHaveAttribute('aria-selected', 'false');
    // R-37 — Trim / Speed / Reverse / Rotate chips render alongside the
    // original four; they share the same kind-switcher tablist.
    expect(screen.getByRole('tab', { name: 'Trim' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'Speed' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'Reverse' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'Rotate' })).toHaveAttribute('aria-selected', 'false');
    // R-38 — Crop chip joins the row.
    expect(screen.getByRole('tab', { name: 'Crop' })).toHaveAttribute('aria-selected', 'false');
    // R-42 — GIF ↔ WebP convert chip is the tenth and final entry.
    expect(screen.getByRole('tab', { name: 'GIF ↔ WebP' })).toHaveAttribute('aria-selected', 'false');
  });

  it('switches the params form when a different kind is selected', () => {
    render(<ToolboxPanel />);
    // gif-resize only exposes 目标宽度.
    fireEvent.click(screen.getByRole('tab', { name: 'GIF Resize' }));
    expect(screen.getByText('目标宽度 (px)')).toBeInTheDocument();
    expect(screen.queryByText('FPS')).toBeNull();

    // gif-optimize defaults to method=lossy → shows Lossy 强度.
    fireEvent.click(screen.getByRole('tab', { name: 'GIF Optimize' }));
    expect(screen.getByText('Optimization method')).toBeInTheDocument();
    expect(screen.getByText('Lossy 强度 (0-200)')).toBeInTheDocument();
  });

  it('gif-optimize method picker swaps the visible sub-fields', () => {
    render(<ToolboxPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'GIF Optimize' }));
    // default = lossy → no colors / dropEveryN field yet.
    expect(screen.queryByText('颜色数 (2-256)')).toBeNull();
    expect(screen.queryByText('每 N 帧丢 1 (2-10)')).toBeNull();

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'color-reduction' } });
    expect(screen.getByText('颜色数 (2-256)')).toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'drop-every-nth' } });
    expect(screen.getByText('每 N 帧丢 1 (2-10)')).toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'budget' } });
    expect(screen.getByText('目标体积 (KB)')).toBeInTheDocument();
    expect(screen.getByText('软阈值 (KB)')).toBeInTheDocument();
  });

  it('clicking 选择文件 invokes toolboxPickFiles with the current kind', async () => {
    const fake = installFakeGiftk();
    fake.toolboxPickFiles.mockResolvedValueOnce(['/some/clip.mp4']);
    render(<ToolboxPanel />);
    await act(async () => {
      fireEvent.click(screen.getByText('选择文件'));
    });
    expect(fake.toolboxPickFiles).toHaveBeenCalledWith('video-to-gif');
  });

  it('surfaces an inline error notice when toolboxPickFiles rejects', async () => {
    const fake = installFakeGiftk();
    fake.toolboxPickFiles.mockRejectedValueOnce(new Error('no parent window'));
    render(<ToolboxPanel />);
    await act(async () => {
      fireEvent.click(screen.getByText('选择文件'));
    });
    // R-36 — the silent catch was the perceived "button is broken" root
    // cause; we now expect an alert role with the underlying message.
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toMatch(/no parent window/);
  });

  it('falls back to DOM file input when preload bridge lacks toolboxPickFiles', async () => {
    // Stale preload bundle scenario: window.giftk is present (other
    // methods exist) but the new toolboxPickFiles symbol is missing.
    // We expect (a) an inline notice telling the user to restart, and
    // (b) the hidden <input type="file"> being clicked as a fallback.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).giftk = {
      onProgress: vi.fn(() => () => undefined),
      startToolbox: vi.fn(async () => ({ ok: true, outputDir: '/o' })),
      cancelAll: vi.fn(async () => undefined),
      openOutputDir: vi.fn(async () => undefined)
      // toolboxPickFiles intentionally omitted.
    };
    render(<ToolboxPanel />);
    // Spy on the hidden input click — it's the fallback trigger.
    const hiddenInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(hiddenInput, 'click').mockImplementation(() => undefined);
    await act(async () => {
      fireEvent.click(screen.getByText('选择文件'));
    });
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toMatch(/preload/);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('disables 开始 button while queue is empty and enables it once a job is added', async () => {
    const fake = installFakeGiftk();
    fake.toolboxPickFiles.mockResolvedValueOnce(['/q/clip.mp4']);
    render(<ToolboxPanel />);
    const startBtn = screen.getByRole('button', { name: /开始/ });
    expect(startBtn).toBeDisabled();
    fireEvent.click(screen.getByText('选择文件'));
    // Wait for the awaited pickFiles + setState to flush.
    const row = await screen.findByText('clip.mp4');
    expect(row).toBeInTheDocument();
    expect(startBtn).not.toBeDisabled();
  });

  // ============== R-37 — Trim / Speed / Reverse / Rotate ==============

  it('Trim chip swaps to startSec/endSec form and shows duration placeholder', () => {
    render(<ToolboxPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Trim' }));
    expect(screen.getByText('开始 (秒)')).toBeInTheDocument();
    expect(screen.getByText('结束 (秒)')).toBeInTheDocument();
    // The video-to-gif's FPS field should be gone now.
    expect(screen.queryByText('FPS')).toBeNull();
    // R-38 — without jobs the duration helper shows a guidance message.
    expect(screen.getByTestId('trim-duration-info').textContent).toMatch(/请先添加文件/);
  });

  it('Speed chip exposes a 速度 dropdown + 自定义倍率 numeric override', () => {
    render(<ToolboxPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Speed' }));
    expect(screen.getByText('速度')).toBeInTheDocument();
    expect(screen.getByText('自定义倍率')).toBeInTheDocument();
  });

  it('Reverse chip accepts gif and webp and shows no audio controls (R-41)', () => {
    render(<ToolboxPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Reverse' }));
    // R-41 — Reverse now accepts .gif AND .webp inputs (both formats
    // have no audio track), so the previously-shown 「同时倒放音频」
    // toggle is gone. The params panel should only contain the
    // explanatory info row.
    expect(screen.getByText(/将整段 GIF \/ WebP 倒放/)).toBeInTheDocument();
    expect(screen.queryByText(/同时倒放音频/)).toBeNull();
    expect(screen.queryByText('音频处理')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(document.querySelector('.tb-params input[type="checkbox"]')).toBeNull();
    // Dropzone hint copy reflects the new whitelist (.gif + .webp).
    expect(screen.getAllByText(/支持 \.gif \/ \.webp/).length).toBeGreaterThan(0);
  });

  it('Rotate chip exposes 旋转角度 + flipH/flipV checkboxes', () => {
    render(<ToolboxPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Rotate' }));
    expect(screen.getByText('旋转角度')).toBeInTheDocument();
    expect(screen.getByText(/水平翻转 \(flipH\)/)).toBeInTheDocument();
    expect(screen.getByText(/垂直翻转 \(flipV\)/)).toBeInTheDocument();
    const checks = document.querySelectorAll('input[type="checkbox"]');
    // Two checkboxes — flipH + flipV. Both default unchecked.
    expect(checks.length).toBeGreaterThanOrEqual(2);
    expect((checks[0] as HTMLInputElement).checked).toBe(false);
    expect((checks[1] as HTMLInputElement).checked).toBe(false);
  });

  // ============== R-38 — Crop + cross-kind job retention ==============

  it('Crop chip renders a single-file guidance line and keeps Start disabled', () => {
    render(<ToolboxPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Crop' }));
    expect(screen.getByText(/请先添加一个文件以加载预览|正在生成预览/)).toBeInTheDocument();
    // The "仅支持单文件" copy may render in either the placeholder card
    // or the post-image notice depending on probe state — either match
    // satisfies the smoke check.
    expect(screen.queryAllByText(/仅支持单文件处理/).length).toBeGreaterThan(0);
    const startBtn = screen.getByRole('button', { name: /开始/ });
    expect(startBtn).toBeDisabled();
  });

  // ============== R-42 — GIF ↔ WebP convert ==============

  it('GIF ↔ WebP chip renders both radios with webp pre-selected and lets the user flip', () => {
    render(<ToolboxPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'GIF ↔ WebP' }));
    // Two radios — GIF and WebP. Default = webp because the queue is
    // empty (the input-aware default-flip effect only fires when a
    // first row enters the queue).
    const radios = document.querySelectorAll<HTMLInputElement>('input[name="gwc-target"]');
    expect(radios).toHaveLength(2);
    const gifRadio = radios[0]!;
    const webpRadio = radios[1]!;
    expect(gifRadio.value).toBe('gif');
    expect(webpRadio.value).toBe('webp');
    expect(webpRadio.checked).toBe(true);
    expect(gifRadio.checked).toBe(false);

    // Flipping to GIF flips the underlying targetFormat — observable
    // via radio state.
    fireEvent.click(gifRadio);
    expect(gifRadio.checked).toBe(true);
    expect(webpRadio.checked).toBe(false);
  });

  it('GIF ↔ WebP defaults targetFormat to the opposite of the first queued file (R-42)', async () => {
    const fake = installFakeGiftk();
    // First queued file is a .gif → effect should flip targetFormat to webp
    // (which already happens to be the static default; we still cover the
    // happy path). Then we add a .webp through the same flow.
    fake.toolboxPickFiles.mockResolvedValueOnce(['/q/in.webp']);
    render(<ToolboxPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'GIF ↔ WebP' }));
    await act(async () => {
      fireEvent.click(screen.getByText('选择文件'));
    });
    expect(await screen.findByText('in.webp')).toBeInTheDocument();
    // Input was .webp, so the default-flip effect should set
    // targetFormat to 'gif'. The radio state reflects that.
    const radios = document.querySelectorAll<HTMLInputElement>('input[name="gwc-target"]');
    const gifRadio = radios[0]!;
    const webpRadio = radios[1]!;
    expect(gifRadio.checked).toBe(true);
    expect(webpRadio.checked).toBe(false);
  });

  // R-43 — userTouchedTargetRef leading-edge guard. Once the user has
  // explicitly clicked a radio, subsequently adding new files MUST
  // NOT silently overwrite their choice. The previous (R-42) edge
  // detector keyed on prevQueueLenRef === 0 → switching from kind A
  // to gif-webp-convert with rows already queued bypassed the guard;
  // and adding a 2nd file under the same kind would re-trigger the
  // effect. R-43 keys on userTouchedTargetRef (set true on radio
  // click) + previewPath dependency.
  it('R-43 — once the user picks a target format, adding more files does not overwrite it', async () => {
    const fake = installFakeGiftk();
    fake.toolboxPickFiles.mockResolvedValueOnce(['/q/first.gif']);
    render(<ToolboxPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'GIF ↔ WebP' }));
    await act(async () => {
      fireEvent.click(screen.getByText('选择文件'));
    });
    expect(await screen.findByText('first.gif')).toBeInTheDocument();
    let radios = document.querySelectorAll<HTMLInputElement>('input[name="gwc-target"]');
    expect(radios[1]!.checked).toBe(true);
    fireEvent.click(radios[0]!);
    radios = document.querySelectorAll<HTMLInputElement>('input[name="gwc-target"]');
    expect(radios[0]!.checked).toBe(true);
    fake.toolboxPickFiles.mockResolvedValueOnce(['/q/second.gif']);
    await act(async () => {
      fireEvent.click(screen.getByText('选择文件'));
    });
    expect(await screen.findByText('second.gif')).toBeInTheDocument();
    radios = document.querySelectorAll<HTMLInputElement>('input[name="gwc-target"]');
    expect(radios[0]!.checked).toBe(true);
    expect(radios[1]!.checked).toBe(false);
  });

  it('switching kinds preserves jobs whose extension is still allowed (R-38, updated R-41)', async () => {
    const fake = installFakeGiftk();
    fake.toolboxPickFiles.mockResolvedValueOnce(['/q/clip.mp4']);
    render(<ToolboxPanel />);
    // Add a video on Video → GIF, then switch to Video → WebP — both
    // accept video, so the row stays visible.
    await act(async () => {
      fireEvent.click(screen.getByText('选择文件'));
    });
    expect(await screen.findByText('clip.mp4')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Video → WebP' }));
    expect(screen.getByText('clip.mp4')).toBeInTheDocument();
    // R-41 — the seven non-video tools all reject .mp4 now. Approve the
    // confirm dialog (stubbed via vi.stubGlobal so jsdom-less window.confirm
    // becomes a controllable function) so the kind switch proceeds and
    // the .mp4 row is dropped.
    const confirmFn = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmFn);
    try {
      fireEvent.click(screen.getByRole('tab', { name: 'GIF Resize' }));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(screen.queryByText('clip.mp4')).toBeNull();
  });

  // R-41 — switching from a video kind to a GIF/WebP-only kind with a
  // queued .mp4 must show window.confirm() before dropping the row.
  // If the user cancels, the kind stays on the original tab and the
  // row is preserved untouched.
  it('cancelling the confirm dialog aborts the kind switch (R-41)', async () => {
    const fake = installFakeGiftk();
    fake.toolboxPickFiles.mockResolvedValueOnce(['/q/clip.mp4']);
    render(<ToolboxPanel />);
    await act(async () => {
      fireEvent.click(screen.getByText('选择文件'));
    });
    expect(await screen.findByText('clip.mp4')).toBeInTheDocument();
    const confirmFn = vi.fn(() => false);
    vi.stubGlobal('confirm', confirmFn);
    try {
      fireEvent.click(screen.getByRole('tab', { name: 'Reverse' }));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(confirmFn).toHaveBeenCalled();
    // Row preserved + still on Video → GIF (default).
    expect(screen.getByText('clip.mp4')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Video → GIF' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Reverse' })).toHaveAttribute('aria-selected', 'false');
  });

  // ============== R-39 — Job thumbnail / meta line / History panel ==============

  it('queued (pending) job rows render a thumbnail container so users can identify clips before Start', async () => {
    const fake = installFakeGiftk();
    fake.toolboxPickFiles.mockResolvedValueOnce(['/q/clip.mp4']);
    render(<ToolboxPanel />);
    await act(async () => {
      fireEvent.click(screen.getByText('选择文件'));
    });
    expect(await screen.findByText('clip.mp4')).toBeInTheDocument();
    // The .tb-job-thumb element is the per-row preview slot. Even
    // before the firstFrame IPC has resolved, the slot exists with a
    // fallback emoji — that's the user-facing requirement #4.
    const thumbs = document.querySelectorAll('.tb-job-thumb');
    expect(thumbs.length).toBeGreaterThan(0);
  });

  it('History section renders empty-state copy by default', () => {
    // R-39 — make sure the panel boots cleanly with an empty history.
    try { window.localStorage.removeItem('giftk.toolbox.history.v1'); } catch { /* ignore */ }
    render(<ToolboxPanel />);
    expect(screen.getByLabelText('工具箱历史结果')).toBeInTheDocument();
    expect(screen.getByText(/历史结果 · 0/)).toBeInTheDocument();
    expect(screen.getByText(/完成的任务会自动出现在这里/)).toBeInTheDocument();
  });

  it('History rows render persisted entries and clicking Reveal calls window.giftk.revealItem', async () => {
    // Pre-seed localStorage so the panel boots with one history entry.
    const entry = {
      id: 't1',
      kind: 'video-to-gif',
      inputPath: '/in/clip.mp4',
      displayName: 'clip.mp4',
      outputs: ['/out/clip.gif'],
      params: {},
      status: 'done',
      finishedAt: Date.now()
    };
    window.localStorage.setItem('giftk.toolbox.history.v1', JSON.stringify([entry]));

    const fake = installFakeGiftk();
    // Augment the bridge with revealItem, the new R-39 IPC.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).giftk.revealItem = vi.fn(async () => ({ ok: true }));

    render(<ToolboxPanel />);
    expect(screen.getByText(/历史结果 · 1/)).toBeInTheDocument();
    expect(screen.getByText('clip.gif')).toBeInTheDocument();

    // Clicking the row's main button reveals the primary output.
    const revealBtn = screen.getByTitle(/在文件管理器中显示 \/out\/clip\.gif/);
    await act(async () => {
      fireEvent.click(revealBtn);
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((window as any).giftk.revealItem).toHaveBeenCalledWith('/out/clip.gif');
    void fake; // keep ts happy if the fake var goes unused otherwise
  });

  it('History row for a failed entry is non-clickable and shows error', () => {
    const entry = {
      id: 't2',
      kind: 'video-to-gif',
      inputPath: '/in/bad.mp4',
      displayName: 'bad.mp4',
      outputs: [],
      params: {},
      status: 'failed',
      error: 'ffprobe boom',
      finishedAt: Date.now()
    };
    window.localStorage.setItem('giftk.toolbox.history.v1', JSON.stringify([entry]));
    installFakeGiftk();
    render(<ToolboxPanel />);
    expect(screen.getByText('失败')).toBeInTheDocument();
    expect(screen.getByText('ffprobe boom')).toBeInTheDocument();
    // The clickable main button is disabled when there's no output.
    const buttons = document.querySelectorAll('.tb-history-main');
    const mainBtn = buttons[0] as HTMLButtonElement;
    expect(mainBtn.disabled).toBe(true);
  });

  it('Clicking 清空历史 wipes the history list and localStorage', async () => {
    const entry = {
      id: 't3',
      kind: 'gif-resize',
      inputPath: '/in/x.gif',
      displayName: 'x.gif',
      outputs: ['/out/x.gif'],
      params: {},
      status: 'done',
      finishedAt: Date.now()
    };
    window.localStorage.setItem('giftk.toolbox.history.v1', JSON.stringify([entry]));
    installFakeGiftk();
    render(<ToolboxPanel />);
    expect(screen.getByText(/历史结果 · 1/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByText('清空历史'));
    });
    expect(screen.getByText(/历史结果 · 0/)).toBeInTheDocument();
    expect(window.localStorage.getItem('giftk.toolbox.history.v1')).toBe('{"version":1,"payload":[]}');
  });
});
