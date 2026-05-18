import type { MediaKind } from './mediaKind';
export type { MediaKind };

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
  source: 'video-tag' | 'source-tag' | 'img-tag' | 'og-meta' | 'link' | 'json-ld' | 'pattern' | 'iframe-embed' | 'webview' | 'ytdlp-direct';
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
  minSize: 450,
  maxSegmentSec: 20,
  fps: 12,
  speed: 1,
  concurrency: 3
};

/* ----------------------- R-35 Toolbox ----------------------- */

/**
 * R-35 — local Toolbox (Ezgif-style). MVP shipped 4 tools (video↔gif/webp,
 * gif-resize, gif-optimize). R-37 adds the next 4: Trim / Speed / Reverse
 * / Rotate. Each tool accepts both video and gif inputs (the processor
 * branches on file extension), so a user can e.g. trim a clip OR a gif
 * with the same UI panel.
 */
export type ToolboxKind =
  | 'video-to-gif'
  | 'video-to-webp'
  | 'gif-resize'
  | 'gif-optimize'
  | 'trim'
  | 'speed'
  | 'reverse'
  | 'rotate'
  | 'crop'
  // R-42 — Bidirectional GIF ↔ WebP converter. Accepts either format
  // and re-encodes to the user-chosen target via sharp (animated mode).
  // Default `targetFormat` is the *opposite* of the input extension, so
  // dropping `loop.gif` defaults to `webp` and vice versa.
  | 'gif-webp-convert';

/** Allowed input extensions per tool. Used both in main-process input
 *  validation AND in the renderer's drag-and-drop / file picker filter.
 *  R-41 — Final tool-input policy: the *first two* tools (Video → GIF /
 *  Video → WebP) are dedicated converters and only accept video
 *  containers. The other seven tools all operate on already-animated
 *  bitmaps, so they accept .gif AND .webp. (gifsicle natively only
 *  understands .gif, so the main-process gif-resize / gif-optimize
 *  paths transparently wrap webp inputs via ffmpeg decode → gifsicle
 *  → ffmpeg re-encode back to .webp; the user-facing rule is simply
 *  "input format == output format".) */
const VIDEO_EXTS = ['.mp4', '.mov', '.webm', '.mkv', '.m4v'] as const;
const GIF_EXTS = ['.gif'] as const;
const GIF_OR_WEBP: readonly string[] = ['.gif', '.webp'];

export const TOOLBOX_INPUT_EXTENSIONS: Record<ToolboxKind, readonly string[]> = {
  'video-to-gif': VIDEO_EXTS,
  'video-to-webp': VIDEO_EXTS,
  // R-41 — gif-resize / gif-optimize accept webp via a transparent
  // gif round-trip in the main process. From the renderer's POV they
  // are "animated-bitmap" tools just like trim/speed/etc.
  'gif-resize': GIF_OR_WEBP,
  'gif-optimize': GIF_OR_WEBP,
  'trim': GIF_OR_WEBP,
  'speed': GIF_OR_WEBP,
  // R-40 / R-41 — Reverse stays GIF-family-only (excludes raw video
  // because ffmpeg's -vf reverse buffers every decoded frame in RAM).
  'reverse': GIF_OR_WEBP,
  'rotate': GIF_OR_WEBP,
  // R-38 — Crop is single-file only. The single-file constraint is
  // enforced in the renderer (the panel requires the queue length to
  // be exactly 1 before enabling Start) because the visual crop rect
  // comes from one preview frame and there is no general way to map
  // one rect onto N heterogeneous inputs.
  'crop': GIF_OR_WEBP,
  // R-42 — GIF ↔ WebP converter accepts either format and the
  // renderer's targetFormat picker decides the output extension.
  'gif-webp-convert': GIF_OR_WEBP
};

// Preserve the legacy union token in case future tools want it back;
// no current tool uses it but the constant is referenced by docs.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const VIDEO_OR_GIF: readonly string[] = [...VIDEO_EXTS, ...GIF_EXTS];

/**
 * R-35 (#2) — gif-optimize sub-strategies, mirrors ezgif's "Optimization
 * method" picker. Each method maps to a different gifsicle invocation:
 *
 *   - lossy            : gifsicle --lossy=N
 *   - color-reduction  : gifsicle --colors=K --color-method=blend-diversity
 *   - color-dither     : gifsicle --colors=K --dither
 *   - drop-every-nth   : gifsicle --delete "#0n,#1n,..." then --optimize
 *   - drop-duplicates  : gifsicle --optimize=3 (frame-dedupe pass)
 *   - optimize-transp  : gifsicle --optimize=3 --transparent (transparency)
 *   - budget           : run the full 4-Phase compressLoop (size-target).
 *
 * Note: the existing single-pass gifsicleOptimize(file, lossy, colors)
 * still drives the explicit lossy + colors path; budget hits compressLoop.
 */
export type ToolboxOptimizeMethod =
  | 'lossy'
  | 'color-reduction'
  | 'color-dither'
  | 'drop-every-nth'
  | 'drop-duplicates'
  | 'optimize-transparency'
  | 'budget';

/** Per-tool params. All fields are optional — sanitiseToolboxOptions in
 *  main/index.ts fills in safe defaults derived from DEFAULT_OPTIONS. */
export interface ToolboxParams {
  /* video → gif / webp */
  fps?: number;            // 1..60, default 12
  width?: number;          // 64..4096, default 0 (keep source width capped at maxWidth)
  startSec?: number;       // optional clip start
  endSec?: number;         // optional clip end
  /* video → webp specific */
  quality?: number;        // 0..100, default 75
  loop?: number;           // 0=infinite, n=loops, default 0
  /* gif-resize / gif-optimize */
  targetWidth?: number;    // 64..4096, used by gif-resize
  lossy?: number;          // 0..200 (gifsicle), used by gif-optimize
  colors?: number;         // 2..256, used by gif-optimize
  maxBytes?: number;       // size budget for gif-optimize (compressLoop hard target)
  softMaxBytes?: number;   // size soft budget for gif-optimize
  /* gif-optimize method picker (R-35 #2) */
  method?: ToolboxOptimizeMethod;
  /** every-Nth frame drop step, used when method === 'drop-every-nth' (2..10). */
  dropEveryN?: number;
  /* ----------- R-37 Trim / Speed / Reverse / Rotate ----------- */
  /** Speed multiplier, used by 'speed'. 0.25..4.0; 1.0 = no-op.
   *  For video tracks we apply setpts=PTS/N + atempo (audio); for gifs
   *  it scales every frame's delay (gifsicle --delay). */
  speedFactor?: number;
  /** Rotation in degrees, used by 'rotate'. Allowed: 0 / 90 / 180 / 270.
   *  90 / 270 swap width and height. */
  rotateDegrees?: number;
  /** Horizontal flip, used by 'rotate'. Applied AFTER rotateDegrees. */
  flipH?: boolean;
  /** Vertical flip, used by 'rotate'. */
  flipV?: boolean;
  /** Audio handling for 'reverse' on video. 'mute' drops audio entirely;
   *  'reverse' applies areverse so audio plays back too; 'keep' leaves
   *  the original (forward) audio over the reversed video. Defaults to
   *  'mute' since most reverse-clip use cases don't need backward speech. */
  reverseAudioMode?: 'mute' | 'reverse' | 'keep';
  /* ----------- R-38 Crop ----------- */
  /** Crop rectangle in *natural* (source-pixel) coordinates. The renderer
   *  reads probeMedia → naturalSize, the user drags a CropBox over the
   *  preview, and the resulting (x, y, w, h) lands here. ffmpeg consumes
   *  it as `crop=w:h:x:y`. Half-pixel values are clamped to integers in
   *  sanitizeToolboxParams. */
  cropX?: number;
  cropY?: number;
  cropW?: number;
  cropH?: number;
  /* ----------- R-42 GIF ↔ WebP convert ----------- */
  /** Target output container for the gif-webp-convert tool. The
   *  renderer initialises this to the *opposite* of the input
   *  extension so the default action is always a real conversion
   *  (uploading `loop.gif` defaults to `webp`; uploading `loop.webp`
   *  defaults to `gif`). The main process trusts whatever value is
   *  here — sanitizeToolboxParams clamps it to one of the two known
   *  literals. */
  targetFormat?: 'gif' | 'webp';
}

/**
 * R-35 — single user-submitted local job. The shape mirrors ProcessTask
 * but carries a local input path instead of a SniffedMedia (no
 * download phase). The main process re-validates `inputPath` against
 * a strict whitelist before reading it (mirrors the reoptimizeFromGifPath
 * path-inside guard).
 */
export interface ToolboxJob {
  /** Renderer-side stable id (e.g. crypto.randomUUID()). */
  id: string;
  kind: ToolboxKind;
  /** Absolute path on the user's disk. Validated in main/index.ts. */
  inputPath: string;
  params: ToolboxParams;
}

export interface ToolboxStartResult {
  ok: boolean;
  outputDir: string;
}

/* ----------------------- R-45 Image-host upload (PicGo-style) ----------------------- */

/**
 * R-45 — supported upload backends.
 *
 *  - customWeb : POST a multipart/form-data body to a user-supplied URL,
 *                pluck the public URL out of the JSON response via JSONPath.
 *                Covers PicGo-Server, custom Cloudflare-Workers proxies,
 *                Lambda functions, etc. The single most flexible backend.
 *  - github    : PUT to GitHub Contents API with base64 body.
 *                Free public-repo + GitHub Pages = a simple CDN-quality
 *                image host without any service to run.
 *  - qiniu     : 七牛云 Kodo. Core backend by user request. We mint an
 *                upload token in main from (AK, SK, bucket, optional
 *                key prefix), then POST multipart/form-data to the
 *                regional upload endpoint.
 *  - aliyunOss : 阿里云 OSS. PUT object via Authorization v1 signed
 *                request, no extra SDK.
 *  - tencentCos: 腾讯云 COS. PUT object via the Authorization v5
 *                signature ("q-sign-algorithm=sha1") form, no extra SDK.
 *
 * Adding a new backend is a 4-step recipe (see uploader/index.ts).
 */
export type UploadBackend = 'customWeb' | 'github' | 'qiniu' | 'aliyunOss' | 'tencentCos';

/** Per-backend config. Each backend reads its own block — extra fields
 *  are harmless. */
export interface CustomWebConfig {
  /** POST endpoint, https only (http only allowed for localhost). */
  url: string;
  /** Multipart field name for the file. Default 'file'. */
  fileField?: string;
  /** Optional headers (Authorization etc.) — strict allowlist applied
   *  in main: only Authorization / X-* / Accept tokens. */
  headers?: Record<string, string>;
  /**
   * JSONPath-lite expression to read the public URL from the JSON
   * response. Subset of JSONPath: `$.data.url`, `data.url`, dotted
   * paths with `[n]` indices. Tested in
   * `tests/main/uploaderUtils.test.ts`.
   */
  urlPath: string;
}

export interface GithubConfig {
  /** Personal Access Token with `repo` scope. */
  token: string;
  /** `owner/repo` form. */
  repo: string;
  /** Branch, default `main`. */
  branch?: string;
  /**
   * Path prefix inside the repo. Final path is
   * `${pathPrefix}/${yyyymmdd}/${filename}`. Defaults to `images`.
   */
  pathPrefix?: string;
  /** Custom CDN domain (e.g. jsdelivr); when set we render
   *  `https://cdn.jsdelivr.net/gh/{repo}@{branch}/{path}` instead of
   *  raw.githubusercontent.com. */
  customDomain?: string;
}

export interface QiniuConfig {
  /** Access key. */
  accessKey: string;
  /** Secret key (kept in main-process settings, never echoed to renderer
   *  by the get IPC). */
  secretKey: string;
  bucket: string;
  /** Public domain bound to the bucket, e.g. `cdn.example.com` (no
   *  protocol, no trailing slash). The uploader prepends `https://`. */
  domain: string;
  /** Region — default 'z0' (华东). Used to pick the upload endpoint. */
  region?: 'z0' | 'z1' | 'z2' | 'na0' | 'as0' | 'cn-east-2';
  /** Optional key prefix (folder). Final key is
   *  `${keyPrefix}/${yyyymmdd}/${filename}`. */
  keyPrefix?: string;
}

export interface AliyunOssConfig {
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  /** e.g. `oss-cn-hangzhou` */
  region: string;
  /** Optional CNAME, takes precedence over region.aliyuncs.com host. */
  customDomain?: string;
  keyPrefix?: string;
}

export interface TencentCosConfig {
  /** SecretId (analogous to AccessKey) */
  secretId: string;
  secretKey: string;
  /** `bucket-appid` form, e.g. `mybucket-1255000000`. */
  bucket: string;
  /** e.g. `ap-shanghai` */
  region: string;
  customDomain?: string;
  keyPrefix?: string;
}

export interface UploadConfigs {
  active: UploadBackend;
  customWeb?: CustomWebConfig;
  github?: GithubConfig;
  qiniu?: QiniuConfig;
  aliyunOss?: AliyunOssConfig;
  tencentCos?: TencentCosConfig;
  /**
   * R-46 — Per-batch upload concurrency. Range 1..6, default 3. Applies
   * across ALL backends. We keep it conservative because most image
   * hosts (especially GitHub Contents API) impose tight per-IP rate
   * limits, and serial uploads have proven too slow when the user has
   * 30+ outputs to push at once. The bound is enforced both in the
   * sanitiser AND in the runner — anything outside [1, 6] is clamped.
   */
  maxConcurrent?: number;
  /**
   * R-46 — Per-job retry budget for transient failures (5xx / network
   * errors / 429). 0 disables retries entirely. Default 2 — i.e.
   * up to 3 attempts including the first. Bounded to [0, 5].
   */
  maxRetries?: number;
}

/** One upload subtask. */
export interface UploadJob {
  /** Renderer-stable id (uuid). */
  id: string;
  /** Absolute local path. Validated on main side: must be inside an
   *  allowed output directory. */
  filePath: string;
  /** Optional override filename (without path) on the remote side. If
   *  unset we use the basename of filePath. */
  remoteName?: string;
  /** R-54 — Optional id of the processing HistoryRecord this output
   *  was produced by. The main process echoes it back on every
   *  UploadProgress event so the renderer can patch the record's
   *  `uploadsByOutputPath` map without bookkeeping its own
   *  jobId → recordId table. */
  recordId?: string;
}

export type UploadStatus = 'pending' | 'uploading' | 'done' | 'failed' | 'cancelled';

/** Streaming progress emit (channel `upload:progress`). */
export interface UploadProgress {
  jobId: string;
  status: UploadStatus;
  /** 0..100 — derived from bytes uploaded if the backend streams,
   *  otherwise jumps 0 → 100 on done. */
  percent: number;
  message?: string;
  /** Public URL on success. */
  url?: string;
  /** Markdown line (`![alt](url)`) — convenience for the UI's "复制全部". */
  markdown?: string;
  /** Failure detail. */
  error?: string;
  /** Backend that processed this job. */
  backend?: UploadBackend;
  /** Total bytes (when known up front). */
  bytesTotal?: number;
  /** Bytes sent so far. */
  bytesUploaded?: number;
  /** R-46 — Current attempt counter (1-based). Surfaced so the UI can
   *  show "重试 2/3" while a transient failure is being retried. */
  attempt?: number;
  /** R-46 — Total attempts allowed for this job (1 + maxRetries). */
  maxAttempts?: number;
  /** R-54 — sha256 hex digest of the file's bytes. Computed by the
   *  main process before uploading so dedup short-circuits and the
   *  history can persist it for future short-circuits. */
  fileHash?: string;
  /** R-54 — `true` when the `done` event was synthesised from a
   *  hash cache hit (no network round-trip happened). */
  reused?: boolean;
  /** R-54 — When the renderer started the job from a processing
   *  HistoryRecord row, this is that record's id. Echoed back on
   *  every progress event so the renderer can patch
   *  `HistoryRecord.uploadsByOutputPath` without keeping its own
   *  jobId→recordId map. */
  recordId?: string;
}

export interface UploadStartPayload {
  jobs: UploadJob[];
  /** Override active backend just for THIS batch. Falls back to the
   *  persisted `active` when omitted. Useful when the user wants to
   *  send one batch to GitHub and another to 七牛 without flipping
   *  the global setting. */
  backendOverride?: UploadBackend;
  /** Optional Markdown alt text template. Defaults to filename
   *  without extension. Supports `{name}` / `{ext}` tokens. */
  altTemplate?: string;
}

export interface UploadStartResult {
  ok: boolean;
  /** When the user kicked off N jobs we return the same N jobIds in
   *  insertion order; the renderer correlates streamed
   *  UploadProgress events with these ids. */
  jobIds: string[];
}

/**
 * R-46 — Result of an "Test connection" probe. We upload a 1×1 PNG
 * to the user's chosen backend with their persisted config and
 * surface either the public URL we got back or the error string. The
 * renderer renders the result inline under the Settings tab, no
 * history record is created.
 */
export interface UploadTestResult {
  ok: boolean;
  /** Returned URL on success. */
  url?: string;
  /** Failure detail on error. */
  error?: string;
  /** Round-trip duration in ms. */
  durationMs?: number;
}

/**
 * Persisted upload-history record (renderer-side, localStorage).
 * Kept SEPARATE from the processing HistoryRecord because:
 *   - Lifetime is different (uploads can be retried independently
 *     of which processing batch they came from);
 *   - Schema is much simpler (no per-task ProcessOptions, no
 *     outputsByTaskId map);
 *   - Listing UX wants a flat reverse-chrono "all uploads" feed
 *     rather than the grouped-by-page card grid the processing
 *     history uses.
 */
export interface UploadHistoryItem {
  jobId: string;
  filePath: string;
  fileName: string;
  status: UploadStatus;
  url?: string;
  markdown?: string;
  error?: string;
  bytesTotal?: number;
  /**
   * R-54 — sha256 hex digest of the bytes that were (or were
   * intended to be) uploaded. Populated for `done` rows so that
   * subsequent upload requests for the same bytes can short-circuit
   * via {@link findUploadByHash}. Older entries (pre-R-54) lack
   * this field and simply do not participate in dedup; this is fine
   * because the dedup hit-rate is monotone — the cache only grows.
   */
  fileHash?: string;
  /**
   * R-54 — Set to `true` when this row was synthesised from a hash
   * cache hit instead of an actual network round-trip. The panel
   * surfaces this with a 「♻️ 复用」 badge so the user understands
   * why "the upload finished in 3ms".
   */
  reused?: boolean;
}

export interface UploadHistoryRecord {
  id: string;
  createdAt: number;
  backend: UploadBackend;
  /** Each row in this batch. */
  items: UploadHistoryItem[];
}

/* ----------------------- R-62 Cross-platform capability probe ----------------------- */

/**
 * R-62 — Severity hint for an unsupported / partially-supported feature.
 *
 *  - 'error'  : the feature is broken on this platform and any code path
 *               that reaches it will throw / fail loudly. Renderer must
 *               surface this prominently (red toast).
 *  - 'warn'   : the feature is wired but has not been validated on this
 *               OS / arch combo (e.g. Linux Snap/Flatpak Chrome
 *               detection) — show as yellow toast, allow user to dismiss
 *               permanently.
 *  - 'info'   : the feature is supported but has a known caveat (e.g.
 *               app icon falls back to .ico on platforms that don't
 *               render it perfectly) — soft hint, dismiss on click.
 */
export type CapabilitySeverity = 'error' | 'warn' | 'info';

/**
 * R-62 — A single platform issue surfaced at app startup. The
 * renderer iterates these and renders one toast per issue (deduped
 * against `localStorage.giftk.dismissedCaps` so users can suppress
 * known ones permanently).
 */
export interface CapabilityIssue {
  /** Stable identifier — used as the localStorage dismissal key.
   *  Format: '<platform>.<feature>' e.g. 'darwin.dock-icon-missing-icns'. */
  id: string;
  severity: CapabilitySeverity;
  /** Short, user-facing title (Chinese, <= 24 chars). */
  title: string;
  /** Longer body explaining the symptom and (if applicable) the fix.
   *  Markdown is NOT rendered — newlines become <br> only. */
  detail: string;
  /** Optional external doc link the toast surfaces as "了解更多". */
  docUrl?: string;
}

/**
 * R-62 — Result of `system:capabilities` IPC. Probed once on app
 * startup; cached in main for the lifetime of the process.
 */
export interface CapabilityReport {
  /** process.platform — 'darwin' / 'win32' / 'linux' / etc. */
  platform: NodeJS.Platform;
  /** process.arch — 'x64' / 'arm64' / 'arm' / etc. */
  arch: string;
  /** True if the bundled app icon could be resolved to a PNG (mac/linux
   *  display correctly) rather than only a 32×32 .ico. */
  hasHiResIcon: boolean;
  /** Whether ffmpeg / ffprobe / gifsicle / yt-dlp resolved to a usable
   *  binary. Each entry has the path we'd invoke and whether `--version`
   *  succeeded. */
  binaries: {
    ffmpeg: { path: string; ok: boolean; version: string };
    ffprobe: { path: string; ok: boolean; version: string };
    gifsicle: { path: string; ok: boolean; version: string };
    ytdlp: { path: string; ok: boolean; version: string };
  };
  /** All issues that should be surfaced to the user as toasts. Empty
   *  array is the happy path. */
  issues: CapabilityIssue[];
}
