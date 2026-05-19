import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';
import PQueue from 'p-queue';
import { isAxiosError } from 'axios';
import type {
  ProcessTask,
  TaskProgress,
  ProcessOptions,
  SniffedMedia,
  PreviewResult,
  ThumbnailResult,
  ToolboxJob,
  ToolboxParams
} from '../shared/types';
import { DEFAULT_OPTIONS } from '../shared/types';
import { downloadToFile } from './downloader';
import {
  probe,
  videoToGifPalette,
  videoToAnimatedWebP,
  gifsicleOptimize,
  gifsicleMethod,
  imageResizeKeepAspect,
  statSizeMB,
  extractFrameDataUrl,
  buildThumbnailDataUrl,
  killAllProcs,
  toolboxTrim,
  toolboxSpeed,
  toolboxReverse,
  toolboxRotate,
  toolboxCrop,
  convertGifWebp
} from './ffmpeg';
import type { ProbeInfo } from './ffmpeg';
import { getCacheDir } from './binaries';
import { log } from './logger';
import { fileNameFor, safeName } from './helpers';
import { downloadYtdlpSections } from './resolver/ytdlp';
import {
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  clampConcurrency as clampConcurrencyExt,
  shortSideAfterCap as shortSideAfterCapExt,
  compressCacheKey,
  ACCEPT_TOL as ACCEPT_TOL_EXT,
  EARLY_FAST_RATIO as EARLY_FAST_RATIO_EXT,
  SHRINK_FIRST_RATIO as SHRINK_FIRST_RATIO_EXT,
  enumerateSegments,
  filterSelectedSegments
} from './processor-utils';

let currentConcurrency = DEFAULT_CONCURRENCY;
const queue = new PQueue({ concurrency: DEFAULT_CONCURRENCY });
const activeAborts: Set<AbortController> = new Set();
// R-43.2 — per-task abort controllers, keyed by task id, so the
// renderer can cancel ONE row in a running batch without nuking the
// whole queue. cancelTask(id) calls .abort() on the matching entry;
// the per-task controller's signal is also linked to its parent batch
// so cancelAllTasks still works (parent abort propagates to every
// child via an `addEventListener('abort', ...)` wire we set up at
// queue.add() time).
const taskAborts: Map<string, AbortController> = new Map();
// Tracks all currently-running batches. cancelAllTasks awaits every one of
// them so a retry-while-draining flow ('cancel → await → start') is race-free:
// the OLD batches must fully settle (including in-flight ffmpeg/gifsicle child
// processes) before a new batch may take their place.
const activeBatchPromises: Set<Promise<void>> = new Set();
// Re-export the unit values the local closures still reference; the
// processor-utils versions are the single source of truth, these aliases
// preserve the old call sites without one-line shotgun edits across the file.
void MAX_CONCURRENCY;

// Local thin wrappers that delegate to the unit-tested processor-utils.
// We keep wrappers (instead of replacing every call site) so the diff stays
// small and JS-side hot path doesn't add module-boundary indirection cost.
function clampConcurrency(n: number | undefined): number {
  return clampConcurrencyExt(n);
}

class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

/**
 * Thrown when a media's aspect ratio cannot satisfy BOTH
 *   max(longSide) <= maxSide   AND   min(shortSide) >= minSide
 * simultaneously, i.e. the image is too elongated for the user's bounds.
 */
class AspectRatioConstraintError extends Error {
  origW: number;
  origH: number;
  maxSide: number;
  minSide: number;
  shortSideAtMax: number;
  constructor(p: { origW: number; origH: number; maxSide: number; minSide: number; shortSideAtMax: number }) {
    const ratio = (p.origW && p.origH) ? `${p.origW}x${p.origH}` : 'unknown size';
    super(
      `aspect ratio out of range: ${ratio}, longest side capped at ${p.maxSide}px would shrink the short side to ${p.shortSideAtMax}px (< minSize ${p.minSide}px). ` +
      `Increase 最长边上限 / decrease 最小尺寸, or crop the media first.`
    );
    this.name = 'AspectRatioConstraintError';
    this.origW = p.origW;
    this.origH = p.origH;
    this.maxSide = p.maxSide;
    this.minSide = p.minSide;
    this.shortSideAtMax = p.shortSideAtMax;
  }
}

/**
 * Given an image with `(longestSide, shortestSide)` and a target longest side,
 * return what the shortest side will become (rounded) while preserving aspect.
 * Returns 0 when shape is unknown.
 */
function shortSideAfterCap(longest: number, shortest: number, cap: number): number {
  return shortSideAfterCapExt(longest, shortest, cap);
}

export async function cancelAllTasks(): Promise<void> {
  for (const ctrl of activeAborts) {
    try { ctrl.abort(); } catch { /* ignore */ }
  }
  queue.clear();
  killAllProcs();
  // Wait for EVERY in-flight batch to fully settle (workers observing the
  // abort, child processes exiting, finally{} blocks running). Without this,
  // a fresh startBatch() call could race with the still-draining old batches
  // and the queue would re-acquire concurrency before the old workers vacated.
  const inflight = Array.from(activeBatchPromises);
  if (inflight.length > 0) {
    try { await Promise.allSettled(inflight); } catch { /* ignore */ }
  }
  activeAborts.clear();
  taskAborts.clear();
}

/**
 * R-43.2 — cancel a single task by id. Aborts only that task's
 * controller, which fires the signal observed by the worker (sharp /
 * ffmpeg / gifsicle wrappers all re-check `signal.aborted` between
 * stages). Returns true if a matching task was found and aborted, false
 * if no such id is currently in-flight (already terminal, never
 * existed, or was sniff/preview which don't go through this map).
 *
 * The abort propagates as a CancelledError out of processOneTask, so
 * the existing `if (isAbortError(err))` branch in the queue worker
 * already emits `{ status: 'cancelled' }` for us — no extra emit needed
 * here.
 */
export function cancelTask(taskId: string): boolean {
  const ctrl = taskAborts.get(taskId);
  if (!ctrl) return false;
  try { ctrl.abort(); } catch { /* ignore */ }
  taskAborts.delete(taskId);
  return true;
}

function safeMediaId(id: string): string {
  return safeName(id);
}

async function ensureDir(p: string): Promise<void> {
  await fsp.mkdir(p, { recursive: true });
}

async function fileExistsNonEmpty(p: string): Promise<boolean> {
  try {
    const s = await fsp.stat(p);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

const HARD_MIN_SIZE = 240;

interface CompressResult {
  finalPath: string;
  sizeMB: number;
  width: number;
  given: boolean; // true = could not even reach the hard target
  reachedSoft: boolean; // true = within best-quality target (e.g. 2MB)
  /** Diagnostic trail of swallowed phase failures (R-08). When non-empty
   *  AND `given === true`, the caller MUST surface them to the user — this
   *  is the difference between "we tried but couldn't shrink it enough"
   *  vs. "every phase actually crashed and bestPath fell back to inputGif". */
  phaseFailures: string[];
  /** True when no phase actually produced any output (bestPath === inputGif).
   *  Used by the caller to flip task status from 'done' to 'failed'. */
  allPhasesFailed: boolean;
}

interface CompressEmit {
  (info: {
    message: string;
    percent: number;
    substep: string;
    stepIndex: number;
    totalSteps: number;
    detail?: string;
    currentSizeMB?: number;
  }): void;
}

function checkCancel(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError();
}

function isAbortError(e: unknown): boolean {
  if (e instanceof CancelledError) return true;
  if (isAxiosError(e)) {
    if (e.code === 'ERR_CANCELED' || e.code === 'ECONNABORTED') return true;
    const msg = (e.message || '').toLowerCase();
    if (msg.includes('canceled') || msg.includes('cancelled') || msg.includes('aborted')) return true;
  }
  if (e instanceof Error) {
    if (e.name === 'CancelledError' || e.name === 'CanceledError' || e.name === 'AbortError') return true;
    const msg = (e.message || '').toLowerCase();
    return msg === 'aborted' || msg === 'cancelled' || msg === 'canceled' || msg === 'download aborted';
  }
  return false;
}

/**
 * Smart GIF compression with tiered targets and **O1-O3 fast paths**.
 *
 *   softTarget  =  best-quality goal   (e.g. 2.0MB) — try hard to reach
 *   hardTarget  =  fallback ceiling    (e.g. 4.0MB) — must reach if possible
 *
 * Cost model (each gifsicle / sharp pass touches every frame, so the only
 * meaningful number is "how many full-frame rewrites do we do?"). Old
 * worst case ≈ 22; new worst case ≈ 8; common case ≈ 2-4.
 *
 * Strategy:
 *   Phase 0 (NEW, O1) — Cheap a-priori estimation:
 *     probe(w, h, frames). Estimate output size as
 *         pixels = w*h*frames; rawMB = pixels * BPP_BUDGET / 8MB
 *     • already smaller than initialSize?     irrelevant — we trust statSize.
 *     • initialSize already <= softMB?         done, 0 passes.
 *     • initialSize <= softMB * EARLY_FAST_RATIO (e.g. 1.6×)?
 *           Skip full lossy search: try ONE gifsicle at adaptiveStart, accept
 *           if within 12% of soft. Most "almost there" gifs finish in 1 pass.
 *     • initialSize >> softMB (e.g. > softMB * SHRINK_FIRST_RATIO = 4×)?
 *           Skip Phase B (lossy on original size — guaranteed to miss soft
 *           target) and jump straight into Phase C with a smarter starting
 *           dimension (sqrt of size ratio).
 *
 *   Phase A — Resize-first to maxSide if larger.
 *
 *   Phase B (REVISED, O2) — Adaptive lossy with linear-extrapolation refine:
 *     • Start at adaptiveStartLossy(curSize / softTarget).
 *     • If first try is within ACCEPT_TOL (12%) of target, accept immediately
 *       (no second pass needed — gifsicle's lossy curve is smooth enough).
 *     • Otherwise do at most ONE refine, but we don't bisect blindly: we
 *       linearly extrapolate next lossy = current + slope * (cur - target),
 *       which converges in 1 step on most natural content.
 *
 *   Phase C (REVISED, O3) — Geometric shrink, but each round only does ONE
 *     gifsicle (reusing the lossy level Phase B converged on), not a full
 *     4-call lossySearch. Only the FINAL round does a quick refine.
 *
 *   Phase D — Aggressive last resort: floor longest side, lossy=200, colors=64.
 *
 *   Cross-cutting (O5): a (srcKey, width, lossy, colors) → sizeMB cache
 *   short-circuits redundant gifsicle calls when Phase C re-tries dimensions
 *   the loop has already explored.
 */
async function compressLoop(
  inputGif: string,
  workDir: string,
  baseName: string,
  options: ProcessOptions,
  emit: CompressEmit,
  signal?: AbortSignal
): Promise<CompressResult> {
  const hardMB = options.maxBytes / (1024 * 1024);
  const softMB = Math.max(0.1, Math.min(hardMB, options.softMaxBytes / (1024 * 1024)));
  const minSide = Math.max(HARD_MIN_SIZE, options.minSize);
  const maxSide = Math.max(minSide, options.maxWidth);
  const TOTAL_STEPS = 8; // new realistic ceiling, was 12
  let stepCounter = 0;
  // Tunables — exposed as constants so a follow-up benchmark pass can
  // tweak them without re-reading the strategy comment. Sourced from
  // processor-utils so unit tests can pin the boundary behaviour.
  const ACCEPT_TOL = ACCEPT_TOL_EXT;          // O2: ±12% of target counts as "good enough"
  const EARLY_FAST_RATIO = EARLY_FAST_RATIO_EXT;     // O1: <= softMB × this → fast path
  const SHRINK_FIRST_RATIO = SHRINK_FIRST_RATIO_EXT;   // O1: > softMB × this → skip lossy on orig size
  const phaseFailures: string[] = [];
  let producedAny = false;
  const recordPhaseFailure = (phase: string, err: unknown): void => {
    const msg = (err as Error)?.message || String(err);
    const short = msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
    phaseFailures.push(`${phase}: ${short}`);
    log(`compressLoop ${phase} failed (will swallow): ${short}`);
    emit({
      message: `${phase} failed (continuing with best so far)`,
      percent: Math.min(95, 60 + stepCounter * 4),
      substep: 'phase-failed',
      stepIndex: ++stepCounter,
      totalSteps: TOTAL_STEPS,
      detail: short
    });
  };

  // O5: in-memory hit cache for (width, lossy, colors) → sizeMB. The src
  // file changes between rounds (after each resize), but within one
  // dimension we very often re-run identical lossy settings — cache spares
  // the redundant gifsicle invocation.
  const optimizeCache = new Map<string, { path: string; size: number }>();
  const cacheKey = compressCacheKey;

  // ---------- Phase 0: probe + a-priori size estimate ----------
  let origW = 0;
  let origH = 0;
  try {
    const info = await probe(inputGif);
    origW = info.width || 0;
    origH = info.height || 0;
  } catch (e) {
    /* sharp/ffprobe may fail on exotic gifs; fall back to no-resize */
    recordPhaseFailure('probe', e);
  }

  const longestSide = Math.max(origW, origH);
  const shortestSide = Math.min(origW, origH);

  if (longestSide > 0 && shortestSide > 0 && longestSide > maxSide) {
    const shortAtMax = shortSideAfterCap(longestSide, shortestSide, maxSide);
    if (shortAtMax > 0 && shortAtMax < minSide && !options.forceAllowSmallSide) {
      throw new AspectRatioConstraintError({
        origW,
        origH,
        maxSide,
        minSide,
        shortSideAtMax: shortAtMax
      });
    }
    // R-26 — when forceAllowSmallSide is set, the user has explicitly
    // accepted that the short side will dip below `minSize` for THIS
    // task only. Record it as a phase note so the diagnostic trail
    // makes the override visible after the fact.
    if (shortAtMax > 0 && shortAtMax < minSide && options.forceAllowSmallSide) {
      recordPhaseFailure(
        'aspect-ratio-bypass',
        new Error(
          `R-26 forceAllowSmallSide=true: capping ${origW}x${origH} to ${maxSide}px will yield short side ${shortAtMax}px (< minSize ${minSide}px) — proceeding anyway.`
        )
      );
    }
  }

  const widthForSide = (side: number): number => {
    if (longestSide <= 0 || origW <= 0) return Math.min(maxSide, side);
    return Math.max(1, Math.round(origW * (side / longestSide)));
  };

  let workSrc = inputGif;
  let workWidth = origW > 0 ? origW : maxSide;
  let workSide = longestSide > 0 ? longestSide : maxSide;

  // ---------- Phase A: resize-first ----------
  if (longestSide > 0 && longestSide > maxSide) {
    const targetWidth = widthForSide(maxSide);
    const targetShort = shortSideAfterCap(longestSide, shortestSide, maxSide);
    const resized = path.join(workDir, `${baseName}.fit.s${maxSide}.gif`);
    emit({
      message: `resizing to fit max ${maxSide}px`,
      percent: 60,
      substep: 'resizing',
      stepIndex: ++stepCounter,
      totalSteps: TOTAL_STEPS,
      detail: `${origW}x${origH} -> long ${maxSide}, short ${targetShort} (w=${targetWidth})`
    });
    try {
      await imageResizeKeepAspect(inputGif, resized, targetWidth, signal);
      workSrc = resized;
      workWidth = targetWidth;
      workSide = maxSide;
      producedAny = true;
    } catch (e) {
      if (isAbortError(e)) throw new CancelledError();
      recordPhaseFailure('phase-A-resize', e);
    }
  }

  const initialSize = await statSizeMB(workSrc);
  emit({
    message: 'probing initial size',
    percent: 62,
    substep: 'probing',
    stepIndex: ++stepCounter,
    totalSteps: TOTAL_STEPS,
    detail: `w=${workWidth} side=${workSide} -> ${initialSize.toFixed(2)}MB`,
    currentSizeMB: initialSize
  });

  let bestPath = workSrc;
  let bestSize = initialSize;
  let bestWidth = workWidth;
  let bestUnderHard = initialSize <= hardMB;
  let bestUnderSoft = initialSize <= softMB;

  // O1 short-circuit #1: already under soft. Zero gifsicle passes.
  if (initialSize <= softMB) {
    return {
      finalPath: workSrc,
      sizeMB: initialSize,
      width: workWidth,
      given: false,
      reachedSoft: true,
      phaseFailures,
      allPhasesFailed: false
    };
  }

  const recordBest = (p: string, s: number, w: number): void => {
    const wasUnderSoft = bestUnderSoft;
    const wasUnderHard = bestUnderHard;
    if (s <= softMB) {
      if (!wasUnderSoft || s > bestSize) {
        bestPath = p; bestSize = s; bestWidth = w;
        bestUnderSoft = true; bestUnderHard = true;
      }
    } else if (s <= hardMB) {
      if (!wasUnderSoft && (!wasUnderHard || s > bestSize)) {
        bestPath = p; bestSize = s; bestWidth = w;
        bestUnderHard = true;
      }
    } else {
      if (!wasUnderHard && s < bestSize) {
        bestPath = p; bestSize = s; bestWidth = w;
      }
    }
  };

  // ---------- helper: gifsicle pass with O5 cache ----------
  const tryOptimize = async (
    src: string,
    width: number,
    lossy: number,
    colors: number,
    label: string
  ): Promise<number> => {
    checkCancel(signal);
    const key = cacheKey(src, width, lossy, colors);
    const hit = optimizeCache.get(key);
    if (hit) {
      // O5: short-circuit redundant gifsicle. Still feed the result into
      // recordBest so the upper loop sees the size it already computed.
      recordBest(hit.path, hit.size, width);
      emit({
        message: `${label} (cache hit)`,
        percent: Math.min(95, 65 + stepCounter * 4),
        substep: 'optimizing',
        stepIndex: ++stepCounter,
        totalSteps: TOTAL_STEPS,
        detail: `cache w=${width} colors=${colors} lossy=${lossy} -> ${hit.size.toFixed(2)}MB`,
        currentSizeMB: hit.size
      });
      return hit.size;
    }
    const out = path.join(workDir, `${baseName}.w${width}.c${colors}l${lossy}.gif`);
    await gifsicleOptimize(src, out, lossy, colors, signal);
    const s = await statSizeMB(out);
    producedAny = true;
    recordBest(out, s, width);
    optimizeCache.set(key, { path: out, size: s });
    emit({
      message: label,
      percent: Math.min(95, 65 + stepCounter * 4),
      substep: 'optimizing',
      stepIndex: ++stepCounter,
      totalSteps: TOTAL_STEPS,
      detail: `w=${width} colors=${colors} lossy=${lossy} -> ${s.toFixed(2)}MB`,
      currentSizeMB: s
    });
    return s;
  };

  const adaptiveStartLossy = (curMB: number, target: number): number => {
    const ratio = curMB / Math.max(0.01, target);
    if (ratio <= 1.2) return 30;
    if (ratio <= 1.6) return 60;
    if (ratio <= 2.2) return 90;
    if (ratio <= 3.0) return 120;
    if (ratio <= 4.5) return 150;
    return 180;
  };

  // ---------- Phase B (revised, O2): single-shot or 1-refine lossy ----------
  // Gifsicle's --lossy curve is monotonic and ≈ smooth, so once we have one
  // (lossy, size) sample we can extrapolate the next lossy linearly:
  //
  //     size(lossy) ≈ size(0) - k * lossy        (k > 0, content-dependent)
  //
  // From a single observation (l1, s1) plus the prior sizeNow at lossy=0:
  //
  //     k = (sizeNow - s1) / l1
  //     l_next ≈ l1 + (s1 - target) / k
  //
  // Clamp l_next to [10, 200], cap lossy levels we never want to spend a
  // pass on (avoid l_next == l1 ± epsilon → no progress).
  const lossySearch = async (
    src: string,
    width: number,
    target: number,
    colors: number,
    phase: string
  ): Promise<number> => {
    const sizeNow = await statSizeMB(src);
    const start = adaptiveStartLossy(sizeNow, target);
    let lastLossy = start;
    let lastSize: number;
    try {
      lastSize = await tryOptimize(src, width, start, colors, `${phase} lossy=${start}`);
    } catch (e) {
      if (isAbortError(e)) throw new CancelledError();
      recordPhaseFailure(`${phase}-start-lossy=${start}`, e);
      return Number.POSITIVE_INFINITY;
    }
    // O2 acceptance: within tolerance (either side) → done, no refine needed.
    if (Math.abs(lastSize - target) / target <= ACCEPT_TOL) return lastSize;
    if (lastSize <= target) {
      // Already smaller than target — saving a refine costs at most some
      // quality. Accept and move on; recordBest already kept this result.
      return lastSize;
    }
    // O2 refine: linear extrapolation, single pass.
    const k = (sizeNow - lastSize) / Math.max(1, lastLossy); // MB per lossy unit
    if (k > 0) {
      const lExtrap = lastLossy + (lastSize - target) / k;
      const lNext = Math.max(10, Math.min(200, Math.round(lExtrap)));
      if (Math.abs(lNext - lastLossy) >= 8) {
        try {
          const s = await tryOptimize(src, width, lNext, colors, `${phase} refine lossy=${lNext}`);
          lastSize = s;
          lastLossy = lNext;
        } catch (e) {
          if (isAbortError(e)) throw new CancelledError();
          recordPhaseFailure(`${phase}-refine-lossy=${lNext}`, e);
        }
      }
    }
    return lastSize;
  };

  // O1 short-circuit #2: if "almost there" (1.0× < init <= 1.6× soft), the
  // adaptive single-shot is highly likely to land within tolerance. Run it
  // and exit if soft achieved — saves Phase B's refine + all of Phase C/D.
  // O1 short-circuit #3: if "way oversized" (> 4× soft), skip lossy on
  // ORIGINAL dimensions — we'd need lossy=180+colors=64 just to barely
  // dent it. Fall through to Phase C resize-first strategy directly.
  let curSize: number;
  if (initialSize <= softMB * EARLY_FAST_RATIO) {
    try {
      curSize = await lossySearch(workSrc, workWidth, softMB, 256, 'fast');
    } catch (e) {
      if (isAbortError(e)) throw new CancelledError();
      recordPhaseFailure('phase-B-fast', e);
      curSize = bestSize;
    }
    if (bestUnderSoft) {
      return {
        finalPath: bestPath, sizeMB: bestSize, width: bestWidth,
        given: false, reachedSoft: true,
        phaseFailures, allPhasesFailed: false
      };
    }
  } else if (initialSize >= softMB * SHRINK_FIRST_RATIO) {
    // Skip Phase B entirely. curSize stays at initialSize so Phase C will
    // pick a properly aggressive ratio for its first shrink.
    curSize = initialSize;
    emit({
      message: 'oversized: skipping original-size lossy, going straight to shrink',
      percent: 64,
      substep: 'planning',
      stepIndex: ++stepCounter,
      totalSteps: TOTAL_STEPS,
      detail: `initial ${initialSize.toFixed(2)}MB >= ${(softMB * SHRINK_FIRST_RATIO).toFixed(1)}MB, skip phase-B`
    });
  } else {
    // Normal regime: Phase B at original dimensions targeting soft.
    try {
      curSize = await lossySearch(workSrc, workWidth, softMB, 256, 'soft');
    } catch (e) {
      if (isAbortError(e)) throw new CancelledError();
      recordPhaseFailure('phase-B-lossySearch', e);
      curSize = bestSize;
    }
    if (bestUnderSoft) {
      return {
        finalPath: bestPath, sizeMB: bestSize, width: bestWidth,
        given: false, reachedSoft: true,
        phaseFailures, allPhasesFailed: false
      };
    }
  }

  // ---------- Phase C (revised, O3): shrink-and-test, single gifsicle per round ----------
  const longSideFloor = (() => {
    if (longestSide <= 0 || shortestSide <= 0) return minSide;
    const fromShort = Math.ceil(longestSide * minSide / shortestSide);
    return Math.max(minSide, Math.min(longestSide, fromShort));
  })();

  const MAX_RESIZE_ROUNDS = 3;
  let curSrc = workSrc;
  let curWidth = workWidth;
  let curSide = workSide;
  // Reuse the lossy level Phase B converged on (or a sensible default if
  // we skipped it). After resize the size shrinks roughly proportional to
  // pixels, so the same lossy is usually a fine starting guess.
  let convergedLossy = adaptiveStartLossy(curSize, softMB);

  for (let round = 0; round < MAX_RESIZE_ROUNDS; round += 1) {
    if (bestUnderSoft) break;
    if (curSide <= longSideFloor) break;
    const aim = bestUnderHard ? softMB : hardMB;
    const ratio = Math.sqrt(Math.max(0.1, aim / Math.max(0.01, curSize)));
    const nextSide = Math.max(longSideFloor, Math.min(curSide - 16, Math.round(curSide * ratio)));
    if (nextSide >= curSide) break;
    const nextWidth = (() => {
      if (longestSide <= 0 || origW <= 0) return nextSide;
      return Math.max(1, Math.round(origW * (nextSide / longestSide)));
    })();
    const nextShort = shortSideAfterCap(longestSide, shortestSide, nextSide);
    const resized = path.join(workDir, `${baseName}.shrink.s${nextSide}.gif`);
    emit({
      message: `shrinking to ${nextSide}px (longest side)`,
      percent: Math.min(90, 70 + round * 6),
      substep: 'resizing',
      stepIndex: ++stepCounter,
      totalSteps: TOTAL_STEPS,
      detail: `aim=${aim.toFixed(1)}MB ratio=${ratio.toFixed(2)} ${curSide}→${nextSide} short=${nextShort} (w=${nextWidth})`
    });
    try {
      await imageResizeKeepAspect(inputGif, resized, nextWidth, signal);
      producedAny = true;
    } catch (e) {
      if (isAbortError(e)) throw new CancelledError();
      recordPhaseFailure(`phase-C-shrink-side=${nextSide}`, e);
      break;
    }
    curSrc = resized;
    curWidth = nextWidth;
    curSide = nextSide;
    const sResized = await statSizeMB(resized);
    recordBest(resized, sResized, nextWidth);
    if (bestUnderSoft) break;

    // O3: each non-final round does ONE gifsicle pass at the lossy level
    // converged in Phase B, instead of a full lossySearch.
    const isFinalRound = round === MAX_RESIZE_ROUNDS - 1 || nextSide <= longSideFloor;
    if (!isFinalRound) {
      try {
        const s = await tryOptimize(curSrc, curWidth, convergedLossy, 256, `r${round + 1} lossy=${convergedLossy}`);
        curSize = s;
        // If still way over, bump lossy for next round.
        if (s > softMB * 1.5) convergedLossy = Math.min(200, convergedLossy + 30);
      } catch (e) {
        if (isAbortError(e)) throw new CancelledError();
        recordPhaseFailure(`phase-C-r${round + 1}-fast`, e);
      }
    } else {
      // Final round: invest in one more refine via lossySearch (which is
      // now itself at most 2 passes thanks to O2).
      try {
        curSize = await lossySearch(curSrc, curWidth, softMB, 256, `r${round + 1}-final`);
      } catch (e) {
        if (isAbortError(e)) throw new CancelledError();
        recordPhaseFailure(`phase-C-r${round + 1}-final-lossySearch`, e);
      }
    }
  }

  // ---------- Phase D: aggressive last resort ----------
  if (!bestUnderHard) {
    try {
      const finalSide = longSideFloor;
      const finalSrc = (() => {
        if (curSide > finalSide) {
          return path.join(workDir, `${baseName}.final.s${finalSide}.gif`);
        }
        return curSrc;
      })();
      if (curSide > finalSide) {
        const finalWidth = (() => {
          if (longestSide <= 0 || origW <= 0) return finalSide;
          return Math.max(1, Math.round(origW * (finalSide / longestSide)));
        })();
        await imageResizeKeepAspect(inputGif, finalSrc, finalWidth, signal);
        producedAny = true;
        curSrc = finalSrc;
        curWidth = finalWidth;
        curSide = finalSide;
      }
      await tryOptimize(curSrc, curWidth, 200, 64, `last-resort lossy=200 colors=64`);
    } catch (e) {
      if (isAbortError(e)) throw new CancelledError();
      recordPhaseFailure('phase-D-last-resort', e);
    }
  }

  return {
    finalPath: bestPath,
    sizeMB: bestSize,
    width: bestWidth,
    given: !bestUnderHard,
    reachedSoft: bestUnderSoft,
    phaseFailures,
    allPhasesFailed: !producedAny
  };
}

/* ----------------------- Thumbnail prefetch ----------------------- */

const THUMB_CACHE_MAX = 200;
const THUMB_ERR_TTL_MS = 30_000;
const thumbCache = new Map<string, ThumbnailResult>();
const inflightThumb = new Map<string, Promise<ThumbnailResult>>();
const thumbErrAt = new Map<string, number>();

function cacheThumb(id: string, result: ThumbnailResult): void {
  if (thumbCache.has(id)) thumbCache.delete(id);
  thumbCache.set(id, result);
  while (thumbCache.size > THUMB_CACHE_MAX) {
    const oldest = thumbCache.keys().next().value;
    if (oldest === undefined) break;
    thumbCache.delete(oldest);
  }
}

export async function prefetchThumbnail(media: SniffedMedia): Promise<ThumbnailResult> {
  const cached = thumbCache.get(media.id);
  if (cached && cached.status === 'ok') {
    thumbCache.delete(media.id);
    thumbCache.set(media.id, cached);
    return cached;
  }
  // Negative cache: avoid hammering huge / failing assets with repeated
  // download+probe attempts. Re-try after THUMB_ERR_TTL_MS.
  const errAt = thumbErrAt.get(media.id);
  if (errAt && Date.now() - errAt < THUMB_ERR_TTL_MS) {
    return { id: media.id, status: 'error', error: 'thumbnail temporarily unavailable (cached failure)' };
  }
  const inflight = inflightThumb.get(media.id);
  if (inflight) return inflight;

  const work = (async () => {
    const dir = path.join(getCacheDir(), safeMediaId(media.id));
    await ensureDir(dir);
    const fname = fileNameFor(media);
    const local = path.join(dir, fname);
    try {
      if (!(await fileExistsNonEmpty(local))) {
        await downloadToFile(media.url, dir, fname, {
          referer: media.pageUrl,
          maxBytes: 200 * 1024 * 1024
        });
      }
      // SC-19 cache poisoning self-heal: thumbnail extract often surfaces
      // ffprobe/ffmpeg "moov atom not found" first when a poisoned source
      // is reused. Unlink and re-download exactly once before giving up.
      let t;
      try {
        t = await buildThumbnailDataUrl(local, media.kind);
      } catch (extractErr) {
        const msg = (extractErr as Error).message || '';
        const corrupted = /moov atom not found|Invalid data found|Truncating packet|could not find codec parameters/i.test(msg);
        if (!corrupted) throw extractErr;
        log(`thumbnail extract failed (likely poisoned cache): ${msg}; purging and redownloading once`);
        await fsp.unlink(local).catch(() => undefined);
        await fsp.unlink(`${local}.part`).catch(() => undefined);
        await downloadToFile(media.url, dir, fname, {
          referer: media.pageUrl,
          maxBytes: 200 * 1024 * 1024
        });
        t = await buildThumbnailDataUrl(local, media.kind);
      }
      const result: ThumbnailResult = {
        id: media.id,
        status: 'ok',
        dataUrl: t.dataUrl,
        width: t.width,
        height: t.height
      };
      cacheThumb(media.id, result);
      thumbErrAt.delete(media.id);
      return result;
    } catch (e) {
      const msg = (e as Error).message || String(e);
      thumbErrAt.set(media.id, Date.now());
      return { id: media.id, status: 'error', error: msg } as ThumbnailResult;
    } finally {
      inflightThumb.delete(media.id);
    }
  })();
  inflightThumb.set(media.id, work);
  return work;
}

/* ----------------------- Preview (frames) ----------------------- */

export async function previewMedia(media: SniffedMedia, _options: ProcessOptions): Promise<PreviewResult> {
  const work = path.join(getCacheDir(), safeMediaId(media.id));
  await ensureDir(work);
  let local: string;
  if (media.kind === 'video' || media.kind === 'gif') {
    const fname = fileNameFor(media);
    local = path.join(work, fname);
    if (!(await fileExistsNonEmpty(local))) {
      await downloadToFile(media.url, work, fname, { referer: media.pageUrl });
    }
  } else {
    return {
      taskId: media.id,
      durationSec: 0,
      width: 0,
      height: 0,
      frames: [],
      error: 'Preview only supports video or gif'
    };
  }

  // SC-19 cache poisoning self-heal (preview path).
  let info: ProbeInfo;
  try {
    info = await probe(local);
  } catch (e) {
    const msg = (e as Error).message || '';
    const corrupted = /moov atom not found|Invalid data found|Truncating packet|could not find codec parameters/i.test(msg);
    if (!corrupted) throw e;
    log(`preview probe failed (likely poisoned cache): ${msg}; purging and redownloading once`);
    await fsp.unlink(local).catch(() => undefined);
    await fsp.unlink(`${local}.part`).catch(() => undefined);
    const fname = fileNameFor(media);
    await downloadToFile(media.url, work, fname, { referer: media.pageUrl });
    info = await probe(local);
  }
  const duration = info.durationSec || 0;
  const sampleN = 6;
  const frames = [] as PreviewResult['frames'];
  if (duration > 0 && info.hasVideo) {
    for (let i = 0; i < sampleN; i++) {
      const t = (duration * i) / sampleN;
      try {
        const url = await extractFrameDataUrl(local, t);
        frames.push({ index: i, timeSec: t, dataUrl: url });
      } catch (e) {
        log(`preview frame failed: ${(e as Error).message}`);
      }
    }
  }

  return {
    taskId: media.id,
    durationSec: duration,
    width: info.width,
    height: info.height,
    frames
  };
}

/* ----------------------- Batch processing ----------------------- */

interface RunArgs {
  task: ProcessTask;
  outputBaseDir: string;
  emit: (p: TaskProgress) => void;
  signal: AbortSignal;
  batchTaken: Set<string>;
}

async function processOneTask({ task, outputBaseDir, emit, signal, batchTaken }: RunArgs): Promise<void> {
  const { media } = task;
  // R-24: `options` may be rewritten after a partial yt-dlp section
  // download to drop the now-stale selectedSegments / clip range, so it
  // must be `let` rather than `const`. Everything else on the task is
  // immutable.
  let options = task.options;

  // Early-fail: embed-only media (Vimeo/YouTube/etc.) cannot be downloaded as
  // a direct stream UNLESS the renderer already opted in to "解析直链" and
  // attached a `resolved` payload. The main process is the security boundary —
  // refuse here too in case a stale task payload slips past the UI guard.
  if (media.requiresExternalDownload && !media.resolved) {
    throw new Error(
      `embed-only media: cannot extract direct stream from ${media.embedHost || 'third-party player'}`
    );
  }

  // When `media.resolved` is present, treat the resolved direct URL as the
  // download source. For Bilibili CDNs we MUST also forward the resolver's
  // headers (Referer, User-Agent) or the CDN returns HTTP 403.
  const fetchUrl = media.resolved?.url || media.url;
  const fetchHeaders = media.resolved?.headers;
  const fetchReferer = media.resolved ? media.pageUrl : media.pageUrl;

  const work = path.join(getCacheDir(), safeMediaId(media.id));
  await ensureDir(work);
  await ensureDir(outputBaseDir);

  const t0 = Date.now();
  const elapsed = (): number => Date.now() - t0;

  // R-33A: manual re-optimize fast path. The renderer pre-validated the
  // path via sanitizeOptions (whitelist + .gif extension). We skip
  // download/encode and jump straight into the gif compress branch using
  // the supplied file as our sourcePath. The branch below (`media.kind
  // === 'gif' || options.reoptimizeFromGifPath`) does the rest.
  //
  // R-79: warning text MUST use the SAME phrases the first-pass branch
  // emits ("exceeds hard target …" / "did not reach soft target …").
  // The renderer's `isUnderTargetDone` predicate is a String.includes
  // match against those exact tokens; if a re-opt result is still
  // over-target, we want the "手动优化" button to come back so the
  // user can keep tightening parameters until the file fits — that is
  // the entire R-79 product requirement ("二次处理后还是不达标的话,
  // 那还是可以继续二次处理"). When the re-opt actually hits the soft
  // target, `warning` stays undefined and the button auto-disappears.
  if (options.reoptimizeFromGifPath) {
    emit({
      taskId: task.id,
      status: 'compressing',
      percent: 50,
      message: 'optimizing gif (re-run)',
      substep: 'optimizing',
      elapsedMs: elapsed()
    });
    const localName = fileNameFor(media);
    const reSrc = path.join(work, localName);
    // Copy into the per-task work dir so compressLoop's intermediate
    // outputs (gifsicle artefacts) live alongside it as usual. We never
    // rename / mutate the user's original output file.
    await fsp.copyFile(options.reoptimizeFromGifPath, reSrc);
    const result = await compressLoop(
      reSrc,
      work,
      fileNameFor(media, ''),
      options,
      (info) =>
        emit({
          taskId: task.id,
          status: 'compressing',
          percent: info.percent,
          message: info.message,
          substep: info.substep,
          stepIndex: info.stepIndex,
          totalSteps: info.totalSteps,
          detail: info.detail,
          currentSizeMB: info.currentSizeMB,
          elapsedMs: elapsed()
        }),
      signal
    );
    const finalOut = path.join(outputBaseDir, fileNameFor(media, '.opt.gif', batchTaken));
    await fsp.copyFile(result.finalPath, finalOut);
    const targetMBLocal = options.maxBytes / (1024 * 1024);
    const softMBLocal2 = options.softMaxBytes / (1024 * 1024);
    const tier = result.reachedSoft
      ? `<= ${softMBLocal2.toFixed(1)}MB (best)`
      : !result.given
        ? `<= ${targetMBLocal.toFixed(1)}MB (fallback)`
        : `over ${targetMBLocal.toFixed(1)}MB`;
    // R-79 — keep the first-pass token vocabulary verbatim so the
    // renderer's `isUnderTargetDone` predicate keeps recognising
    // re-optimised-but-still-over-target rows and brings the
    // "手动优化" button back. We embed "(re-run)" in the message
    // (not the warning) so logs / history can still distinguish a
    // re-run from a first pass without breaking the predicate.
    let warning: string | undefined;
    if (result.given) {
      warning = `final size ${result.sizeMB.toFixed(2)}MB exceeds hard target ${targetMBLocal.toFixed(1)}MB at min ${options.minSize}px`;
      if (result.phaseFailures.length > 0) {
        warning += ` · ${result.phaseFailures.length} phase failure(s) — click for details`;
      }
    } else if (!result.reachedSoft) {
      warning = `did not reach soft target ${softMBLocal2.toFixed(1)}MB; saved at ${result.sizeMB.toFixed(2)}MB`;
      if (result.phaseFailures.length > 0) {
        warning += ` · ${result.phaseFailures.length} phase failure(s) — click for details`;
      }
    }
    emit({
      taskId: task.id,
      status: 'done',
      percent: 100,
      outputs: [finalOut],
      currentSizeMB: result.sizeMB,
      warning,
      phaseFailures: result.phaseFailures.length > 0 ? result.phaseFailures : undefined,
      message: `gif re-optimized (${result.sizeMB.toFixed(2)}MB ${tier})`,
      elapsedMs: elapsed()
    });
    return;
  }

  emit({
    taskId: task.id,
    status: 'downloading',
    percent: 5,
    message: 'downloading source',
    substep: 'downloading',
    elapsedMs: elapsed()
  });
  const localName = fileNameFor(media);
  const sourcePath = path.join(work, localName);
  // R-24: when the source is a yt-dlp resolved page AND the user has
  // explicitly limited the work to a strict subset of segments AND we
  // know the resolved duration up-front (sniffer probed it), download
  // only those time ranges via yt-dlp's --download-sections. The output
  // is a concatenated mp4 whose duration equals the sum of the picked
  // ranges, so the existing segment-splitting code below produces one
  // ffmpeg run per requested chunk without touching the rest of the
  // remote file. Saves wall time AND CDN bandwidth.
  //
  // We *deliberately* require selectedSegments to be set — without an
  // explicit pick we keep the legacy "download whole stream once, slice
  // locally" behaviour because that is the most predictable for short
  // clips and for cases where future re-runs may want different ranges.
  const ytdlpResolved = media.resolved?.source === 'ytdlp';
  const knownDuration = media.resolved?.durationSec;
  const userPickedSubset =
    options.selectedSegments && options.selectedSegments.length > 0;
  const canPartialFetch =
    ytdlpResolved &&
    typeof knownDuration === 'number' &&
    knownDuration > 0 &&
    userPickedSubset === true;

  let partialFetchUsed = false;
  if (canPartialFetch && !(await fileExistsNonEmpty(sourcePath))) {
    // Pre-compute segments using the resolved duration so we know which
    // [start,end] ranges to ask yt-dlp for. enumerateSegments uses the
    // same equal-split policy that processor.ts later applies, so the
    // segment indices align 1:1 between the two passes.
    const fullStart = options.startSec ?? 0;
    const fullEnd = options.endSec ?? (knownDuration as number);
    const allSegs = enumerateSegments(fullStart, fullEnd, options.maxSegmentSec);
    const pickedSegs = filterSelectedSegments(allSegs, options.selectedSegments);
    if (pickedSegs.length > 0 && pickedSegs.length < allSegs.length) {
      const sections = pickedSegs.map((s) => ({ startSec: s.start, endSec: s.start + s.duration }));
      try {
        log(`[R-24] yt-dlp section download: ${sections.length}/${allSegs.length} segments`);
        emit({
          taskId: task.id,
          status: 'downloading',
          percent: 6,
          message: `downloading ${sections.length} selected segments via yt-dlp`,
          substep: 'downloading',
          elapsedMs: elapsed()
        });
        await downloadYtdlpSections(media.pageUrl, sourcePath, sections, signal);
        partialFetchUsed = true;
      } catch (e) {
        log(`[R-24] section download failed, falling back to full download: ${(e as Error).message}`);
        // Fall through to legacy full-stream download.
      }
    }
  }
  // After a successful partial fetch, the local file already contains
  // ONLY the picked segments stitched end-to-end. Re-applying the
  // selectedSegments whitelist on top of that file would either be a
  // no-op (subset matches) or filter incorrectly (indices no longer
  // align). Clearing it lets the rest of videoToGif treat the file as
  // a normal short source and produce one gif per concatenated chunk.
  if (partialFetchUsed) {
    options = { ...options, selectedSegments: undefined, startSec: undefined, endSec: undefined };
  }

  if (!partialFetchUsed && !(await fileExistsNonEmpty(sourcePath))) {
    let lastEmit = 0;
    await downloadToFile(fetchUrl, work, localName, {
      referer: fetchReferer,
      headers: fetchHeaders,
      signal,
      onProgress: (rec, total) => {
        const now = Date.now();
        if (now - lastEmit < 120) return;
        lastEmit = now;
        const pct = total ? Math.min(20, 5 + (rec / total) * 15) : 10;
        emit({
          taskId: task.id,
          status: 'downloading',
          percent: pct,
          substep: 'downloading',
          message: total
            ? `downloading ${(rec / 1024).toFixed(0)} / ${(total / 1024).toFixed(0)} KB`
            : `downloading ${(rec / 1024).toFixed(0)} KB`,
          bytesDownloaded: rec,
          bytesTotal: total || undefined,
          elapsedMs: elapsed()
        });
      }
    });
  }

  checkCancel(signal);

  const targetMB = options.maxBytes / (1024 * 1024);

  if (media.kind === 'gif') {
    emit({
      taskId: task.id,
      status: 'compressing',
      percent: 50,
      message: 'optimizing gif',
      substep: 'optimizing',
      elapsedMs: elapsed()
    });

    // R-33B: skip-compress fast path. User explicitly asked to bypass the
    // gifsicle iterative loop. We just copy the downloaded gif as-is to the
    // output directory and report success. Output may exceed maxBytes — we
    // surface the actual size via currentSizeMB so the UI can display it
    // without a warning (warning is reserved for *failures to meet target*,
    // not *intentional skip*).
    if (options.skipCompress === true) {
      const finalOut = path.join(outputBaseDir, fileNameFor(media, '.gif', batchTaken));
      await fsp.copyFile(sourcePath, finalOut);
      const sizeMB = await statSizeMB(finalOut);
      emit({
        taskId: task.id,
        status: 'done',
        percent: 100,
        outputs: [finalOut],
        currentSizeMB: sizeMB,
        message: `gif saved as-is (${sizeMB.toFixed(2)}MB · compress skipped)`,
        elapsedMs: elapsed()
      });
      return;
    }

    const result = await compressLoop(
      sourcePath,
      work,
      fileNameFor(media, ''),
      options,
      (info) =>
        emit({
          taskId: task.id,
          status: 'compressing',
          percent: info.percent,
          message: info.message,
          substep: info.substep,
          stepIndex: info.stepIndex,
          totalSteps: info.totalSteps,
          detail: info.detail,
          currentSizeMB: info.currentSizeMB,
          elapsedMs: elapsed()
        }),
      signal
    );
    const finalOut = path.join(outputBaseDir, fileNameFor(media, '.gif', batchTaken));
    await fsp.copyFile(result.finalPath, finalOut);
    const softMB = options.softMaxBytes / (1024 * 1024);
    const tier = result.reachedSoft
      ? `<= ${softMB.toFixed(1)}MB (best)`
      : !result.given
        ? `<= ${targetMB.toFixed(1)}MB (fallback)`
        : `over ${targetMB.toFixed(1)}MB`;

    // R-08 / Bug B: distinguish "we tried hard, couldn't shrink" from
    // "every phase actually failed and we silently kept the original".
    // If allPhasesFailed === true, surface the diagnostics through `error`
    // and flip status to 'failed' instead of 'done'.
    if (result.allPhasesFailed) {
      const diag = result.phaseFailures.length
        ? result.phaseFailures.slice(0, 3).join(' | ')
        : 'no phase produced any output (input file kept as-is)';
      emit({
        taskId: task.id,
        status: 'failed',
        percent: 100,
        currentSizeMB: result.sizeMB,
        error: `gif compression: every phase failed → kept original ${result.sizeMB.toFixed(2)}MB. ${diag}`,
        message: 'gif compression failed (no phase produced output)',
        elapsedMs: elapsed()
      });
      return;
    }

    let warning: string | undefined;
    if (result.given) {
      // Real problem: couldn't reach hard target. Surface a short warning;
      // full phase failure list is delivered via the `phaseFailures` field
      // and the UI's click-to-open detail modal (no need to inline 2 of N
      // here — that was misleading users about what they should care about).
      warning = `final size ${result.sizeMB.toFixed(2)}MB exceeds hard target ${targetMB.toFixed(1)}MB at min ${options.minSize}px`;
      if (result.phaseFailures.length > 0) {
        warning += ` · ${result.phaseFailures.length} phase failure(s) — click for details`;
      }
    } else if (!result.reachedSoft) {
      // Reached hard target but not soft. Mild notice.
      warning = `did not reach soft target ${softMB.toFixed(1)}MB; saved at ${result.sizeMB.toFixed(2)}MB`;
      if (result.phaseFailures.length > 0) {
        warning += ` · ${result.phaseFailures.length} phase failure(s) — click for details`;
      }
    }
    // Reached soft target: SUCCESS. Even if some phases failed along the
    // way, the user got a good output — don't display a "⚠ warning" that
    // makes a successful 1.67MB result look broken. Phase failure trail
    // is still attached via the `phaseFailures` field for the optional
    // detail modal, but `warning` stays undefined.

    emit({
      taskId: task.id,
      status: 'done',
      percent: 100,
      outputs: [finalOut],
      currentSizeMB: result.sizeMB,
      warning,
      phaseFailures: result.phaseFailures.length > 0 ? result.phaseFailures : undefined,
      message: `gif saved (${result.sizeMB.toFixed(2)}MB ${tier})`,
      elapsedMs: elapsed()
    });
    return;
  }

  if (media.kind === 'image') {
    // Derive the file extension from the URL pathname (NOT the full URL),
    // so query strings like `?w=400&v=2` don't leak into the filename and
    // break Windows write semantics (`.gif?w=400` is illegal on NTFS).
    const cleanExt = (() => {
      try {
        const ext = path.extname(new URL(media.url).pathname).toLowerCase();
        if (/^\.[a-z0-9]{1,5}$/.test(ext)) return ext;
      } catch { /* fall through */ }
      return '.bin';
    })();
    const finalOut = path.join(
      outputBaseDir,
      fileNameFor(media, cleanExt, batchTaken)
    );
    await fsp.copyFile(sourcePath, finalOut);
    emit({
      taskId: task.id,
      status: 'done',
      percent: 100,
      outputs: [finalOut],
      message: 'image copied',
      elapsedMs: elapsed()
    });
    return;
  }

  // ----- video branch -----
  emit({
    taskId: task.id,
    status: 'probing',
    percent: 22,
    substep: 'probing-video',
    elapsedMs: elapsed()
  });
  // SC-19 cache poisoning self-heal: an earlier failed/throttled SABR
  // download can leave a cached `.mp4` on disk that has no `moov` atom.
  // The short-read self-check at download time (SC-16) only protects new
  // downloads — but an existing poisoned file gets reused on the next
  // run, and ffprobe blows up with "moov atom not found / Invalid data
  // found when processing input", failing the whole task.
  //
  // Strategy: try to probe; if it fails with a known corruption marker,
  // unlink the cache file and re-download exactly once. Only fail the
  // task if the second probe still fails — at that point it's a real
  // bad source, not a stale cache.
  let info: ProbeInfo;
  try {
    info = await probe(sourcePath);
  } catch (e) {
    const msg = (e as Error).message || '';
    const corrupted = /moov atom not found|Invalid data found|Truncating packet|could not find codec parameters/i.test(msg);
    if (!corrupted) throw e;
    log(`probe failed on cached source (likely poisoned): ${msg}; purging and redownloading once`);
    emit({
      taskId: task.id,
      status: 'downloading',
      percent: 8,
      message: 'cached source corrupted — re-downloading',
      substep: 'downloading',
      elapsedMs: elapsed()
    });
    await fsp.unlink(sourcePath).catch(() => undefined);
    // Also clean any sidecar partial markers if present.
    await fsp.unlink(`${sourcePath}.part`).catch(() => undefined);
    await downloadToFile(fetchUrl, work, localName, {
      referer: fetchReferer,
      headers: fetchHeaders,
      signal
    });
    info = await probe(sourcePath);
  }
  if (!info.hasVideo || info.durationSec <= 0) {
    throw new Error('invalid video stream');
  }

  const totalDuration = info.durationSec;
  const userStart = options.startSec ?? 0;
  const userEnd = options.endSec ?? totalDuration;
  const clipStart = Math.max(0, Math.min(totalDuration, userStart));
  const clipEnd = Math.max(clipStart, Math.min(totalDuration, userEnd));
  const range = clipEnd - clipStart;
  if (range <= 0.5) throw new Error('clip range too short (<0.5s)');

  // R-22: split the clip into equally-sized segments, then optionally filter
  // by user's selectedSegments whitelist so a long video doesn't expand into
  // a flood of tasks. enumerateSegments + filterSelectedSegments are pure
  // helpers in processor-utils.ts (covered by processor-utils.test.ts).
  const allSegments = enumerateSegments(clipStart, clipEnd, options.maxSegmentSec);
  const segments = filterSelectedSegments(allSegments, options.selectedSegments);
  if (segments.length === 0) {
    // filterSelectedSegments only returns [] when allSegments itself is empty
    // (range non-positive); guarded by the range check above, but keep an
    // explicit error for defensive coverage.
    throw new Error('no segments to process');
  }

  const srcW = info.width > 0 ? info.width : options.maxWidth;
  const srcH = info.height > 0 ? info.height : 0;
  // Constrain BOTH width and height by maxWidth (treated as max longest side).
  // Also enforce: short side after the cap must be >= minSize, else fail fast.
  const initialWidth = (() => {
    const maxSide = options.maxWidth;
    const minSide = Math.max(HARD_MIN_SIZE, options.minSize);
    if (minSide > maxSide) return Math.max(minSide, maxSide);
    if (srcH <= 0 || srcW <= 0) {
      return Math.max(minSide, Math.min(maxSide, srcW));
    }
    const longest = Math.max(srcW, srcH);
    const shortest = Math.min(srcW, srcH);
    if (longest > maxSide) {
      const shortAtMax = shortSideAfterCap(longest, shortest, maxSide);
      if (shortAtMax > 0 && shortAtMax < minSide && !options.forceAllowSmallSide) {
        throw new AspectRatioConstraintError({
          origW: srcW,
          origH: srcH,
          maxSide,
          minSide,
          shortSideAtMax: shortAtMax
        });
      }
      // R-26 — see compressGif for symmetric override path. We don't have a
      // recordPhaseFailure() in this scope (videoToGif callers consume the
      // warnings array), so emit a lightweight log line instead so the
      // override remains traceable in the renderer-side log feed.
      if (shortAtMax > 0 && shortAtMax < minSide && options.forceAllowSmallSide) {
        log(
          `R-26 forceAllowSmallSide=true: capping ${srcW}x${srcH} to ${maxSide}px will yield short side ${shortAtMax}px (< minSize ${minSide}px) — proceeding.`
        );
      }
    }
    const effectiveSide = Math.min(maxSide, longest);
    const effectiveWidth = Math.round(srcW * (effectiveSide / longest));
    return Math.max(minSide, effectiveWidth);
  })();
  const speed = options.speed > 0 ? options.speed : 1;

  // FPS fallback chain for video → gif. Start at user fps, then degrade.
  const userFps = options.fps > 0 ? options.fps : 12;
  const VIDEO_FPS_FALLBACK = Array.from(new Set([userFps, 12, 10, 8, 6])).filter((f) => f >= 4);

  const outputs: string[] = [];
  const warnings: string[] = [];
  // Aggregated full phase failure trail across all segments (R-04 / R-08).
  // Surfaced via TaskProgress.phaseFailures so the UI can show a detail
  // modal with the complete diagnostic, while the user-facing warnings
  // string stays short and focused on actionable items.
  const videoPhaseFailures: string[] = [];

  // O5: process segments with bounded concurrency (was strictly serial).
  // ffmpeg + gifsicle are CPU/IO-heavy, but the segments are completely
  // independent (different time slices, distinct output paths). Running 2
  // at a time is a sweet spot on most laptops — enough to overlap the
  // ffmpeg-bound and gifsicle-bound parts of two segments without thrashing
  // when the user also has the main batch queue running parallel tasks.
  // We collect results into a sparse array indexed by segment number so
  // the final outputs[] preserves on-disk ordering even though tasks
  // complete out of order.
  // O8 (R-24): bound concurrency by available CPUs rather than the previous
  // hard-coded 2. ffmpeg + gifsicle are heavily CPU-bound so we cap at
  // ceil(cpus / 2) (leaving headroom for the OS, the renderer, and the
  // batch queue itself which may already be running multiple tasks). On
  // a 4-core machine this becomes 2 (same as before); on an 8-core M-series
  // chip it becomes 4 — empirically 40-50% wall-time savings on 3-segment
  // videos with no measurable thrashing.
  const cpuLimit = Math.max(2, Math.min(4, Math.ceil((os.cpus()?.length || 2) / 2)));
  const SEG_CONCURRENCY = Math.min(cpuLimit, segments.length);
  const segQueue = new PQueue({ concurrency: SEG_CONCURRENCY });
  const segResults: Array<string | null> = new Array(segments.length).fill(null);
  const processSegment = async (i: number): Promise<void> => {
    checkCancel(signal);
    const seg = segments[i];
    emit({
      taskId: task.id,
      status: 'converting',
      percent: 25 + (i / segments.length) * 25,
      segmentIndex: i + 1,
      totalSegments: segments.length,
      message: `converting segment ${i + 1}/${segments.length} -> gif`,
      substep: 'encoding-segment',
      elapsedMs: elapsed()
    });

    let baseGif: string | null = null;
    let baseFps = 0;
    const tempCleanup: string[] = [];
    const STATS_MODES: Array<'diff' | 'single'> = ['diff', 'single'];
    outerStats: for (const statsMode of STATS_MODES) {
      for (const fps of VIDEO_FPS_FALLBACK) {
        checkCancel(signal);
        const out = path.join(
          work,
          `${fileNameFor(media, `.s${seg.index}.f${fps}.w${initialWidth}.${statsMode}`)}.gif`
        );
        tempCleanup.push(out);
        try {
          await videoToGifPalette(
            {
              input: sourcePath,
              output: out,
              startSec: seg.start,
              durationSec: seg.duration,
              fps,
              width: initialWidth,
              speed,
              cropRect: options.cropRect,
              statsMode
            },
            (s) => log(`ffmpeg: ${s}`),
            signal
          );
          baseGif = out;
          baseFps = fps;
          if (statsMode !== 'diff') {
            warnings.push(`seg ${i + 1} fell back to stats_mode=${statsMode}`);
          }
          break outerStats;
        } catch (e) {
          if (e instanceof CancelledError || isAbortError(e)) throw new CancelledError();
          log(`ffmpeg seg ${seg.index} failed at fps=${fps} (stats=${statsMode}): ${(e as Error).message}`);
          fsp.unlink(out).catch(() => undefined);
        }
      }
    }

    if (!baseGif) {
      const errMsg = `seg ${i + 1} ffmpeg conversion failed at all fps (incl. stats_mode fallback)`;
      warnings.push(errMsg);
      log(errMsg);
      for (const tp of tempCleanup) fsp.unlink(tp).catch(() => undefined);
      return;
    }

    emit({
      taskId: task.id,
      status: 'compressing',
      percent: 55 + (i / segments.length) * 25,
      segmentIndex: i + 1,
      totalSegments: segments.length,
      message: `seg ${i + 1} compressing (fps=${baseFps})`,
      substep: 'optimizing',
      elapsedMs: elapsed()
    });

    // O4 fast path: video → baseGif uses options.maxWidth (the size the
    // user explicitly chose). After ffmpeg produces the baseGif, if it is
    // already small enough we skip compressLoop entirely — palettegen
    // already does most of the work, no extra gifsicle pass needed.
    //
    // R-33B: when user asked to skip-compress entirely, take the same fast
    // path *unconditionally* (no size check). The freshly-encoded gif from
    // palettegen is what the user wants — no lossy/colour reduction.
    const baseSizeMB = await statSizeMB(baseGif);
    const softMBLocal = options.softMaxBytes / (1024 * 1024);
    if (options.skipCompress === true || baseSizeMB <= softMBLocal) {
      const reason = options.skipCompress === true ? 'skipCompress' : `<= soft ${softMBLocal.toFixed(2)}MB`;
      log(`seg ${i + 1} baseGif ${baseSizeMB.toFixed(2)}MB ${reason}; skipping compressLoop`);
      const finalOut = path.join(
        outputBaseDir,
        fileNameFor(media, segments.length > 1 ? `.part${i + 1}.gif` : '.gif', batchTaken)
      );
      await fsp.copyFile(baseGif, finalOut);
      segResults[i] = finalOut;
      return;
    }

    const compressed = await compressLoop(
      baseGif,
      work,
      fileNameFor(media, `.s${seg.index}`),
      options,
      (cinfo) =>
        emit({
          taskId: task.id,
          status: 'compressing',
          percent: 65 + (i / segments.length) * 30,
          segmentIndex: i + 1,
          totalSegments: segments.length,
          message: `seg ${i + 1} ${cinfo.message}`,
          substep: cinfo.substep,
          stepIndex: cinfo.stepIndex,
          totalSteps: cinfo.totalSteps,
          detail: cinfo.detail,
          currentSizeMB: cinfo.currentSizeMB,
          elapsedMs: elapsed()
        }),
      signal
    );

    const finalOut = path.join(
      outputBaseDir,
      fileNameFor(media, segments.length > 1 ? `.part${i + 1}.gif` : '.gif', batchTaken)
    );
    await fsp.copyFile(compressed.finalPath, finalOut);
    segResults[i] = finalOut;

    if (compressed.allPhasesFailed) {
      const diag = compressed.phaseFailures.length
        ? compressed.phaseFailures.slice(0, 2).join(' | ')
        : 'no phase produced any output';
      warnings.push(`seg ${i + 1} compress: every phase failed (${diag}); kept ${compressed.sizeMB.toFixed(2)}MB`);
    } else if (compressed.given) {
      const trail = compressed.phaseFailures.length
        ? ` · ${compressed.phaseFailures.length} phase failure(s) — click for details`
        : '';
      warnings.push(
        `seg ${i + 1} final ${compressed.sizeMB.toFixed(2)}MB exceeds ${targetMB.toFixed(1)}MB target${trail}`
      );
    }
    // Reached target with some swallowed phase failures: SUCCESS for this
    // segment — don't add a "warning" for it. The full failure trail is
    // still aggregated into the final emit.phaseFailures array below.

    if (compressed.phaseFailures.length > 0) {
      const prefix = segments.length > 1 ? `seg ${i + 1}: ` : '';
      for (const f of compressed.phaseFailures) videoPhaseFailures.push(`${prefix}${f}`);
    }
  };

  await Promise.all(
    segments.map((_, i) => segQueue.add(() => processSegment(i)))
  );
  // Preserve segment order even though tasks may have completed out of order.
  for (const r of segResults) {
    if (r) outputs.push(r);
  }

  if (outputs.length === 0) {
    emit({ taskId: task.id, status: 'failed', percent: 100, error: 'no segment could be produced', elapsedMs: elapsed() });
    return;
  }

  emit({
    taskId: task.id,
    status: 'done',
    percent: 100,
    outputs,
    warning: warnings.length > 0 ? warnings.join('; ') : undefined,
    phaseFailures: videoPhaseFailures.length > 0 ? videoPhaseFailures : undefined,
    message: `produced ${outputs.length} file(s)${warnings.length ? ` (with ${warnings.length} warning)` : ''}`,
    elapsedMs: elapsed()
  });
}

export async function startBatch(
  tasks: ProcessTask[],
  outputBaseDir: string,
  emit: (p: TaskProgress) => void
): Promise<void> {
  // R-20: tasks may be enqueued at any time — including while a previous batch
  // is still draining. This is what powers the "重试" button on a failed task:
  // the user clicks retry, the renderer calls startBatch with one task, and we
  // simply append it to the shared PQueue. We no longer reject with 'busy'.
  // cancelAllTasks() still aborts EVERY in-flight controller, so cancellation
  // semantics are unchanged.
  // Honour per-batch concurrency override (first task's options wins; UI-level
  // setting is consistent across all tasks in a batch). Only adjust the queue
  // when no other batch is currently relying on the existing concurrency.
  const desired = clampConcurrency(tasks[0]?.options?.concurrency);
  if (desired !== currentConcurrency && activeAborts.size === 0) {
    queue.concurrency = desired;
    currentConcurrency = desired;
    log(`batch concurrency set to ${desired}`);
  }
  const ctrl = new AbortController();
  activeAborts.add(ctrl);
  const signal = ctrl.signal;
  const batchTaken = new Set<string>();
  const run = (async (): Promise<void> => {
    try {
      await Promise.all(
        tasks.map((task) =>
          queue.add(async () => {
            // R-43.2 — per-task abort controller. Linked to the parent
            // batch signal so a `cancelAllTasks()` parent abort still
            // propagates here; a `cancelTask(task.id)` only fires this
            // controller, leaving siblings running.
            const taskCtrl = new AbortController();
            const onParentAbort = () => {
              try { taskCtrl.abort(); } catch { /* ignore */ }
            };
            if (signal.aborted) {
              taskCtrl.abort();
            } else {
              signal.addEventListener('abort', onParentAbort, { once: true });
            }
            taskAborts.set(task.id, taskCtrl);
            const taskSignal = taskCtrl.signal;
            try {
              if (taskSignal.aborted) {
                emit({ taskId: task.id, status: 'cancelled', percent: 100, message: 'cancelled before start' });
                return;
              }
              emit({ taskId: task.id, status: 'pending', percent: 0 });
              await processOneTask({ task, outputBaseDir, emit, signal: taskSignal, batchTaken });
            } catch (err) {
              if (isAbortError(err)) {
                log(`task ${task.id} cancelled`);
                emit({ taskId: task.id, status: 'cancelled', percent: 100, message: 'cancelled' });
                return;
              }
              const msg = (err as Error).message || String(err);
              log(`task ${task.id} failed: ${msg}`);
              // R-26 — surface the spec-violation errorCode so the renderer
              // can render "强制允许" instead of the generic "重试" button
              // for AspectRatioConstraintError. Runtime/network/transcode
              // failures still fall through to the bare error string and
              // the original retry button.
              if (err instanceof AspectRatioConstraintError) {
                emit({
                  taskId: task.id,
                  status: 'failed',
                  percent: 100,
                  error: msg,
                  errorCode: 'ASPECT_RATIO_OUT_OF_RANGE',
                  errorMeta: {
                    origW: err.origW,
                    origH: err.origH,
                    minSide: err.minSide,
                    maxSide: err.maxSide,
                    shortSideAtMax: err.shortSideAtMax
                  }
                });
                return;
              }
              emit({ taskId: task.id, status: 'failed', percent: 100, error: msg });
            } finally {
              signal.removeEventListener('abort', onParentAbort);
              // Only delete OUR entry — a retry of the same id may
              // already have a fresh controller registered, in which
              // case we must not clobber it.
              if (taskAborts.get(task.id) === taskCtrl) {
                taskAborts.delete(task.id);
              }
            }
          })
        )
      );
    } finally {
      activeAborts.delete(ctrl);
    }
  })();
  // Track ALL in-flight batches (not just the latest) so cancelAllTasks can
  // await every one before returning. Without this, a retry kicked off while
  // an earlier batch is still draining would leak past cancelAll.
  activeBatchPromises.add(run);
  run.finally(() => {
    activeBatchPromises.delete(run);
  });
  return run;
}

/* ----------------------- R-35 Toolbox ----------------------- */

/**
 * Build a ProcessOptions snapshot from ToolboxParams. We reuse the existing
 * ProcessOptions type because compressLoop / videoToGifPalette consume it
 * directly — saves us from threading a parallel option struct down the
 * call chain. Defaults are pulled from DEFAULT_OPTIONS so users get
 * sensible knobs even when they leave fields blank.
 */
function toolboxParamsToProcessOptions(params: ToolboxParams): ProcessOptions {
  const opts: ProcessOptions = { ...DEFAULT_OPTIONS };
  if (typeof params.fps === 'number') opts.fps = params.fps;
  if (typeof params.startSec === 'number') opts.startSec = params.startSec;
  if (typeof params.endSec === 'number') opts.endSec = params.endSec;
  if (typeof params.maxBytes === 'number') opts.maxBytes = params.maxBytes;
  if (typeof params.softMaxBytes === 'number') {
    opts.softMaxBytes = Math.min(opts.maxBytes, params.softMaxBytes);
  }
  // Toolbox 'width' is the longest-side cap (mirrors ProcessOptions.maxWidth).
  // gif-resize's targetWidth is consumed differently — read directly from params.
  if (typeof params.width === 'number') opts.maxWidth = Math.max(64, params.width);
  return opts;
}

interface ToolboxRunArgs {
  job: ToolboxJob;
  outputBaseDir: string;
  emit: (p: TaskProgress) => void;
  signal: AbortSignal;
  batchTaken: Set<string>;
}

async function processToolboxJob({ job, outputBaseDir, emit, signal, batchTaken }: ToolboxRunArgs): Promise<void> {
  const t0 = Date.now();
  const elapsed = (): number => Date.now() - t0;
  const work = path.join(getCacheDir(), `toolbox-${safeName(job.id)}`);
  await ensureDir(work);
  await ensureDir(outputBaseDir);

  const inputBaseRaw = path.basename(job.inputPath, path.extname(job.inputPath)) || job.id;
  const inputStem = safeName(inputBaseRaw) || 'job';

  // Synthesise a SniffedMedia-shaped lookup so existing helpers (fileNameFor)
  // and the renderer-side TaskProgress consumers behave identically.
  // The url field is unused (we never download it) — kept as file:// for
  // diagnostic logs.
  const fakeMedia: SniffedMedia = {
    id: job.id,
    url: `file://${job.inputPath}`,
    kind: (() => {
      if (job.kind === 'gif-resize' || job.kind === 'gif-optimize') return 'gif';
      // R-37 — Trim/Speed/Reverse/Rotate are file-type-agnostic: pick
      // 'gif' when the source is a .gif so downstream filename helpers
      // and progress UI label it correctly, otherwise treat as video.
      const ext = path.extname(job.inputPath).toLowerCase();
      if (ext === '.gif') return 'gif';
      return 'video';
    })(),
    pageUrl: `file://${job.inputPath}`,
    source: 'pattern'
  };

  const opts = toolboxParamsToProcessOptions(job.params);

  emit({
    taskId: job.id,
    status: 'pending',
    percent: 1,
    message: `${job.kind}: starting`,
    elapsedMs: elapsed()
  });

  if (job.kind === 'video-to-gif' || job.kind === 'video-to-webp') {
    let info: ProbeInfo;
    emit({
      taskId: job.id,
      status: 'probing',
      percent: 8,
      substep: 'probing',
      message: 'probing video',
      elapsedMs: elapsed()
    });
    try {
      info = await probe(job.inputPath);
    } catch (e) {
      throw new Error(`ffprobe failed: ${(e as Error).message}`);
    }
    if (!info.hasVideo || info.durationSec <= 0) {
      throw new Error('input is not a valid video stream');
    }
    const totalDuration = info.durationSec;
    const userStart = typeof job.params.startSec === 'number' ? job.params.startSec : 0;
    const userEnd = typeof job.params.endSec === 'number' ? job.params.endSec : totalDuration;
    const clipStart = Math.max(0, Math.min(totalDuration, userStart));
    const clipEnd = Math.max(clipStart, Math.min(totalDuration, userEnd));
    const range = clipEnd - clipStart;
    if (range <= 0.05) throw new Error('clip range too short (< 0.05s)');

    const fps = Math.max(1, Math.min(60, job.params.fps ?? DEFAULT_OPTIONS.fps));
    // 'width' here is the longest-side cap; if not provided, keep source dims.
    const widthCap = typeof job.params.width === 'number' ? Math.max(64, job.params.width) : 0;
    const targetWidth = (() => {
      if (widthCap <= 0) return Math.max(64, info.width || 0);
      if (!info.width || !info.height) return widthCap;
      const longest = Math.max(info.width, info.height);
      if (longest <= widthCap) return info.width;
      return Math.max(2, Math.round(info.width * (widthCap / longest)));
    })();

    const ext = job.kind === 'video-to-gif' ? '.gif' : '.webp';
    const finalOut = path.join(outputBaseDir, fileNameFor(fakeMedia, ext, batchTaken));

    if (job.kind === 'video-to-gif') {
      emit({
        taskId: job.id,
        status: 'converting',
        percent: 25,
        substep: 'encoding',
        message: 'encoding video → gif',
        elapsedMs: elapsed()
      });
      const tmpGif = path.join(work, `${inputStem}.raw.gif`);
      await videoToGifPalette(
        {
          input: job.inputPath,
          output: tmpGif,
          startSec: clipStart,
          durationSec: range,
          fps,
          width: targetWidth,
          speed: 1
        },
        (s) => log(`ffmpeg: ${s}`),
        signal
      );

      emit({
        taskId: job.id,
        status: 'compressing',
        percent: 65,
        substep: 'optimizing',
        message: 'optimizing gif',
        elapsedMs: elapsed()
      });
      const result = await compressLoop(
        tmpGif,
        work,
        inputStem,
        opts,
        (info2) =>
          emit({
            taskId: job.id,
            status: 'compressing',
            percent: Math.min(95, info2.percent),
            substep: info2.substep,
            stepIndex: info2.stepIndex,
            totalSteps: info2.totalSteps,
            detail: info2.detail,
            currentSizeMB: info2.currentSizeMB,
            message: info2.message,
            elapsedMs: elapsed()
          }),
        signal
      );
      await fsp.copyFile(result.finalPath, finalOut);
      emit({
        taskId: job.id,
        status: 'done',
        percent: 100,
        outputs: [finalOut],
        currentSizeMB: result.sizeMB,
        message: `gif saved (${result.sizeMB.toFixed(2)}MB)`,
        elapsedMs: elapsed()
      });
      return;
    }

    // video-to-webp
    emit({
      taskId: job.id,
      status: 'converting',
      percent: 30,
      substep: 'encoding',
      message: 'encoding video → animated webp',
      elapsedMs: elapsed()
    });
    await videoToAnimatedWebP(
      {
        input: job.inputPath,
        output: finalOut,
        startSec: clipStart,
        durationSec: range,
        fps,
        width: targetWidth,
        speed: 1,
        quality: job.params.quality ?? 75,
        loop: job.params.loop ?? 0
      },
      (s) => log(`ffmpeg(webp): ${s}`),
      signal
    );
    const sizeMB = await statSizeMB(finalOut);
    emit({
      taskId: job.id,
      status: 'done',
      percent: 100,
      outputs: [finalOut],
      currentSizeMB: sizeMB,
      message: `webp saved (${sizeMB.toFixed(2)}MB)`,
      elapsedMs: elapsed()
    });
    return;
  }

  if (job.kind === 'gif-resize') {
    const target = job.params.targetWidth;
    if (typeof target !== 'number' || target < 64) {
      throw new Error('gif-resize: targetWidth required (>=64)');
    }
    // R-41 — output extension mirrors the input so a .webp source
    // round-trips back to .webp instead of being silently turned into
    // a .gif. Defaults to .gif if the input has no extension (which
    // shouldn't happen given the picker filters but is defensive).
    const resizeOutExt = path.extname(job.inputPath).toLowerCase() || '.gif';
    emit({
      taskId: job.id,
      status: 'converting',
      percent: 30,
      substep: 'resizing',
      message: `resizing gif → width ${target}`,
      elapsedMs: elapsed()
    });
    const finalOut = path.join(outputBaseDir, fileNameFor(fakeMedia, resizeOutExt, batchTaken));
    await imageResizeKeepAspect(job.inputPath, finalOut, target, signal);
    const sizeMB = await statSizeMB(finalOut);
    emit({
      taskId: job.id,
      status: 'done',
      percent: 100,
      outputs: [finalOut],
      currentSizeMB: sizeMB,
      message: `gif resized (${sizeMB.toFixed(2)}MB · w=${target})`,
      elapsedMs: elapsed()
    });
    return;
  }

  if (job.kind === 'gif-optimize') {
    // Three execution modes (R-35 #2):
    //   (a) explicit `method` picker — single-axis gifsicle pass via
    //       gifsicleMethod (lossy / colors / drop frames / dedupe / etc).
    //   (b) explicit lossy + colors pair (legacy explicit mode) when no
    //       `method` was set — single gifsicle --lossy=N --colors=K pass.
    //   (c) iterative compressLoop when user supplied size budget
    //       — that's the "shrink to <= 2MB" autopilot mode.
    // We pick based on which fields the user actually filled in. The
    // method picker takes precedence over both legacy fields because
    // it's the most explicit user intent.
    const hasMethod = typeof job.params.method === 'string';
    const hasExplicit = typeof job.params.lossy === 'number' || typeof job.params.colors === 'number';
    const hasBudget = typeof job.params.maxBytes === 'number' || typeof job.params.softMaxBytes === 'number';
    // R-41 — output extension mirrors the input so .webp inputs stay
    // .webp on the way out. The gifsicleMethod/Optimize helpers
    // transparently round-trip through a tmp .gif when needed.
    const optOutExt = path.extname(job.inputPath).toLowerCase() || '.gif';

    if (hasMethod && job.params.method !== 'budget') {
      const method = job.params.method as Exclude<NonNullable<ToolboxParams['method']>, 'budget'>;
      const lossy = job.params.lossy ?? 80;
      const colors = job.params.colors ?? 128;
      const dropEveryN = job.params.dropEveryN ?? 2;
      emit({
        taskId: job.id,
        status: 'compressing',
        percent: 30,
        substep: 'optimizing',
        message: `gifsicle method=${method}`,
        elapsedMs: elapsed()
      });
      const finalOut = path.join(outputBaseDir, fileNameFor(fakeMedia, optOutExt, batchTaken));
      await gifsicleMethod(job.inputPath, finalOut, method, { lossy, colors, dropEveryN, signal });
      const sizeMB = await statSizeMB(finalOut);
      emit({
        taskId: job.id,
        status: 'done',
        percent: 100,
        outputs: [finalOut],
        currentSizeMB: sizeMB,
        message: `gif optimized (${sizeMB.toFixed(2)}MB · ${method})`,
        elapsedMs: elapsed()
      });
      return;
    }

    if (!hasMethod && hasExplicit && !hasBudget) {
      const lossy = job.params.lossy ?? 0;
      const colors = job.params.colors ?? 256;
      emit({
        taskId: job.id,
        status: 'compressing',
        percent: 30,
        substep: 'optimizing',
        message: `gifsicle lossy=${lossy} colors=${colors}`,
        elapsedMs: elapsed()
      });
      const finalOut = path.join(outputBaseDir, fileNameFor(fakeMedia, optOutExt, batchTaken));
      await gifsicleOptimize(job.inputPath, finalOut, lossy, colors, signal);
      const sizeMB = await statSizeMB(finalOut);
      emit({
        taskId: job.id,
        status: 'done',
        percent: 100,
        outputs: [finalOut],
        currentSizeMB: sizeMB,
        message: `gif optimized (${sizeMB.toFixed(2)}MB · lossy=${lossy} colors=${colors})`,
        elapsedMs: elapsed()
      });
      return;
    }
    emit({
      taskId: job.id,
      status: 'compressing',
      percent: 25,
      substep: 'optimizing',
      message: 'optimizing gif (size budget)',
      elapsedMs: elapsed()
    });
    const result = await compressLoop(
      job.inputPath,
      work,
      inputStem,
      opts,
      (info2) =>
        emit({
          taskId: job.id,
          status: 'compressing',
          percent: Math.min(95, info2.percent),
          substep: info2.substep,
          stepIndex: info2.stepIndex,
          totalSteps: info2.totalSteps,
          detail: info2.detail,
          currentSizeMB: info2.currentSizeMB,
          message: info2.message,
          elapsedMs: elapsed()
        }),
      signal
    );
    const finalOut = path.join(outputBaseDir, fileNameFor(fakeMedia, '.opt.gif', batchTaken));
    await fsp.copyFile(result.finalPath, finalOut);
    emit({
      taskId: job.id,
      status: 'done',
      percent: 100,
      outputs: [finalOut],
      currentSizeMB: result.sizeMB,
      phaseFailures: result.phaseFailures.length > 0 ? result.phaseFailures : undefined,
      message: `gif optimized (${result.sizeMB.toFixed(2)}MB)`,
      elapsedMs: elapsed()
    });
    return;
  }

  /* ---------- R-37: Trim / Speed / Reverse / Rotate ----------
   * These four tools accept either a video or a .gif. The output
   * extension mirrors the input extension so a .mov stays .mov and
   * a .gif stays .gif — that's the least-surprise behaviour, and the
   * underlying ffmpeg / gifsicle helpers already handle both cases.
   */
  const inputExt = path.extname(job.inputPath).toLowerCase() || '.mp4';

  if (job.kind === 'trim') {
    const startSec = typeof job.params.startSec === 'number' ? job.params.startSec : 0;
    const endSec = typeof job.params.endSec === 'number' ? job.params.endSec : undefined;
    if (typeof endSec === 'number' && endSec <= startSec) {
      throw new Error('trim: endSec must be greater than startSec');
    }
    emit({
      taskId: job.id,
      status: 'converting',
      percent: 30,
      substep: 'trimming',
      message: `trim ${startSec.toFixed(2)}s..${typeof endSec === 'number' ? endSec.toFixed(2) + 's' : 'EOF'}`,
      elapsedMs: elapsed()
    });
    const finalOut = path.join(outputBaseDir, fileNameFor(fakeMedia, inputExt, batchTaken));
    await toolboxTrim(job.inputPath, finalOut, startSec, endSec, { signal });
    const sizeMB = await statSizeMB(finalOut);
    emit({
      taskId: job.id,
      status: 'done',
      percent: 100,
      outputs: [finalOut],
      currentSizeMB: sizeMB,
      message: `trimmed (${sizeMB.toFixed(2)}MB)`,
      elapsedMs: elapsed()
    });
    return;
  }

  if (job.kind === 'speed') {
    const factor = typeof job.params.speedFactor === 'number' ? job.params.speedFactor : 1;
    emit({
      taskId: job.id,
      status: 'converting',
      percent: 30,
      substep: 'retiming',
      message: `speed ×${factor.toFixed(2)}`,
      elapsedMs: elapsed()
    });
    const finalOut = path.join(outputBaseDir, fileNameFor(fakeMedia, inputExt, batchTaken));
    await toolboxSpeed(job.inputPath, finalOut, factor, { signal });
    const sizeMB = await statSizeMB(finalOut);
    emit({
      taskId: job.id,
      status: 'done',
      percent: 100,
      outputs: [finalOut],
      currentSizeMB: sizeMB,
      message: `speed ×${factor.toFixed(2)} (${sizeMB.toFixed(2)}MB)`,
      elapsedMs: elapsed()
    });
    return;
  }

  if (job.kind === 'reverse') {
    const audioMode: 'mute' | 'reverse' | 'keep' =
      job.params.reverseAudioMode === 'reverse' || job.params.reverseAudioMode === 'keep'
        ? job.params.reverseAudioMode
        : 'mute';
    emit({
      taskId: job.id,
      status: 'converting',
      percent: 30,
      substep: 'reversing',
      message: `reverse (audio=${audioMode})`,
      elapsedMs: elapsed()
    });
    const finalOut = path.join(outputBaseDir, fileNameFor(fakeMedia, inputExt, batchTaken));
    await toolboxReverse(job.inputPath, finalOut, audioMode, { signal });
    const sizeMB = await statSizeMB(finalOut);
    emit({
      taskId: job.id,
      status: 'done',
      percent: 100,
      outputs: [finalOut],
      currentSizeMB: sizeMB,
      message: `reversed (${sizeMB.toFixed(2)}MB · audio=${audioMode})`,
      elapsedMs: elapsed()
    });
    return;
  }

  if (job.kind === 'rotate') {
    const degrees = typeof job.params.rotateDegrees === 'number' ? job.params.rotateDegrees : 0;
    const flipH = !!job.params.flipH;
    const flipV = !!job.params.flipV;
    emit({
      taskId: job.id,
      status: 'converting',
      percent: 30,
      substep: 'rotating',
      message: `rotate ${degrees}°${flipH ? ' +flipH' : ''}${flipV ? ' +flipV' : ''}`,
      elapsedMs: elapsed()
    });
    const finalOut = path.join(outputBaseDir, fileNameFor(fakeMedia, inputExt, batchTaken));
    await toolboxRotate(job.inputPath, finalOut, degrees, { flipH, flipV }, { signal });
    const sizeMB = await statSizeMB(finalOut);
    emit({
      taskId: job.id,
      status: 'done',
      percent: 100,
      outputs: [finalOut],
      currentSizeMB: sizeMB,
      message: `rotated ${degrees}° (${sizeMB.toFixed(2)}MB)`,
      elapsedMs: elapsed()
    });
    return;
  }

  if (job.kind === 'crop') {
    // R-38 — Crop is single-file only (UI enforced); we still re-validate
    // the rect here so a corrupted IPC payload can't trigger ffmpeg with
    // garbage dimensions. All four fields must be defined and positive.
    const { cropX, cropY, cropW, cropH } = job.params;
    if (
      typeof cropX !== 'number' || typeof cropY !== 'number' ||
      typeof cropW !== 'number' || typeof cropH !== 'number' ||
      cropW <= 0 || cropH <= 0
    ) {
      throw new Error('crop: cropX/Y/W/H all required and W/H must be positive');
    }
    emit({
      taskId: job.id,
      status: 'converting',
      percent: 30,
      substep: 'cropping',
      message: `crop ${cropW}×${cropH} @ (${cropX},${cropY})`,
      elapsedMs: elapsed()
    });
    const finalOut = path.join(outputBaseDir, fileNameFor(fakeMedia, inputExt, batchTaken));
    await toolboxCrop(
      job.inputPath,
      finalOut,
      { x: cropX, y: cropY, w: cropW, h: cropH },
      { signal }
    );
    const sizeMB = await statSizeMB(finalOut);
    emit({
      taskId: job.id,
      status: 'done',
      percent: 100,
      outputs: [finalOut],
      currentSizeMB: sizeMB,
      message: `cropped to ${cropW}×${cropH} (${sizeMB.toFixed(2)}MB)`,
      elapsedMs: elapsed()
    });
    return;
  }

  if (job.kind === 'gif-webp-convert') {
    // R-42 — GIF ↔ WebP transcode. The sanitizer already restricts
    // targetFormat to one of the two literals, so an `undefined` here
    // means the renderer didn't send the field at all; that's a real
    // bug, not something we should silently paper over with a default.
    //
    // R-43 M-3 — surface the missing field as an explicit error so any
    // future regression in the renderer (e.g. a setKind path that
    // forgets to seed defaultParamsFor) is caught immediately instead
    // of producing wrong-format output.
    const requested = job.params.targetFormat;
    if (requested !== 'gif' && requested !== 'webp') {
      throw new Error(`gif-webp-convert: targetFormat is required (got ${String(requested)})`);
    }
    const target: 'gif' | 'webp' = requested;
    const outExt: '.gif' | '.webp' = target === 'gif' ? '.gif' : '.webp';
    const inputExtLower = path.extname(job.inputPath).toLowerCase();

    // R-43 H-1 — same-format short circuit. If the user picked the
    // same container their source already has, transcoding through
    // sharp/ffmpeg would needlessly re-encode (lossy webp at q=75 even
    // when the source is already lossless webp). Just copy the file
    // into the toolbox output directory verbatim. fileNameFor's
    // batchTaken set still ensures we don't collide with another
    // job's output.
    const finalOut = path.join(outputBaseDir, fileNameFor(fakeMedia, outExt, batchTaken));
    if (inputExtLower === outExt) {
      emit({
        taskId: job.id,
        status: 'converting',
        percent: 30,
        substep: 'copying',
        message: `same-format copy → ${target.toUpperCase()}`,
        elapsedMs: elapsed()
      });
      await fsp.copyFile(job.inputPath, finalOut);
      const sizeMB = await statSizeMB(finalOut);
      emit({
        taskId: job.id,
        status: 'done',
        percent: 100,
        outputs: [finalOut],
        currentSizeMB: sizeMB,
        message: `copied as ${target.toUpperCase()} (${sizeMB.toFixed(2)}MB, same format)`,
        elapsedMs: elapsed()
      });
      return;
    }

    emit({
      taskId: job.id,
      status: 'converting',
      percent: 30,
      substep: 'transcoding',
      message: `→ ${target.toUpperCase()}`,
      elapsedMs: elapsed()
    });
    await convertGifWebp(job.inputPath, finalOut, target, signal);
    const sizeMB = await statSizeMB(finalOut);
    emit({
      taskId: job.id,
      status: 'done',
      percent: 100,
      outputs: [finalOut],
      currentSizeMB: sizeMB,
      message: `converted to ${target.toUpperCase()} (${sizeMB.toFixed(2)}MB)`,
      elapsedMs: elapsed()
    });
    return;
  }

  throw new Error(`unsupported toolbox kind: ${(job as { kind: string }).kind}`);
}

/**
 * Public entry point for the R-35 Toolbox. Mirrors startBatch's queue-and-
 * track structure exactly so a toolbox job and a sniff-batch task share
 * the same PQueue (single source of concurrency truth) and the same
 * cancellation surface (cancelAllTasks aborts both).
 */
export async function startToolbox(
  jobs: ToolboxJob[],
  outputBaseDir: string,
  emit: (p: TaskProgress) => void
): Promise<void> {
  const ctrl = new AbortController();
  activeAborts.add(ctrl);
  const signal = ctrl.signal;
  const batchTaken = new Set<string>();
  const run = (async (): Promise<void> => {
    try {
      await Promise.all(
        jobs.map((job) =>
          queue.add(async () => {
            // R-43.2 — per-task abort controller (toolbox parity with startBatch).
            const taskCtrl = new AbortController();
            const onParentAbort = () => {
              try { taskCtrl.abort(); } catch { /* ignore */ }
            };
            if (signal.aborted) {
              taskCtrl.abort();
            } else {
              signal.addEventListener('abort', onParentAbort, { once: true });
            }
            taskAborts.set(job.id, taskCtrl);
            const taskSignal = taskCtrl.signal;
            try {
              if (taskSignal.aborted) {
                emit({ taskId: job.id, status: 'cancelled', percent: 100, message: 'cancelled before start' });
                return;
              }
              emit({ taskId: job.id, status: 'pending', percent: 0 });
              await processToolboxJob({ job, outputBaseDir, emit, signal: taskSignal, batchTaken });
            } catch (err) {
              if (isAbortError(err)) {
                log(`toolbox ${job.id} cancelled`);
                emit({ taskId: job.id, status: 'cancelled', percent: 100, message: 'cancelled' });
                return;
              }
              const msg = (err as Error).message || String(err);
              log(`toolbox ${job.id} failed: ${msg}`);
              emit({ taskId: job.id, status: 'failed', percent: 100, error: msg });
            } finally {
              signal.removeEventListener('abort', onParentAbort);
              if (taskAborts.get(job.id) === taskCtrl) {
                taskAborts.delete(job.id);
              }
            }
          })
        )
      );
    } finally {
      activeAborts.delete(ctrl);
    }
  })();
  activeBatchPromises.add(run);
  run.finally(() => {
    activeBatchPromises.delete(run);
  });
  return run;
}
