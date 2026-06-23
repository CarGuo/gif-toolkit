/**
 * processor-utils.ts — pure-function library extracted from processor.ts so
 * the math behind compression strategy can be unit-tested without spinning up
 * Electron / ffmpeg / sharp.
 *
 * Everything here MUST be:
 *   - referentially transparent (no I/O, no clocks, no random),
 *   - deterministic given the inputs,
 *   - free of side effects on module load.
 *
 * The matching tests live in tests/main/processor-utils.test.ts and are the
 * regression safety net for O1-O5 (commit 18ecc18). When you tweak any
 * tunable here, run `npm test` first.
 */
import crypto from 'crypto';

/* ------------------------- Concurrency clamp ------------------------- */

export const DEFAULT_CONCURRENCY = 3;
export const MAX_CONCURRENCY = 8;

/**
 * Clamp a user-supplied concurrency setting into [1, MAX_CONCURRENCY], with
 * NaN / undefined / non-positive falling back to DEFAULT_CONCURRENCY. Floors
 * fractional inputs.
 */
export function clampConcurrency(n: number | undefined): number {
  if (!Number.isFinite(n) || !n || (n as number) <= 0) return DEFAULT_CONCURRENCY;
  return Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(n as number)));
}

/* ------------------------- Aspect-ratio math ------------------------- */

/**
 * Re-exported from shared/sizeGuard.ts so the main process and the
 * renderer share a single source of truth for the aspect-ratio
 * projection used by both processor.ts (post-probe) and the R-72
 * batch pre-flight modal (pre-dispatch).
 *
 * If you tweak the formula, change it in shared/sizeGuard.ts only;
 * the existing tests/main/processor-utils.test.ts and the new
 * tests/shared/sizeGuard.test.ts both pin the boundary behaviour.
 */
export { shortSideAfterCap } from '../shared/sizeGuard';

/* ------------------------- Compression cache key ------------------------- */

/**
 * Stable cache key for the gifsicle output cache (O5). Two compressions with
 * identical (source path, width, lossy, colors) produce byte-identical output,
 * so we can short-circuit the redundant gifsicle pass.
 */
export function compressCacheKey(
  src: string,
  width: number,
  lossy: number,
  colors: number
): string {
  return `${src}|w=${width}|l=${lossy}|c=${colors}`;
}

/* ------------------------- O1 fast/shrink-first thresholds ------------------------- */

export const ACCEPT_TOL = 0.12;          // O2: ±12% of target counts as "good enough"
export const EARLY_FAST_RATIO = 1.6;     // O1: <= softMB × this → fast path (one pass)
export const SHRINK_FIRST_RATIO = 4.0;   // O1: > softMB × this → skip lossy on orig size
export const HARD_OVERSHOOT_LOSSY_BUMP = 30;

/**
 * Decide which Phase 0 branch to enter, given the gif's size on disk and the
 * user's soft target. Pure function so we can table-test the boundary between
 * fast / normal / shrink-first regimes.
 */
export type Phase0Branch = 'already-soft' | 'fast' | 'normal' | 'shrink-first';

export function planPhase0(initialMB: number, softMB: number): Phase0Branch {
  if (softMB <= 0) return 'normal';
  if (initialMB <= softMB) return 'already-soft';
  if (initialMB <= softMB * EARLY_FAST_RATIO) return 'fast';
  if (initialMB >= softMB * SHRINK_FIRST_RATIO) return 'shrink-first';
  return 'normal';
}

export type CompressionTargetTier = 'fallback' | 'soft';

/**
 * Pick the next compression target. The pipeline is two-tiered:
 * first get under the hard/fallback cap, then spend extra attempts on
 * the soft/best cap. This keeps oversized GIFs from wasting early passes
 * chasing an unrealistic soft target before they have reached a usable
 * fallback result.
 */
export function chooseCompressionTargetMB(
  hasReachedHard: boolean,
  hardMB: number,
  softMB: number
): { targetMB: number; tier: CompressionTargetTier } {
  if (!hasReachedHard && hardMB > 0) {
    return { targetMB: hardMB, tier: 'fallback' };
  }
  return { targetMB: softMB, tier: 'soft' };
}

/* ------------------------- O2 adaptive lossy starting point ------------------------- */

/**
 * Choose an initial gifsicle --lossy value based on how far the current size
 * is from the target. Bigger ratios → more aggressive lossy. Returned value
 * is clamped to [10, 200] which matches the gifsicle valid range.
 */
export function adaptiveStartLossy(currentMB: number, targetMB: number): number {
  if (targetMB <= 0 || !Number.isFinite(currentMB)) return 60;
  const ratio = currentMB / targetMB;
  if (ratio <= 1.0) return 20;
  if (ratio <= 1.5) return 40;
  if (ratio <= 2.5) return 80;
  if (ratio <= 4.0) return 120;
  return 160;
}

/**
 * O2 linear-extrapolation refine: given two samples on the gifsicle lossy
 * curve `(0, baselineMB)` and `(lastLossy, lastMB)`, predict the next lossy
 * value that should land near `targetMB`. Caller is responsible for clamping
 * to [10, 200] and for the early-accept short-circuit when |lastMB - target|
 * is already within ACCEPT_TOL.
 *
 * Returns NaN when the slope is degenerate (no information to extrapolate).
 */
export function extrapolateNextLossy(
  baselineMB: number,
  lastLossy: number,
  lastMB: number,
  targetMB: number
): number {
  if (lastLossy <= 0) return NaN;
  const k = (baselineMB - lastMB) / lastLossy; // slope: MB shaved per lossy unit
  if (!Number.isFinite(k) || k <= 0) return NaN;
  return lastLossy + (lastMB - targetMB) / k;
}

/**
 * C-02 — symmetric early-accept for Phase B's first lossy sample.
 *
 * Pre-fix behaviour: lossySearch accepted ANY `lastSize <= targetMB` and
 * returned immediately. With an aggressive `adaptiveStartLossy` start
 * (e.g. ratio=1.0 → lossy=20) this could land the first try at 30‑60 %
 * of the target — i.e. the user asked for "best 2MB" and got a visibly
 * mushy 0.7MB. The asymmetry contradicts ACCEPT_TOL's "±12 %" intent.
 *
 * `decideEarlyAccept` returns one of three actions:
 *   - 'accept'         : within tolerance on either side; done.
 *   - 'refine-shrink'  : lastSize > target by > tol; pick MORE lossy.
 *   - 'refine-grow'    : lastSize < target by > tol; pick LESS lossy
 *                        (we overshot — find back the quality).
 *
 * Pure function, side-effect free; matching tests pin the boundary.
 */
export type EarlyAcceptDecision = 'accept' | 'refine-shrink' | 'refine-grow';

export function decideEarlyAccept(
  lastSizeMB: number,
  targetMB: number,
  tol: number = ACCEPT_TOL
): EarlyAcceptDecision {
  if (targetMB <= 0 || !Number.isFinite(lastSizeMB) || !Number.isFinite(targetMB)) {
    return 'accept';
  }
  const diff = (lastSizeMB - targetMB) / targetMB;
  if (Math.abs(diff) <= tol) return 'accept';
  return diff > 0 ? 'refine-shrink' : 'refine-grow';
}

/* ------------------------- C-05 recordBest preference ------------------------- */

/**
 * Candidate snapshot consumed by `pickBetterCandidate`. Coordinates are
 * decoupled from the artefact path so the function is trivially testable.
 */
export interface CandidateSnapshot {
  sizeMB: number;
}

/**
 * C-05 — choose between two compression candidates given soft / hard caps.
 *
 * Pre-fix behaviour ([processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) `recordBest`):
 *   once a candidate was under softMB, ANY later candidate that was also
 *   under softMB AND larger replaced `best`. Net effect: best drifted
 *   towards the soft ceiling and the final artefact frequently landed
 *   at e.g. 1.99MB when an earlier 1.4MB pass was strictly better quality
 *   per byte. From the "soft cap = best" semantic that's a regression.
 *
 * New preference order (most → least preferred):
 *   1. Under soft is always preferred over over-soft.
 *   2. Under hard is always preferred over over-hard.
 *   3. Within the same band (both under soft, or both under hard,
 *      or both over hard) prefer the SMALLER candidate. Smaller =
 *      more headroom for the user's downstream pipeline (uploaders,
 *      embedded viewers, wechat 2MB cap, etc.).
 *   4. When sizes tie, prefer the existing `best` (stability — avoid
 *      log churn from cache-hit re-records).
 *
 * Returns `true` iff `incoming` should replace `current`.
 */
export function shouldReplaceBest(
  current: CandidateSnapshot | null,
  incoming: CandidateSnapshot,
  softMB: number,
  hardMB: number
): boolean {
  if (!current) return true;
  const tierOf = (s: number): 0 | 1 | 2 => {
    if (s <= softMB) return 0;
    if (s <= hardMB) return 1;
    return 2;
  };
  const ct = tierOf(current.sizeMB);
  const it = tierOf(incoming.sizeMB);
  if (it !== ct) return it < ct; // lower tier number = better band
  // Same band: prefer strictly smaller. Equal → keep current for stability.
  return incoming.sizeMB < current.sizeMB;
}

/* ------------------------- Geometric shrink target width ------------------------- */

/**
 * Phase C: when current GIF is too big after Phase B, shrink longest side by
 * sqrt(currentMB / targetMB) so a 4× over-budget gif gets halved. Result is
 * clamped to [minSide, currentLongestSide-1] so we always make progress.
 */
export function geometricShrinkLongestSide(
  currentLongestSide: number,
  currentMB: number,
  targetMB: number,
  minSide: number
): number {
  if (currentLongestSide <= minSide) return minSide;
  if (targetMB <= 0 || currentMB <= 0) return Math.max(minSide, currentLongestSide - 1);
  const ratio = Math.sqrt(targetMB / currentMB);
  const next = Math.round(currentLongestSide * Math.min(0.95, ratio));
  return Math.max(minSide, Math.min(currentLongestSide - 1, next));
}

/* ------------------------- Video clip segmentation (R-22) ------------------------- */

/**
 * One slice of a video → gif clip. Coordinates are in seconds, anchored to
 * the original video timeline (not relative to clipStart).
 */
export interface ClipSegment {
  index: number;       // 0-based ordinal among all segments produced from this clip
  start: number;       // absolute seconds into the source video
  duration: number;    // length of this slice in seconds
}

/**
 * Split a clip range [clipStart, clipEnd] into ceil(range / maxSegmentSec)
 * equally-sized segments. We deliberately keep all segments the same length
 * (= range / segCount) instead of "N full + 1 leftover" so the user gets
 * predictable durations like 0..10 / 10..20 instead of 0..15 / 15..18.
 *
 * Pure function; safe to import outside the Electron main process.
 *
 * Returns [] when the range is non-positive (caller should reject early).
 */
export function enumerateSegments(
  clipStart: number,
  clipEnd: number,
  maxSegmentSec: number
): ClipSegment[] {
  const segLen = Math.max(1, maxSegmentSec);
  const start = Math.max(0, clipStart);
  const end = Math.max(start, clipEnd);
  const range = end - start;
  if (range <= 0) return [];
  const segCount = Math.max(1, Math.ceil(range / segLen));
  const segActual = range / segCount;
  return Array.from({ length: segCount }, (_, i) => ({
    index: i,
    start: start + i * segActual,
    duration: segActual
  }));
}

/**
 * Apply `selectedSegments` whitelist to a segment list, preserving original
 * order. `undefined` (legacy callers) means "process every segment". Empty
 * array after dedup/clamp → also fall back to all segments to avoid producing
 * zero outputs (the renderer should never send `[]`, but we guard anyway).
 *
 * Out-of-range indices are dropped silently (renderer-side stale state is
 * possible if maxSegmentSec changes between PreviewPanel and submission).
 */
export function filterSelectedSegments(
  all: ClipSegment[],
  selected: readonly number[] | undefined
): ClipSegment[] {
  if (!selected || selected.length === 0) return all;
  const allow = new Set(
    selected
      .filter((n) => Number.isInteger(n) && n >= 0 && n < all.length)
  );
  if (allow.size === 0) return all;
  return all.filter((s) => allow.has(s.index));
}

/* ------------------------- Partial-fetch cache key (P1.1) ------------------------- */

/**
 * Inputs that must be hashed into the partial-fetch filename so a yt-dlp
 * `--download-sections` run with one selection cannot poison the cache for a
 * later run with a different selection (or the full stream). Only the fields
 * that change WHICH bytes are written are included; everything cosmetic
 * (e.g. fps, gif quality knobs) is omitted because those don't affect the
 * downloaded source.
 */
export interface PartialFetchKey {
  selectedSegments?: readonly number[];
  startSec?: number;
  endSec?: number;
  maxSegmentSec?: number;
}

/**
 * Derive a stable sibling filename for a partial (`--download-sections`) fetch
 * given the full-stream filename and the user's segment selection. Full-stream
 * downloads keep the original `localName`; partial fetches go to
 * `${stem}.sections.${hash}${ext}` so a later full or differently-scoped run
 * sees a cache miss and re-downloads instead of reusing the stitched-only mp4.
 *
 * Pure function: deterministic, no I/O, safe to unit-test in isolation.
 */
export function derivePartialSourceName(
  localName: string,
  key: PartialFetchKey
): string {
  const dot = localName.lastIndexOf('.');
  const ext = dot > 0 ? localName.slice(dot) : '.mp4';
  const stem = dot > 0 ? localName.slice(0, dot) : localName;
  const normalized = JSON.stringify({
    selectedSegments: key.selectedSegments
      ? [...key.selectedSegments].sort((a, b) => a - b)
      : null,
    startSec: key.startSec ?? null,
    endSec: key.endSec ?? null,
    maxSegmentSec: key.maxSegmentSec ?? null
  });
  const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 8);
  return `${stem}.sections.${hash}${ext}`;
}
