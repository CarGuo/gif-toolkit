/**
 * R-TRIM-FRAMESTRIP — renderer integration tests for TrimFrameStrip.
 *
 * Covers
 * ------
 *   1. Empty / loading / error / ready render gating.
 *   2. The component calls `window.giftk.toolboxThumbnailStrip` exactly
 *      once per (inputPath, duration) and renders one <img> per frame.
 *   3. Pointer-down on a handle triggers an atomic onChange patch
 *      ({ startSec, endSec }) — never two separate updates.
 *   4. The ▶ button toggles its accessible name between the playing
 *      and paused states (visual smoke).
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TrimFrameStrip } from '../../src/renderer/components/ToolboxPanel';

function installFakeGiftk(impl?: Partial<{
  toolboxThumbnailStrip: (p: string, n?: number) => Promise<{
    sourceDurationSec: number;
    frames: { atSec: number; dataUrl: string }[];
  }>;
}>) {
  const fake = {
    toolboxThumbnailStrip:
      impl?.toolboxThumbnailStrip ??
      vi.fn(async (_p: string, n?: number) => ({
        sourceDurationSec: 10,
        frames: Array.from({ length: n ?? 10 }, (_, i) => ({
          atSec: ((i + 0.5) * 10) / (n ?? 10),
          dataUrl: `data:image/jpeg;base64,STUB${i}`
        }))
      })),
    toolboxFileUrlFor: vi.fn(async (p: string) => ({ url: `file://${p}` })),
    onProgress: vi.fn(() => () => undefined)
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).giftk = fake as any;
  return fake;
}

describe('TrimFrameStrip', () => {
  beforeEach(() => {
    installFakeGiftk();
  });

  it('renders the empty placeholder when no input is provided', () => {
    render(
      <TrimFrameStrip
        inputPath={null}
        durationSec={0}
        startSec={undefined}
        endSec={undefined}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByTestId('trim-frame-strip-empty')).toBeInTheDocument();
  });

  it('renders the empty placeholder when duration is 0 (still probing)', () => {
    render(
      <TrimFrameStrip
        inputPath={'/tmp/x.mp4'}
        durationSec={0}
        startSec={undefined}
        endSec={undefined}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByTestId('trim-frame-strip-empty')).toBeInTheDocument();
  });

  it('renders one <img> per frame after IPC resolves', async () => {
    const giftk = installFakeGiftk();
    render(
      <TrimFrameStrip
        inputPath={'/tmp/x.mp4'}
        durationSec={10}
        startSec={undefined}
        endSec={undefined}
        onChange={vi.fn()}
      />
    );
    await waitFor(() => {
      expect(screen.getByTestId('trim-frame-strip')).toBeInTheDocument();
    });
    expect(giftk.toolboxThumbnailStrip).toHaveBeenCalledTimes(1);
    expect(giftk.toolboxThumbnailStrip).toHaveBeenCalledWith('/tmp/x.mp4', 10);
    const imgs = screen
      .getByTestId('trim-frame-strip-track')
      .querySelectorAll('img');
    expect(imgs.length).toBe(10);
  });

  it('shows the error state when the IPC rejects', async () => {
    installFakeGiftk({
      toolboxThumbnailStrip: vi.fn(async () => {
        throw new Error('ffmpeg missing');
      })
    });
    render(
      <TrimFrameStrip
        inputPath={'/tmp/x.mp4'}
        durationSec={10}
        startSec={undefined}
        endSec={undefined}
        onChange={vi.fn()}
      />
    );
    await waitFor(() => {
      expect(screen.getByTestId('trim-frame-strip-error')).toBeInTheDocument();
    });
    // Surface the underlying message — the rule explicitly forbids
    // failing silently with a "fake empty" frame strip.
    expect(screen.getByTestId('trim-frame-strip-error').textContent).toMatch(
      /ffmpeg missing/
    );
  });

  it('emits an atomic { startSec, endSec } patch on handle pointer drag', async () => {
    const onChange = vi.fn();
    render(
      <TrimFrameStrip
        inputPath={'/tmp/x.mp4'}
        durationSec={10}
        startSec={2}
        endSec={8}
        onChange={onChange}
      />
    );
    const startHandle = await screen.findByTestId(
      'trim-frame-strip-handle-start'
    );
    const track = screen.getByTestId('trim-frame-strip-track');
    // happy-dom returns 0×0 rects without explicit layout, so stub the
    // bounding rect to model a 800px-wide strip mapped to [0, 10s].
    Object.defineProperty(track, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        right: 800,
        bottom: 64,
        width: 800,
        height: 64,
        x: 0,
        y: 0,
        toJSON: () => ({})
      })
    });
    // Pointerdown installs the move/up listeners on `target` itself.
    // The actual apply() runs on pointerup (or any pointermove) — that's
    // where the atomic onChange gets called.
    act(() => {
      fireEvent.pointerDown(startHandle, { pointerId: 1, clientX: 0 });
    });
    act(() => {
      const ev = new Event('pointerup', { bubbles: false });
      // Synthesise the clientX field that the listener reads.
      Object.defineProperty(ev, 'clientX', { value: 400, configurable: true });
      Object.defineProperty(ev, 'pointerId', { value: 1, configurable: true });
      startHandle.dispatchEvent(ev);
    });
    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1];
    const patch = lastCall[0];
    // Atomic — both fields are present (R-TRIM-FRAMESTRIP.7).
    expect(patch).toHaveProperty('startSec');
    expect(patch).toHaveProperty('endSec');
    expect(patch.endSec).toBe(8);
    // x=400 / 800 * 10 = 5.0s, then clamped under selEnd-0.05 = 7.95.
    expect(patch.startSec).toBeGreaterThan(4.5);
    expect(patch.startSec).toBeLessThan(5.5);
  });

  it('toggles the play button accessible name on click', async () => {
    render(
      <TrimFrameStrip
        inputPath={'/tmp/x.mp4'}
        durationSec={10}
        startSec={2}
        endSec={8}
        onChange={vi.fn()}
      />
    );
    const playBtn = await screen.findByTestId('trim-frame-strip-play');
    expect(playBtn.getAttribute('aria-label')).toBe('预览选中区间');
    act(() => {
      fireEvent.click(playBtn);
    });
    expect(playBtn.getAttribute('aria-label')).toBe('暂停预览');
  });
});
