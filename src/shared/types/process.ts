import type { SniffedMedia } from './media';

/** R-81 — gifsicle `--optimize` level. O1=safe/fast, O2=better, O3=best (default). */
export type GifOptimizeLevel = 1 | 2 | 3;

/** R-81 — gifsicle dithering when reducing palette. `none` = posterize (smaller,
 *  banding); `floyd-steinberg` = error-diffusion (industry default,
 *  cleanest gradients); `ordered` = patterned (smaller than FS, more visible). */
export type GifDither = 'none' | 'floyd-steinberg' | 'ordered';

/** R-81 — runtime guard list mirrored in main/index.ts sanitizeOptions
 *  so renderer-supplied values cannot escape this set. */
export const GIF_OPTIMIZE_LEVELS: readonly GifOptimizeLevel[] = [1, 2, 3] as const;
export const GIF_DITHER_MODES: readonly GifDither[] = [
  'none',
  'floyd-steinberg',
  'ordered',
] as const;

/** R-81 — `lossy` ceiling. 0 = no lossy compression; 200 = aggressive
 *  (gifsicle hard cap). compressLoop will never *exceed* this value;
 *  the adaptive lossy search may pick anything in [0, lossyCeiling]. */
export const GIF_LOSSY_MAX = 200;

/** R-81 — `colors` floor. gifsicle accepts 2..256; we keep 2 as the
 *  hard floor so a determined user can ship a 1-bit palette but the
 *  default 256 means no palette reduction. compressLoop will never
 *  reduce *below* this floor; the adaptive search may pick anything
 *  in [colorsFloor, 256]. */
export const GIF_COLORS_MIN = 2;
export const GIF_COLORS_MAX = 256;

export interface ProcessOptions {
  /** Hard target: must reach (or best-effort) before giving up. Default 4MB. */
  maxBytes: number;
  /** Soft target: prefer to reach this for higher quality margin. Default 2MB. */
  softMaxBytes: number;
  /** Max length of the LONGEST side (width OR height). Default 800. */
  maxWidth: number;
  /** Lower bound for the longest side. Default 450 (R-25 raise). */
  minSize: number;
  maxSegmentSec: number;  // max single gif duration when splitting video, default 20
  fps: number;            // default 12
  speed: number;          // playback speed multiplier, default 1.0
  outDir?: string;        // overrides default user folder
  startSec?: number;      // optional clipping (video only)
  endSec?: number;
  cropRect?: { x: number; y: number; w: number; h: number };
  concurrency?: number;   // batch parallelism, default 3
  /**
   * Per-task segment whitelist for video → gif (R-22). When the clip range
   * exceeds maxSegmentSec, processor.ts splits it into N equal segments
   * indexed 0..N-1. `selectedSegments` restricts processing to the listed
   * indices only. Unset (undefined) preserves legacy behaviour: process
   * every segment. Values are deduped, sorted, and clamped to [0, N-1] in
   * sanitizeOptions; out-of-range entries are dropped silently. Empty array
   * after clamp is treated the same as `undefined` to avoid producing zero
   * outputs and confusing the user.
   */
  selectedSegments?: number[];
  /**
   * R-26 escape hatch — when true, processor.ts skips the
   * AspectRatioConstraintError guard and lets the longest-side cap apply
   * even if the resulting short side falls below `minSize`. Intended to
   * be set on a *per-retry* basis after the user clicks "强制允许" on a
   * failed task; should never be sticky across the global form. Renderer
   * side helpers (App.onForceAllowOne) re-dispatch a single task with
   * this flag flipped, then the original DEFAULT_OPTIONS continue to
   * govern subsequent batches.
   */
  forceAllowSmallSide?: boolean;
  /**
   * R-33 — when true, processor skips the entire gifsicle compress loop
   * and saves the freshly-encoded gif as-is. Intended for users who do
   * NOT want quality loss from lossy/colour reduction (e.g. when the
   * source clip is already small or when they value fidelity over file
   * size). The output may exceed maxBytes — the UI must convey that
   * trade-off. The flag is propagated through OptionsForm as a per-batch
   * checkbox; we accept it on a per-task basis too so the manual
   * "二次优化" entry can dispatch a re-run with skipCompress=false on
   * an already-converted gif while the global form keeps its setting.
   */
  skipCompress?: boolean;
  /**
   * R-33 — manual re-optimization input path. When set, processor uses
   * this LOCAL gif file as the input to compressLoop directly, skipping
   * BOTH download AND ffmpeg encode. The path must be inside the
   * application's output root (validated in main/index.ts sanitizeOptions
   * via isPathInside) so a compromised renderer cannot point this at
   * arbitrary files. The accompanying ProcessTask.media is treated as a
   * pure metadata carrier (id/title/url for naming) — its url is NOT
   * fetched. Combine with reduced fps/maxWidth/maxBytes to push an
   * already-processed gif further down.
   */
  reoptimizeFromGifPath?: string;
  /**
   * R-81 — gifsicle `--lossy=N` ceiling (0..200, integer). The adaptive
   * lossy search inside compressLoop will never pick a value greater
   * than this. 0 = forbid lossy entirely (pure-palette compression
   * only — visually safest, highest size). 200 = full freedom for the
   * adaptive search to push aggressively. Undefined = use DEFAULT.
   */
  lossyCeiling?: number;
  /**
   * R-81 — gifsicle `--colors=N` floor (2..256, integer). The adaptive
   * palette-reduction step inside compressLoop will never pick a value
   * smaller than this. 256 = forbid palette reduction (highest fidelity
   * gradients, largest size). 2 = full freedom for the adaptive search
   * to crush palette down to a posterised 2-color frame. Undefined =
   * use DEFAULT.
   */
  colorsFloor?: number;
  /**
   * R-81 — gifsicle `--optimize=N` level. Locked across the entire
   * compress loop (every gifsicle invocation). Default 3 (best). 1 is
   * faster but ~20% larger; 2 is mid-tier. Undefined = use DEFAULT.
   */
  optimizeLevel?: GifOptimizeLevel;
  /**
   * R-81 — gifsicle dithering applied whenever palette reduction is
   * active (i.e. `--colors < 256`). Locked across the entire compress
   * loop. `floyd-steinberg` is the industry default and cleanest on
   * gradients; `none` is smallest at the cost of banding; `ordered`
   * sits between. Undefined = use DEFAULT.
   */
  dither?: GifDither;
}

export type TaskStatus =
  | 'pending'
  | 'downloading'
  | 'probing'
  | 'segmenting'
  | 'converting'
  | 'compressing'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  /** R-TB-CHAIN — chain step is paused waiting for the renderer to
   *  resolve runtime params (currently only crop, where the user must
   *  draw a box on the previous step's output frame). The renderer
   *  must call `toolbox:resumeChain` with the param patch to advance,
   *  or `toolbox:cancelChain` to abort. Outside chain mode this status
   *  is never emitted. */
  | 'awaiting-input';

export interface TaskProgress {
  taskId: string;
  status: TaskStatus;
  percent: number; // 0..100
  message?: string;
  segmentIndex?: number;
  totalSegments?: number;
  currentSizeMB?: number;
  outputs?: string[]; // local file paths
  error?: string;
  /** Stable, machine-readable failure category. Lets the UI tell apart
   *  "spec rejected by config" (e.g. ASPECT_RATIO_OUT_OF_RANGE — actionable
   *  via 强制允许) from runtime/network/transcode failures (actionable via
   *  retry). Absent when status !== 'failed'. See R-26. */
  errorCode?: 'ASPECT_RATIO_OUT_OF_RANGE';
  /** Optional structured payload paired with `errorCode` for renderer to
   *  format human-readable hints without re-parsing the error string.
   *  Currently only carries the geometry that violated the spec. */
  errorMeta?: {
    origW?: number;
    origH?: number;
    minSide?: number;
    maxSide?: number;
    shortSideAtMax?: number;
  };
  warning?: string; // soft over-limit notice
  /** Fine-grained substep label, e.g. "downloading", "probing", "estimating",
   *  "binary-search", "resizing", "optimizing", "encoding-segment". */
  substep?: string;
  /** 1-based current step index within the substep. */
  stepIndex?: number;
  /** Total expected steps for the current substep. */
  totalSteps?: number;
  /** One-line human-readable detail (e.g. "lossy=120 colors=128 -> 4.8MB"). */
  detail?: string;
  /** Total elapsed milliseconds since the task started. */
  elapsedMs?: number;
  /** Bytes downloaded so far (downloading substep). */
  bytesDownloaded?: number;
  /** Total bytes (when known). */
  bytesTotal?: number;
  /** Optional full diagnostic list of phase failures swallowed during
   *  compression (R-04 / R-08). The UI can show these in a click-to-open
   *  modal so users see the complete trail rather than the first 2 only.
   *  Empty / undefined means no swallowed failures. */
  phaseFailures?: string[];
  /**
   * R-SIZE-REGRESSION-V1 — 当一步处理产出体积比输入体积**反而变大**
   * 超过容忍阈值（5%）时,main 在 done emit 里携带这个负面信号,
   * 让渲染端贴一个 ⚠️ 徽标给用户。这个字段只在 status==='done' 且
   * (after / before) > 1.05 时存在;before/after 单位都是 bytes。
   *
   * 经典反例:已被 Photoshop 高度优化的源 gif 经过 ffmpeg 解码 ->
   * crop -> 重编码后,palette / LZW 缓存重置 -> 体积反而上升 65%。
   * 我们不自动 fallback,只把数据透出来让用户决定。
   */
  sizeRegression?: {
    /** Source file bytes (the step's inputPath). */
    beforeBytes: number;
    /** Output file bytes (collected[0]). */
    afterBytes: number;
    /** afterBytes / beforeBytes; always > 1.05 when this field exists. */
    ratio: number;
    /**
     * P1-3 — true when the toolbox budget branch explicitly fell back to a
     * byte-for-byte copy of the input because no produced artefact was
     * smaller than the source. beforeBytes / afterBytes / ratio are still
     * filled in (with ratio == 1.0) so existing UI tooltips render
     * coherent numbers; `reverted` is the dedicated "no benefit" flag the
     * renderer can branch on for a stronger warning state than the
     * generic > 1.05 regression badge.
     */
    reverted?: boolean;
  };
}

export interface ProcessTask {
  id: string;
  media: SniffedMedia;
  options: ProcessOptions;
}

export interface PreviewFrame {
  index: number;
  timeSec: number;
  dataUrl: string;
}

export interface PreviewResult {
  taskId: string;
  durationSec: number;
  width: number;
  height: number;
  frames: PreviewFrame[];
  error?: string;
}

export type ThumbnailStatus = 'ok' | 'error';

export interface ThumbnailResult {
  id: string;
  status: ThumbnailStatus;
  dataUrl?: string;
  width?: number;
  height?: number;
  /** Absolute local cache path of the downloaded source. When present
   *  the renderer can swap from the static `dataUrl` to a live
   *  `giftk-local://<localPath>` playback for animated formats so the
   *  thumbnail loops the actual GIF/WebP/video instead of a frozen
   *  first frame. Only populated for kinds that benefit from it
   *  (gif / video). */
  localPath?: string;
  /** Source file kind hint — let the renderer pick a sensible <img> /
   *  <video> element without re-sniffing the URL. Mirrors
   *  SniffedMedia.kind. */
  kind?: 'video' | 'gif' | 'image';
  error?: string;
}

export interface BatchStartResult {
  ok: boolean;
  outputDir: string;
  /** Session log id for this batch; renderer pins it onto the
   *  HistoryRecord so the rerun / single-process / upload paths can
   *  thread it back into subsequent IPC calls. */
  sessionId?: string;
}

export const DEFAULT_OPTIONS: ProcessOptions = {
  maxBytes: 4 * 1024 * 1024,
  softMaxBytes: 2 * 1024 * 1024,
  maxWidth: 800,
  minSize: 450,
  maxSegmentSec: 20,
  fps: 12,
  speed: 1,
  concurrency: 3,
  // R-81 — defaults preserve legacy behaviour:
  //   lossyCeiling=200 lets the adaptive search go anywhere in [0,200];
  //   colorsFloor=2    lets the adaptive search crush palette all the way;
  //   optimizeLevel=3  matches the historical hard-coded -O3;
  //   dither=floyd-steinberg is the industry default for palette reduction.
  // Tightening any of these from the UI = "be safer / preserve quality";
  // loosening = (only meaningful for colorsFloor / lossyCeiling) gives
  // the search more room to shrink.
  lossyCeiling: 200,
  colorsFloor: 2,
  optimizeLevel: 3,
  dither: 'floyd-steinberg',
};
