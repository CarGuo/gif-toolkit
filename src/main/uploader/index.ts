/**
 * R-45 — Upload coordinator (Electron main side).
 *
 *  - Persists per-backend config under `<userData>/upload-config.json`.
 *    No external store dependency; we want one tiny JSON file we can
 *    `cat` for diagnostics.
 *  - Validates every job's filePath against `allowedOutputDirs` (the
 *    same allowlist processor uses) — a hostile renderer cannot ask us
 *    to upload `/etc/passwd`.
 *  - Runs jobs serially by default (concurrency=1) so the user's egress
 *    bandwidth isn't shredded; we expose `setMaxConcurrent` for future
 *    expansion but keep it conservative.
 *  - Streams `upload:progress` events to all renderer windows. Mirrors
 *    the processor.ts progress contract so the renderer can wire its
 *    UploadHistoryPanel similarly.
 *  - Cooperates with `app.before-quit` and pre-existing per-job cancel
 *    semantics: each job has its own AbortController; cancelOne /
 *    cancelAll just abort them.
 *
 * Failure handling is intentionally per-job: a single failed upload
 * (auth error, quota, network blip) does NOT cancel the rest of the
 * batch. The renderer surfaces failed rows with an inline retry hook.
 */
import { BrowserWindow, app, ipcMain } from 'electron';
import axios from 'axios';
import { promises as fsp } from 'fs';
import { createHash, randomBytes } from 'crypto';
import path from 'path';
import { log } from '../logger';
import {
  log as logSession,
  openSession as openLogSession,
  closeSession as closeLogSession,
  reopenSession,
  readSession as readLogSession
} from '../sessionLogger';
import { dispatchUpload } from './backends';
import { isMockUploadEnabled } from './mockOss';
import {
  TINY_PNG_BYTES,
  backoffDelayMs,
  buildMarkdown,
  inferQiniuRegionFromUploadHost,
  isRetriableUploadError,
  qiniuRegionQueryUrl
} from './uploaderUtils';
import type {
  UploadBackend,
  UploadConfigs,
  UploadJob,
  UploadProgress,
  UploadStartPayload,
  UploadStartResult,
  UploadTestResult
} from '../../shared/types';

const CONFIG_FILE = 'upload-config.json';
let cachedConfigs: UploadConfigs | null = null;

/** R-45 — registry of in-flight jobs so cancelOne / cancelAll can abort
 *  cleanly. We store an AbortController per jobId. The map shrinks only
 *  when the job reaches a terminal status. */
const inflight: Map<string, AbortController> = new Map();

/** R-46 — registry of pending queues per active batch so `cancelAll`
 *  can also drop jobs that have not yet been picked up by a worker.
 *  Without this, in-flight jobs abort but queued ones still run. */
const pendingQueues: Set<UploadJob[]> = new Set();

function configPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE);
}

/* ----------------------- R-54: hash dedup cache --------------------------- */

/**
 * R-54 — File-hash → previous remote URL cache.
 *
 * Why a separate file (not the upload-history JSON the renderer
 * keeps in localStorage)? Two reasons:
 *
 *  1. Authority. The cache is consulted from the *main* process
 *     before the renderer's history can answer back, so we can't
 *     wait on an IPC round-trip. Keeping it on disk in main means
 *     the cold-start path is `readFile + JSON.parse` — sub-ms for
 *     the typical < 1MB cache file.
 *  2. Separation of concerns. localStorage history is a UI feature
 *     ("show me what I've uploaded recently"). The hash cache is a
 *     correctness/perf feature ("if we've seen these bytes, return
 *     the same URL"). They evolve independently — clearing upload
 *     history shouldn't blow the dedup cache.
 *
 * Schema (`<userData>/upload-hash-cache.json`):
 *   {
 *     [sha256_hex]: {
 *       url: string,
 *       backend: UploadBackend,
 *       fileName: string,
 *       uploadedAt: number  // epoch ms
 *     }
 *   }
 *
 * TTL: 30 days. URLs from object-storage signed-URL backends could
 * theoretically expire shorter than that, but for the backends we
 * support today (customWeb / github / qiniu / aliyunOss / tencentCos)
 * a public read URL is stable for the lifetime of the underlying
 * object. We still cap at 30 days as a compromise so a deleted /
 * rotated remote object eventually drops out of the cache.
 */
const HASH_CACHE_FILE = 'upload-hash-cache.json';
const HASH_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface HashCacheEntry {
  url: string;
  backend: UploadBackend;
  fileName: string;
  uploadedAt: number;
}
type HashCache = Record<string, HashCacheEntry>;
let cachedHashCache: HashCache | null = null;

function hashCachePath(): string {
  return path.join(app.getPath('userData'), HASH_CACHE_FILE);
}

async function readHashCache(): Promise<HashCache> {
  if (cachedHashCache) return cachedHashCache;
  try {
    const raw = await fsp.readFile(hashCachePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      cachedHashCache = parsed as HashCache;
      return cachedHashCache;
    }
  } catch {
    // missing / corrupt — fall through to fresh cache
  }
  cachedHashCache = {};
  return cachedHashCache;
}

async function writeHashCache(c: HashCache): Promise<void> {
  cachedHashCache = c;
  try {
    await fsp.mkdir(path.dirname(hashCachePath()), { recursive: true });
    await fsp.writeFile(hashCachePath(), JSON.stringify(c, null, 2), { mode: 0o600 });
  } catch (e) {
    // Cache is best-effort — log but never fail the upload.
    log(`[upload] hash-cache write failed (non-fatal): ${(e as Error).message || String(e)}`);
  }
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function readConfigs(): Promise<UploadConfigs> {
  if (cachedConfigs) return cachedConfigs;
  try {
    const raw = await fsp.readFile(configPath(), 'utf8');
    const parsed = JSON.parse(raw) as UploadConfigs;
    cachedConfigs = sanitiseConfigs(parsed);
    return cachedConfigs;
  } catch {
    cachedConfigs = { active: 'customWeb' };
    return cachedConfigs;
  }
}

async function writeConfigs(c: UploadConfigs): Promise<void> {
  cachedConfigs = sanitiseConfigs(c);
  // 0600 perms are best-effort on macOS / Linux; on Windows the ACL
  // model differs. The file lives under userData which is per-user, so
  // even default perms keep it private to the OS account.
  await fsp.mkdir(path.dirname(configPath()), { recursive: true });
  await fsp.writeFile(configPath(), JSON.stringify(cachedConfigs, null, 2), { mode: 0o600 });
}

function sanitiseConfigs(c: Partial<UploadConfigs>): UploadConfigs {
  const out: UploadConfigs = {
    active: (c.active && ['customWeb', 'github', 'qiniu', 'aliyunOss', 'tencentCos'].includes(c.active)
      ? c.active
      : 'customWeb') as UploadBackend,
    maxConcurrent: clampInt(c.maxConcurrent, 1, 6, 3),
    maxRetries: clampInt(c.maxRetries, 0, 5, 2)
  };
  if (c.customWeb && typeof c.customWeb === 'object') {
    const cw = c.customWeb;
    out.customWeb = {
      url: typeof cw.url === 'string' ? cw.url : '',
      urlPath: typeof cw.urlPath === 'string' ? cw.urlPath : '',
      fileField: typeof cw.fileField === 'string' ? cw.fileField : undefined,
      headers: cw.headers && typeof cw.headers === 'object' ? sanitiseStringMap(cw.headers as Record<string, unknown>) : {}
    };
  }
  if (c.github && typeof c.github === 'object') out.github = pickStrings(c.github, ['token', 'repo', 'branch', 'pathPrefix', 'customDomain']);
  if (c.qiniu && typeof c.qiniu === 'object') {
    const qn = c.qiniu;
    out.qiniu = {
      ...pickStrings(qn, ['accessKey', 'secretKey', 'bucket', 'domain', 'keyPrefix']),
      region: typeof qn.region === 'string' ? (qn.region as NonNullable<UploadConfigs['qiniu']>['region']) : undefined
    };
  }
  if (c.aliyunOss && typeof c.aliyunOss === 'object') out.aliyunOss = pickStrings(c.aliyunOss, ['accessKeyId', 'accessKeySecret', 'bucket', 'region', 'customDomain', 'keyPrefix']);
  if (c.tencentCos && typeof c.tencentCos === 'object') out.tencentCos = pickStrings(c.tencentCos, ['secretId', 'secretKey', 'bucket', 'region', 'customDomain', 'keyPrefix']);
  return out;
}

function clampInt(v: unknown, lo: number, hi: number, def: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : def;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function sanitiseStringMap(src: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof k === 'string' && typeof v === 'string') out[k] = v;
  }
  return out;
}

function pickStrings<T extends object>(src: Partial<T>, keys: ReadonlyArray<keyof T>): T {
  const o: Partial<T> = {};
  for (const k of keys) {
    const v = (src as Record<string, unknown>)[k as string];
    if (typeof v === 'string') (o as Record<string, unknown>)[k as string] = v;
  }
  return o as T;
}

/* ----------------------- public API ----------------------- */

/** Wire the uploader IPC channels. Pass-in is the same allowedOutputDirs
 *  Set the rest of the app uses, so we share the file allowlist without
 *  duplicating the path-inside helper. */
export function registerUploaderIpc(opts: {
  allowedOutputDirs: Set<string>;
  isPathInside: (parent: string, child: string) => boolean;
  defaultOutDir: () => string;
}): void {
  ipcMain.handle('upload:settings:get', async () => {
    const c = await readConfigs();
    // Mask secret fields when echoing to renderer. The renderer never
    // needs to read back AK/SK; it submits new values via :set. We
    // expose only `<set>` markers so the form can show "已配置 ✓".
    return maskSecrets(c);
  });

  ipcMain.handle('upload:settings:set', async (_e, payload: unknown) => {
    if (!payload || typeof payload !== 'object') throw new Error('settings payload required');
    const merged = mergeMaskedSettings(await readConfigs(), payload as Partial<UploadConfigs>);
    await writeConfigs(merged);
    return { ok: true };
  });

  ipcMain.handle('upload:start', async (_e, payload: unknown): Promise<UploadStartResult> => {
    const p = payload as UploadStartPayload;
    if (!p || typeof p !== 'object' || !Array.isArray(p.jobs)) throw new Error('jobs required');
    const configs = await readConfigs();
    const backend: UploadBackend = (p.backendOverride && isValidBackend(p.backendOverride)) ? p.backendOverride : configs.active;
    const altTemplate = typeof p.altTemplate === 'string' ? p.altTemplate : undefined;
    const jobs = p.jobs.map((j) => sanitiseJob(j, opts));
    const jobIds = jobs.map((j) => j.id);
    // Per-session log: reuse the renderer-pinned sessionId when present
    // (so upload entries land in the same chain as the preceding sniff
    // / process round). When the user uploads from the history panel
    // without a fresh sniff, mint a standalone session so the upload
    // is still observable. If the upstream session was already closed
    // by `process:start`, reopen it so this new stage can keep
    // appending entries against the same session_id.
    let sid: string;
    if (typeof p.sessionId === 'string' && p.sessionId) {
      sid = p.sessionId;
      const existing = readLogSession(sid);
      if (existing && existing.closedAt != null) {
        reopenSession({ sessionId: sid, origin: 'upload:start' });
      } else if (!existing) {
        // Session was never opened upstream — open it now.
        openLogSession({ sessionId: sid, origin: 'upload:start (resumed)' });
      }
    } else {
      sid = `upl-${Date.now()}-${randomBytes(4).toString('hex')}`;
      openLogSession({ sessionId: sid, origin: 'upload:start (standalone)' });
    }
    logSession({
      sessionId: sid,
      stage: 'upload',
      substep: 'start',
      message: `upload start: ${jobs.length} job(s) backend=${backend}`,
      data: { backend, jobIds, altTemplate, jobCount: jobs.length }
    });
    // Fire-and-forget; results stream over upload:progress.
    void runBatch(backend, configs, jobs, altTemplate, sid);
    return { ok: true, jobIds, sessionId: sid };
  });

  ipcMain.handle('upload:cancel', async (_e, jobId: unknown) => {
    if (typeof jobId !== 'string') throw new Error('jobId required');
    const ctrl = inflight.get(jobId);
    if (!ctrl) return { ok: true, cancelled: false };
    ctrl.abort();
    return { ok: true, cancelled: true };
  });

  ipcMain.handle('upload:cancelAll', async () => {
    // R-46 — drop any queued-but-not-yet-started jobs first, then abort
    // the in-flight ones. Doing it in this order means a worker that
    // wakes up between queue.shift() and runOneJob() will simply find
    // the queue empty and exit.
    for (const q of pendingQueues) q.length = 0;
    for (const ctrl of inflight.values()) ctrl.abort();
    return { ok: true };
  });

  /**
   * R-46 — "测试连接" — uploads a 1×1 PNG to validate signing /
   * permission / domain config without touching the user's real
   * outputs. Returns either { ok:true, url } or { ok:false, error }.
   */
  ipcMain.handle('upload:test', async (_e, payload: unknown): Promise<UploadTestResult> => {
    const p = payload as { backend?: UploadBackend; configs?: Partial<UploadConfigs> };
    if (!p || typeof p !== 'object') return { ok: false, error: 'invalid payload' };
    const backend = p.backend && isValidBackend(p.backend) ? p.backend : (await readConfigs()).active;
    // Use the just-saved configs from disk so the user need not press
    // "save" before the test fires; but allow `configs` override if
    // the renderer wants to test an unsaved draft.
    const persisted = await readConfigs();
    const configs = p.configs && typeof p.configs === 'object'
      ? mergeMaskedSettings(persisted, p.configs as Partial<UploadConfigs>)
      : persisted;
    const start = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30_000);
      try {
        const { url } = await dispatchUpload({
          backend,
          fileBytes: TINY_PNG_BYTES,
          fileName: `giftk-test-${Date.now()}.png`,
          configs,
          signal: ctrl.signal
        });
        return { ok: true, url, durationMs: Date.now() - start };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message || String(e), durationMs: Date.now() - start };
    }
  });

  /**
   * R-46 — Qiniu region auto-probe. Calls the public UC v3 query
   * endpoint (no secret required) and infers the closest known region
   * literal from the upload-host string in the response.
   */
  ipcMain.handle('upload:qiniuProbeRegion', async (_e, payload: unknown): Promise<{ ok: boolean; region?: string; host?: string; error?: string }> => {
    const p = payload as { accessKey?: string; bucket?: string };
    if (!p || typeof p !== 'object' || typeof p.accessKey !== 'string' || typeof p.bucket !== 'string') {
      return { ok: false, error: 'accessKey/bucket required' };
    }
    try {
      const qUrl = qiniuRegionQueryUrl(p.accessKey, p.bucket);
      const res = await axios.get(qUrl, { timeout: 30_000, validateStatus: () => true });
      if (res.status < 200 || res.status >= 300) {
        return { ok: false, error: `HTTP ${res.status}: ${truncateForLog(JSON.stringify(res.data), 200)}` };
      }
      const data = res.data as { up?: { acc?: { main?: string[] }; src?: { main?: string[] } } } | undefined;
      const host =
        data?.up?.acc?.main?.[0] ||
        data?.up?.src?.main?.[0] ||
        '';
      const region = host ? inferQiniuRegionFromUploadHost(host) : undefined;
      if (!region) return { ok: false, host, error: '无法从 UC 响应推断 region (host=' + (host || '<empty>') + ')' };
      return { ok: true, region, host };
    } catch (e) {
      return { ok: false, error: (e as Error).message || String(e) };
    }
  });
}

function truncateForLog(s: string, n: number): string {
  if (typeof s !== 'string') return '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function isValidBackend(b: string): b is UploadBackend {
  return ['customWeb', 'github', 'qiniu', 'aliyunOss', 'tencentCos'].includes(b);
}

function sanitiseJob(raw: unknown, opts: { allowedOutputDirs: Set<string>; isPathInside: (a: string, b: string) => boolean; defaultOutDir: () => string }): UploadJob {
  if (!raw || typeof raw !== 'object') throw new Error('job must be object');
  const r = raw as Partial<UploadJob>;
  const id = typeof r.id === 'string' && r.id.length > 0 && r.id.length < 200 ? r.id : '';
  if (!id) throw new Error('job.id required');
  const filePath = typeof r.filePath === 'string' ? path.resolve(r.filePath) : '';
  if (!filePath) throw new Error('job.filePath required');
  // The same path allowlist the rest of the app uses.
  const def = opts.defaultOutDir();
  const inAllow =
    opts.allowedOutputDirs.has(filePath) ||
    [...opts.allowedOutputDirs].some((d) => opts.isPathInside(d, filePath)) ||
    (def && (filePath === def || opts.isPathInside(def, filePath)));
  if (!inAllow) throw new Error(`upload: filePath outside allowed output tree: ${filePath}`);
  const remoteName = typeof r.remoteName === 'string' && r.remoteName.length > 0 && r.remoteName.length < 200 ? r.remoteName : undefined;
  return { id, filePath, remoteName };
}

/* ----------------------- runner ----------------------- */

function emit(p: UploadProgress): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    try { w.webContents.send('upload:progress', p); } catch { /* ignore */ }
  }
  // R-? — Session log fan-out. We only mirror terminal transitions
  // (done / failed / cancelled) to keep the log readable; in-flight
  // bytesUploaded ticks fire dozens of times per second per job and
  // would otherwise drown the .log file.
  const sid = jobSessionMap.get(p.jobId);
  if (!sid) return;
  if (p.status !== 'done' && p.status !== 'failed' && p.status !== 'cancelled') return;
  const level = p.status === 'failed' ? 'error' : (p.status === 'cancelled' ? 'warn' : 'info');
  logSession({
    sessionId: sid,
    stage: 'upload',
    level,
    substep: `job.${p.status}`,
    message: `[${p.jobId}] ${p.status}${p.error ? ': ' + p.error : ''}${p.url ? ' -> ' + p.url : ''}`,
    data: {
      jobId: p.jobId,
      status: p.status,
      backend: p.backend,
      url: p.url,
      reused: p.reused,
      bytesTotal: p.bytesTotal,
      bytesUploaded: p.bytesUploaded,
      attempt: p.attempt,
      maxAttempts: p.maxAttempts,
      fileHash: p.fileHash,
      error: p.error
    }
  });
  // Drop the mapping once the job hits a terminal state to avoid
  // unbounded memory growth across long-running app sessions.
  jobSessionMap.delete(p.jobId);
}

/** R-? — jobId → sessionId map. Populated by runBatch when the
 *  caller passes a sessionId on UploadStartPayload, drained by
 *  emit() on terminal transitions. */
const jobSessionMap = new Map<string, string>();

async function runBatch(
  backend: UploadBackend,
  configs: UploadConfigs,
  jobs: UploadJob[],
  altTemplate?: string,
  sessionId?: string
): Promise<void> {
  const concurrency = configs.maxConcurrent ?? 3;
  const maxRetries = configs.maxRetries ?? 2;
  log(`[upload] start batch backend=${backend} jobs=${jobs.length} concurrency=${concurrency} retries=${maxRetries}`);
  if (sessionId) {
    for (const j of jobs) jobSessionMap.set(j.id, sessionId);
  }
  // R-46 — Bounded-concurrency worker pool. We spawn `concurrency`
  // workers that pull from a shared queue. This replaces the previous
  // strictly serial loop so users can saturate egress without
  // hammering one host at concurrency=N when N is high.
  const queue = jobs.slice();
  pendingQueues.add(queue);
  const workers: Promise<void>[] = [];
  const seat = async (): Promise<void> => {
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) return;
      await runOneJob(backend, configs, job, maxRetries, altTemplate);
    }
  };
  let runError: unknown = null;
  try {
    for (let i = 0; i < Math.min(concurrency, jobs.length); i++) workers.push(seat());
    await Promise.all(workers);
  } catch (e) {
    runError = e;
  } finally {
    pendingQueues.delete(queue);
  }
  log(`[upload] batch done backend=${backend}`);
  if (sessionId) {
    if (runError) {
      logSession({
        sessionId,
        stage: 'upload',
        level: 'error',
        substep: 'batch.error',
        message: `upload batch error backend=${backend}: ${(runError as Error).message}`,
        data: { backend, jobCount: jobs.length }
      });
      closeLogSession({
        sessionId,
        outcome: 'error',
        message: `upload batch error: ${(runError as Error).message}`
      });
    } else {
      logSession({
        sessionId,
        stage: 'upload',
        substep: 'batch.done',
        message: `upload batch done backend=${backend}`,
        data: { backend, jobCount: jobs.length }
      });
      closeLogSession({
        sessionId,
        outcome: 'done',
        message: `upload batch finished — ${jobs.length} job(s)`
      });
    }
  }
  if (runError) throw runError;
}

async function runOneJob(
  backend: UploadBackend,
  configs: UploadConfigs,
  job: UploadJob,
  maxRetries: number,
  altTemplate?: string
): Promise<void> {
  const ctrl = new AbortController();
  inflight.set(job.id, ctrl);
  const fileName = job.remoteName || path.basename(job.filePath);
  // R-54 — `recordId` is the renderer-supplied id of the processing
  // HistoryRecord this output came from. We echo it on every emit so
  // the renderer can patch HistoryRecord.uploadsByOutputPath without
  // keeping its own jobId → recordId map.
  const recordId = job.recordId;
  let bytes: Buffer;
  try {
    bytes = await fsp.readFile(job.filePath);
  } catch (e) {
    emit({
      jobId: job.id, backend,
      status: 'failed', percent: 0,
      error: `read failed: ${(e as Error).message || String(e)}`,
      recordId
    });
    inflight.delete(job.id);
    return;
  }
  const total = bytes.length;
  const maxAttempts = maxRetries + 1;

  // R-54 — Hash-dedup short-circuit. Compute sha256 of the bytes we
  // are about to upload; if the cache has a matching entry for this
  // backend that is still within TTL, emit a synthetic `done` event
  // with the cached URL and SKIP the entire retry loop. The renderer
  // surfaces this row as 「♻️ 复用」 and the upload-history record
  // carries the same `fileHash` for future short-circuits.
  //
  // We hash even when the cache is empty so subsequent uploads of
  // the same bytes can be deduped — the cost is one in-memory pass
  // over a buffer we already have in RAM (sub-ms for a 5MB GIF).
  const fileHash = sha256Hex(bytes);
  // R-COVERAGE-REAL-SCENARIO — Skip the hash-dedup short-circuit when
  // mock-oss mode is on. Otherwise a stale entry from a prior smoke
  // run (or a sibling realPipeline SUITE that uploaded the same fixture
  // bytes) would synthesise a `done` with the OLD non-mock URL and the
  // smoke spec would never see `dispatchUpload` route into mockOss.
  // The dedup feature itself is not under test in mock mode — every
  // smoke job needs to traverse `dispatchUpload` for assertions.
  const skipHashCache = isMockUploadEnabled();
  if (!skipHashCache) {
    try {
      const cache = await readHashCache();
      const hit = cache[fileHash];
      if (
        hit &&
        hit.backend === backend &&
        typeof hit.url === 'string' &&
        hit.url.length > 0 &&
        Date.now() - (hit.uploadedAt || 0) < HASH_CACHE_TTL_MS
      ) {
        const md = buildMarkdown(fileName, hit.url, altTemplate);
        emit({
          jobId: job.id, backend,
          status: 'done', percent: 100,
          url: hit.url, markdown: md,
          bytesTotal: total, bytesUploaded: total,
          message: '♻️ hash 命中,复用历史地址',
          attempt: 1, maxAttempts: 1,
          fileHash, reused: true,
          recordId
        });
        log(`[upload] hash-cache HIT job=${job.id} sha=${fileHash.slice(0, 8)}… url=${hit.url}`);
        inflight.delete(job.id);
        return;
      }
    } catch (e) {
      // Cache lookup failure is non-fatal: just go uploaded as normal.
      log(`[upload] hash-cache lookup failed (non-fatal): ${(e as Error).message || String(e)}`);
    }
  }

  let lastErr: unknown;
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (ctrl.signal.aborted) break;
      emit({
        jobId: job.id, backend, status: 'uploading', percent: 0,
        bytesTotal: total, bytesUploaded: 0,
        message: fileName, attempt, maxAttempts,
        fileHash, recordId
      });
      try {
        const { url } = await dispatchUpload({
          backend, fileBytes: bytes, fileName, configs,
          signal: ctrl.signal,
          onProgress: (sent, all) => {
            const pct = all > 0 ? Math.min(99, Math.round((sent / all) * 100)) : 0;
            emit({
              jobId: job.id, backend,
              status: 'uploading', percent: pct,
              bytesTotal: all, bytesUploaded: sent,
              message: fileName, attempt, maxAttempts,
              fileHash, recordId
            });
          }
        });
        const md = buildMarkdown(fileName, url, altTemplate);
        emit({
          jobId: job.id, backend, status: 'done', percent: 100,
          url, markdown: md,
          bytesTotal: total, bytesUploaded: total,
          attempt, maxAttempts,
          fileHash, recordId
        });
        // R-54 — Persist the successful upload into the dedup cache.
        // We swallow write failures (best-effort): a missing cache
        // entry just means the next identical upload will repeat.
        // Skipped under mock-oss mode so smoke runs never persist a
        // mock URL into the user's hash-cache file.
        if (!skipHashCache) {
          try {
            const cache = await readHashCache();
            cache[fileHash] = {
              url,
              backend,
              fileName,
              uploadedAt: Date.now()
            };
            await writeHashCache(cache);
          } catch {
            // already logged inside writeHashCache
          }
        }
        log(`[upload] ok job=${job.id} attempt=${attempt} url=${url} sha=${fileHash.slice(0, 8)}…`);
        return;
      } catch (e) {
        lastErr = e;
        if (ctrl.signal.aborted) break;
        const retriable = isRetriableUploadError(e);
        const lastTry = attempt >= maxAttempts;
        if (!retriable || lastTry) break;
        const delay = backoffDelayMs(attempt - 1);
        log(`[upload] retry job=${job.id} attempt=${attempt}/${maxAttempts} after ${delay}ms: ${(e as Error).message || String(e)}`);
        await sleep(delay, ctrl.signal);
      }
    }
    const aborted = ctrl.signal.aborted;
    emit({
      jobId: job.id, backend,
      status: aborted ? 'cancelled' : 'failed',
      percent: 0,
      error: aborted ? 'cancelled by user' : ((lastErr as Error)?.message || String(lastErr) || 'failed'),
      fileHash, recordId
    });
    log(`[upload] ${aborted ? 'cancelled' : 'failed'} job=${job.id}: ${(lastErr as Error)?.message || String(lastErr) || 'failed'}`);
  } finally {
    inflight.delete(job.id);
  }
}

/** Cancel-aware sleep — resolves early when the signal aborts so
 *  cancelOne doesn't have to wait out an in-flight backoff. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/* ----------------------- secrets masking ----------------------- */

const SECRET_FIELDS: Record<UploadBackend, string[]> = {
  customWeb: [], // we mask Authorization header value below
  github: ['token'],
  qiniu: ['secretKey'],
  aliyunOss: ['accessKeySecret'],
  tencentCos: ['secretKey']
};

const MASK = '••••••';

function maskSecrets(c: UploadConfigs): UploadConfigs {
  const cloned: UploadConfigs = JSON.parse(JSON.stringify(c));
  for (const backend of Object.keys(SECRET_FIELDS) as UploadBackend[]) {
    const block = (cloned as unknown as Record<string, Record<string, unknown> | undefined>)[backend];
    if (!block) continue;
    for (const k of SECRET_FIELDS[backend]) {
      if (typeof block[k] === 'string' && (block[k] as string).length > 0) {
        block[k] = MASK;
      }
    }
  }
  // Mask Authorization header value in customWeb headers.
  if (cloned.customWeb && cloned.customWeb.headers) {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(cloned.customWeb.headers)) {
      next[k] = k.toLowerCase() === 'authorization' && v ? MASK : v;
    }
    cloned.customWeb.headers = next;
  }
  return cloned;
}

/**
 * R-45 — When the renderer submits :set, any field that is still the
 * literal MASK string means "user did not edit it; keep prior value".
 * Without this, every settings save would clobber the actual secrets
 * (the renderer only sees masked values via :get).
 */
function mergeMaskedSettings(prior: UploadConfigs, incoming: Partial<UploadConfigs>): UploadConfigs {
  const merged: UploadConfigs = { ...prior, ...incoming } as UploadConfigs;
  for (const backend of Object.keys(SECRET_FIELDS) as UploadBackend[]) {
    const inc = (incoming as unknown as Record<string, Record<string, unknown> | undefined>)[backend];
    const pri = (prior as unknown as Record<string, Record<string, unknown> | undefined>)[backend];
    if (!inc) continue;
    for (const k of SECRET_FIELDS[backend]) {
      if (inc[k] === MASK && pri && typeof pri[k] === 'string') {
        inc[k] = pri[k];
      }
    }
    // Persist merged block back into merged.
    (merged as unknown as Record<string, unknown>)[backend] = inc;
  }
  if (merged.customWeb && merged.customWeb.headers && prior.customWeb && prior.customWeb.headers) {
    const incHdrs = merged.customWeb.headers;
    const priHdrs = prior.customWeb.headers;
    for (const k of Object.keys(incHdrs)) {
      if (incHdrs[k] === MASK && typeof priHdrs[k] === 'string') {
        incHdrs[k] = priHdrs[k];
      }
    }
  }
  return merged;
}
