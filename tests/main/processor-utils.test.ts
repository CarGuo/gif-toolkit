/**
 * Tests for src/main/processor-utils.ts — the math behind compressLoop's
 * O1-O5 optimisations (commit 18ecc18). These tests are the regression
 * safety net: when you tweak EARLY_FAST_RATIO / SHRINK_FIRST_RATIO /
 * ACCEPT_TOL or refactor adaptiveStartLossy, run these first.
 */
import { describe, expect, it } from 'vitest';
import {
  ACCEPT_TOL,
  DEFAULT_CONCURRENCY,
  EARLY_FAST_RATIO,
  MAX_CONCURRENCY,
  SHRINK_FIRST_RATIO,
  adaptiveStartLossy,
  clampConcurrency,
  compressCacheKey,
  extrapolateNextLossy,
  geometricShrinkLongestSide,
  planPhase0,
  shortSideAfterCap
} from '../../src/main/processor-utils';

describe('clampConcurrency', () => {
  it('returns DEFAULT_CONCURRENCY for invalid inputs', () => {
    expect(clampConcurrency(undefined)).toBe(DEFAULT_CONCURRENCY);
    expect(clampConcurrency(0)).toBe(DEFAULT_CONCURRENCY);
    expect(clampConcurrency(-5)).toBe(DEFAULT_CONCURRENCY);
    expect(clampConcurrency(NaN)).toBe(DEFAULT_CONCURRENCY);
    expect(clampConcurrency(Infinity)).toBe(DEFAULT_CONCURRENCY);
  });

  it('clamps high values to MAX_CONCURRENCY', () => {
    expect(clampConcurrency(MAX_CONCURRENCY)).toBe(MAX_CONCURRENCY);
    expect(clampConcurrency(MAX_CONCURRENCY + 1)).toBe(MAX_CONCURRENCY);
    expect(clampConcurrency(99999)).toBe(MAX_CONCURRENCY);
  });

  it('floors fractional inputs', () => {
    expect(clampConcurrency(2.9)).toBe(2);
    expect(clampConcurrency(1.0001)).toBe(1);
  });

  it('keeps valid integers', () => {
    expect(clampConcurrency(2)).toBe(2);
    expect(clampConcurrency(5)).toBe(5);
  });
});

describe('shortSideAfterCap', () => {
  it('returns 0 for invalid shapes', () => {
    expect(shortSideAfterCap(0, 100, 800)).toBe(0);
    expect(shortSideAfterCap(100, 0, 800)).toBe(0);
    expect(shortSideAfterCap(100, 100, 0)).toBe(0);
    expect(shortSideAfterCap(-1, 100, 800)).toBe(0);
  });

  it('returns the original short side when no cap is needed', () => {
    expect(shortSideAfterCap(800, 600, 1000)).toBe(600);
    expect(shortSideAfterCap(800, 600, 800)).toBe(600);
  });

  it('scales preserving aspect when capped', () => {
    expect(shortSideAfterCap(1600, 900, 800)).toBe(450);
    expect(shortSideAfterCap(2000, 1000, 1000)).toBe(500);
  });

  it('rounds (does not floor) and is bounded below by 1', () => {
    expect(shortSideAfterCap(2001, 1, 1000)).toBe(1);
    expect(shortSideAfterCap(3, 2, 2)).toBe(1); // 2*(2/3) = 1.33 → 1
  });
});

describe('compressCacheKey', () => {
  it('is stable for identical inputs', () => {
    const a = compressCacheKey('/tmp/x.gif', 800, 60, 256);
    const b = compressCacheKey('/tmp/x.gif', 800, 60, 256);
    expect(a).toBe(b);
  });

  it('changes when any axis changes', () => {
    const base = compressCacheKey('/tmp/x.gif', 800, 60, 256);
    expect(compressCacheKey('/tmp/y.gif', 800, 60, 256)).not.toBe(base);
    expect(compressCacheKey('/tmp/x.gif', 600, 60, 256)).not.toBe(base);
    expect(compressCacheKey('/tmp/x.gif', 800, 80, 256)).not.toBe(base);
    expect(compressCacheKey('/tmp/x.gif', 800, 60, 128)).not.toBe(base);
  });
});

describe('planPhase0', () => {
  it('returns "already-soft" when initial fits target', () => {
    expect(planPhase0(0.5, 2)).toBe('already-soft');
    expect(planPhase0(2, 2)).toBe('already-soft');
  });

  it('returns "fast" within EARLY_FAST_RATIO', () => {
    expect(planPhase0(2 * EARLY_FAST_RATIO, 2)).toBe('fast');
    expect(planPhase0(2 * 1.3, 2)).toBe('fast');
  });

  it('returns "shrink-first" once SHRINK_FIRST_RATIO is hit', () => {
    expect(planPhase0(2 * SHRINK_FIRST_RATIO, 2)).toBe('shrink-first');
    expect(planPhase0(2 * 5, 2)).toBe('shrink-first');
  });

  it('returns "normal" in between fast and shrink-first', () => {
    expect(planPhase0(2 * 2.5, 2)).toBe('normal');
    expect(planPhase0(2 * 3.9, 2)).toBe('normal');
  });

  it('handles degenerate softMB by falling back to "normal"', () => {
    expect(planPhase0(5, 0)).toBe('normal');
    expect(planPhase0(5, -1)).toBe('normal');
  });
});

describe('adaptiveStartLossy', () => {
  it('returns small lossy when already near target', () => {
    expect(adaptiveStartLossy(1.0, 2.0)).toBe(20);
    expect(adaptiveStartLossy(2.0, 2.0)).toBe(20);
  });

  it('escalates monotonically with overshoot ratio', () => {
    const a = adaptiveStartLossy(2.5, 2);
    const b = adaptiveStartLossy(4, 2);
    const c = adaptiveStartLossy(6, 2);
    const d = adaptiveStartLossy(10, 2);
    expect(a).toBeLessThanOrEqual(b);
    expect(b).toBeLessThanOrEqual(c);
    expect(c).toBeLessThanOrEqual(d);
  });

  it('returns a sane default for degenerate target', () => {
    expect(adaptiveStartLossy(5, 0)).toBe(60);
    expect(adaptiveStartLossy(NaN, 2)).toBe(60);
  });
});

describe('extrapolateNextLossy', () => {
  it('extrapolates linearly between (0,base) and (l1,s1)', () => {
    // base = 5MB at lossy=0, after lossy=40 dropped to 3MB → slope 0.05 MB/unit
    // target = 2MB → next = 40 + (3-2)/0.05 = 40 + 20 = 60
    expect(extrapolateNextLossy(5, 40, 3, 2)).toBeCloseTo(60, 3);
  });

  it('returns NaN for degenerate slope (no compression effect)', () => {
    expect(extrapolateNextLossy(3, 40, 3, 2)).toBeNaN();
    expect(extrapolateNextLossy(3, 40, 4, 2)).toBeNaN(); // negative slope
  });

  it('returns NaN when lastLossy is zero (no sample)', () => {
    expect(extrapolateNextLossy(5, 0, 5, 2)).toBeNaN();
  });
});

describe('geometricShrinkLongestSide', () => {
  it('halves longest side roughly when 4× over budget', () => {
    // sqrt(2/8) = 0.5
    expect(geometricShrinkLongestSide(1000, 8, 2, 240)).toBe(500);
  });

  it('caps the per-iteration shrink factor at 0.95 to guarantee progress without thrash', () => {
    // currentMB < targetMB → sqrt(target/cur) > 1, but the function caps at 0.95
    // so we shrink by at most 5% per iteration even when the heuristic suggests grow.
    expect(geometricShrinkLongestSide(800, 1, 2, 240)).toBe(760);
  });

  it('respects minSide floor', () => {
    expect(geometricShrinkLongestSide(300, 100, 2, 240)).toBe(240);
  });

  it('returns minSide when already at or below the floor', () => {
    expect(geometricShrinkLongestSide(240, 5, 2, 240)).toBe(240);
    expect(geometricShrinkLongestSide(100, 5, 2, 240)).toBe(240);
  });
});

describe('exported tunable invariants', () => {
  it('ACCEPT_TOL is a small positive fraction', () => {
    expect(ACCEPT_TOL).toBeGreaterThan(0);
    expect(ACCEPT_TOL).toBeLessThan(0.5);
  });

  it('EARLY_FAST_RATIO < SHRINK_FIRST_RATIO so planPhase0 is well-ordered', () => {
    expect(EARLY_FAST_RATIO).toBeLessThan(SHRINK_FIRST_RATIO);
  });

  it('DEFAULT_CONCURRENCY ≤ MAX_CONCURRENCY', () => {
    expect(DEFAULT_CONCURRENCY).toBeLessThanOrEqual(MAX_CONCURRENCY);
    expect(DEFAULT_CONCURRENCY).toBeGreaterThan(0);
  });
});
