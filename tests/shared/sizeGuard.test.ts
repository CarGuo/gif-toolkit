/**
 * R-72 — Tests for the shared aspect-ratio pre-flight guard.
 *
 * The renderer uses these helpers to decide BEFORE dispatching a
 * batch whether each task would be rejected by processor.ts'
 * AspectRatioConstraintError check. The processor still runs the same
 * check after probe, so these tests focus on:
 *
 *   1. Boundary correctness: must agree with processor-utils.shortSideAfterCap
 *      so the modal doesn't list an item that the processor would
 *      actually accept (false positive) or skip an item that the
 *      processor would reject (false negative).
 *   2. The unknown-dim path: SniffedMedia for raw URLs without HEAD
 *      probe data must NOT trigger the modal — we don't want to
 *      block a batch on guesses.
 *   3. The HARD_MIN_SIZE floor: even when the user sets minSize=0,
 *      the effective minSide is 240 — same invariant as processor.ts L283.
 */
import { describe, expect, it } from 'vitest';
import {
  SIZE_GUARD_HARD_MIN,
  effectiveMaxSide,
  evaluateSizeGuard,
  shortSideAfterCap
} from '../../src/shared/sizeGuard';

describe('shortSideAfterCap (R-72 mirror)', () => {
  it('returns the original short side when longest already fits', () => {
    expect(shortSideAfterCap(600, 400, 800)).toBe(400);
    expect(shortSideAfterCap(800, 400, 800)).toBe(400);
  });

  it('scales the short side proportionally when capping kicks in', () => {
    // 1600x900 capped at 800: short = round(900 * 800/1600) = 450
    expect(shortSideAfterCap(1600, 900, 800)).toBe(450);
  });

  it('returns 0 when shape is unknown / inputs are non-positive', () => {
    expect(shortSideAfterCap(0, 100, 800)).toBe(0);
    expect(shortSideAfterCap(100, 0, 800)).toBe(0);
    expect(shortSideAfterCap(100, 100, 0)).toBe(0);
    expect(shortSideAfterCap(-1, 100, 800)).toBe(0);
  });

  it('floors the result at 1 even for absurdly thin sources', () => {
    expect(shortSideAfterCap(10000, 1, 100)).toBe(1);
  });
});

describe('effectiveMaxSide (R-72)', () => {
  it('clamps minSize up to HARD_MIN before comparing with maxWidth', () => {
    // user set minSize=0 → effective minSide = 240; maxWidth=800 wins.
    expect(effectiveMaxSide({ maxWidth: 800, minSize: 0 })).toBe(800);
  });

  it('returns minSide when minSide > maxWidth (absurd config)', () => {
    expect(effectiveMaxSide({ maxWidth: 100, minSize: 600 })).toBe(600);
  });
});

describe('evaluateSizeGuard (R-72)', () => {
  const opts = { maxWidth: 800, minSize: 450 };

  it('returns "unknown" when width or height are missing', () => {
    expect(evaluateSizeGuard({}, opts)).toEqual({ state: 'unknown' });
    expect(evaluateSizeGuard({ width: 0, height: 600 }, opts)).toEqual({
      state: 'unknown'
    });
    expect(evaluateSizeGuard({ width: 600, height: 0 }, opts)).toEqual({
      state: 'unknown'
    });
  });

  it('returns "ok" when longest fits below the cap (no scaling needed)', () => {
    expect(evaluateSizeGuard({ width: 600, height: 400 }, opts)).toEqual({
      state: 'ok'
    });
  });

  it('returns "ok" when capping yields a short side >= minSide', () => {
    // 1600x900 -> cap 800 -> short 450 (== minSide, just passes).
    expect(evaluateSizeGuard({ width: 1600, height: 900 }, opts)).toEqual({
      state: 'ok'
    });
  });

  it('returns "will-fail" when capping drops short side below minSide', () => {
    // 1600x600 -> cap 800 -> short 300 (< 450).
    const v = evaluateSizeGuard({ width: 1600, height: 600 }, opts);
    expect(v.state).toBe('will-fail');
    if (v.state !== 'will-fail') return;
    expect(v.origW).toBe(1600);
    expect(v.origH).toBe(600);
    expect(v.maxSide).toBe(800);
    expect(v.minSide).toBe(450);
    expect(v.shortSideAtMax).toBe(300);
  });

  it('orientation-agnostic: portrait inputs use the longer of (w,h) as cap target', () => {
    // 600x1600 (portrait) — same shape as the previous case rotated.
    const v = evaluateSizeGuard({ width: 600, height: 1600 }, opts);
    expect(v.state).toBe('will-fail');
    if (v.state !== 'will-fail') return;
    expect(v.shortSideAtMax).toBe(300);
  });

  it('respects HARD_MIN_SIZE even when the user sets minSize=0', () => {
    // 1600x300 -> cap 800 -> short 150 (< HARD_MIN 240).
    const v = evaluateSizeGuard(
      { width: 1600, height: 300 },
      { maxWidth: 800, minSize: 0 }
    );
    expect(v.state).toBe('will-fail');
    if (v.state !== 'will-fail') return;
    expect(v.minSide).toBe(SIZE_GUARD_HARD_MIN);
  });
});
