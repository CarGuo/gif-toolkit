/**
 * R-82 — Pure helper extracted from main/index.ts sanitizeOptions for the
 * R-81 four gifsicle knobs (lossyCeiling / colorsFloor / optimizeLevel /
 * dither). Lives in its own file so the test suite can reach it without
 * dragging in electron/app/path side effects from main/index.ts.
 *
 * Contract: the input is whatever the renderer dispatched over IPC. We
 * accept *only* values that pass type + range + enum-membership checks;
 * anything else is silently dropped (the caller will fall back to the
 * DEFAULT_OPTIONS value, matching the original sanitizeOptions
 * behaviour). Specifically protects against the R-82 P0 crash where a
 * stale dist/shared/types.js shadowed the barrel re-export and made
 * GIF_OPTIMIZE_LEVELS undefined at runtime — `includes` on undefined
 * threw `TypeError: Cannot read properties of undefined`.
 */
import {
  GIF_OPTIMIZE_LEVELS,
  GIF_DITHER_MODES,
  GIF_LOSSY_MAX,
  GIF_COLORS_MIN,
  GIF_COLORS_MAX,
  type GifOptimizeLevel,
  type GifDither,
} from '../shared/types/process';

export interface GifOptimizeKnobs {
  lossyCeiling?: number;
  colorsFloor?: number;
  optimizeLevel?: GifOptimizeLevel;
  dither?: GifDither;
}

export function sanitizeGifOptimizeKnobs(obj: Record<string, unknown>): GifOptimizeKnobs {
  const out: GifOptimizeKnobs = {};

  if (typeof obj.lossyCeiling === 'number' && Number.isFinite(obj.lossyCeiling)) {
    out.lossyCeiling = Math.max(0, Math.min(GIF_LOSSY_MAX, Math.round(obj.lossyCeiling)));
  }
  if (typeof obj.colorsFloor === 'number' && Number.isFinite(obj.colorsFloor)) {
    out.colorsFloor = Math.max(GIF_COLORS_MIN, Math.min(GIF_COLORS_MAX, Math.round(obj.colorsFloor)));
  }
  if (typeof obj.optimizeLevel === 'number' && Number.isFinite(obj.optimizeLevel)) {
    const lvl = Math.round(obj.optimizeLevel) as GifOptimizeLevel;
    if (GIF_OPTIMIZE_LEVELS.includes(lvl)) {
      out.optimizeLevel = lvl;
    }
  }
  if (typeof obj.dither === 'string' && GIF_DITHER_MODES.includes(obj.dither as GifDither)) {
    out.dither = obj.dither as GifDither;
  }

  return out;
}
