/**
 * R-55 Fix #3 — Offline page import.
 *
 * The user can hand the app a fully-saved web page (or a single media
 * file) and we treat it like a sniff result. This is the "I gave up
 * waiting on Cloudflare / login walls / GFW, just take what I already
 * have on disk" escape hatch for the four online sniff backends.
 *
 * Three input shapes are supported:
 *
 *   1. Single .mhtml / .mht file
 *      RFC 2557 multipart/related archive. We parse the MIME parts,
 *      pull the primary text/html and walk it for <video>/<source>/
 *      <img>/<iframe>, resolving each linked URL against either the
 *      original Content-Location (so external CDN refs survive) or
 *      the matching part inside the same archive (so we can show the
 *      *cached* copy directly via a temp `file://` extraction).
 *
 *   2. Single .html / .htm file (optionally with a sibling `_files/`
 *      directory — the layout used by Chrome's "Webpage, complete"
 *      and Edge's "Save As → Webpage, complete")
 *      We read the .html, treat the file's parent directory as the
 *      base for relative URLs, and emit `file://` URLs for any
 *      references that exist on disk. References that look like
 *      absolute http(s) URLs are kept as-is.
 *
 *   3. Single image / video file
 *      No HTML at all — just synthesise one SniffedMedia from the
 *      file path. This lets the user drop e.g. a downloaded `.mp4`
 *      onto the URL bar and continue straight into the processor.
 *
 * The output mimics `SniffResult` exactly so the renderer's existing
 * grid / selection / batch UI works without a single special case.
 */
import * as cheerio from 'cheerio';
import crypto from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { SniffResult, SniffedMedia, MediaKind, SniffProgress } from '../shared/types';
import { log } from './logger';
import { matchEmbedProvider } from './sniffer';

/**
 * R-56 — Convert an absolute on-disk path into the renderer-displayable
 * `giftk-local://` URL form. The previous R-55 release returned bare
 * `file://` URLs, but Electron's renderer (loaded over
 * http://localhost:5173 in dev / file:// in prod) wouldn't render
 * cross-protocol `<img src="file://…">` tags due to the default
 * webSecurity / CSP policy — every saved-page extract showed up as
 * 「图像加载失败」with empty metadata. The custom giftk-local scheme
 * is registered as `secure + standard + corsEnabled` in main/index.ts
 * so renderer fetches and CSP both treat it like a normal http origin
 * while the main-process protocol handler still re-reads the bytes
 * off the original absolute path.
 *
 * Encoding rules:
 *  - URL-encode each path segment so spaces / unicode / ? round-trip.
 *  - Use `localhost` as host so the URL parses as a standard authority
 *    URL on every platform (Electron's protocol.handle requires this).
 *  - On Windows, prefix the drive letter with `/` to keep the path
 *    absolute when decoded back (`/C:/Users/...`).
 */
function pathToGiftkLocalURL(absPath: string): string {
  const norm = path.resolve(absPath);
  // Split into segments so each one is encoded independently —
  // `encodeURI` would leave `?` and `#` un-escaped, breaking the URL.
  const parts = norm.split(path.sep).map((seg) => encodeURIComponent(seg));
  // On POSIX the leading `/` becomes an empty first segment which we
  // want to preserve; on win32 we add the leading `/` ourselves so
  // `C:` lands as `/C:` after the host.
  const joined = process.platform === 'win32'
    ? '/' + parts.filter(Boolean).join('/')
    : parts.join('/'); // first part is "" for absolute POSIX paths
  return `giftk-local://localhost${joined}`;
}

const VIDEO_EXTS = new Set(['.mp4', '.webm', '.m4v', '.mov', '.mkv']);
const GIF_EXTS = new Set(['.gif']);
const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.avif']);
const HTML_EXTS = new Set(['.html', '.htm']);
const MHTML_EXTS = new Set(['.mhtml', '.mht']);

/**
 * R-56 — Offline import options. The pre-R-56 entry point only
 * received an absolute path; this is now wrapped in an options
 * object so the IPC layer can pipe progress + cancel through.
 *
 *  - `onProgress` is called at meaningful checkpoints (stat,
 *    parse-html, extract-media, finalize). Without it the
 *    renderer was hard-pinning a 50% spinner that looked like
 *    a stalled job for any non-trivial input — the「为什么我
 *    一点它就 60%/卡住」complaint from the R-56 feedback loop.
 *  - `signal` lets the user cancel in-flight (matches the
 *    other four sniff backends).
 *  - `includeStaticImages` — DEFAULT FALSE in R-56. The user's
 *    截图 showed a saved page where every <img> thumbnail
 *    (cover.png, avatar.webp, sprite.jpg, ...) was being treated
 *    like a primary media item, polluting the result grid. GIF
 *    is the project's core scenario and is always kept;
 *    .mp4/.webm/.mov/.mkv/.m4v are always kept; .png/.jpg/.webp
 *    are only included when the caller explicitly opts in.
 */
export interface OfflineImportOptions {
  onProgress?: (p: SniffProgress) => void;
  signal?: AbortSignal;
  /** Default false — R-56 ignored static images by default. */
  includeStaticImages?: boolean;
}

function shortId(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function classifyByExt(p: string): MediaKind | null {
  const ext = path.extname(p).toLowerCase();
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (GIF_EXTS.has(ext)) return 'gif';
  if (IMG_EXTS.has(ext)) return 'image';
  return null;
}

/**
 * Resolve a (possibly relative) src attribute against an offline
 * base directory. Returns:
 *  - http(s)://… untouched (so external CDN refs still flow through
 *    the normal downloader),
 *  - data: URLs untouched (renderer can preview them directly),
 *  - file:// URL when the referenced path exists on disk,
 *  - null otherwise (broken / not-on-disk reference).
 */
function resolveOfflineRef(baseDir: string, raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^data:/i.test(trimmed)) return trimmed;
  if (/^file:\/\//i.test(trimmed)) return trimmed;
  // R-56 — mhtml staging rewrites primary HTML refs to giftk-local://
  // URLs before handing them back to collectFromDom. Pass them through
  // unchanged so the .mhtml flow surfaces the staged resources.
  if (/^giftk-local:\/\//i.test(trimmed)) return trimmed;
  // Strip any URL fragment or query before resolving on disk.
  const noFrag = trimmed.split('#')[0].split('?')[0];
  if (!noFrag) return null;
  // Decode any %20-style escapes so "My Site_files/foo.mp4" works.
  let decoded = noFrag;
  try { decoded = decodeURIComponent(noFrag); } catch { /* keep as-is */ }
  // Reject absolute UNIX / Windows paths — the user's saved-page
  // archive should only ever reference assets relative to itself.
  if (path.isAbsolute(decoded)) return null;
  const resolved = path.resolve(baseDir, decoded);
  if (!resolved.startsWith(path.resolve(baseDir))) return null;
  if (!fs.existsSync(resolved)) return null;
  return pathToGiftkLocalURL(resolved);
}

/**
 * Walk a parsed offline DOM and collect candidate media. Mirrors the
 * five most-useful selectors from sniffer.extractFromHtml but with
 * the offline URL resolver above.
 */
function collectFromDom(
  $: cheerio.CheerioAPI,
  baseDir: string,
  pageUrl: string,
  map: Map<string, SniffedMedia>,
  includeStaticImages: boolean
): string | undefined {
  const title = $('title').first().text().trim() || undefined;

  const push = (m: SniffedMedia): void => {
    if (!map.has(m.url)) map.set(m.url, m);
  };

  $('video').each((_, el) => {
    const $el = $(el);
    const poster = resolveOfflineRef(baseDir, $el.attr('poster') || '') || undefined;
    const direct = $el.attr('src');
    if (direct) {
      const u = resolveOfflineRef(baseDir, direct);
      if (u) push({ id: shortId(u), url: u, kind: 'video', source: 'video-tag', poster, pageUrl });
    }
    $el.find('source').each((__, s) => {
      const sSrc = $(s).attr('src');
      if (!sSrc) return;
      const u = resolveOfflineRef(baseDir, sSrc);
      if (!u) return;
      push({
        id: shortId(u),
        url: u,
        kind: 'video',
        mime: $(s).attr('type') || undefined,
        source: 'source-tag',
        poster,
        pageUrl
      });
    });
  });

  // R-56 Fix #D — <img> sweep is filtered. GIF is always kept (the
  // project's core scenario). Static images (.png/.jpg/.webp/.bmp/.avif)
  // are only kept when the caller explicitly opts in via
  // OfflineImportOptions.includeStaticImages. Without this filter, every
  // saved page bled its thumbnails / avatars / sprite-sheets into the
  // result grid as un-extractable file:// rows — exactly the screenshot
  // the user attached on the R-56 feedback round.
  $('img').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-original');
    if (!src) return;
    const u = resolveOfflineRef(baseDir, src);
    if (!u) return;
    const ext = path.extname(u.split('?')[0]).toLowerCase();
    const isGif = GIF_EXTS.has(ext);
    if (!isGif && !includeStaticImages) return;
    const kind: MediaKind = isGif ? 'gif' : 'image';
    push({ id: shortId(u), url: u, kind, source: 'img-tag', pageUrl });
  });

  // Open Graph fallback (often the only signal on SPA-saved pages).
  const ogVideo = $('meta[property="og:video"], meta[property="og:video:url"]').attr('content');
  if (ogVideo) {
    const u = resolveOfflineRef(baseDir, ogVideo);
    if (u) push({ id: shortId(u), url: u, kind: 'video', source: 'og-meta', pageUrl });
  }
  // og:image is also gated by includeStaticImages — except GIFs, which
  // we always keep regardless.
  const ogImage = $('meta[property="og:image"]').attr('content');
  if (ogImage) {
    const u = resolveOfflineRef(baseDir, ogImage);
    if (u) {
      const ext = path.extname(u.split('?')[0]).toLowerCase();
      const isGif = GIF_EXTS.has(ext);
      if (isGif || includeStaticImages) {
        const kind: MediaKind = isGif ? 'gif' : 'image';
        push({ id: shortId(u), url: u, kind, source: 'og-meta', pageUrl });
      }
    }
  }

  // R-60 — <iframe> sweep for known video-embed providers (YouTube,
  // Vimeo, Bilibili, Dailymotion, Wistia, Brightcove, Streamable, TED).
  // The user's R-60 feedback was: "为什么 mhtml 里面有 iframe 视频会
  // 识别不到,你底层嗅探逻辑难道不是多个入口公用吗?" — and they were
  // right.  The online sniffer in sniffer.ts has had iframe-embed
  // extraction since R-50, but the offline / mhtml path was carrying
  // its own hand-written DOM walker that only knew <video>/<source>/
  // <img>/og:*. We now reuse `matchEmbedProvider` from sniffer.ts so
  // the recognition rules can never drift between the two entry points
  // (online live page sniff and offline mhtml import).
  //
  // Important: iframe URLs are absolute (the embed always points at
  // youtube.com / vimeo.com / etc.), so we deliberately do NOT pipe
  // them through resolveOfflineRef — that helper rewrites to local
  // file:// for siblings inside the saved bundle, which would break
  // the embed.  We just normalise relative-to-absolute via URL().
  $('iframe').each((_, el) => {
    const $el = $(el);
    const rawSrc =
      $el.attr('src') || $el.attr('data-src') || $el.attr('data-lazy-src') || '';
    if (!rawSrc) return;
    let absUrl: string;
    try {
      absUrl = new URL(rawSrc, pageUrl).toString();
    } catch {
      return;
    }
    let host: string;
    try {
      host = new URL(absUrl).hostname.toLowerCase();
    } catch {
      return;
    }
    const provider = matchEmbedProvider(host, absUrl);
    if (!provider) return;
    push({
      id: shortId(absUrl),
      url: absUrl,
      kind: 'video',
      source: 'iframe-embed',
      pageUrl,
      requiresExternalDownload: true,
      embedHost: provider
    });
  });

  return title;
}

/**
 * Single-file path: emit one synthesised SniffedMedia and call it a
 * day. We still wrap it in a SniffResult so the renderer doesn't need
 * a separate code path.
 */
function importSingleMediaFile(absPath: string): SniffResult {
  const kind = classifyByExt(absPath);
  if (!kind) {
    throw new Error(`不支持的离线媒体扩展名: ${path.extname(absPath)}`);
  }
  const url = pathToGiftkLocalURL(absPath);
  let sizeBytes: number | undefined;
  try { sizeBytes = fs.statSync(absPath).size; } catch { /* ignore */ }
  const item: SniffedMedia = {
    id: shortId(url),
    url,
    kind,
    sizeBytes,
    source: kind === 'image' || kind === 'gif' ? 'img-tag' : 'video-tag',
    pageUrl: url
  };
  return {
    pageUrl: url,
    title: path.basename(absPath),
    items: [item],
    warnings: []
  };
}

/**
 * Imports a Chrome / Edge "Webpage, complete" save (.html + sibling
 * `_files/` dir) OR any standalone .html file.
 */
function importHtmlFile(absHtmlPath: string, opts: OfflineImportOptions): SniffResult {
  const baseDir = path.dirname(absHtmlPath);
  opts.onProgress?.({ stage: 'parsing', percent: 30, message: '读取 HTML…' });
  const html = fs.readFileSync(absHtmlPath, 'utf8');
  if (opts.signal?.aborted) throw new Error('已取消离线导入');
  opts.onProgress?.({ stage: 'parsing', percent: 55, message: '解析 DOM…' });
  const $ = cheerio.load(html);
  const pageUrl = pathToGiftkLocalURL(absHtmlPath);
  const map = new Map<string, SniffedMedia>();
  opts.onProgress?.({ stage: 'parsing', percent: 75, message: '抽取媒体引用…' });
  const title = collectFromDom($, baseDir, pageUrl, map, opts.includeStaticImages ?? false);
  const warnings: string[] = [];
  if (map.size === 0) {
    warnings.push(
      '页面里没有找到 <video>/og:video/og:image(GIF)/已知第三方 embed iframe(YouTube/Vimeo/Bilibili 等)引用,' +
      '或者引用的本地文件不存在。如果你保存的是 SPA(微博、Twitter 等),' +
      '请改用 .mhtml 或在浏览器里点击「另存为 → 网页,完整」获得完整的 _files 目录。' +
      ' 默认会过滤静态图像(png/jpg/webp);如果你希望也包含它们,请使用「包含静态图像」选项。'
    );
  }
  return {
    pageUrl,
    title,
    items: Array.from(map.values()),
    warnings
  };
}

/**
 * Minimal RFC 2557 / 2822 parser for .mhtml. Chrome / Edge / Safari
 * all emit single-part-per-resource archives with clean
 * `Content-Type` and `Content-Location` headers, so we don't need
 * full RFC compliance — just enough to pull each resource into a
 * temp folder and let the same offline-HTML extractor walk it.
 */
function importMhtmlFile(absPath: string, opts: OfflineImportOptions): SniffResult {
  opts.onProgress?.({ stage: 'parsing', percent: 15, message: '读取 mhtml 归档…' });
  const raw = fs.readFileSync(absPath);
  if (opts.signal?.aborted) throw new Error('已取消离线导入');
  // Outer headers end at the first blank line.
  const headEnd = findHeaderTerminator(raw, 0);
  if (headEnd < 0) throw new Error('mhtml 文件缺少头部分隔符,无法解析');
  const headers = parseHeaders(raw.subarray(0, headEnd).toString('utf8'));
  const boundary = extractBoundary(headers.get('content-type') || '');
  if (!boundary) throw new Error('mhtml Content-Type 缺少 multipart/related 的 boundary 参数');
  const delim = Buffer.from(`--${boundary}`);
  const closing = Buffer.from(`--${boundary}--`);

  const partOffsets: number[] = [];
  let cursor = headEnd + 4;
  while (cursor < raw.length) {
    const idx = raw.indexOf(delim, cursor);
    if (idx < 0) break;
    partOffsets.push(idx);
    cursor = idx + delim.length;
  }
  if (partOffsets.length < 2) {
    throw new Error('mhtml 解析失败:未找到任何 multipart/related part');
  }
  opts.onProgress?.({
    stage: 'parsing',
    percent: 25,
    message: `定位到 ${partOffsets.length} 个 multipart 段,开始落盘…`,
    total: partOffsets.length
  });

  // Stage every part into a temp dir keyed by its Content-Location so
  // relative-href resolution (collectFromDom) sees real files on disk.
  const stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'giftk-mhtml-'));
  let primaryHtmlPath: string | null = null;
  let primaryHtmlOrigin: string | undefined;
  const locToFile = new Map<string, string>();

  for (let i = 0; i < partOffsets.length - 1; i += 1) {
    if (opts.signal?.aborted) throw new Error('已取消离线导入');
    const start = partOffsets[i] + delim.length;
    const end = partOffsets[i + 1];
    if (start >= end) continue;
    // Skip CRLF after boundary.
    let bodyStart = start;
    if (raw[bodyStart] === 0x0d && raw[bodyStart + 1] === 0x0a) bodyStart += 2;
    if (raw[bodyStart] === 0x0a) bodyStart += 1;
    const partHeadEnd = findHeaderTerminator(raw, bodyStart);
    if (partHeadEnd < 0 || partHeadEnd >= end) continue;
    const partHeaders = parseHeaders(raw.subarray(bodyStart, partHeadEnd).toString('utf8'));
    const ctype = (partHeaders.get('content-type') || '').toLowerCase();
    const cenc = (partHeaders.get('content-transfer-encoding') || '').toLowerCase();
    const cloc = partHeaders.get('content-location') || '';
    const bodyRaw = raw.subarray(partHeadEnd + 4, end);
    let decoded: Buffer;
    if (cenc === 'base64') {
      decoded = Buffer.from(bodyRaw.toString('ascii').replace(/\s+/g, ''), 'base64');
    } else if (cenc === 'quoted-printable') {
      decoded = decodeQuotedPrintable(bodyRaw.toString('utf8'));
    } else {
      decoded = bodyRaw;
    }
    // Pick a stable on-disk filename: hash of Content-Location + the
    // best-guess extension. Avoids path traversal entirely.
    const ext = guessExtFromMime(ctype) || extFromUrlPath(cloc) || '.bin';
    const fileName = `${shortId(cloc || `${i}`)}${ext}`;
    const destPath = path.join(stagedDir, fileName);
    fs.writeFileSync(destPath, decoded);
    if (cloc) locToFile.set(cloc, destPath);
    if (!primaryHtmlPath && ctype.startsWith('text/html')) {
      primaryHtmlPath = destPath;
      primaryHtmlOrigin = cloc || undefined;
    }
    if (raw.indexOf(closing, end) === end) break;
    if ((i & 0x07) === 0) {
      // Emit a progress tick every 8 parts so big archives (Twitter
      // threads with 200+ media) still feel responsive without
      // flooding the IPC channel.
      const pct = 25 + Math.round((i / partOffsets.length) * 35);
      opts.onProgress?.({
        stage: 'parsing',
        percent: pct,
        message: `落盘资源 ${i + 1}/${partOffsets.length}…`,
        probed: i + 1,
        total: partOffsets.length
      });
    }
  }

  if (!primaryHtmlPath) {
    throw new Error('mhtml 里没有找到主 text/html 部分');
  }

  // Rewrite the primary HTML so all links resolve to staged files.
  opts.onProgress?.({ stage: 'parsing', percent: 70, message: '重写 HTML 引用…' });
  const primaryHtml = fs.readFileSync(primaryHtmlPath, 'utf8');
  const $ = cheerio.load(primaryHtml);

  const rewriteAttr = (sel: string, attr: string): void => {
    $(sel).each((_, el) => {
      const v = $(el).attr(attr);
      if (!v) return;
      // Resolve against original page origin first (so absolute hrefs
      // inside the saved DOM line up with the right Content-Location),
      // then fall back to as-is keyed lookup.
      let key = v;
      if (primaryHtmlOrigin) {
        try { key = new URL(v, primaryHtmlOrigin).toString(); } catch { /* ignore */ }
      }
      const staged = locToFile.get(key) || locToFile.get(v);
      if (staged) {
        $(el).attr(attr, pathToGiftkLocalURL(staged));
      }
    });
  };
  rewriteAttr('video', 'src');
  rewriteAttr('video', 'poster');
  rewriteAttr('source', 'src');
  rewriteAttr('img', 'src');
  rewriteAttr('img', 'data-src');
  rewriteAttr('img', 'data-original');
  rewriteAttr('meta[property="og:video"]', 'content');
  rewriteAttr('meta[property="og:video:url"]', 'content');
  rewriteAttr('meta[property="og:image"]', 'content');

  if (opts.signal?.aborted) throw new Error('已取消离线导入');
  opts.onProgress?.({ stage: 'parsing', percent: 85, message: '抽取媒体引用…' });
  const map = new Map<string, SniffedMedia>();
  const pageUrl = primaryHtmlOrigin || pathToGiftkLocalURL(absPath);
  // baseDir is stagedDir because we rewrote relative refs to absolute
  // file:// URLs above; the resolver will short-circuit on those.
  const title = collectFromDom($, stagedDir, pageUrl, map, opts.includeStaticImages ?? false);
  const warnings: string[] = [];
  if (map.size === 0) {
    warnings.push(
      'mhtml 解析成功,但里面没有找到 <video>/og:video/og:image(GIF)/已知第三方 embed iframe(YouTube/Vimeo/Bilibili 等)。' +
      ' 默认会过滤静态图像(png/jpg/webp);如果你希望也包含它们,请使用「包含静态图像」选项。'
    );
  }
  return {
    pageUrl,
    title,
    items: Array.from(map.values()),
    warnings
  };
}

function findHeaderTerminator(buf: Buffer, from: number): number {
  // Both \r\n\r\n and \n\n are tolerated; we standardise on \r\n\r\n
  // (return index of the first \r). For \n\n we return -1 only if
  // neither is present.
  const crlf = buf.indexOf(Buffer.from('\r\n\r\n'), from);
  if (crlf >= 0) return crlf;
  const lf = buf.indexOf(Buffer.from('\n\n'), from);
  if (lf >= 0) return lf - 2; // pretend the missing \r was there so headEnd+4 still works
  return -1;
}

function parseHeaders(text: string): Map<string, string> {
  const out = new Map<string, string>();
  // Continuation lines: lines beginning with whitespace fold into the
  // previous header value (RFC 2822 §2.2.3).
  const lines = text.split(/\r?\n/);
  let lastKey: string | null = null;
  for (const line of lines) {
    if (!line) continue;
    if (/^\s/.test(line) && lastKey) {
      out.set(lastKey, `${out.get(lastKey)} ${line.trim()}`);
      continue;
    }
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase();
    out.set(k, m[2]);
    lastKey = k;
  }
  return out;
}

function extractBoundary(contentType: string): string | null {
  const m = contentType.match(/boundary\s*=\s*"?([^";]+)"?/i);
  return m ? m[1].trim() : null;
}

function decodeQuotedPrintable(s: string): Buffer {
  // Drop soft line breaks (= at end of line), then decode =XX hex.
  const collapsed = s.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < collapsed.length; i += 1) {
    const ch = collapsed.charCodeAt(i);
    if (ch === 0x3d /* '=' */ && i + 2 < collapsed.length) {
      const hex = collapsed.slice(i + 1, i + 3);
      const v = parseInt(hex, 16);
      if (!Number.isNaN(v)) {
        bytes.push(v);
        i += 2;
        continue;
      }
    }
    bytes.push(ch);
  }
  return Buffer.from(bytes);
}

function guessExtFromMime(mime: string): string | null {
  const m = mime.toLowerCase();
  if (m.startsWith('text/html')) return '.html';
  if (m.startsWith('image/jpeg')) return '.jpg';
  if (m.startsWith('image/png')) return '.png';
  if (m.startsWith('image/webp')) return '.webp';
  if (m.startsWith('image/gif')) return '.gif';
  if (m.startsWith('video/mp4')) return '.mp4';
  if (m.startsWith('video/webm')) return '.webm';
  return null;
}

function extFromUrlPath(u: string): string | null {
  try {
    const ext = path.extname(new URL(u).pathname).toLowerCase();
    return ext || null;
  } catch {
    const ext = path.extname(u.split('?')[0]).toLowerCase();
    return ext || null;
  }
}

/**
 * Public entry — picks the right strategy based on the path's stat.
 * Throws on unsupported inputs so the IPC layer can surface a clear
 * error to the renderer.
 *
 * R-56 — `opts` carries `onProgress`/`signal`/`includeStaticImages`.
 * The IPC handler in main/index.ts forwards SniffProgress events
 * over the same `sniff:progress` channel the four online sniff
 * backends use, so the renderer's existing spinner / log line work
 * unchanged.
 */
export async function importOfflinePath(
  absPath: string,
  opts: OfflineImportOptions = {}
): Promise<SniffResult> {
  log(`offline import: ${absPath}`);
  opts.onProgress?.({ stage: 'fetching', percent: 5, message: '检查输入路径…' });
  let st;
  try {
    st = await fsp.stat(absPath);
  } catch (e) {
    throw new Error(`无法访问文件: ${(e as Error).message}`);
  }
  if (opts.signal?.aborted) throw new Error('已取消离线导入');
  if (st.isDirectory()) {
    opts.onProgress?.({ stage: 'parsing', percent: 12, message: '扫描目录里的 .html / .htm…' });
    // Directory: scan for the first .html / .htm at the top level
    // and treat the directory as its base.
    const entries = await fsp.readdir(absPath);
    const htmlEntry = entries.find((e) => HTML_EXTS.has(path.extname(e).toLowerCase()));
    if (!htmlEntry) {
      throw new Error('目录里没有 .html / .htm 文件,无法识别为「网页完整目录」');
    }
    const r = importHtmlFile(path.join(absPath, htmlEntry), opts);
    opts.onProgress?.({ stage: 'done', percent: 100, found: r.items.length });
    return r;
  }
  const ext = path.extname(absPath).toLowerCase();
  let r: SniffResult;
  if (MHTML_EXTS.has(ext)) {
    r = importMhtmlFile(absPath, opts);
  } else if (HTML_EXTS.has(ext)) {
    r = importHtmlFile(absPath, opts);
  } else if (classifyByExt(absPath)) {
    opts.onProgress?.({ stage: 'parsing', percent: 60, message: '识别为单一媒体文件,直接合成结果…' });
    r = importSingleMediaFile(absPath);
  } else {
    throw new Error(`不支持的离线导入类型: ${ext || '(无扩展名)'}`);
  }
  opts.onProgress?.({ stage: 'done', percent: 100, found: r.items.length });
  return r;
}
