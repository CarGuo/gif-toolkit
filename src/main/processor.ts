import path from 'path';
import { promises as fsp } from 'fs';
import PQueue from 'p-queue';
import { isAxiosError } from 'axios';
import type {
  ProcessTask,
  TaskProgress,
  ProcessOptions,
  SniffedMedia,
  PreviewResult,
  ThumbnailResult
} from '../shared/types';
import { downloadToFile } from './downloader';
import {
  probe,
  videoToGifPalette,
  gifsicleOptimize,
  imageResizeKeepAspect,
  statSizeMB,
  extractFrameDataUrl,
  buildThumbnailDataUrl,
  killAllProcs
} from './ffmpeg';
import { getCacheDir } from './binaries';
import { log } from './logger';
import { fileNameFor, safeName } from './helpers';

const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 8;
let currentConcurrency = DEFAULT_CONCURRENCY;
const queue = new PQueue({ concurrency: DEFAULT_CONCURRENCY });
const activeAborts: Set<AbortController> = new Set();

function clampConcurrency(n: number | undefined): number {
  if (!Number.isFinite(n) || !n || n <= 0) return DEFAULT_CONCURRENCY;
  return Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(n as number)));
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
  if (longest <= 0 || shortest <= 0 || cap <= 0) return 0;
  if (longest <= cap) return shortest; // no shrink needed
  return Math.max(1, Math.round(shortest * (cap / longest)));
}

export function cancelAllTasks(): void {
  for (const ctrl of activeAborts) {
    try { ctrl.abort(); } catch { /* ignore */ }
  }
  activeAborts.clear();
  queue.clear();
  killAllProcs();
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
 * Smart GIF compression with tiered targets.
 *
 *   softTarget  =  best-quality goal   (e.g. 2.0MB) — try hard to reach
 *   hardTarget  =  fallback ceiling    (e.g. 4.0MB) — must reach if possible
 *
 * Strategy:
 *   Phase A — Resize-first:
 *     If max(origW, origH) > maxSide, downscale to maxSide on the longest
 *     side BEFORE any lossy work. Both width and height end up <= maxSide.
 *   Phase B — Adaptive lossy targeting softTarget:
 *     Pick a starting lossy level proportional to (curSize / softTarget),
 *     so we don't waste calls trying lossy=0 on a 5x-oversize file.
 *     Narrow with 3-step binary search around startLossy.
 *   Phase C — Geometric shrink targeting hardTarget:
 *     If still over hardTarget, shrink longest side by sqrt(hard/cur),
 *     repeat lossy search; up to 3 rounds.
 *   Phase D — Last resort:
 *     minSize + lossy=200 + colors=64.
 *
 * Total worst case: ~12 gifsicle calls.
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
  const TOTAL_STEPS = 12;
  let stepCounter = 0;

  // ---------- Phase A: probe + resize-first ----------
  let origW = 0;
  let origH = 0;
  try {
    const info = await probe(inputGif);
    origW = info.width || 0;
    origH = info.height || 0;
  } catch {
    /* sharp/ffprobe may fail on exotic gifs; fall back to no-resize */
  }

  // The longest / shortest side of the source.
  const longestSide = Math.max(origW, origH);
  const shortestSide = Math.min(origW, origH);

  // Strict aspect-ratio check: if forcing longest side <= maxSide would push
  // the short side below minSide, refuse early with a clear, user-visible message.
  if (longestSide > 0 && shortestSide > 0 && longestSide > maxSide) {
    const shortAtMax = shortSideAfterCap(longestSide, shortestSide, maxSide);
    if (shortAtMax > 0 && shortAtMax < minSide) {
      throw new AspectRatioConstraintError({
        origW,
        origH,
        maxSide,
        minSide,
        shortSideAtMax: shortAtMax
      });
    }
  }

  // Convert "max longest side" into a sharp width param while preserving aspect.
  const widthForSide = (side: number): number => {
    if (longestSide <= 0 || origW <= 0) return Math.min(maxSide, side);
    return Math.max(1, Math.round(origW * (side / longestSide)));
  };

  let workSrc = inputGif;
  let workWidth = origW > 0 ? origW : maxSide;
  let workSide = longestSide > 0 ? longestSide : maxSide;

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
    } catch (e) {
      if (isAbortError(e)) throw new CancelledError();
      log(`initial resize failed: ${(e as Error).message}`);
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

  if (initialSize <= softMB) {
    return {
      finalPath: workSrc,
      sizeMB: initialSize,
      width: workWidth,
      given: false,
      reachedSoft: true
    };
  }

  const recordBest = (p: string, s: number, w: number): void => {
    const wasUnderSoft = bestUnderSoft;
    const wasUnderHard = bestUnderHard;
    if (s <= softMB) {
      // Prefer largest size that still fits soft target (best quality).
      if (!wasUnderSoft || s > bestSize) {
        bestPath = p; bestSize = s; bestWidth = w;
        bestUnderSoft = true; bestUnderHard = true;
      }
    } else if (s <= hardMB) {
      // Prefer largest within hard, but never demote a soft-pass result.
      if (!wasUnderSoft && (!wasUnderHard || s > bestSize)) {
        bestPath = p; bestSize = s; bestWidth = w;
        bestUnderHard = true;
      }
    } else {
      // Above hard: only useful as fallback if nothing under hard yet.
      if (!wasUnderHard && s < bestSize) {
        bestPath = p; bestSize = s; bestWidth = w;
      }
    }
  };

  // ---------- helper: gifsicle pass ----------
  const tryOptimize = async (
    src: string,
    width: number,
    lossy: number,
    colors: number,
    label: string
  ): Promise<number> => {
    checkCancel(signal);
    const out = path.join(workDir, `${baseName}.w${width}.c${colors}l${lossy}.gif`);
    await gifsicleOptimize(src, out, lossy, colors, signal);
    const s = await statSizeMB(out);
    recordBest(out, s, width);
    emit({
      message: label,
      percent: Math.min(95, 65 + stepCounter * 2),
      substep: 'optimizing',
      stepIndex: ++stepCounter,
      totalSteps: TOTAL_STEPS,
      detail: `w=${width} colors=${colors} lossy=${lossy} -> ${s.toFixed(2)}MB`,
      currentSizeMB: s
    });
    return s;
  };

  // Map "how far we are from soft target" to a sane starting lossy level.
  const adaptiveStartLossy = (curMB: number, target: number): number => {
    const ratio = curMB / Math.max(0.01, target);
    if (ratio <= 1.2) return 30;
    if (ratio <= 1.6) return 60;
    if (ratio <= 2.2) return 90;
    if (ratio <= 3.0) return 120;
    if (ratio <= 4.5) return 150;
    return 180;
  };

  // ---------- Phase B: adaptive lossy search aiming at SOFT target ----------
  const lossySearch = async (
    src: string,
    width: number,
    target: number,
    colors: number,
    phase: string
  ): Promise<number> => {
    const sizeNow = await statSizeMB(src);
    const start = adaptiveStartLossy(sizeNow, target);
    let lo = 0;
    let hi = 200;
    let lastSize = sizeNow;
    try {
      lastSize = await tryOptimize(src, width, start, colors, `${phase} start lossy=${start}`);
    } catch (e) {
      if (isAbortError(e)) throw new CancelledError();
      log(`gifsicle start lossy=${start} failed: ${(e as Error).message}`);
      return Number.POSITIVE_INFINITY;
    }
    if (lastSize <= target) {
      hi = start; // try smaller lossy for higher quality
    } else {
      lo = start; // need stronger lossy
    }
    // Up to 3 binary refinements (we already used 1 probe above)
    for (let iter = 0; iter < 3; iter += 1) {
      const mid = Math.round((lo + hi) / 2);
      if (mid === lo || mid === hi) break;
      let s: number;
      try {
        s = await tryOptimize(src, width, mid, colors, `${phase} binary lossy=${mid}`);
      } catch (e) {
        if (isAbortError(e)) throw new CancelledError();
        log(`gifsicle lossy=${mid} failed: ${(e as Error).message}`);
        break;
      }
      lastSize = s;
      if (s <= target) hi = mid; else lo = mid;
      if (Math.abs(s - target) / target < 0.05) break;
    }
    return lastSize;
  };

  let curSize: number;
  try {
    curSize = await lossySearch(workSrc, workWidth, softMB, 256, 'soft');
  } catch (e) {
    if (isAbortError(e)) throw new CancelledError();
    curSize = bestSize;
  }
  if (bestUnderSoft) {
    return { finalPath: bestPath, sizeMB: bestSize, width: bestWidth, given: false, reachedSoft: true };
  }

  // ---------- Phase C: geometric shrink, target HARD then re-probe SOFT ----------
  // The minimum longest-side we are still allowed to use, derived so that the
  // matching short side stays >= minSide. This is what makes the resize "flexible":
  //   shortSide(longest=L) = round(shortestSide * L / longestSide)
  //   solve for L:           L = ceil(longestSide * minSide / shortestSide)
  // For square or unknown shapes this collapses to minSide.
  const longSideFloor = (() => {
    if (longestSide <= 0 || shortestSide <= 0) return minSide;
    const fromShort = Math.ceil(longestSide * minSide / shortestSide);
    return Math.max(minSide, Math.min(longestSide, fromShort));
  })();

  const MAX_RESIZE_ROUNDS = 3;
  let curSrc = workSrc;
  let curWidth = workWidth;
  let curSide = workSide;

  for (let round = 0; round < MAX_RESIZE_ROUNDS; round += 1) {
    if (bestUnderSoft) break;
    if (curSide <= longSideFloor) break;
    // Shrink longest side to roughly hit hard target (over-shrink slightly to
    // also grant some headroom for re-trying soft target afterwards).
    const aim = bestUnderHard ? softMB : hardMB;
    const ratio = Math.sqrt(Math.max(0.1, aim / Math.max(0.01, curSize)));
    // Floor candidate at longSideFloor so the SHORT side never drops < minSide.
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
      percent: Math.min(90, 70 + round * 5),
      substep: 'resizing',
      stepIndex: ++stepCounter,
      totalSteps: TOTAL_STEPS,
      detail: `aim=${aim.toFixed(1)}MB ratio=${ratio.toFixed(2)} ${curSide}→${nextSide} short=${nextShort} (w=${nextWidth})`
    });
    try {
      await imageResizeKeepAspect(inputGif, resized, nextWidth, signal);
    } catch (e) {
      if (isAbortError(e)) throw new CancelledError();
      log(`shrink failed at side=${nextSide}: ${(e as Error).message}`);
      break;
    }
    curSrc = resized;
    curWidth = nextWidth;
    curSide = nextSide;
    const sResized = await statSizeMB(resized);
    recordBest(resized, sResized, nextWidth);
    if (bestUnderSoft) break;
    // After resize, retry lossy targeting soft (preferred) or hard.
    const retryTarget = bestUnderHard ? softMB : hardMB;
    try {
      curSize = await lossySearch(curSrc, curWidth, retryTarget, 256, `r${round + 1}`);
    } catch (e) {
      if (isAbortError(e)) throw new CancelledError();
      break;
    }
  }

  // ---------- Phase D: aggressive last resort ----------
  if (!bestUnderHard) {
    try {
      // The smallest longest-side we still allow (respects short-side floor).
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
        curSrc = finalSrc;
        curWidth = finalWidth;
        curSide = finalSide;
      }
      await tryOptimize(curSrc, curWidth, 200, 64, `last-resort lossy=200 colors=64`);
    } catch (e) {
      if (isAbortError(e)) throw new CancelledError();
      log(`final aggressive step failed: ${(e as Error).message}`);
    }
  }

  return {
    finalPath: bestPath,
    sizeMB: bestSize,
    width: bestWidth,
    given: !bestUnderHard,
    reachedSoft: bestUnderSoft
  };
}

/* ----------------------- Thumbnail prefetch ----------------------- */

const THUMB_CACHE_MAX = 200;
const thumbCache = new Map<string, ThumbnailResult>();
const inflightThumb = new Map<string, Promise<ThumbnailResult>>();

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
      const t = await buildThumbnailDataUrl(local, media.kind);
      const result: ThumbnailResult = {
        id: media.id,
        status: 'ok',
        dataUrl: t.dataUrl,
        width: t.width,
        height: t.height
      };
      cacheThumb(media.id, result);
      return result;
    } catch (e) {
      const msg = (e as Error).message || String(e);
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

  const info = await probe(local);
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
  const { media, options } = task;
  const work = path.join(getCacheDir(), safeMediaId(media.id));
  await ensureDir(work);
  await ensureDir(outputBaseDir);

  const t0 = Date.now();
  const elapsed = (): number => Date.now() - t0;

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
  if (!(await fileExistsNonEmpty(sourcePath))) {
    let lastEmit = 0;
    await downloadToFile(media.url, work, localName, {
      referer: media.pageUrl,
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
    emit({
      taskId: task.id,
      status: 'done',
      percent: 100,
      outputs: [finalOut],
      currentSizeMB: result.sizeMB,
      warning: result.given
        ? `final size ${result.sizeMB.toFixed(2)}MB exceeds hard target ${targetMB.toFixed(1)}MB at min ${options.minSize}px`
        : !result.reachedSoft
          ? `did not reach soft target ${softMB.toFixed(1)}MB; saved at ${result.sizeMB.toFixed(2)}MB`
          : undefined,
      message: `gif saved (${result.sizeMB.toFixed(2)}MB ${tier})`,
      elapsedMs: elapsed()
    });
    return;
  }

  if (media.kind === 'image') {
    const finalOut = path.join(
      outputBaseDir,
      fileNameFor(media, path.extname(media.url) || '.bin', batchTaken)
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
  const info = await probe(sourcePath);
  if (!info.hasVideo || info.durationSec <= 0) {
    throw new Error('invalid video stream');
  }

  const totalDuration = info.durationSec;
  const segLen = Math.max(1, options.maxSegmentSec);
  const userStart = options.startSec ?? 0;
  const userEnd = options.endSec ?? totalDuration;
  const clipStart = Math.max(0, Math.min(totalDuration, userStart));
  const clipEnd = Math.max(clipStart, Math.min(totalDuration, userEnd));
  const range = clipEnd - clipStart;
  if (range <= 0.5) throw new Error('clip range too short (<0.5s)');

  const segCount = Math.max(1, Math.ceil(range / segLen));
  const segActual = range / segCount;
  const segments = Array.from({ length: segCount }, (_, i) => ({
    index: i,
    start: clipStart + i * segActual,
    duration: segActual
  }));

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
      if (shortAtMax > 0 && shortAtMax < minSide) {
        throw new AspectRatioConstraintError({
          origW: srcW,
          origH: srcH,
          maxSide,
          minSide,
          shortSideAtMax: shortAtMax
        });
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

  for (let i = 0; i < segments.length; i++) {
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
            (s) => log(`ffmpeg: ${s}`)
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
      continue;
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
    outputs.push(finalOut);

    if (compressed.given) {
      warnings.push(
        `seg ${i + 1} final ${compressed.sizeMB.toFixed(2)}MB exceeds ${targetMB.toFixed(1)}MB target`
      );
    }
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
    message: `produced ${outputs.length} file(s)${warnings.length ? ` (with ${warnings.length} warning)` : ''}`,
    elapsedMs: elapsed()
  });
}

export async function startBatch(
  tasks: ProcessTask[],
  outputBaseDir: string,
  emit: (p: TaskProgress) => void
): Promise<void> {
  // A9: refuse new batch if one is already running
  if (activeAborts.size > 0) {
    throw new Error('busy');
  }
  // Honour per-batch concurrency override (first task's options wins; UI-level
  // setting is consistent across all tasks in a batch).
  const desired = clampConcurrency(tasks[0]?.options?.concurrency);
  if (desired !== currentConcurrency) {
    queue.concurrency = desired;
    currentConcurrency = desired;
    log(`batch concurrency set to ${desired}`);
  }
  const ctrl = new AbortController();
  activeAborts.add(ctrl);
  const signal = ctrl.signal;
  const batchTaken = new Set<string>();
  try {
    await Promise.all(
      tasks.map((task) =>
        queue.add(async () => {
          try {
            if (signal.aborted) {
              emit({ taskId: task.id, status: 'cancelled', percent: 100, message: 'cancelled before start' });
              return;
            }
            emit({ taskId: task.id, status: 'pending', percent: 0 });
            await processOneTask({ task, outputBaseDir, emit, signal, batchTaken });
          } catch (err) {
            if (isAbortError(err)) {
              log(`task ${task.id} cancelled`);
              emit({ taskId: task.id, status: 'cancelled', percent: 100, message: 'cancelled' });
              return;
            }
            const msg = (err as Error).message || String(err);
            log(`task ${task.id} failed: ${msg}`);
            emit({ taskId: task.id, status: 'failed', percent: 100, error: msg });
          }
        })
      )
    );
  } finally {
    activeAborts.delete(ctrl);
  }
}
