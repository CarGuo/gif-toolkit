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
  GIFSKI_ACCEPT_TOL,
  GIFSKI_Q_MAX,
  GIFSKI_Q_MIN,
  GIFSKI_Q_PROBE,
  MAX_CONCURRENCY,
  SHRINK_FIRST_RATIO,
  adaptiveStartLossy,
  chooseCompressionTargetMB,
  clampConcurrency,
  compressCacheKey,
  decideEarlyAccept,
  decideGifskiAccept,
  derivePartialSourceName,
  enumerateSegments,
  extrapolateNextLossy,
  filterSelectedSegments,
  geometricShrinkLongestSide,
  nextGifskiQuality,
  planPhase0,
  predictGifskiQuality,
  refineGifskiQuality,
  shortSideAfterCap,
  shouldReplaceBest
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

describe('chooseCompressionTargetMB', () => {
  it('targets the hard fallback cap before any hard-fit result exists', () => {
    expect(chooseCompressionTargetMB(false, 4, 2)).toEqual({
      targetMB: 4,
      tier: 'fallback'
    });
  });

  it('targets the soft cap after the pipeline already has a hard-fit result', () => {
    expect(chooseCompressionTargetMB(true, 4, 2)).toEqual({
      targetMB: 2,
      tier: 'soft'
    });
  });

  it('falls back to soft when the hard cap is degenerate', () => {
    expect(chooseCompressionTargetMB(false, 0, 2)).toEqual({
      targetMB: 2,
      tier: 'soft'
    });
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

/* ------------------------- C-02 decideEarlyAccept ------------------------- */

describe('decideEarlyAccept (C-02 symmetric Phase B early-accept)', () => {
  it('accepts when lastSize is within ±ACCEPT_TOL of target', () => {
    expect(decideEarlyAccept(2.0, 2.0)).toBe('accept');
    // Use a tiny margin INSIDE the tolerance so the boundary check survives
    // FP rounding (2 * 1.12 = 2.2400000000000002 in IEEE-754, which is
    // strictly > target * (1 + tol) when compared bit-exact).
    expect(decideEarlyAccept(2.0 * (1 + ACCEPT_TOL * 0.9), 2.0)).toBe('accept');
    expect(decideEarlyAccept(2.0 * (1 - ACCEPT_TOL * 0.9), 2.0)).toBe('accept');
  });

  it('asks for more lossy (refine-shrink) when lastSize is too big', () => {
    // 50 % over target — well beyond ACCEPT_TOL (12 %).
    expect(decideEarlyAccept(3.0, 2.0)).toBe('refine-shrink');
  });

  it('asks for LESS lossy (refine-grow) when first try overshoots small', () => {
    // This is the asymmetry C-02 fixes: pre-fix any undershoot was
    // "accept", which lost quality silently. 0.5 MB vs 2 MB target is
    // way below the tolerance band, so we must refine BACK up.
    expect(decideEarlyAccept(0.5, 2.0)).toBe('refine-grow');
  });

  it('boundary just outside tolerance triggers a refine (either side)', () => {
    const eps = 1e-6;
    expect(decideEarlyAccept(2.0 * (1 + ACCEPT_TOL) + eps, 2.0)).toBe('refine-shrink');
    expect(decideEarlyAccept(2.0 * (1 - ACCEPT_TOL) - eps, 2.0)).toBe('refine-grow');
  });

  it('falls back to accept for degenerate inputs (no useful info)', () => {
    expect(decideEarlyAccept(NaN, 2)).toBe('accept');
    expect(decideEarlyAccept(2, 0)).toBe('accept');
    expect(decideEarlyAccept(2, -1)).toBe('accept');
  });

  it('respects an overridden tolerance', () => {
    // tight 1 % tolerance — even small drift triggers refine.
    expect(decideEarlyAccept(2.05, 2.0, 0.01)).toBe('refine-shrink');
    expect(decideEarlyAccept(1.95, 2.0, 0.01)).toBe('refine-grow');
  });
});

/* ------------------------- C-05 shouldReplaceBest ------------------------- */

describe('shouldReplaceBest (C-05 band-tiered, smaller-wins recordBest)', () => {
  const SOFT = 2;
  const HARD = 4;

  it('always replaces when there is no current best', () => {
    expect(shouldReplaceBest(null, { sizeMB: 5 }, SOFT, HARD)).toBe(true);
    expect(shouldReplaceBest(null, { sizeMB: 0.1 }, SOFT, HARD)).toBe(true);
  });

  it('prefers under-soft over under-hard', () => {
    expect(shouldReplaceBest({ sizeMB: 3.5 }, { sizeMB: 1.5 }, SOFT, HARD)).toBe(true);
  });

  it('prefers under-hard over over-hard', () => {
    expect(shouldReplaceBest({ sizeMB: 5 }, { sizeMB: 3 }, SOFT, HARD)).toBe(true);
  });

  it('rejects when incoming is in a worse tier', () => {
    expect(shouldReplaceBest({ sizeMB: 1.5 }, { sizeMB: 3 }, SOFT, HARD)).toBe(false);
    expect(shouldReplaceBest({ sizeMB: 3 }, { sizeMB: 5 }, SOFT, HARD)).toBe(false);
  });

  it('within the same band, prefers strictly smaller (C-05 fix)', () => {
    // Pre-fix behaviour: once under soft, a LARGER under-soft replaced
    // best (best drifted toward 2 MB). New behaviour: smaller wins.
    expect(shouldReplaceBest({ sizeMB: 1.4 }, { sizeMB: 1.9 }, SOFT, HARD)).toBe(false);
    expect(shouldReplaceBest({ sizeMB: 1.9 }, { sizeMB: 1.4 }, SOFT, HARD)).toBe(true);
  });

  it('within the over-hard band, smaller is still better (we are at least making progress)', () => {
    expect(shouldReplaceBest({ sizeMB: 8 }, { sizeMB: 6 }, SOFT, HARD)).toBe(true);
    expect(shouldReplaceBest({ sizeMB: 6 }, { sizeMB: 8 }, SOFT, HARD)).toBe(false);
  });

  it('ties prefer the existing best (stability — avoid log churn)', () => {
    expect(shouldReplaceBest({ sizeMB: 1.5 }, { sizeMB: 1.5 }, SOFT, HARD)).toBe(false);
    expect(shouldReplaceBest({ sizeMB: 3 }, { sizeMB: 3 }, SOFT, HARD)).toBe(false);
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

describe('enumerateSegments (R-22)', () => {
  it('returns a single segment when range fits within maxSegmentSec', () => {
    const segs = enumerateSegments(0, 10, 20);
    expect(segs.length).toBe(1);
    expect(segs[0]).toEqual({ index: 0, start: 0, duration: 10 });
  });

  it('produces equally-sized segments instead of "N full + leftover"', () => {
    // 50s clip with 20s cap should be 3 segments of 50/3 ≈ 16.67s each,
    // NOT [20, 20, 10]. This keeps progress UI predictable.
    const segs = enumerateSegments(0, 50, 20);
    expect(segs.length).toBe(3);
    for (const s of segs) {
      expect(s.duration).toBeCloseTo(50 / 3, 6);
    }
    // Indices monotonic, starts contiguous.
    expect(segs[0].start).toBe(0);
    expect(segs[1].start).toBeCloseTo(50 / 3, 6);
    expect(segs[2].start).toBeCloseTo((50 / 3) * 2, 6);
  });

  it('honours non-zero clipStart', () => {
    const segs = enumerateSegments(10, 30, 5);
    expect(segs.length).toBe(4);
    expect(segs[0].start).toBe(10);
    expect(segs[3].start).toBeCloseTo(25, 6);
  });

  it('returns [] when range is non-positive', () => {
    expect(enumerateSegments(5, 5, 10)).toEqual([]);
    expect(enumerateSegments(10, 5, 10)).toEqual([]);
  });

  it('treats zero/negative maxSegmentSec as 1s (defensive)', () => {
    const segs = enumerateSegments(0, 3, 0);
    expect(segs.length).toBe(3);
    expect(segs[0].duration).toBe(1);
  });
});

describe('filterSelectedSegments (R-22)', () => {
  const all = [
    { index: 0, start: 0, duration: 10 },
    { index: 1, start: 10, duration: 10 },
    { index: 2, start: 20, duration: 10 }
  ];

  it('returns all segments when selection is undefined (legacy callers)', () => {
    expect(filterSelectedSegments(all, undefined)).toEqual(all);
  });

  it('returns all segments when selection is empty', () => {
    expect(filterSelectedSegments(all, [])).toEqual(all);
  });

  it('keeps only whitelisted indices, preserving original order', () => {
    expect(filterSelectedSegments(all, [0, 2])).toEqual([all[0], all[2]]);
    // Selection order doesn't affect output order — original indexing wins.
    expect(filterSelectedSegments(all, [2, 0])).toEqual([all[0], all[2]]);
  });

  it('drops out-of-range or non-integer indices silently', () => {
    expect(filterSelectedSegments(all, [99])).toEqual(all);  // empty allow → fallback to all
    expect(filterSelectedSegments(all, [1, 99, 0])).toEqual([all[0], all[1]]);
    expect(filterSelectedSegments(all, [0.5, 1.7, 2])).toEqual([all[2]]);
    expect(filterSelectedSegments(all, [-1, 0])).toEqual([all[0]]);
  });

  it('dedupes selection without affecting output', () => {
    expect(filterSelectedSegments(all, [1, 1, 1])).toEqual([all[1]]);
  });
});

/* ------------------------- P1.1 partial-fetch cache key ------------------------- */

describe('derivePartialSourceName (P1.1 partial cache isolation)', () => {
  it('produces a sibling filename with sections.<hash>.<ext>', () => {
    const out = derivePartialSourceName('source.mp4', { selectedSegments: [0] });
    expect(out).toMatch(/^source\.sections\.[0-9a-f]{8}\.mp4$/);
  });

  it('different segment selections yield different filenames (no cache poisoning)', () => {
    const a = derivePartialSourceName('source.mp4', { selectedSegments: [0] });
    const b = derivePartialSourceName('source.mp4', { selectedSegments: [1] });
    const c = derivePartialSourceName('source.mp4', { selectedSegments: [0, 1] });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });

  it('full-stream localName never collides with any partial filename', () => {
    // The full-stream cache uses the original `localName` directly, while every
    // partial run picks a sibling `*.sections.<hash>.*` path. They must never
    // collide — that's the whole point of P1.1.
    const fullName = 'source.mp4';
    const partialNames = [
      derivePartialSourceName(fullName, { selectedSegments: [0] }),
      derivePartialSourceName(fullName, { selectedSegments: [0, 1] }),
      derivePartialSourceName(fullName, { startSec: 5, endSec: 15 }),
      derivePartialSourceName(fullName, {})
    ];
    for (const p of partialNames) {
      expect(p).not.toBe(fullName);
    }
    // And the partials themselves should all be unique across distinct keys.
    expect(new Set(partialNames).size).toBe(partialNames.length);
  });

  it('is deterministic for identical inputs (cache hit on re-run)', () => {
    const a = derivePartialSourceName('clip.mp4', {
      selectedSegments: [0, 2],
      startSec: 0,
      endSec: 30,
      maxSegmentSec: 10
    });
    const b = derivePartialSourceName('clip.mp4', {
      selectedSegments: [0, 2],
      startSec: 0,
      endSec: 30,
      maxSegmentSec: 10
    });
    expect(a).toBe(b);
  });

  it('selection order does not affect the hash (set-equivalent inputs match)', () => {
    const a = derivePartialSourceName('clip.mp4', { selectedSegments: [0, 2, 1] });
    const b = derivePartialSourceName('clip.mp4', { selectedSegments: [2, 1, 0] });
    expect(a).toBe(b);
  });

  it('preserves the original extension', () => {
    expect(derivePartialSourceName('a.mp4', { selectedSegments: [0] })).toMatch(/\.mp4$/);
    expect(derivePartialSourceName('a.webm', { selectedSegments: [0] })).toMatch(/\.webm$/);
    expect(derivePartialSourceName('a.mkv', { selectedSegments: [0] })).toMatch(/\.mkv$/);
  });

  it('falls back to .mp4 when localName has no extension', () => {
    expect(derivePartialSourceName('noext', { selectedSegments: [0] })).toMatch(/\.mp4$/);
  });

  it('startSec/endSec changes also change the hash (different time window = different cache)', () => {
    const a = derivePartialSourceName('clip.mp4', { selectedSegments: [0], startSec: 0, endSec: 10 });
    const b = derivePartialSourceName('clip.mp4', { selectedSegments: [0], startSec: 5, endSec: 15 });
    expect(a).not.toBe(b);
  });

  it('regression: partial[0] then full produce DIFFERENT cache paths', () => {
    // The bug being fixed: first run picks segment [0] and writes a stitched
    // mp4 to `source.mp4`, then a second run with no selectedSegments sees
    // that file and skips the full download. After the fix, partial[0] writes
    // to `source.sections.<hash>.mp4` and the full run still targets
    // `source.mp4` — distinct on-disk paths, no reuse.
    const fullName = 'source.mp4';
    const partialName = derivePartialSourceName(fullName, { selectedSegments: [0] });
    expect(partialName).not.toBe(fullName);
    expect(partialName).toMatch(/^source\.sections\..+\.mp4$/);
  });
});

describe('predictGifskiQuality (single-sample power-curve)', () => {
  it('returns lower quality when last sample exceeds target', () => {
    // 4MB at q=80, target 2MB → ratio 0.5, exp 2 → 80 · sqrt(0.5) ≈ 57
    const q = predictGifskiQuality(80, 4, 2);
    expect(q).toBeGreaterThan(GIFSKI_Q_MIN);
    expect(q).toBeLessThan(80);
    expect(Math.abs(q - 57)).toBeLessThanOrEqual(2);
  });

  it('returns higher quality when last sample is under target', () => {
    // 1MB at q=40, target 2MB → ratio 2, exp 2 → 40 · sqrt(2) ≈ 57
    const q = predictGifskiQuality(40, 1, 2);
    expect(q).toBeGreaterThan(40);
    expect(Math.abs(q - 57)).toBeLessThanOrEqual(2);
  });

  it('clamps to [GIFSKI_Q_MIN, GIFSKI_Q_MAX]', () => {
    expect(predictGifskiQuality(80, 100, 0.001)).toBe(GIFSKI_Q_MIN);
    expect(predictGifskiQuality(80, 0.001, 100)).toBe(GIFSKI_Q_MAX);
  });

  it('returns NaN for degenerate inputs', () => {
    expect(predictGifskiQuality(0, 1, 1)).toBeNaN();
    expect(predictGifskiQuality(80, 0, 1)).toBeNaN();
    expect(predictGifskiQuality(80, 1, 0)).toBeNaN();
    expect(predictGifskiQuality(NaN, 1, 1)).toBeNaN();
    expect(predictGifskiQuality(80, NaN, 1)).toBeNaN();
  });
});

describe('refineGifskiQuality (two-sample log-log fit)', () => {
  it('fits a monotone log-log line and solves for target', () => {
    // Synthetic curve: size = (q/100)^2 · 10  → q=100 → 10MB, q=50 → 2.5MB
    // Solve target=5MB → q ≈ 100·sqrt(5/10) ≈ 70.7
    const q = refineGifskiQuality(100, 10, 50, 2.5, 5);
    expect(q).toBeGreaterThan(GIFSKI_Q_MIN);
    expect(q).toBeLessThan(GIFSKI_Q_MAX);
    expect(Math.abs(q - 71)).toBeLessThanOrEqual(2);
  });

  it('returns NaN when both samples are at the same quality', () => {
    expect(refineGifskiQuality(80, 4, 80, 4, 2)).toBeNaN();
  });

  it('returns NaN when the slope is non-monotone (inverted pair)', () => {
    // q1=80 / mb1=2, q2=50 / mb2=4 — higher quality should be bigger, not smaller.
    expect(refineGifskiQuality(80, 2, 50, 4, 2)).toBeNaN();
  });

  it('clamps the solved quality to [GIFSKI_Q_MIN, GIFSKI_Q_MAX]', () => {
    // Aggressive target far below both samples → would solve to single digits.
    const q = refineGifskiQuality(100, 10, 80, 6, 0.001);
    expect(q).toBe(GIFSKI_Q_MIN);
  });
});

describe('decideGifskiAccept (symmetric ±tol)', () => {
  it('accepts within ±GIFSKI_ACCEPT_TOL on both sides', () => {
    expect(decideGifskiAccept(2, 2)).toBe('accept');
    expect(decideGifskiAccept(2 * (1 + GIFSKI_ACCEPT_TOL * 0.9), 2)).toBe('accept');
    expect(decideGifskiAccept(2 * (1 - GIFSKI_ACCEPT_TOL * 0.9), 2)).toBe('accept');
  });

  it('refines down when oversized beyond tol', () => {
    expect(decideGifskiAccept(2 * (1 + GIFSKI_ACCEPT_TOL * 2), 2)).toBe('refine-shrink');
  });

  it('refines up when undersized beyond tol', () => {
    expect(decideGifskiAccept(2 * (1 - GIFSKI_ACCEPT_TOL * 2), 2)).toBe('refine-grow');
  });

  it('treats invalid inputs as accept (caller short-circuit)', () => {
    expect(decideGifskiAccept(NaN, 2)).toBe('accept');
    expect(decideGifskiAccept(2, 0)).toBe('accept');
  });
});

describe('nextGifskiQuality (state machine driver)', () => {
  it('returns the probe value GIFSKI_Q_PROBE on the first call', () => {
    expect(nextGifskiQuality([], 2)).toBe(GIFSKI_Q_PROBE);
  });

  it('uses single-sample extrapolation with one prior sample', () => {
    const q = nextGifskiQuality([{ quality: 80, sizeMB: 4 }], 2);
    expect(q).toBeLessThan(80);
    expect(q).toBeGreaterThan(GIFSKI_Q_MIN);
  });

  it('uses log-log fit with two or more samples (good curve)', () => {
    // q=80 → 4MB, q=60 → 2.25MB (consistent with EXP≈2). Target 1MB.
    const q = nextGifskiQuality(
      [{ quality: 80, sizeMB: 4 }, { quality: 60, sizeMB: 2.25 }],
      1
    );
    expect(q).toBeLessThan(60);
    expect(q).toBeGreaterThanOrEqual(GIFSKI_Q_MIN);
  });

  it('falls back to single-sample when log-log fit is degenerate', () => {
    // Inverted pair → refineGifskiQuality returns NaN → next falls back.
    const q = nextGifskiQuality(
      [{ quality: 80, sizeMB: 2 }, { quality: 50, sizeMB: 4 }],
      1
    );
    expect(Number.isFinite(q)).toBe(true);
  });

  it('returns NaN for non-positive target', () => {
    expect(nextGifskiQuality([{ quality: 80, sizeMB: 4 }], 0)).toBeNaN();
    expect(nextGifskiQuality([{ quality: 80, sizeMB: 4 }], -1)).toBeNaN();
  });
});
