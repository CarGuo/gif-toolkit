import axios, { AxiosRequestConfig } from 'axios';
import fs from 'fs';
import path from 'path';
import { promises as fsp } from 'fs';
import { fileURLToPath } from 'url';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export interface DownloadOptions {
  referer?: string;
  signal?: AbortSignal;
  maxBytes?: number;
  onProgress?: (downloadedBytes: number, totalBytes: number | null) => void;
  /** Extra headers, e.g. Referer required by Bilibili CDN. Caller is
   *  responsible for sanitising them — main process IPC layer already does
   *  this for renderer-supplied values. */
  headers?: Record<string, string>;
}

/**
 * R-56 — Resolve a sniffed-media URL into an on-disk path when it
 * points at a local resource. Returns null for remote http(s) URLs.
 *
 * Supports two local schemes that the offline-import pipeline emits:
 *
 *   file:///abs/path                 standard RFC 8089 file URL
 *   giftk-local://localhost/abs/path our renderer-displayable mirror
 *                                    (see main/index.ts protocol handler)
 *
 * Falls back to null on any parse failure so the caller can take the
 * normal axios path.
 */
export function resolveLocalUrl(rawUrl: string): string | null {
  if (rawUrl.startsWith('file://')) {
    try { return fileURLToPath(rawUrl); } catch { return null; }
  }
  if (rawUrl.startsWith('giftk-local://')) {
    try {
      const u = new URL(rawUrl);
      // pathname comes back as `/Users/...` on macOS / `/C:/...` on
      // Windows. decodeURIComponent so spaces / unicode resolve.
      let p = decodeURIComponent(u.pathname);
      if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
      return p;
    } catch {
      return null;
    }
  }
  return null;
}

export async function downloadToFile(
  url: string,
  destDir: string,
  fileName: string,
  optionsOrReferer?: DownloadOptions | string,
  onProgressLegacy?: (downloadedBytes: number, totalBytes: number | null) => void
): Promise<string> {
  const opts: DownloadOptions =
    typeof optionsOrReferer === 'string'
      ? { referer: optionsOrReferer, onProgress: onProgressLegacy }
      : optionsOrReferer ?? {};

  await fsp.mkdir(destDir, { recursive: true });
  const target = path.join(destDir, fileName);

  // R-56 — local-file fast path. Offline-import items return either a
  // file:// or giftk-local:// URL pointing at a real on-disk file
  // (mhtml extracted to tmpdir, single .mp4 the user dropped, ...).
  // Skip axios entirely and just `fs.copyFile` so the processor /
  // toolbox / probe pipeline keeps working on offline-mode items
  // without needing a giftk-local capable HTTP client.
  const localPath = resolveLocalUrl(url);
  if (localPath) {
    if (!fs.existsSync(localPath)) {
      throw new Error(`offline file not found: ${localPath}`);
    }
    const st = await fsp.stat(localPath);
    const maxBytesLocal = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    if (st.size > maxBytesLocal) {
      throw new Error(`local file too large: ${st.size} > ${maxBytesLocal}`);
    }
    await fsp.copyFile(localPath, target);
    if (opts.onProgress) opts.onProgress(st.size, st.size);
    return target;
  }

  const tmp = `${target}.part`;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  // Clean stale partial
  await fsp.unlink(tmp).catch(() => undefined);

  const cfg: AxiosRequestConfig = {
    responseType: 'stream',
    headers: {
      'User-Agent': UA,
      // Force identity so googlevideo / Bilibili CDNs don't return a
      // gzipped or chunked-throttled stream that ffprobe later fails on.
      // SABR throttling tends to be much milder when no `Accept-Encoding`
      // negotiation is offered.
      'Accept-Encoding': 'identity',
      Connection: 'keep-alive',
      ...(opts.referer ? { Referer: opts.referer } : {}),
      ...(opts.headers || {})
    },
    timeout: 60000,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
    maxContentLength: maxBytes,
    maxBodyLength: maxBytes
  };
  if (opts.signal) cfg.signal = opts.signal as AbortSignal;

  const res = await axios.get<NodeJS.ReadableStream>(url, cfg);

  const total = Number(res.headers['content-length']) || null;
  if (total && total > maxBytes) {
    throw new Error(`remote file too large: ${total} > ${maxBytes}`);
  }
  let received = 0;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const out = fs.createWriteStream(tmp);
    const cleanup = (err: Error) => {
      if (settled) return;
      settled = true;
      try { (res.data as NodeJS.ReadableStream & { destroy?: (e?: Error) => void }).destroy?.(err); } catch { /* ignore */ }
      out.destroy();
      fsp.unlink(tmp).catch(() => undefined);
      reject(err);
    };

    res.data.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        cleanup(new Error(`download exceeded max bytes: ${maxBytes}`));
        return;
      }
      if (opts.onProgress) opts.onProgress(received, total);
    });
    res.data.on('error', (e: Error) => cleanup(e));
    out.on('error', (e: Error) => cleanup(e));
    out.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve();
    });

    if (opts.signal) {
      const onAbort = () => cleanup(new Error('download aborted'));
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    res.data.pipe(out);
  });

  // Short-read self-check: SABR-throttled googlevideo streams sometimes
  // close cleanly mid-way and we end up with a header-truncated file that
  // ffprobe later rejects with "Invalid data found when processing input".
  // Treat any short-read >5% as a download failure so the caller can retry
  // (or report a clear error rather than corrupt cache).
  if (total && received > 0 && received < Math.floor(total * 0.95)) {
    await fsp.unlink(tmp).catch(() => undefined);
    throw new Error(
      `incomplete download: received ${received} of expected ${total} bytes ` +
      `(short-read; remote may be SABR-throttled or the signed URL has expired)`
    );
  }

  await fsp.rename(tmp, target);
  return target;
}
