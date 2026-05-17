/**
 * R-45 — pure helpers for the upload pipeline. Kept in a leaf module so
 * the unit tests (which run under vitest's Node environment, no electron
 * runtime) can import them without dragging in the BrowserWindow /
 * session / ipcMain symbols from the rest of the main bundle.
 *
 * Anything that *does* need Electron (file IO via node:fs, electron-log,
 * dialog, etc.) lives in src/main/uploader/index.ts.
 */
import crypto from 'crypto';
import path from 'path';

/**
 * R-45 — Build a Markdown image-link line for a successful upload.
 *
 * altTemplate supports `{name}` (file basename without extension) and
 * `{ext}` (lowercase extension without the dot). Falls back to `{name}`.
 * The alt text is sanitised: square brackets and pipes are stripped so
 * a malicious filename can't break out of `![...](...)`.
 */
export function buildMarkdown(
  fileName: string,
  url: string,
  altTemplate?: string
): string {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  const name = path.basename(fileName, path.extname(fileName));
  const tpl = altTemplate && altTemplate.trim().length > 0 ? altTemplate : '{name}';
  const alt = tpl
    .replace(/\{name\}/g, name)
    .replace(/\{ext\}/g, ext)
    .replace(/[\[\]|`]/g, ''); // eslint-disable-line no-useless-escape
  return `![${alt}](${url})`;
}

/**
 * R-45 — JSONPath-lite resolver for customWeb.urlPath.
 *
 * Subset supported (deliberately tiny — we don't want a full JSONPath
 * dependency for one-line extraction):
 *
 *   $.data.url       → root traversal
 *   data.url         → root traversal (the leading $. is optional)
 *   data.list[0].url → numeric index segments
 *   $['weird-key']   → bracket-quoted key segments (single OR double quote)
 *
 * Returns undefined when the path doesn't resolve to a non-empty string.
 */
export function resolveJsonPath(obj: unknown, expr: string): string | undefined {
  if (!expr || typeof expr !== 'string') return undefined;
  let body = expr.trim();
  if (body.startsWith('$.')) body = body.slice(2);
  else if (body.startsWith('$')) body = body.slice(1);

  const tokens: Array<string | number> = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] === '.') { i++; continue; }
    if (body[i] === '[') {
      const end = body.indexOf(']', i);
      if (end < 0) return undefined;
      const inner = body.slice(i + 1, end).trim();
      if (/^\d+$/.test(inner)) {
        tokens.push(Number(inner));
      } else if (/^['"].*['"]$/.test(inner)) {
        tokens.push(inner.slice(1, -1));
      } else {
        return undefined;
      }
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < body.length && body[j] !== '.' && body[j] !== '[') j++;
    const seg = body.slice(i, j);
    if (seg.length === 0) return undefined;
    tokens.push(seg);
    i = j;
  }
  let cur: unknown = obj;
  for (const t of tokens) {
    if (cur == null) return undefined;
    if (typeof t === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[t];
    } else {
      if (typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[t];
    }
  }
  return typeof cur === 'string' && cur.length > 0 ? cur : undefined;
}

/**
 * R-45 — Generate the remote object key.
 *
 * Format: `<keyPrefix>/<yyyymmdd>/<basename>`. We always strip a leading
 * slash from keyPrefix and collapse double slashes so concatenation is
 * predictable. The yyyymmdd segment helps users keep buckets organised
 * without per-upload manual config.
 *
 * `now` is injected so tests are deterministic; production callers omit
 * it and we use `Date.now()`.
 */
export function buildRemoteKey(
  fileName: string,
  keyPrefix?: string,
  now?: Date
): string {
  const d = now ?? new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateSeg = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const safeName = sanitizeRemoteName(fileName);
  const prefix = (keyPrefix || '').replace(/^\/+|\/+$/g, '');
  return prefix
    ? `${prefix}/${dateSeg}/${safeName}`
    : `${dateSeg}/${safeName}`;
}

/**
 * R-45 — Strip path traversal / leading slash / Windows drive letters
 * out of a user-supplied remote filename, plus collapse anything that's
 * not [A-Za-z0-9._-] to underscore. A short hash suffix is *not* added
 * here — callers can append one if they want stronger collision
 * resistance.
 */
export function sanitizeRemoteName(input: string): string {
  const base = path.posix.basename(String(input).replace(/\\+/g, '/'));
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'file';
}

/**
 * R-45 — Produce a short, content-derived random suffix to avoid
 * collisions when two files share a basename. Uses 6 hex chars (24 bits)
 * — plenty for a per-user upload feed; it's not a security identifier.
 */
export function shortRandomSuffix(): string {
  return crypto.randomBytes(3).toString('hex');
}

/* ----------------------- 七牛 helpers ----------------------- */

/**
 * R-45 — 七牛 upload-token mint.
 *
 * Spec: https://developer.qiniu.com/kodo/1208/upload-token
 *
 *   1. Build a "PutPolicy" JSON ({scope, deadline}) where scope is the
 *      bucket name, deadline is unix-epoch seconds.
 *   2. urlsafe-base64 encode the JSON.
 *   3. HMAC-SHA1 sign the encoded JSON with secretKey.
 *   4. urlsafe-base64 encode the HMAC.
 *   5. Token = `${accessKey}:${encodedSign}:${encodedPutPolicy}`.
 *
 * Pure function so we can unit test the token shape without hitting the
 * network. Verified against the byte-exact reference in qiniu/go-sdk.
 */
export function mintQiniuUploadToken(
  accessKey: string,
  secretKey: string,
  bucket: string,
  expiresInSec = 3600,
  now?: Date
): string {
  if (!accessKey || !secretKey || !bucket) {
    throw new Error('mintQiniuUploadToken: accessKey/secretKey/bucket required');
  }
  const deadline =
    Math.floor((now ? now.getTime() : Date.now()) / 1000) + expiresInSec;
  const policy = JSON.stringify({ scope: bucket, deadline });
  const encodedPolicy = urlSafeBase64(Buffer.from(policy, 'utf8'));
  const sign = crypto
    .createHmac('sha1', secretKey)
    .update(encodedPolicy)
    .digest();
  const encodedSign = urlSafeBase64(sign);
  return `${accessKey}:${encodedSign}:${encodedPolicy}`;
}

/** 七牛 region → upload host. Per
 *  https://developer.qiniu.com/kodo/4088/upload-domain. */
export function qiniuUploadHost(region?: string): string {
  switch (region) {
    case 'z1': return 'https://upload-z1.qiniup.com';
    case 'z2': return 'https://upload-z2.qiniup.com';
    case 'na0': return 'https://upload-na0.qiniup.com';
    case 'as0': return 'https://upload-as0.qiniup.com';
    case 'cn-east-2': return 'https://upload-cn-east-2.qiniup.com';
    case 'z0':
    default:
      return 'https://upload.qiniup.com';
  }
}

/** Qiniu / OSS / COS share urlsafe-base64. */
export function urlSafeBase64(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

/* ----------------------- 阿里云 OSS helpers ----------------------- */

/**
 * R-45 — Aliyun OSS Authorization v1 (PutObject).
 *
 * Spec: https://help.aliyun.com/zh/oss/developer-reference/include-signatures-in-the-authorization-header
 *
 *   StringToSign = VERB + "\n" +
 *                  Content-MD5 + "\n" +
 *                  Content-Type + "\n" +
 *                  Date + "\n" +
 *                  CanonicalizedOSSHeaders +
 *                  CanonicalizedResource
 *   Signature = base64(HMAC-SHA1(StringToSign, accessKeySecret))
 *   Authorization = "OSS " + accessKeyId + ":" + Signature
 *
 * For a plain PutObject we omit CanonicalizedOSSHeaders entirely
 * (no x-oss-* headers) and CanonicalizedResource is just `/${bucket}/${key}`.
 */
export function buildAliyunPutSignature(args: {
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  key: string;
  contentType: string;
  contentMd5: string;
  /** `Date` header value in RFC1123 (toUTCString). */
  date: string;
}): { authorization: string; stringToSign: string } {
  const stringToSign =
    'PUT\n' +
    args.contentMd5 + '\n' +
    args.contentType + '\n' +
    args.date + '\n' +
    `/${args.bucket}/${args.key}`;
  const sig = crypto
    .createHmac('sha1', args.accessKeySecret)
    .update(stringToSign, 'utf8')
    .digest('base64');
  return {
    authorization: `OSS ${args.accessKeyId}:${sig}`,
    stringToSign
  };
}

/* ----------------------- 腾讯 COS helpers ----------------------- */

/**
 * R-45 — Tencent COS signature ("q-sign-algorithm=sha1") for PutObject.
 *
 * Spec: https://cloud.tencent.com/document/product/436/7778
 *
 *   SignKey   = HMAC-SHA1(SecretKey, "q-key-time").hex
 *   FormatString = "put\n/<key>\n\nhost=<host>\n"
 *   StringToSign = "sha1\n<q-sign-time>\nhex(sha1(FormatString))\n"
 *   Signature = HMAC-SHA1(SignKey, StringToSign).hex
 *
 * We hard-code:
 *   - signed-header-list = "host"
 *   - signed-param-list = "" (empty — PutObject has no signed query
 *     params here)
 *
 * Pure function so we can verify byte-exact output against the
 * reference go-sdk in unit tests.
 */
export function buildCosPutSignature(args: {
  secretId: string;
  secretKey: string;
  host: string;
  key: string;
  /** Validity window in seconds, default 600. */
  expiresInSec?: number;
  now?: Date;
}): { authorization: string; signTime: string } {
  const start = Math.floor((args.now ? args.now.getTime() : Date.now()) / 1000);
  const end = start + (args.expiresInSec ?? 600);
  const signTime = `${start};${end}`;
  const signKey = crypto
    .createHmac('sha1', args.secretKey)
    .update(signTime)
    .digest('hex');
  // The "key" in COS signature is path-encoded but slashes are NOT
  // percent-encoded.
  const formatString =
    'put\n/' + args.key + '\n\nhost=' + args.host.toLowerCase() + '\n';
  const httpString =
    'sha1\n' + signTime + '\n' +
    crypto.createHash('sha1').update(formatString).digest('hex') + '\n';
  const signature = crypto
    .createHmac('sha1', signKey)
    .update(httpString)
    .digest('hex');
  const authorization = [
    'q-sign-algorithm=sha1',
    `q-ak=${args.secretId}`,
    `q-sign-time=${signTime}`,
    `q-key-time=${signTime}`,
    'q-header-list=host',
    'q-url-param-list=',
    `q-signature=${signature}`
  ].join('&');
  return { authorization, signTime };
}

/* ----------------------- mime helpers ----------------------- */

/** Basic mime guesser sufficient for the formats this app produces:
 *  gif / webp / mp4 / png / jpg / webm. Fallback is octet-stream. */
export function guessMimeFromName(fileName: string): string {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  switch (ext) {
    case 'gif':  return 'image/gif';
    case 'webp': return 'image/webp';
    case 'mp4':  return 'video/mp4';
    case 'webm': return 'video/webm';
    case 'png':  return 'image/png';
    case 'apng': return 'image/apng';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    default:     return 'application/octet-stream';
  }
}

/* ----------------------- header allowlist ----------------------- */

/**
 * R-45 — strict header allowlist for customWeb backend. Everything else
 * the user types in the UI is dropped silently. Lower-cased compare.
 *
 * Why: a hostile / careless config could otherwise inject Host /
 * Content-Length / Cookie / Authorization-mascarading-as-Authorization
 * headers that bypass the multipart body or hit other origins.
 */
const CUSTOM_WEB_HEADER_ALLOWLIST = new Set<string>([
  'authorization',
  'accept',
  'accept-language'
]);

export function sanitizeCustomWebHeaders(
  raw: Record<string, string> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== 'string' || typeof v !== 'string') continue;
    if (!/^[A-Za-z0-9-]+$/.test(k)) continue;
    const lk = k.toLowerCase();
    const allowed =
      CUSTOM_WEB_HEADER_ALLOWLIST.has(lk) || lk.startsWith('x-');
    if (!allowed) continue;
    if (v.length > 2048) continue;
    if (/[\r\n]/.test(v) || v.includes('\u0000')) continue;
    out[k] = v;
  }
  return out;
}

/* ----------------------- R-46 retry / backoff helpers ----------------------- */

/**
 * R-46 — Compute an exponential-backoff delay for the given retry
 * attempt index (0-based). Caps at `maxMs` and adds full jitter so
 * concurrent jobs that all hit a 429 don't re-fire in lockstep.
 *
 * Pure function for unit-testing; in production callers feed the
 * resulting milliseconds into `setTimeout`.
 */
export function backoffDelayMs(
  attemptIndex: number,
  baseMs = 500,
  maxMs = 8000,
  rand: () => number = Math.random
): number {
  const target = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attemptIndex)));
  // Full jitter, per AWS Architecture Blog "exponential backoff and
  // jitter" recommendation: a random delay in [0, target].
  return Math.floor(rand() * target);
}

/**
 * R-46 — Decide whether a backend error is worth retrying.
 *
 *   - Network errors (no status, ECONNRESET, ETIMEDOUT, etc.)  → retry
 *   - HTTP 5xx                                                 → retry
 *   - HTTP 408 / 425 / 429                                     → retry
 *   - HTTP 4xx (other)                                         → DO NOT retry
 *     (auth / permission / signature / quota — retrying won't help)
 *
 * The string contract is: backends throw "<backend> HTTP <code>: ..."
 * for HTTP failures and "network error: ..." for connection failures
 * (see `call()` in backends.ts). This regex inspection keeps the
 * helper pure (no axios import in the test path).
 */
export function isRetriableUploadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err || '');
  if (!msg) return false;
  if (/network error/i.test(msg)) return true;
  if (/abort|cancelled/i.test(msg)) return false;
  const m = /HTTP\s+(\d{3})/i.exec(msg);
  if (!m) return false;
  const code = Number(m[1]);
  if (code >= 500 && code <= 599) return true;
  if (code === 408 || code === 425 || code === 429) return true;
  return false;
}

/* ----------------------- R-46 markdown format helpers ----------------------- */

/**
 * R-46 — Render an uploaded image link in one of the supported
 * markdown-adjacent formats. The 'markdown' branch reuses the
 * canonical `![alt](url)` builder; the others are direct string
 * builders so a user can paste into wikis / forums / static HTML.
 *
 * Pure; tested against fixed strings in uploaderUtils.test.ts.
 */
export function formatMediaLink(
  fileName: string,
  url: string,
  format: 'markdown' | 'html' | 'bbcode' | 'url',
  altTemplate?: string
): string {
  switch (format) {
    case 'markdown':
      // Defer to buildMarkdown to keep alt-sanitisation centralised.
      return buildMarkdown(fileName, url, altTemplate);
    case 'html': {
      const ext = path.extname(fileName).slice(1).toLowerCase();
      const name = path.basename(fileName, path.extname(fileName));
      const tpl = altTemplate && altTemplate.trim().length > 0 ? altTemplate : '{name}';
      const altRaw = tpl.replace(/\{name\}/g, name).replace(/\{ext\}/g, ext);
      // For HTML, escape quotes / angle brackets / ampersands rather
      // than stripping — closer to how a regular CMS handles alt.
      const alt = altRaw
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      const safeUrl = String(url).replace(/"/g, '&quot;');
      return `<img src="${safeUrl}" alt="${alt}" />`;
    }
    case 'bbcode':
      return `[img]${url}[/img]`;
    case 'url':
    default:
      return url;
  }
}

/* ----------------------- R-46 七牛 region auto-probe ----------------------- */

/**
 * R-46 — Build the public Qiniu UC ("user-center") region-query URL.
 *
 * Endpoint: `https://uc.qbox.me/v3/query?ak={ak}&bucket={bucket}`
 *
 * No secret key is required, so we expose this as a renderer-callable
 * IPC. The response payload contains an `up.acc.main` array with the
 * appropriate upload host for the bucket; once retrieved, the
 * uploader can post directly without the user having to manually pick
 * a region from the dropdown.
 */
export function qiniuRegionQueryUrl(accessKey: string, bucket: string): string {
  if (!accessKey || !bucket) {
    throw new Error('qiniuRegionQueryUrl: accessKey/bucket required');
  }
  return `https://uc.qbox.me/v3/query?ak=${encodeURIComponent(accessKey)}&bucket=${encodeURIComponent(bucket)}`;
}

/**
 * R-46 — Map an arbitrary upload host string returned by the Qiniu UC
 * query to the closest known region literal in our `qiniuUploadHost`
 * lookup table. Returns `undefined` if no rule matches; callers should
 * then fall back to the user's manual region picker.
 */
export function inferQiniuRegionFromUploadHost(host: string): string | undefined {
  if (!host || typeof host !== 'string') return undefined;
  const h = host.toLowerCase();
  if (/upload-z1\./.test(h)) return 'z1';
  if (/upload-z2\./.test(h)) return 'z2';
  if (/upload-na0\./.test(h)) return 'na0';
  if (/upload-as0\./.test(h)) return 'as0';
  if (/upload-cn-east-2\./.test(h)) return 'cn-east-2';
  if (/upload\.qiniup\.com/.test(h)) return 'z0';
  return undefined;
}

/* ----------------------- R-46 1×1 PNG for "test connection" ----------------------- */

/**
 * R-46 — Smallest valid PNG (1×1, single solid pixel). Bytes are
 * exact; emitted by `pngcrush` from a 1px source. We use this as the
 * payload of "测试连接" probes so we exercise the entire signing /
 * multipart / response-parse chain without touching the user's real
 * outputs. 67 bytes total — even GitHub's 1MB Contents API soft
 * threshold won't notice.
 */
export const TINY_PNG_BYTES: Buffer = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
  '0000000d49444154789c63600100000005000165f4e3f60000000049454e44ae426082',
  'hex'
);
