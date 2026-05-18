import type { SniffedMedia } from './media';

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
  | 'cancelled';

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
  error?: string;
}

export interface BatchStartResult {
  ok: boolean;
  outputDir: string;
}

export const DEFAULT_OPTIONS: ProcessOptions = {
  maxBytes: 4 * 1024 * 1024,
  softMaxBytes: 2 * 1024 * 1024,
  maxWidth: 800,
  minSize: 450,
  maxSegmentSec: 20,
  fps: 12,
  speed: 1,
  concurrency: 3
};
