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
import path from 'path';
import { log } from '../logger';
import { dispatchUpload } from './backends';
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
    // Fire-and-forget; results stream over upload:progress.
    void runBatch(backend, configs, jobs, altTemplate);
    return { ok: true, jobIds };
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
}

async function runBatch(
  backend: UploadBackend,
  configs: UploadConfigs,
  jobs: UploadJob[],
  altTemplate?: string
): Promise<void> {
  const concurrency = configs.maxConcurrent ?? 3;
  const maxRetries = configs.maxRetries ?? 2;
  log(`[upload] start batch backend=${backend} jobs=${jobs.length} concurrency=${concurrency} retries=${maxRetries}`);
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
  try {
    for (let i = 0; i < Math.min(concurrency, jobs.length); i++) workers.push(seat());
    await Promise.all(workers);
  } finally {
    pendingQueues.delete(queue);
  }
  log(`[upload] batch done backend=${backend}`);
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
  let bytes: Buffer;
  try {
    bytes = await fsp.readFile(job.filePath);
  } catch (e) {
    emit({
      jobId: job.id, backend,
      status: 'failed', percent: 0,
      error: `read failed: ${(e as Error).message || String(e)}`
    });
    inflight.delete(job.id);
    return;
  }
  const total = bytes.length;
  const maxAttempts = maxRetries + 1;
  let lastErr: unknown;
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (ctrl.signal.aborted) break;
      emit({
        jobId: job.id, backend, status: 'uploading', percent: 0,
        bytesTotal: total, bytesUploaded: 0,
        message: fileName, attempt, maxAttempts
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
              message: fileName, attempt, maxAttempts
            });
          }
        });
        const md = buildMarkdown(fileName, url, altTemplate);
        emit({
          jobId: job.id, backend, status: 'done', percent: 100,
          url, markdown: md,
          bytesTotal: total, bytesUploaded: total,
          attempt, maxAttempts
        });
        log(`[upload] ok job=${job.id} attempt=${attempt} url=${url}`);
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
      error: aborted ? 'cancelled by user' : ((lastErr as Error)?.message || String(lastErr) || 'failed')
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
