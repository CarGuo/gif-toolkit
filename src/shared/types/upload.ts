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
  /** Optional sessionId to associate this upload batch with a
   *  pre-existing session log (created during sniff/process). When
   *  provided, the upload coordinator emits stage='upload' entries
   *  into the same log so the user can trace one history record's
   *  full lifecycle in a single .log/.json export. */
  sessionId?: string;
}

export interface UploadStartResult {
  ok: boolean;
  /** When the user kicked off N jobs we return the same N jobIds in
   *  insertion order; the renderer correlates streamed
   *  UploadProgress events with these ids. */
  jobIds: string[];
  /** The session id this upload batch logs against. Either echoed
   *  from the request payload (when the renderer pinned a session
   *  from the upstream sniff/process round) or freshly minted by the
   *  main process for standalone uploads (e.g. re-upload from the
   *  history panel). The renderer uses this to wire follow-up actions
   *  (history record patch, log panel) to the same session. */
  sessionId: string;
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
   * R-73 — Latest streamed percent (0..100) from the active upload.
   * Folded in by `applyProgressToRecord` so the live progress modal
   * can render a per-row bar without a separate transient state map.
   * Only meaningful while `status === 'uploading'`; ignored on
   * terminal rows (the icon already conveys the result). Persisted
   * to localStorage but the writer is debounced 250ms so streaming
   * percent ticks don't churn disk.
   */
  percent?: number;
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
