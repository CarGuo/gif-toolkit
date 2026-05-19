/**
 * R-82 — Regression tests for sanitizeGifOptimizeKnobs.
 *
 * Why this file exists: in R-81 the four gifsicle knobs (lossyCeiling /
 * colorsFloor / optimizeLevel / dither) were added to sanitizeOptions
 * directly inside main/index.ts. The B-3 / R-81 push went out without a
 * dev smoke test, and a parallel issue in dist/ — a stale single-file
 * dist/shared/types.js shadowed the new dist/shared/types/index.js
 * barrel — caused GIF_OPTIMIZE_LEVELS / GIF_DITHER_MODES to be
 * `undefined` at runtime. The very next IPC `process:start` crashed
 * with `TypeError: Cannot read properties of undefined (reading
 * 'includes')`. This test suite locks down the four-knob contract so
 * the same TypeError can never silently re-appear.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeGifOptimizeKnobs } from '../../src/main/sanitizeOptions';
import {
  GIF_LOSSY_MAX,
  GIF_COLORS_MIN,
  GIF_COLORS_MAX,
} from '../../src/shared/types/process';

describe('sanitizeGifOptimizeKnobs (R-82)', () => {
  describe('lossyCeiling', () => {
    it('accepts a valid integer in range', () => {
      expect(sanitizeGifOptimizeKnobs({ lossyCeiling: 80 }).lossyCeiling).toBe(80);
    });

    it('clamps values above GIF_LOSSY_MAX (200) down to 200', () => {
      expect(sanitizeGifOptimizeKnobs({ lossyCeiling: 9999 }).lossyCeiling).toBe(GIF_LOSSY_MAX);
    });

    it('clamps negative values up to 0', () => {
      expect(sanitizeGifOptimizeKnobs({ lossyCeiling: -50 }).lossyCeiling).toBe(0);
    });

    it('rounds non-integer numbers', () => {
      expect(sanitizeGifOptimizeKnobs({ lossyCeiling: 80.7 }).lossyCeiling).toBe(81);
    });

    it('drops non-number inputs silently (NaN)', () => {
      expect(sanitizeGifOptimizeKnobs({ lossyCeiling: NaN }).lossyCeiling).toBeUndefined();
    });

    it('drops non-number inputs silently (string)', () => {
      expect(sanitizeGifOptimizeKnobs({ lossyCeiling: '80' }).lossyCeiling).toBeUndefined();
    });

    it('drops non-number inputs silently (Infinity)', () => {
      expect(sanitizeGifOptimizeKnobs({ lossyCeiling: Infinity }).lossyCeiling).toBeUndefined();
    });

    it('drops missing field silently (omitted)', () => {
      expect(sanitizeGifOptimizeKnobs({}).lossyCeiling).toBeUndefined();
    });

    it('accepts 0 (lossy disabled)', () => {
      expect(sanitizeGifOptimizeKnobs({ lossyCeiling: 0 }).lossyCeiling).toBe(0);
    });

    it('accepts the upper bound exactly', () => {
      expect(sanitizeGifOptimizeKnobs({ lossyCeiling: GIF_LOSSY_MAX }).lossyCeiling).toBe(GIF_LOSSY_MAX);
    });
  });

  describe('colorsFloor', () => {
    it('accepts a valid integer in range', () => {
      expect(sanitizeGifOptimizeKnobs({ colorsFloor: 64 }).colorsFloor).toBe(64);
    });

    it('clamps values above GIF_COLORS_MAX (256) down to 256', () => {
      expect(sanitizeGifOptimizeKnobs({ colorsFloor: 9999 }).colorsFloor).toBe(GIF_COLORS_MAX);
    });

    it('clamps values below GIF_COLORS_MIN (2) up to 2', () => {
      expect(sanitizeGifOptimizeKnobs({ colorsFloor: 0 }).colorsFloor).toBe(GIF_COLORS_MIN);
      expect(sanitizeGifOptimizeKnobs({ colorsFloor: -10 }).colorsFloor).toBe(GIF_COLORS_MIN);
      expect(sanitizeGifOptimizeKnobs({ colorsFloor: 1 }).colorsFloor).toBe(GIF_COLORS_MIN);
    });

    it('rounds non-integer numbers', () => {
      expect(sanitizeGifOptimizeKnobs({ colorsFloor: 64.7 }).colorsFloor).toBe(65);
    });

    it('drops non-number inputs silently', () => {
      expect(sanitizeGifOptimizeKnobs({ colorsFloor: NaN }).colorsFloor).toBeUndefined();
      expect(sanitizeGifOptimizeKnobs({ colorsFloor: '64' }).colorsFloor).toBeUndefined();
      expect(sanitizeGifOptimizeKnobs({ colorsFloor: null }).colorsFloor).toBeUndefined();
    });

    it('accepts both bounds exactly', () => {
      expect(sanitizeGifOptimizeKnobs({ colorsFloor: GIF_COLORS_MIN }).colorsFloor).toBe(GIF_COLORS_MIN);
      expect(sanitizeGifOptimizeKnobs({ colorsFloor: GIF_COLORS_MAX }).colorsFloor).toBe(GIF_COLORS_MAX);
    });
  });

  describe('optimizeLevel', () => {
    it.each([1, 2, 3])('accepts the canonical level %d', (lvl) => {
      expect(sanitizeGifOptimizeKnobs({ optimizeLevel: lvl }).optimizeLevel).toBe(lvl);
    });

    it('rounds non-integer numbers before checking enum membership', () => {
      // 2.4 rounds to 2 which is valid
      expect(sanitizeGifOptimizeKnobs({ optimizeLevel: 2.4 }).optimizeLevel).toBe(2);
    });

    it('drops out-of-enum values silently (0 / 4 / 999)', () => {
      expect(sanitizeGifOptimizeKnobs({ optimizeLevel: 0 }).optimizeLevel).toBeUndefined();
      expect(sanitizeGifOptimizeKnobs({ optimizeLevel: 4 }).optimizeLevel).toBeUndefined();
      expect(sanitizeGifOptimizeKnobs({ optimizeLevel: 999 }).optimizeLevel).toBeUndefined();
    });

    it('drops non-number inputs silently', () => {
      expect(sanitizeGifOptimizeKnobs({ optimizeLevel: NaN }).optimizeLevel).toBeUndefined();
      expect(sanitizeGifOptimizeKnobs({ optimizeLevel: '3' }).optimizeLevel).toBeUndefined();
      expect(sanitizeGifOptimizeKnobs({ optimizeLevel: 'O3' }).optimizeLevel).toBeUndefined();
      expect(sanitizeGifOptimizeKnobs({ optimizeLevel: null }).optimizeLevel).toBeUndefined();
    });

    it('drops missing field silently', () => {
      expect(sanitizeGifOptimizeKnobs({}).optimizeLevel).toBeUndefined();
    });

    /**
     * R-82 — this is the exact crash that hit production. The renderer
     * dispatches a normal optimizeLevel:3 and the main process must not
     * throw `TypeError: Cannot read properties of undefined (reading
     * 'includes')` regardless of how the GIF_OPTIMIZE_LEVELS constant
     * arrives. Calling sanitizeGifOptimizeKnobs at all proves the
     * import path resolved correctly.
     */
    it('R-82 regression: never throws on a normal renderer payload', () => {
      expect(() => sanitizeGifOptimizeKnobs({
        optimizeLevel: 3,
        dither: 'floyd-steinberg',
        lossyCeiling: 200,
        colorsFloor: 2,
      })).not.toThrow();
    });
  });

  describe('dither', () => {
    it.each(['none', 'floyd-steinberg', 'ordered'])('accepts the enum value %s', (d) => {
      expect(sanitizeGifOptimizeKnobs({ dither: d }).dither).toBe(d);
    });

    it('drops unknown enum strings silently', () => {
      expect(sanitizeGifOptimizeKnobs({ dither: 'bayer' }).dither).toBeUndefined();
      expect(sanitizeGifOptimizeKnobs({ dither: 'FloydSteinberg' }).dither).toBeUndefined();
      expect(sanitizeGifOptimizeKnobs({ dither: '' }).dither).toBeUndefined();
    });

    it('drops non-string inputs silently', () => {
      expect(sanitizeGifOptimizeKnobs({ dither: 1 }).dither).toBeUndefined();
      expect(sanitizeGifOptimizeKnobs({ dither: null }).dither).toBeUndefined();
      expect(sanitizeGifOptimizeKnobs({ dither: undefined }).dither).toBeUndefined();
    });

    it('drops missing field silently', () => {
      expect(sanitizeGifOptimizeKnobs({}).dither).toBeUndefined();
    });
  });

  describe('combined / edge cases', () => {
    it('returns empty object for empty input', () => {
      expect(sanitizeGifOptimizeKnobs({})).toEqual({});
    });

    it('returns empty object for input with only unrelated keys', () => {
      expect(sanitizeGifOptimizeKnobs({ foo: 'bar', maxBytes: 1000 })).toEqual({});
    });

    it('passes all four valid knobs through together', () => {
      const result = sanitizeGifOptimizeKnobs({
        lossyCeiling: 120,
        colorsFloor: 64,
        optimizeLevel: 2,
        dither: 'ordered',
      });
      expect(result).toEqual({
        lossyCeiling: 120,
        colorsFloor: 64,
        optimizeLevel: 2,
        dither: 'ordered',
      });
    });

    it('partial valid input only sets the valid fields', () => {
      const result = sanitizeGifOptimizeKnobs({
        lossyCeiling: 50,
        optimizeLevel: 99,
        dither: 'unknown',
        colorsFloor: 'wrong',
      });
      expect(result).toEqual({ lossyCeiling: 50 });
    });

    it('does not throw on hostile input shapes', () => {
      expect(() => sanitizeGifOptimizeKnobs({
        lossyCeiling: { x: 1 } as unknown as number,
        colorsFloor: [] as unknown as number,
        optimizeLevel: () => 3 as unknown as number,
        dither: Symbol('floyd-steinberg') as unknown as string,
      })).not.toThrow();
    });
  });
});
