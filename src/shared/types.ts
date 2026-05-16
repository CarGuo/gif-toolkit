export type MediaKind = 'video' | 'gif' | 'image';

export interface ResolvedMedia {
  /** Direct streamable URL (mp4/m4s/webm/etc) extracted by the resolver. */
  url: string;
  mime?: string;
  /** Headers required by the CDN (e.g. Referer for Bilibili). Sanitised by main. */
  headers?: Record<string, string>;
  qualityLabel?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  sizeBytes?: number;
  /** Provider tag, currently always 'ytdlp'. */
  source: 'ytdlp';
  /** Extractor name reported by yt-dlp (e.g. "youtube", "twitter", "bilibili"). */
  extractor?: string;
  title?: string;
}

export interface SniffedMedia {
  id: string;
  url: string;
  kind: MediaKind;
  mime?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  sizeBytes?: number;
  poster?: string;
  source: 'video-tag' | 'source-tag' | 'img-tag' | 'og-meta' | 'link' | 'json-ld' | 'pattern' | 'iframe-embed';
  pageUrl: string;
  /** True for embeds (Vimeo / YouTube / etc.) whose underlying media stream
   *  cannot be retrieved via a plain HTTP GET. Renderer should disable the
   *  process action and surface a hint to the user instead. */
  requiresExternalDownload?: boolean;
  /** Hostname of the embed provider (e.g. "vimeo.com", "youtube.com").
   *  Only set when `requiresExternalDownload` is true. */
  embedHost?: string;
  /** Populated AFTER the user opts in to "解析直链". Once set, the embed
   *  becomes a regular video task: processor downloads `resolved.url`
   *  with `resolved.headers`. */
  resolved?: ResolvedMedia;
}

export interface SniffResult {
  pageUrl: string;
  title?: string;
  items: SniffedMedia[];
  warnings: string[];
}

export interface ProcessOptions {
  /** Hard target: must reach (or best-effort) before giving up. Default 4MB. */
  maxBytes: number;
  /** Soft target: prefer to reach this for higher quality margin. Default 2MB. */
  softMaxBytes: number;
  /** Max length of the LONGEST side (width OR height). Default 800. */
  maxWidth: number;
  /** Lower bound for the longest side. Default 240. */
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

export type SniffStage =
  | 'fetching'   // downloading the article HTML
  | 'parsing'    // parsing DOM, extracting media tags
  | 'probing'    // HEAD requests to fill mime/size
  | 'done';

export interface SniffProgress {
  stage: SniffStage;
  percent: number;       // 0..100
  message?: string;
  found?: number;        // total media items discovered so far
  probed?: number;       // probed count (during 'probing')
  total?: number;        // total to probe
}

export const DEFAULT_OPTIONS: ProcessOptions = {
  maxBytes: 4 * 1024 * 1024,
  softMaxBytes: 2 * 1024 * 1024,
  maxWidth: 800,
  minSize: 240,
  maxSegmentSec: 20,
  fps: 12,
  speed: 1,
  concurrency: 3
};
