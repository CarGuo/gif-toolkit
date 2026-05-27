/**
 * R-TRIM-FRAMESTRIP — unit tests for the pure scheduling logic
 * extracted from extractFrameStrip. We intentionally don't exercise
 * the ffmpeg child-process side here (R-82: sanitize 抽纯模块单测) —
 * the actual binary is covered by integration runs. This file's
 * focus is the count-clamp, duration-guard, and mid-slot sampling
 * algorithm — tiny, pure, deterministic.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
}));

const { computeFrameStripPositions } = await import('../../src/main/ffmpeg');

describe('computeFrameStripPositions', () => {
  it('rejects non-positive / non-finite duration', () => {
    expect(() => computeFrameStripPositions(0, 10)).toThrow(/durationSec/);
    expect(() => computeFrameStripPositions(-1, 10)).toThrow(/durationSec/);
    expect(() => computeFrameStripPositions(NaN, 10)).toThrow(/durationSec/);
    expect(() => computeFrameStripPositions(Infinity, 10)).toThrow(/durationSec/);
  });

  it('clamps count to [2, 24]', () => {
    expect(computeFrameStripPositions(5, 1).length).toBe(2);
    expect(computeFrameStripPositions(5, 0).length).toBe(2);
    expect(computeFrameStripPositions(5, -3).length).toBe(2);
    expect(computeFrameStripPositions(5, 999).length).toBe(24);
    expect(computeFrameStripPositions(5, 25).length).toBe(24);
  });

  it('truncates fractional counts via Math.floor', () => {
    expect(computeFrameStripPositions(10, 5.7).length).toBe(5);
    expect(computeFrameStripPositions(10, 10.99).length).toBe(10);
  });

  it('produces mid-slot atSec values across the duration', () => {
    // duration=10, n=4 → slot=2.5 → atSec = 1.25, 3.75, 6.25, 8.75
    const out = computeFrameStripPositions(10, 4);
    expect(out.map((v) => Number(v.toFixed(3)))).toEqual([
      1.25, 3.75, 6.25, 8.75
    ]);
  });

  it('never lands on 0 or duration (avoids first/lastFrame duplicates)', () => {
    const out = computeFrameStripPositions(10, 12);
    for (const v of out) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(10);
    }
  });

  it('returns positions in ascending order', () => {
    const out = computeFrameStripPositions(7, 8);
    const sorted = [...out].sort((a, b) => a - b);
    expect(out).toEqual(sorted);
  });

  it('still works for sub-second durations (cross-platform short clips)', () => {
    const out = computeFrameStripPositions(0.5, 6);
    expect(out.length).toBe(6);
    for (const v of out) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(0.5);
    }
  });
});
