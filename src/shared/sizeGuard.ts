/**
 * R-72 — Pre-flight aspect-ratio / size guard for batch dispatch.
 *
 * Why this lives in shared/:
 *   processor.ts (main) and App.tsx (renderer) both need to ask "would
 *   this media fail the longest-side cap → short-side floor check?"
 *   The math is identical in both directions:
 *
 *     1. compute the effective maxSide (clamped to >= minSide >= HARD_MIN_SIZE)
 *     2. if longest > maxSide: project the short side after the cap
 *     3. if projected short < minSide: fail spec (unless forceAllowSmallSide)
 *
 * The processor enforces this AFTER the file is downloaded and probed
 * (when origW/origH are authoritative). The renderer wants to enforce
 * the same rule BEFORE dispatch, using the dimensions that came back
 * from the sniff layer (SniffedMedia.width / .height) so the user can
 * one-shot "allow all" instead of clicking 强制允许 N times after the
 * batch fails N times. When the sniffed dims are missing (some sources
 * don't provide them), evaluateSizeGuard returns 'unknown' and the
 * renderer should let the batch proceed — the main-side guard remains
 * the source of truth and will still catch the bad ones the same way
 * it did before R-72.
 *
 * IMPORTANT: this module must stay PURE (no I/O, no Electron / Node
 * APIs, no clocks). Both the renderer bundle (vite) and the main
 * bundle (tsc) inline it; making it impure would mean the renderer
 * ships a no-op shim and the main bundle ships the real one, which
 * is exactly the kind of split-brain that bit us in R-70.
 */

/** Lower bound shared with processor.ts — never let users set minSide
 *  below this floor, or the gif quality degrades to mush. Mirrors the
 *  HARD_MIN_SIZE constant in processor.ts; if you change one, change
 *  both. */
export const SIZE_GUARD_HARD_MIN = 240;

/**
 * Project the short side after capping the longest side. Pure mirror
 * of [shortSideAfterCap](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor-utils.ts#L39-L43)
 * so the renderer doesn't have to import from src/main/.
 *
 * Returns 0 when shape is unknown (caller should treat as "skip the
 * pre-check, fall back to runtime guard").
 */
export function shortSideAfterCap(longest: number, shortest: number, cap: number): number {
  if (longest <= 0 || shortest <= 0 || cap <= 0) return 0;
  if (longest <= cap) return shortest;
  return Math.max(1, Math.round(shortest * (cap / longest)));
}

/**
 * Compute the effective maxSide given the user's options. Mirrors
 * `Math.max(minSide, options.maxWidth)` from processor.ts L284 and
 * its sister at L1304.
 */
export function effectiveMaxSide(options: { maxWidth: number; minSize: number }): number {
  const minSide = Math.max(SIZE_GUARD_HARD_MIN, options.minSize);
  return Math.max(minSide, options.maxWidth);
}

export type SizeGuardVerdict =
  /** Dimensions unknown — let runtime guard decide. */
  | { state: 'unknown' }
  /** Either shape fits, or the short side after capping still meets minSide. */
  | { state: 'ok' }
  /** Will be rejected by processor.ts unless forceAllowSmallSide is set. */
  | {
      state: 'will-fail';
      origW: number;
      origH: number;
      maxSide: number;
      minSide: number;
      shortSideAtMax: number;
    };

/**
 * Pure pre-flight check. Returns one of three verdicts so the renderer
 * can decide whether to surface the batch size-guard modal. Does NOT
 * read from anything other than its arguments — safe to call inside
 * a React render or a useMemo without worrying about side effects.
 *
 * The accepted dim source is provided by the caller because the
 * renderer pulls from `m.width / m.height` (URL sniff results) while
 * the resolved-direct-link case prefers `m.resolved?.width/.height`.
 * Keeping the dim resolution out of this module means we don't
 * couple shared/ to SniffedMedia's exact field shape.
 */
export function evaluateSizeGuard(
  dims: { width?: number; height?: number },
  options: { maxWidth: number; minSize: number }
): SizeGuardVerdict {
  const w = dims.width ?? 0;
  const h = dims.height ?? 0;
  if (w <= 0 || h <= 0) return { state: 'unknown' };
  const longest = Math.max(w, h);
  const shortest = Math.min(w, h);
  const minSide = Math.max(SIZE_GUARD_HARD_MIN, options.minSize);
  const maxSide = Math.max(minSide, options.maxWidth);
  // Fits without capping → trivially ok.
  if (longest <= maxSide) return { state: 'ok' };
  const shortAtMax = shortSideAfterCap(longest, shortest, maxSide);
  // Cap applies but the projected short side is still tall enough.
  if (shortAtMax >= minSide) return { state: 'ok' };
  return {
    state: 'will-fail',
    origW: w,
    origH: h,
    maxSide,
    minSide,
    shortSideAtMax: shortAtMax
  };
}
