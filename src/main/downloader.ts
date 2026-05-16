import axios, { AxiosRequestConfig } from 'axios';
import fs from 'fs';
import path from 'path';
import { promises as fsp } from 'fs';

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
  const tmp = `${target}.part`;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  // Clean stale partial
  await fsp.unlink(tmp).catch(() => undefined);

  const cfg: AxiosRequestConfig = {
    responseType: 'stream',
    headers: {
      'User-Agent': UA,
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

  await fsp.rename(tmp, target);
  return target;
}
