/**
 * R-COMPRESS-V1 wave 2 — regression tests for the two ParamForm UX
 * upgrades shipped in commit e80275a:
 *
 *   #1  GIF Optimize 「目标体积快捷条」(target-bytes shortcut chips):
 *       4-button strip above the method picker. Clicking a size chip
 *       must (a) flip method=budget so the 4-Phase pipeline kicks in,
 *       (b) overwrite maxBytes with the chip's preset (in bytes), and
 *       (c) highlight the active chip via the .is-active class.
 *
 *   #2  smart fps default for video→gif / video→webp: when ParamForm
 *       receives a non-zero mediaInfo.frameRate the FPS NumField hint
 *       must surface "源 N fps" so the user can sanity-check the
 *       smart-default heuristic. The actual fps mutation lives in
 *       ToolboxPanel's effect (which would require the full IPC
 *       harness to test); here we lock the *display* layer so the
 *       mediaInfo plumbing through ParamForm doesn't silently regress.
 *
 * The tests target ParamForm directly (now exported for testing) so we
 * avoid mocking the entire toolbox IPC + jobMedia probe pipeline.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ParamForm, type MediaInfo } from '../../src/renderer/components/ToolboxPanel';
import type { ToolboxParams } from '../../src/shared/types/toolbox';

describe('ParamForm — GIF Optimize 目标体积快捷条 (R-COMPRESS-V1 #1)', () => {
  it('renders the 4-chip strip with 自定义 plus three size presets', () => {
    const { container } = render(
      <ParamForm
        kind="gif-optimize"
        params={{ method: 'lossy', lossy: 80 }}
        setParams={() => undefined}
        mediaInfo={null}
      />
    );
    const chips = container.querySelectorAll('button.tb-target-bytes-chip');
    // 3 size chips + 1 自定义 = 4 buttons
    expect(chips.length).toBe(4);
    const labels = Array.from(chips).map((c) => c.textContent);
    expect(labels).toEqual(['< 2 MB', '< 5 MB', '< 10 MB', '自定义']);
  });

  it('clicking < 5 MB chip sets method=budget and maxBytes=5MB', () => {
    let captured: ToolboxParams | null = null;
    const setParams = vi.fn((updater: any) => {
      const next = typeof updater === 'function' ? updater({ method: 'lossy', lossy: 80 }) : updater;
      captured = next;
    });
    const { container } = render(
      <ParamForm
        kind="gif-optimize"
        params={{ method: 'lossy', lossy: 80 }}
        setParams={setParams}
        mediaInfo={null}
      />
    );
    const chips = container.querySelectorAll('button.tb-target-bytes-chip');
    // chip index 1 = "< 5 MB"
    fireEvent.click(chips[1]);
    expect(setParams).toHaveBeenCalledTimes(1);
    expect(captured).not.toBeNull();
    expect(captured!.method).toBe('budget');
    expect(captured!.maxBytes).toBe(5 * 1024 * 1024);
  });

  it('highlights only the chip whose bytes match current params.maxBytes (when method=budget)', () => {
    const { container } = render(
      <ParamForm
        kind="gif-optimize"
        params={{ method: 'budget', maxBytes: 2 * 1024 * 1024 }}
        setParams={() => undefined}
        mediaInfo={null}
      />
    );
    const chips = Array.from(container.querySelectorAll('button.tb-target-bytes-chip'));
    const active = chips.filter((c) => c.classList.contains('is-active'));
    expect(active.length).toBe(1);
    expect(active[0].textContent).toBe('< 2 MB');
  });

  it('highlights 自定义 when method=budget but maxBytes is a non-preset value', () => {
    const { container } = render(
      <ParamForm
        kind="gif-optimize"
        params={{ method: 'budget', maxBytes: 7 * 1024 * 1024 }} // 7MB ≠ any preset
        setParams={() => undefined}
        mediaInfo={null}
      />
    );
    const chips = Array.from(container.querySelectorAll('button.tb-target-bytes-chip'));
    const active = chips.filter((c) => c.classList.contains('is-active'));
    expect(active.length).toBe(1);
    expect(active[0].textContent).toBe('自定义');
  });

  it('keeps no chip active when method !== budget', () => {
    const { container } = render(
      <ParamForm
        kind="gif-optimize"
        params={{ method: 'lossy', lossy: 80, maxBytes: 5 * 1024 * 1024 }}
        setParams={() => undefined}
        mediaInfo={null}
      />
    );
    const chips = Array.from(container.querySelectorAll('button.tb-target-bytes-chip'));
    expect(chips.some((c) => c.classList.contains('is-active'))).toBe(false);
  });

  it('clicking 自定义 flips method=budget without replacing an existing custom maxBytes', () => {
    let captured: ToolboxParams | null = null;
    const prev: ToolboxParams = { method: 'budget', maxBytes: 7 * 1024 * 1024 };
    const setParams = vi.fn((updater: any) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      captured = next;
    });
    const { container } = render(
      <ParamForm
        kind="gif-optimize"
        params={prev}
        setParams={setParams}
        mediaInfo={null}
      />
    );
    const chips = container.querySelectorAll('button.tb-target-bytes-chip');
    fireEvent.click(chips[3]); // 自定义
    expect(captured!.method).toBe('budget');
    // Custom value preserved — 自定义 is a no-op for the size, just
    // ensures the budget pipeline is on so the NumField is editable.
    expect(captured!.maxBytes).toBe(7 * 1024 * 1024);
  });
});

describe('ParamForm — smart fps hint (R-COMPRESS-V1 #2)', () => {
  const baseMediaInfo: MediaInfo = {
    width: 1920,
    height: 1080,
    durationSec: 12.5,
    frameRate: 60
  };

  it('video-to-gif shows source fps in FPS hint when frameRate is known', () => {
    const { container } = render(
      <ParamForm
        kind="video-to-gif"
        params={{ fps: 12, width: 800 }}
        setParams={() => undefined}
        mediaInfo={baseMediaInfo}
      />
    );
    // Hint text is rendered alongside the FPS NumField.
    expect(container.textContent).toContain('源视频 60fps');
    expect(container.textContent).toContain('min(源,24)');
  });

  it('video-to-gif falls back to "1–60" hint when frameRate is missing', () => {
    const { container } = render(
      <ParamForm
        kind="video-to-gif"
        params={{ fps: 12, width: 800 }}
        setParams={() => undefined}
        mediaInfo={null}
      />
    );
    expect(container.textContent).toContain('1–60');
    expect(container.textContent).not.toContain('源视频');
  });

  it('video-to-webp also surfaces the source fps in hint', () => {
    const { container } = render(
      <ParamForm
        kind="video-to-webp"
        params={{ fps: 15, width: 800, quality: 75, loop: 0 }}
        setParams={() => undefined}
        mediaInfo={{ ...baseMediaInfo, frameRate: 29.97 }}
      />
    );
    // 29.97 -> toFixed(2) — rendered as "29.97fps"
    expect(container.textContent).toContain('源 29.97fps');
  });
});
