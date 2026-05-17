/**
 * R-45 — Upload backends.
 *
 * Each backend exports a single async function with the same signature:
 *
 *   uploadXxx(args: {
 *     fileBytes: Buffer;
 *     fileName: string;
 *     config: BackendConfig;
 *     onProgress?: (sent: number, total: number) => void;
 *     signal?: AbortSignal;
 *   }): Promise<{ url: string }>
 *
 * Throwing surfaces a string error to the renderer; the dispatcher
 * never catches/swallows.
 *
 * Adding a 6th backend (e.g. SM.MS, Imgur) is a 4-step recipe:
 *   1. Add a new branch to `UploadBackend` in src/shared/types.ts
 *   2. Add a Config interface for it
 *   3. Implement `uploadXxx` here following the contract above
 *   4. Add a case in `dispatchUpload` below + a UI form in
 *      UploadSettingsModal.tsx
 *
 * No SDKs are used — every backend talks plain HTTP via axios with
 * pre-computed signatures from uploaderUtils.ts. This keeps the asar
 * bundle small and auditable.
 */
import axios, { AxiosError, AxiosProgressEvent, AxiosRequestConfig } from 'axios';
import crypto from 'crypto';
import path from 'path';
import type {
  AliyunOssConfig,
  CustomWebConfig,
  GithubConfig,
  QiniuConfig,
  TencentCosConfig,
  UploadBackend,
  UploadConfigs
} from '../../shared/types';
import {
  buildAliyunPutSignature,
  buildCosPutSignature,
  buildRemoteKey,
  guessMimeFromName,
  mintQiniuUploadToken,
  qiniuUploadHost,
  resolveJsonPath,
  sanitizeCustomWebHeaders,
  sanitizeRemoteName,
  shortRandomSuffix
} from './uploaderUtils';
import { buildMultipart } from './multipart';

interface BackendArgs<T> {
  fileBytes: Buffer;
  fileName: string;
  config: T;
  onProgress?: (sent: number, total: number) => void;
  signal?: AbortSignal;
}

/** Shared axios call wrapper that maps status / connection errors to
 *  the human-readable strings we want to surface in the upload-history
 *  panel. */
async function call(args: AxiosRequestConfig): Promise<{ status: number; data: unknown; headers: Record<string, unknown> }> {
  try {
    const r = await axios({ ...args, timeout: 60_000, maxBodyLength: Infinity, maxContentLength: Infinity, validateStatus: () => true });
    return { status: r.status, data: r.data, headers: r.headers as Record<string, unknown> };
  } catch (e) {
    const ax = e as AxiosError;
    if (axios.isCancel(e)) throw new Error('upload cancelled');
    throw new Error(`network error: ${ax.message || String(e)}`);
  }
}

function progressAdapter(onProgress?: (s: number, t: number) => void): ((p: AxiosProgressEvent) => void) | undefined {
  if (!onProgress) return undefined;
  return (p) => {
    if (typeof p.loaded === 'number' && typeof p.total === 'number' && p.total > 0) {
      onProgress(p.loaded, p.total);
    }
  };
}

/* ----------------------- customWeb ----------------------- */

export async function uploadCustomWeb(
  args: BackendArgs<CustomWebConfig>
): Promise<{ url: string }> {
  const { config } = args;
  if (!config.url) throw new Error('customWeb: url required');
  const u = new URL(config.url);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))) {
    throw new Error('customWeb: only https URLs are allowed (http only for localhost)');
  }
  const fileField = config.fileField || 'file';
  const safeName = sanitizeRemoteName(args.fileName);
  const mp = buildMultipart([
    {
      name: fileField,
      value: args.fileBytes,
      filename: safeName,
      contentType: guessMimeFromName(args.fileName)
    }
  ]);
  const headers: Record<string, string> = {
    'Content-Type': mp.contentType,
    'Content-Length': String(mp.body.length),
    ...sanitizeCustomWebHeaders(config.headers)
  };
  const res = await call({
    method: 'POST',
    url: config.url,
    data: mp.body,
    headers,
    onUploadProgress: progressAdapter(args.onProgress),
    signal: args.signal as unknown as AbortSignal
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`customWeb HTTP ${res.status}: ${truncate(JSON.stringify(res.data), 300)}`);
  }
  let payload: unknown = res.data;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { /* keep string */ }
  }
  const url = resolveJsonPath(payload, config.urlPath);
  if (!url) {
    throw new Error(`customWeb: response did not contain a string at "${config.urlPath}". body=${truncate(JSON.stringify(payload), 200)}`);
  }
  return { url };
}

/* ----------------------- github ----------------------- */

export async function uploadGithub(
  args: BackendArgs<GithubConfig>
): Promise<{ url: string }> {
  const { config } = args;
  if (!config.token) throw new Error('github: token required');
  if (!/^[\w-]+\/[\w.-]+$/.test(config.repo)) throw new Error('github: repo must be in owner/repo form');
  const branch = config.branch || 'main';
  const prefix = (config.pathPrefix || 'images').replace(/^\/+|\/+$/g, '');
  const safeName = sanitizeRemoteName(args.fileName);
  // Append a short suffix so that re-uploads of the same basename don't
  // collide on the same yyyymmdd dir. GitHub returns 422 on overwrite
  // without a sha, so this gives every upload a clean slate.
  const finalName = `${stripExt(safeName)}-${shortRandomSuffix()}${path.extname(safeName)}`;
  const remotePath = buildRemoteKey(finalName, prefix);
  const apiUrl = `https://api.github.com/repos/${config.repo}/contents/${encodeURI(remotePath)}`;
  const body = {
    message: `gif-toolkit upload ${finalName}`,
    branch,
    content: args.fileBytes.toString('base64')
  };
  const res = await call({
    method: 'PUT',
    url: apiUrl,
    headers: {
      'Authorization': `token ${config.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'gif-toolkit'
    },
    data: body,
    onUploadProgress: progressAdapter(args.onProgress),
    signal: args.signal as unknown as AbortSignal
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`github HTTP ${res.status}: ${truncate(JSON.stringify(res.data), 300)}`);
  }
  // The Contents API echoes content.download_url which is the
  // raw.githubusercontent.com link; fall through to it. If the user
  // configured a customDomain (jsdelivr), build that instead.
  let publicUrl: string | undefined;
  if (config.customDomain) {
    const dom = config.customDomain.replace(/\/+$/, '');
    publicUrl = `${dom}/${encodeURI(remotePath)}`;
  } else {
    const data = res.data as { content?: { download_url?: string } };
    publicUrl = data?.content?.download_url;
  }
  if (!publicUrl) throw new Error('github: response missing download_url');
  return { url: publicUrl };
}

/* ----------------------- qiniu ----------------------- */

export async function uploadQiniu(
  args: BackendArgs<QiniuConfig>
): Promise<{ url: string }> {
  const { config } = args;
  if (!config.accessKey || !config.secretKey || !config.bucket || !config.domain) {
    throw new Error('qiniu: accessKey/secretKey/bucket/domain required');
  }
  const token = mintQiniuUploadToken(config.accessKey, config.secretKey, config.bucket);
  const safeName = sanitizeRemoteName(args.fileName);
  const finalName = `${stripExt(safeName)}-${shortRandomSuffix()}${path.extname(safeName)}`;
  const key = buildRemoteKey(finalName, config.keyPrefix);
  const mp = buildMultipart([
    { name: 'key', value: key },
    { name: 'token', value: token },
    {
      name: 'file',
      value: args.fileBytes,
      filename: finalName,
      contentType: guessMimeFromName(args.fileName)
    }
  ]);
  const host = qiniuUploadHost(config.region);
  const res = await call({
    method: 'POST',
    url: host,
    headers: {
      'Content-Type': mp.contentType,
      'Content-Length': String(mp.body.length)
    },
    data: mp.body,
    onUploadProgress: progressAdapter(args.onProgress),
    signal: args.signal as unknown as AbortSignal
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`qiniu HTTP ${res.status}: ${truncate(JSON.stringify(res.data), 300)}`);
  }
  const dom = config.domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return { url: `https://${dom}/${key}` };
}

/* ----------------------- aliyun OSS ----------------------- */

export async function uploadAliyunOss(
  args: BackendArgs<AliyunOssConfig>
): Promise<{ url: string }> {
  const { config } = args;
  if (!config.accessKeyId || !config.accessKeySecret || !config.bucket || !config.region) {
    throw new Error('aliyunOss: accessKeyId/accessKeySecret/bucket/region required');
  }
  const safeName = sanitizeRemoteName(args.fileName);
  const finalName = `${stripExt(safeName)}-${shortRandomSuffix()}${path.extname(safeName)}`;
  const key = buildRemoteKey(finalName, config.keyPrefix);
  const contentType = guessMimeFromName(args.fileName);
  const contentMd5 = crypto.createHash('md5').update(args.fileBytes).digest('base64');
  const date = new Date().toUTCString();
  const { authorization } = buildAliyunPutSignature({
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    bucket: config.bucket,
    key,
    contentType,
    contentMd5,
    date
  });
  const host = config.customDomain
    ? config.customDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '')
    : `${config.bucket}.${config.region}.aliyuncs.com`;
  const url = `https://${host}/${encodeURI(key)}`;
  const res = await call({
    method: 'PUT',
    url,
    headers: {
      'Authorization': authorization,
      'Content-Type': contentType,
      'Content-MD5': contentMd5,
      'Date': date,
      'Content-Length': String(args.fileBytes.length),
      'Host': host
    },
    data: args.fileBytes,
    onUploadProgress: progressAdapter(args.onProgress),
    signal: args.signal as unknown as AbortSignal
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`aliyunOss HTTP ${res.status}: ${truncate(stringifyMaybeXml(res.data), 300)}`);
  }
  return { url };
}

/* ----------------------- tencent COS ----------------------- */

export async function uploadTencentCos(
  args: BackendArgs<TencentCosConfig>
): Promise<{ url: string }> {
  const { config } = args;
  if (!config.secretId || !config.secretKey || !config.bucket || !config.region) {
    throw new Error('tencentCos: secretId/secretKey/bucket/region required');
  }
  const safeName = sanitizeRemoteName(args.fileName);
  const finalName = `${stripExt(safeName)}-${shortRandomSuffix()}${path.extname(safeName)}`;
  const key = buildRemoteKey(finalName, config.keyPrefix);
  const contentType = guessMimeFromName(args.fileName);
  const host = config.customDomain
    ? config.customDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '')
    : `${config.bucket}.cos.${config.region}.myqcloud.com`;
  const { authorization } = buildCosPutSignature({
    secretId: config.secretId,
    secretKey: config.secretKey,
    host,
    key
  });
  const url = `https://${host}/${encodeURI(key)}`;
  const res = await call({
    method: 'PUT',
    url,
    headers: {
      'Authorization': authorization,
      'Content-Type': contentType,
      'Content-Length': String(args.fileBytes.length),
      'Host': host
    },
    data: args.fileBytes,
    onUploadProgress: progressAdapter(args.onProgress),
    signal: args.signal as unknown as AbortSignal
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`tencentCos HTTP ${res.status}: ${truncate(stringifyMaybeXml(res.data), 300)}`);
  }
  return { url };
}

/* ----------------------- dispatcher ----------------------- */

export async function dispatchUpload(args: {
  backend: UploadBackend;
  fileBytes: Buffer;
  fileName: string;
  configs: UploadConfigs;
  onProgress?: (sent: number, total: number) => void;
  signal?: AbortSignal;
}): Promise<{ url: string }> {
  switch (args.backend) {
    case 'customWeb': {
      if (!args.configs.customWeb) throw new Error('customWeb is not configured');
      return uploadCustomWeb({
        fileBytes: args.fileBytes,
        fileName: args.fileName,
        config: args.configs.customWeb,
        onProgress: args.onProgress,
        signal: args.signal
      });
    }
    case 'github': {
      if (!args.configs.github) throw new Error('github is not configured');
      return uploadGithub({
        fileBytes: args.fileBytes,
        fileName: args.fileName,
        config: args.configs.github,
        onProgress: args.onProgress,
        signal: args.signal
      });
    }
    case 'qiniu': {
      if (!args.configs.qiniu) throw new Error('qiniu is not configured');
      return uploadQiniu({
        fileBytes: args.fileBytes,
        fileName: args.fileName,
        config: args.configs.qiniu,
        onProgress: args.onProgress,
        signal: args.signal
      });
    }
    case 'aliyunOss': {
      if (!args.configs.aliyunOss) throw new Error('aliyunOss is not configured');
      return uploadAliyunOss({
        fileBytes: args.fileBytes,
        fileName: args.fileName,
        config: args.configs.aliyunOss,
        onProgress: args.onProgress,
        signal: args.signal
      });
    }
    case 'tencentCos': {
      if (!args.configs.tencentCos) throw new Error('tencentCos is not configured');
      return uploadTencentCos({
        fileBytes: args.fileBytes,
        fileName: args.fileName,
        config: args.configs.tencentCos,
        onProgress: args.onProgress,
        signal: args.signal
      });
    }
    default:
      throw new Error(`unknown backend: ${args.backend as string}`);
  }
}

/* ----------------------- internal ----------------------- */

function truncate(s: string, n: number): string {
  if (typeof s !== 'string') return '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

/** Aliyun / COS surface XML on errors; keep it short. */
function stringifyMaybeXml(d: unknown): string {
  if (typeof d === 'string') return d;
  try { return JSON.stringify(d); } catch { return String(d); }
}
