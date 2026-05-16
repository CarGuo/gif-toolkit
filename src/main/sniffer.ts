import axios, { isAxiosError } from 'axios';
import * as cheerio from 'cheerio';
import crypto from 'crypto';
import PQueue from 'p-queue';
import { URL } from 'url';
import type { SniffResult, SniffedMedia, MediaKind, SniffProgress } from '../shared/types';
import { log } from './logger';
import { isPrivateHost } from './helpers';
import { fetchRenderedDom } from './headlessFetch';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const VIDEO_EXT = ['.mp4', '.webm', '.m4v', '.mov', '.mkv'];
const GIF_EXT = ['.gif'];
const IMG_EXT = ['.png', '.jpg', '.jpeg', '.webp'];

const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_ITEMS = 200;

function id(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function abs(base: string, link: string): string | null {
  if (!link) return null;
  try {
    const u = new URL(link, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function classifyByExt(url: string): MediaKind | null {
  const lower = url.split('?')[0].toLowerCase();
  if (VIDEO_EXT.some((e) => lower.endsWith(e))) return 'video';
  if (GIF_EXT.some((e) => lower.endsWith(e))) return 'gif';
  if (IMG_EXT.some((e) => lower.endsWith(e))) return 'image';
  return null;
}

/**
 * Match well-known video-embed iframe sources by host (and optionally a path
 * sanity check). Returns a normalised provider host, or null if not a player.
 *
 * We only flag iframes whose URL clearly identifies the player endpoint
 * (e.g. `player.vimeo.com/video/<id>`, `youtube.com/embed/<id>`); a random
 * `<iframe src="https://example.com/foo">` is not enough.
 */
interface EmbedRule {
  hostSuffix: string;
  needsPath?: string;
  provider: string;
  // Optional explicit regex used for the static-HTML scan (rule 8). When
  // omitted, a default regex is auto-derived from hostSuffix + needsPath
  // so that EMBED_PATTERNS and EMBED_RULES cannot drift out of sync.
  pattern?: RegExp;
}

const EMBED_RULES: EmbedRule[] = [
  { hostSuffix: 'player.vimeo.com', needsPath: '/video/', provider: 'vimeo.com',
    pattern: /https?:(?:\\?\/){2}player\.vimeo\.com(?:\\?\/)video(?:\\?\/)\d+(?:[?][^\s"'<>]*)?/gi },
  { hostSuffix: 'vimeo.com', needsPath: '/video/', provider: 'vimeo.com',
    pattern: /https?:(?:\\?\/){2}vimeo\.com(?:\\?\/)video(?:\\?\/)\d+(?:[?][^\s"'<>]*)?/gi },
  { hostSuffix: 'youtube.com', needsPath: '/embed/', provider: 'youtube.com',
    pattern: /https?:(?:\\?\/){2}(?:www\.)?youtube\.com(?:\\?\/)embed(?:\\?\/)[A-Za-z0-9_-]+(?:[?][^\s"'<>]*)?/gi },
  { hostSuffix: 'youtube-nocookie.com', needsPath: '/embed/', provider: 'youtube.com',
    pattern: /https?:(?:\\?\/){2}(?:www\.)?youtube-nocookie\.com(?:\\?\/)embed(?:\\?\/)[A-Za-z0-9_-]+(?:[?][^\s"'<>]*)?/gi },
  { hostSuffix: 'youtu.be', provider: 'youtube.com',
    pattern: /https?:(?:\\?\/){2}youtu\.be(?:\\?\/)[A-Za-z0-9_-]+(?:[?][^\s"'<>]*)?/gi },
  { hostSuffix: 'player.bilibili.com', provider: 'bilibili.com',
    pattern: /https?:(?:\\?\/){2}player\.bilibili\.com(?:\\?\/)player\.html[^\s"'<>]*/gi },
  { hostSuffix: 'bilibili.com', needsPath: '/player', provider: 'bilibili.com',
    pattern: /https?:(?:\\?\/){2}(?:www\.)?bilibili\.com(?:\\?\/)player[^\s"'<>]*/gi },
  { hostSuffix: 'dailymotion.com', needsPath: '/embed/', provider: 'dailymotion.com',
    pattern: /https?:(?:\\?\/){2}(?:www\.)?dailymotion\.com(?:\\?\/)embed(?:\\?\/)video(?:\\?\/)[A-Za-z0-9]+/gi },
  { hostSuffix: 'fast.wistia.net', provider: 'wistia.com',
    pattern: /https?:(?:\\?\/){2}fast\.wistia\.net(?:\\?\/)embed(?:\\?\/)iframe(?:\\?\/)[A-Za-z0-9]+/gi },
  { hostSuffix: 'wistia.com', needsPath: '/embed/', provider: 'wistia.com',
    pattern: /https?:(?:\\?\/){2}(?:[a-z0-9.-]+\.)?wistia\.com(?:\\?\/)embed(?:\\?\/)[^\s"'<>]+/gi },
  { hostSuffix: 'players.brightcove.net', provider: 'brightcove.com',
    pattern: /https?:(?:\\?\/){2}players\.brightcove\.net(?:\\?\/)\d+[^\s"'<>]*/gi },
  { hostSuffix: 'streamable.com', needsPath: '/o/', provider: 'streamable.com',
    pattern: /https?:(?:\\?\/){2}streamable\.com(?:\\?\/)o(?:\\?\/)[A-Za-z0-9]+/gi },
  { hostSuffix: 'streamable.com', needsPath: '/e/', provider: 'streamable.com',
    pattern: /https?:(?:\\?\/){2}streamable\.com(?:\\?\/)e(?:\\?\/)[A-Za-z0-9]+/gi },
  { hostSuffix: 'embed.ted.com', provider: 'ted.com',
    pattern: /https?:(?:\\?\/){2}embed\.ted\.com(?:\\?\/)[^\s"'<>]+/gi },
  { hostSuffix: 'video.twimg.com', provider: 'twitter.com',
    pattern: /https?:(?:\\?\/){2}video\.twimg\.com(?:\\?\/)[^\s"'<>]+/gi }
];

function matchEmbedProvider(host: string, fullUrl: string): string | null {
  const lowerUrl = fullUrl.toLowerCase();
  for (const r of EMBED_RULES) {
    if (host === r.hostSuffix || host.endsWith('.' + r.hostSuffix)) {
      if (!r.needsPath) return r.provider;
      if (lowerUrl.includes(r.needsPath)) return r.provider;
    }
  }
  return null;
}

/**
 * Build a dedup key that treats two URLs as equal when they differ only in
 * "presentation transforms" (size / crop / quality / format hints) of the
 * same underlying asset.
 *
 * Design goal: be CDN-agnostic. We do NOT hard-code host whitelists. Instead
 * we recognise *structural* patterns that virtually all CDNs and CMSes use
 * to express transforms:
 *
 *   1) Whole path segment is a transform expression
 *      - Blogger / Photos:        `s1600`, `s16000`, `w640-h640`, `h480-w800`
 *      - Cloudinary / similar:    `c_fill,w_300,h_300`, `q_auto`, `f_auto`,
 *                                 `w_800`, `h_600`
 *      - Semantic size buckets:   `thumb`, `thumbnail`, `thumbs`,
 *                                 `max`, `resize`, `fit`, `fit-in`,
 *                                 `crop`, `scale`
 *      - A pure-number segment immediately after a sizing keyword
 *        (e.g. Medium `/max/800/foo.png` → drop both `max` and `800`).
 *
 *   2) Segment-tail transform suffix
 *      - googleusercontent style: `…CCC=s2048`, `…=w1024-h768`
 *      - Twitter pbs style:       `…ABCDEFG.jpg:large`, `:orig`, `:small`
 *
 *   3) Filename-embedded size hints
 *      - WordPress / generic:     `foo-1024x768.jpg`, `foo_1024x768.jpg`
 *      - Shopify:                 `shoe_300x.jpg`, `shoe_300x300.jpg`
 *      - Wikipedia thumb:         `800px-Foo.jpg` → strip the prefix and
 *        also collapse the `/thumb/.../` directory pair.
 *      - Generic numeric suffix:  `foo@2x.png`, `foo-large.jpg`
 *
 *   4) Extension family normalisation: `.jpeg` ≡ `.jpg`.
 *
 *   5) Query string is dropped entirely (signed tokens, cache busters,
 *      transform query keys like imgix `?w=300`, Squarespace `?format=2500w`,
 *      Twitter `?name=large` all collapse here).
 *
 * Edge cases (accepted, by user request):
 *   - A real path like `/users/s1234/avatar.png` will lose `s1234` even
 *     though here it is a user-id bucket, not a size. False merge.
 *   - A real CMS path like `/issue/s12/cover.jpg` likewise. False merge.
 *   These are inherent ambiguities of the URL string alone and are
 *   accepted as a trade-off for a single, structural, host-independent
 *   rule set.
 */

// Whole-segment patterns
const SEG_BLOGGER_RX = /^(?:s\d{2,5}|w\d{2,5}(?:-h\d{2,5})?|h\d{2,5}(?:-w\d{2,5})?)$/i;
const SEG_CLOUDINARY_RX = /^(?:[a-z]_[\w.-]+(?:,[a-z]_[\w.-]+)*)$/i;
const CLOUDINARY_KEYS = /(?:^|,)(?:w|h|c|q|f|x|y|r|e|g|dpr|ar|fl|so|du|eo|l|t|b|co|bo|o|a|z|pg)_/i;
const SEG_SEMANTIC_RX = /^(?:thumb|thumbs|thumbnail|thumbnails|max|resize|fit|fit-in|crop|scale|small|medium|large|original|orig)$/i;
const SEG_NUMERIC_RX = /^\d{2,5}$/;

// Segment-tail transform suffixes
const TAIL_GOOG_RX = /=(?:s\d{2,5}|w\d{2,5}(?:-h\d{2,5})?|h\d{2,5})(?:-[a-z0-9]+)?$/i;
const TAIL_COLON_RX = /:(?:large|orig|original|small|medium|thumb|thumbnail)$/i;

// Filename transforms
const FN_WIKI_PX_RX = /^\d{2,5}px-/i;
const FN_NXN_RX = /[-_]\d{2,5}x\d{0,5}(?=\.[a-z0-9]+$)/i;
const FN_AT_X_RX = /@\d(?:\.\d)?x(?=\.[a-z0-9]+$)/i;
const FN_SEMANTIC_RX = /[-_](?:thumb|thumbnail|small|medium|large|orig|original)(?=\.[a-z0-9]+$)/i;

const EXT_FAMILY: Record<string, string> = { '.jpeg': '.jpg' };

function normaliseFilename(name: string): string {
  let n = name;
  // Wikipedia thumb: `800px-Foo.jpg` → `Foo.jpg`
  n = n.replace(FN_WIKI_PX_RX, '');
  // `foo-1024x768.jpg` / `foo_300x.jpg` / `foo-300x300.jpg`
  n = n.replace(FN_NXN_RX, '');
  // `foo@2x.png`
  n = n.replace(FN_AT_X_RX, '');
  // `foo-large.jpg` / `foo_thumb.png`
  n = n.replace(FN_SEMANTIC_RX, '');
  // jpeg → jpg
  const dot = n.lastIndexOf('.');
  if (dot >= 0) {
    const ext = n.slice(dot).toLowerCase();
    if (EXT_FAMILY[ext]) n = n.slice(0, dot) + EXT_FAMILY[ext];
  }
  return n;
}

function stripSegmentTail(seg: string): string {
  let s = seg;
  s = s.replace(TAIL_GOOG_RX, '');
  s = s.replace(TAIL_COLON_RX, '');
  return s;
}

function isTransformSegment(seg: string): boolean {
  if (!seg) return false;
  if (SEG_BLOGGER_RX.test(seg)) return true;
  if (SEG_CLOUDINARY_RX.test(seg) && CLOUDINARY_KEYS.test(',' + seg)) return true;
  if (SEG_SEMANTIC_RX.test(seg)) return true;
  return false;
}

function dedupKey(url: string): string {
  try {
    const u = new URL(url);
    const rawSegs = u.pathname.split('/');
    const segs: string[] = [];
    let prevWasSizingKeyword = false;
    for (let i = 0; i < rawSegs.length; i += 1) {
      let seg = rawSegs[i];
      if (i === rawSegs.length - 1 && seg) {
        seg = stripSegmentTail(seg);
        seg = normaliseFilename(seg);
      } else {
        seg = stripSegmentTail(seg);
      }
      if (!seg) {
        prevWasSizingKeyword = false;
        continue;
      }
      // Drop pure-number segment that follows a sizing keyword (Medium `/max/800/`)
      if (prevWasSizingKeyword && SEG_NUMERIC_RX.test(seg)) {
        prevWasSizingKeyword = false;
        continue;
      }
      if (isTransformSegment(seg)) {
        prevWasSizingKeyword = SEG_SEMANTIC_RX.test(seg);
        continue;
      }
      prevWasSizingKeyword = false;
      segs.push(seg);
    }
    // Collapse trailing duplicated leaf (Wikipedia thumb pattern: `/a/ab/Foo.jpg/Foo.jpg`
    // — after dropping the `thumb` directory, the original filename appears twice).
    if (segs.length >= 2 && segs[segs.length - 1] === segs[segs.length - 2]) {
      segs.pop();
    }
    return `${u.host.toLowerCase()}/${segs.join('/')}`;
  } catch {
    return url;
  }
}

/**
 * Score a candidate variant. Higher = preferred when two URLs collide on
 * dedupKey. We prefer (in order):
 *   - URLs that already carry HEAD-probed metadata (size / mime / poster)
 *   - URLs whose path segments express a larger size hint
 *   - URLs that are NOT obvious thumbnails / small variants
 */
function variantScore(x: SniffedMedia): number {
  let s = 0;
  if (x.sizeBytes && x.sizeBytes > 0) s += 4;
  if (x.mime) s += 1;
  if (x.poster) s += 1;
  try {
    const u = new URL(x.url);
    let maxDim = 0;
    let demote = 0;
    for (const seg of u.pathname.split('/')) {
      if (!seg) continue;
      // Blogger / Photos size segment
      const m1 = /^(?:s|w|h)(\d{2,5})(?:-(?:w|h)(\d{2,5}))?$/i.exec(seg);
      if (m1) {
        const a = Number(m1[1]) || 0;
        const b = Number(m1[2]) || 0;
        maxDim = Math.max(maxDim, a, b);
      }
      // Cloudinary `w_800`
      const m2 = /(?:^|,)(?:w|h)_(\d{2,5})/i.exec(seg);
      if (m2) maxDim = Math.max(maxDim, Number(m2[1]) || 0);
      // Trailing `=s2048` etc on segment tail
      const m3 = /=(?:s|w|h)(\d{2,5})/i.exec(seg);
      if (m3) maxDim = Math.max(maxDim, Number(m3[1]) || 0);
      // `:large`/`:orig` are "big" hints
      if (/:(?:large|orig|original)$/i.test(seg)) maxDim = Math.max(maxDim, 1600);
      if (/:(?:small|thumb|thumbnail)$/i.test(seg)) demote += 2;
      // semantic size words
      if (/^(?:thumb|thumbs|thumbnail|thumbnails|small)$/i.test(seg)) demote += 2;
      if (/^(?:large|original|orig)$/i.test(seg)) maxDim = Math.max(maxDim, 1600);
      // filename `-1024x768`
      const m4 = /[-_](\d{2,5})x(\d{0,5})(?=\.[a-z0-9]+$)/i.exec(seg);
      if (m4) maxDim = Math.max(maxDim, Number(m4[1]) || 0, Number(m4[2]) || 0);
      // filename `800px-Foo.jpg`
      const m5 = /^(\d{2,5})px-/i.exec(seg);
      if (m5) maxDim = Math.max(maxDim, Number(m5[1]) || 0);
    }
    if (maxDim > 0) s += Math.min(5, Math.floor(maxDim / 400));
    s -= Math.min(4, demote);
  } catch {
    // ignore
  }
  return s;
}

function pushUnique(map: Map<string, SniffedMedia>, m: SniffedMedia): void {
  if (map.size >= MAX_ITEMS) return;
  const key = dedupKey(m.url);
  const existing = map.get(key);
  if (!existing) {
    map.set(key, m);
    return;
  }
  if (variantScore(m) > variantScore(existing)) {
    // Keep the original id so renderer references stay stable across repeated sniffs.
    map.set(key, { ...m, id: existing.id });
  }
}

function isCancelLikeError(e: unknown): boolean {
  if (!e) return false;
  if (isAxiosError(e)) {
    if (e.code === 'ERR_CANCELED' || e.code === 'ECONNABORTED') return true;
    const msg = (e.message || '').toLowerCase();
    if (msg.includes('canceled') || msg.includes('cancelled') || msg.includes('aborted')) return true;
  }
  if (e instanceof Error) {
    if (e.name === 'CanceledError' || e.name === 'AbortError' || e.name === 'CancelledError') return true;
    const msg = (e.message || '').toLowerCase();
    if (msg === 'canceled' || msg === 'cancelled' || msg === 'aborted') return true;
  }
  return false;
}

/**
 * Stream-fetch HTML with a hard byte cap. Aborts mid-flight when the cap is hit.
 */
async function fetchHtmlStreamed(
  pageUrl: string,
  maxBytes: number,
  emit: (p: SniffProgress) => void,
  signal?: AbortSignal
): Promise<string> {
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) {
      const e = new Error('cancelled');
      e.name = 'CancelledError';
      throw e;
    }
    const onAbort = () => {
      try { controller.abort(); } catch { /* ignore */ }
    };
    signal.addEventListener('abort', onAbort, { once: true });
  }
  emit({ stage: 'fetching', percent: 5, message: '请求文章 HTML…' });
  const res = await axios.get<NodeJS.ReadableStream>(pageUrl, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    responseType: 'stream',
    timeout: 20000,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
    signal: controller.signal as AbortSignal
  });

  // Pre-check final URL host (post-redirect)
  const finalUrl =
    (res.request && (res.request as { res?: { responseUrl?: string } }).res?.responseUrl) ||
    pageUrl;
  try {
    const u = new URL(finalUrl);
    if (isPrivateHost(u.hostname)) {
      controller.abort();
      throw new Error('redirect target is private/loopback and is not allowed');
    }
  } catch (e) {
    if ((e as Error).message?.includes('private/loopback')) throw e;
    // ignore URL parse failures – keep going
  }

  const total = Number(res.headers['content-length']) || 0;
  if (total && total > maxBytes) {
    controller.abort();
    throw new Error(`HTML too large: ${total} > ${maxBytes}`);
  }

  return new Promise<string>((resolve, reject) => {
    const stream = res.data as NodeJS.ReadableStream;
    let received = 0;
    const chunks: Buffer[] = [];
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      try { controller.abort(); } catch { /* ignore */ }
      try { (stream as NodeJS.ReadableStream & { destroy?: (e?: Error) => void }).destroy?.(err); } catch { /* ignore */ }
      reject(err);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      const buf = Buffer.concat(chunks, received);
      resolve(buf.toString('utf8'));
    };

    stream.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        fail(new Error(`HTML stream exceeded ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
      emit({
        stage: 'fetching',
        percent: total > 0 ? 5 + Math.round((received / total) * 25) : 15,
        message: total > 0
          ? `下载 HTML ${(received / 1024).toFixed(0)} / ${(total / 1024).toFixed(0)} KB`
          : `下载 HTML ${(received / 1024).toFixed(0)} KB`
      });
    });
    stream.on('error', (e: Error) => fail(e));
    stream.on('end', () => succeed());
    stream.on('close', () => succeed());
  });
}

/**
 * Apply rules 1..7 against an HTML string and write hits into `map`.
 * Returns the document title (if any) so the caller can use it.
 *
 * This is split out as a stand-alone function because we run it twice in
 * the SPA / anti-bot fallback path: once on the raw HTTP response, then
 * again on the headless-rendered DOM if the first pass yielded nothing.
 */
function extractFromHtml(
  html: string,
  pageUrl: string,
  map: Map<string, SniffedMedia>
): string | undefined {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim() || undefined;

  // 1) <video> + <source>
  $('video').each((_, el) => {
    const $el = $(el);
    const poster = abs(pageUrl, $el.attr('poster') || '') || undefined;
    const directSrc = $el.attr('src');
    if (directSrc) {
      const u = abs(pageUrl, directSrc);
      if (u) {
        pushUnique(map, {
          id: id(u),
          url: u,
          kind: 'video',
          source: 'video-tag',
          poster,
          pageUrl
        });
      }
    }
    $el.find('source').each((__, s) => {
      const sSrc = $(s).attr('src');
      const type = $(s).attr('type');
      if (!sSrc) return;
      const u = abs(pageUrl, sSrc);
      if (!u) return;
      pushUnique(map, {
        id: id(u),
        url: u,
        kind: 'video',
        mime: type,
        source: 'source-tag',
        poster,
        pageUrl
      });
    });
  });

  // 2) <img> with .gif
  $('img').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-original');
    if (!src) return;
    const u = abs(pageUrl, src);
    if (!u) return;
    const kind = classifyByExt(u);
    if (kind === 'gif') {
      pushUnique(map, { id: id(u), url: u, kind: 'gif', source: 'img-tag', pageUrl });
    }
  });

  // 3) og:video / twitter:player:stream
  const ogVideo =
    $('meta[property="og:video"]').attr('content') ||
    $('meta[property="og:video:url"]').attr('content');
  if (ogVideo) {
    const u = abs(pageUrl, ogVideo);
    if (u) {
      pushUnique(map, { id: id(u), url: u, kind: 'video', source: 'og-meta', pageUrl });
    }
  }
  const tw = $('meta[name="twitter:player:stream"]').attr('content');
  if (tw) {
    const u = abs(pageUrl, tw);
    if (u) pushUnique(map, { id: id(u), url: u, kind: 'video', source: 'og-meta', pageUrl });
  }

  // 4) <a href="*.gif|*.mp4">
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const u = abs(pageUrl, href);
    if (!u) return;
    const kind = classifyByExt(u);
    if (kind === 'video' || kind === 'gif') {
      pushUnique(map, { id: id(u), url: u, kind, source: 'link', pageUrl });
    }
  });

  // 5) JSON-LD VideoObject
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).contents().text();
      const parsed: unknown = JSON.parse(raw);
      const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
      for (const it of items) {
        if (it && typeof it === 'object') {
          const obj = it as Record<string, unknown>;
          const cu = (obj.contentUrl as string) || (obj.url as string);
          const t = obj['@type'];
          if (cu && (t === 'VideoObject' || (Array.isArray(t) && t.includes('VideoObject')))) {
            const u = abs(pageUrl, cu);
            if (u) pushUnique(map, { id: id(u), url: u, kind: 'video', source: 'json-ld', pageUrl });
          }
        }
      }
    } catch {
      // ignore parse errors
    }
  });

  // 6) <iframe> embeds for known video players (Vimeo, YouTube, Bilibili, ...).
  //    The actual stream is served via MSE/HLS/DASH and cannot be retrieved
  //    via a single HTTP GET. We list the embed URL so the user can see what
  //    was on the page and jump to the original to grab a direct .mp4 link.
  $('iframe').each((_, el) => {
    const $el = $(el);
    const rawSrc =
      $el.attr('src') || $el.attr('data-src') || $el.attr('data-lazy-src') || '';
    if (!rawSrc) return;
    const u = abs(pageUrl, rawSrc);
    if (!u) return;
    let host: string;
    try {
      host = new URL(u).hostname.toLowerCase();
    } catch {
      return;
    }
    const provider = matchEmbedProvider(host, u);
    if (!provider) return;
    pushUnique(map, {
      id: id(u),
      url: u,
      kind: 'video',
      source: 'iframe-embed',
      pageUrl,
      requiresExternalDownload: true,
      embedHost: provider
    });
  });

  // 7) Regex fallback for raw URLs in <script> blocks
  const rxFiles = /(https?:\/\/[^\s"'<>()]+\.(?:mp4|webm|gif))(\?[^\s"'<>()]*)?/gi;
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = rxFiles.exec(html)) !== null) {
    const raw = match[0];
    const key = dedupKey(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = classifyByExt(raw) ?? 'video';
    pushUnique(map, { id: id(raw), url: raw, kind, source: 'pattern', pageUrl });
  }

  // 8) Regex fallback for known-provider embed URLs that are referenced inside
  //    <script>/JSON payloads instead of as real <iframe> tags. SPA frameworks
  //    (Next.js / Nuxt / etc.) often serialize the embed URL into a JSON blob
  //    and only mount the actual <iframe> on the client after hydration. By
  //    scanning the raw HTML — including JSON-escaped variants like
  //    `https:\/\/player.vimeo.com\/video\/...` — we still surface the embed
  //    even when the static DOM has zero <iframe> nodes.
  const normaliseEmbed = (raw: string): string => {
    let s = raw;
    // First pass: collapse JSON / unicode escapes into their canonical char.
    s = s.replace(/\\\//g, '/');
    s = s.replace(/\\u00([0-9a-fA-F]{2})/g, (_m, hh: string) =>
      String.fromCharCode(parseInt(hh, 16))
    );
    // HTML entity un-escape — loop because pages occasionally double-encode
    // (`&amp;amp;v=42` → `&amp;v=42` → `&v=42`).
    let prev = '';
    while (prev !== s && s.includes('&amp;')) {
      prev = s;
      s = s.replace(/&amp;/g, '&');
    }
    // Strip trailing JSON-string padding / punctuation noise.
    s = s.replace(/\\+$/g, '').replace(/[)\]}>,.;]+$/g, '');
    return s;
  };
  // Data-driven: the regex list is derived from EMBED_RULES so they cannot
  // drift out of sync. Fall back to a host-based default when a rule omits
  // an explicit pattern.
  const EMBED_PATTERNS: RegExp[] = EMBED_RULES.map((r) => {
    if (r.pattern) return r.pattern;
    const hostEsc = r.hostSuffix.replace(/\./g, '\\.');
    return new RegExp(
      `https?:(?:\\\\?/){2}(?:[a-z0-9.-]+\\.)?${hostEsc}(?:\\\\?/)[^\\s"'<>]+`,
      'gi'
    );
  });
  for (const rx of EMBED_PATTERNS) {
    let m: RegExpExecArray | null;
    while ((m = rx.exec(html)) !== null) {
      const candidate = normaliseEmbed(m[0]);
      const u = abs(pageUrl, candidate);
      if (!u) continue;
      let host: string;
      try {
        host = new URL(u).hostname.toLowerCase();
      } catch {
        continue;
      }
      const provider = matchEmbedProvider(host, u);
      if (!provider) continue;
      pushUnique(map, {
        id: id(u),
        url: u,
        kind: 'video',
        source: 'iframe-embed',
        pageUrl,
        requiresExternalDownload: true,
        embedHost: provider
      });
    }
  }

  return title;
}

export async function sniffPage(
  pageUrl: string,
  onProgress?: (p: SniffProgress) => void,
  signal?: AbortSignal
): Promise<SniffResult> {
  log(`sniff start: ${pageUrl}`);
  const emit = (p: SniffProgress) => {
    try { onProgress?.(p); } catch { /* swallow */ }
  };
  const checkCancel = (): void => {
    if (signal?.aborted) {
      const e = new Error('cancelled');
      e.name = 'CancelledError';
      throw e;
    }
  };
  // Validate page URL
  const parsed = new URL(pageUrl);
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error('Only http(s) URLs are supported');
  }

  const warnings: string[] = [];
  const map = new Map<string, SniffedMedia>();

  emit({ stage: 'fetching', percent: 2, message: '请求文章 HTML…' });
  checkCancel();
  const html = await fetchHtmlStreamed(pageUrl, MAX_HTML_BYTES, emit, signal);
  checkCancel();
  emit({ stage: 'parsing', percent: 32, message: '解析页面 DOM…' });

  // Cloudflare Turnstile / "Just a moment..." JS challenges return HTTP 200
  // with a tiny stub HTML that has none of the real page content. Detect this
  // up-front so we can surface a clear error rather than pretending we sniffed
  // the page and finding zero items.
  const looksLikeCfChallenge =
    /<title>\s*Just a moment\.\.\.\s*<\/title>/i.test(html) ||
    /challenges\.cloudflare\.com\/turnstile/i.test(html) ||
    /\/cdn-cgi\/challenge-platform\//i.test(html) ||
    /cf-browser-verification|cf_chl_jschl_tk/i.test(html);
  if (looksLikeCfChallenge) {
    warnings.push(
      'Page is behind a Cloudflare bot challenge (Turnstile / "Just a moment..."). ' +
        'In the current network/IP we cannot pass it automatically. Open the URL ' +
        'in a normal browser, finish the verification once, then retry — or save ' +
        'the page locally and use the offline file path.'
    );
  }

  let title = extractFromHtml(html, pageUrl, map);

  // Fallback: SPA / anti-bot / CDN-protected pages may not expose any
  // <video>/<iframe>/<img>.gif via the raw HTTP HTML. Triggers (any one is
  // sufficient):
  //   - we found nothing in the static HTML (the most reliable signal — even
  //     well-known SPA flags like __NEXT_DATA__ can be missing when the page
  //     is heavily SSR-optimised), OR
  //   - the HTML is clearly a CSR shell AND happens to also be very short
  //     (every typical Next.js SSR page would otherwise trip looksLikeCsr;
  //     keeping that flag standalone forced ~30s of headless on every Next
  //     site, even when static parsing already found media).
  // In any of these cases re-load through a headless Electron BrowserWindow
  // so JS can hydrate the iframe / <video> elements that were not in the
  // static HTML, and read the live DOM.
  const looksTooShort = html.length < 50 * 1024;
  const looksLikeCsr =
    /__NEXT_DATA__|__NUXT__|window\.__INITIAL_STATE__|data-reactroot/i.test(html) ||
    /just a moment\.\.\.|attention required|cf-browser-verification/i.test(html);
  const noMedia = map.size === 0;

  if (noMedia || (looksTooShort && looksLikeCsr)) {
    try {
      emit({
        stage: 'parsing',
        percent: 40,
        message: '静态 HTML 未发现媒体,尝试浏览器渲染…'
      });
      const rendered = await fetchRenderedDom(pageUrl);
      emit({
        stage: 'parsing',
        percent: 50,
        message: `浏览器渲染完成 (${(rendered.html.length / 1024).toFixed(0)} KB),重新解析 DOM…`
      });
      const renderedIsCfChallenge =
        /<title>\s*Just a moment\.\.\.\s*<\/title>/i.test(rendered.html) ||
        /challenges\.cloudflare\.com\/turnstile/i.test(rendered.html) ||
        /\/cdn-cgi\/challenge-platform\//i.test(rendered.html);
      if (renderedIsCfChallenge) {
        warnings.push(
          'Headless render also hit a Cloudflare bot challenge — automatic ' +
            'sniffing is not possible from this network. Visit the page in a ' +
            'normal browser to clear the challenge once, or use a saved local copy.'
        );
      }
      const renderedTitle = extractFromHtml(rendered.html, rendered.finalUrl || pageUrl, map);
      if (!title && renderedTitle) title = renderedTitle;

      // Belt-and-suspenders: also classify any iframes captured directly from
      // the live document (some sites build the iframe as a child of a Shadow
      // DOM or attach it after our snapshot — using the live `document` lets
      // us catch them too).
      for (const iframeUrl of rendered.iframes) {
        const u = abs(rendered.finalUrl || pageUrl, iframeUrl);
        if (!u) continue;
        let host: string;
        try {
          host = new URL(u).hostname.toLowerCase();
        } catch {
          continue;
        }
        const provider = matchEmbedProvider(host, u);
        if (!provider) continue;
        pushUnique(map, {
          id: id(u),
          url: u,
          kind: 'video',
          source: 'iframe-embed',
          pageUrl,
          requiresExternalDownload: true,
          embedHost: provider
        });
      }
      if (map.size === 0) {
        warnings.push(
          'Headless render also found no <video>/<iframe>; the page may require login or block automation.'
        );
      }
    } catch (e) {
      warnings.push(`headless fallback failed: ${(e as Error).message}`);
      log(`headless fallback failed: ${(e as Error).message}`);
    }
  }

  if (map.size === 0) {
    warnings.push('No media elements found on this page.');
  }

  // probe HEAD for sizes (best-effort, parallel limit small)
  const list = Array.from(map.values());
  emit({
    stage: 'probing',
    percent: 55,
    message: `已发现 ${list.length} 项,正在探测大小…`,
    found: list.length,
    probed: 0,
    total: list.length
  });
  const headQueue = new PQueue({ concurrency: 6 });
  let probed = 0;
  await Promise.all(
    list.map((item) =>
      headQueue.add(async () => {
        try {
          if (signal?.aborted) return;
          // Pre-check the source URL host before HEAD
          try {
            const u = new URL(item.url);
            if (isPrivateHost(u.hostname)) return;
          } catch {
            return;
          }
          const head = await axios.head(item.url, {
            headers: { 'User-Agent': UA, Referer: pageUrl },
            timeout: 8000,
            maxRedirects: 5,
            validateStatus: (s) => s >= 200 && s < 400,
            signal: signal as AbortSignal | undefined
          });
          // Re-check the post-redirect final URL
          const finalUrl =
            (head.request && (head.request as { res?: { responseUrl?: string } }).res?.responseUrl) ||
            item.url;
          try {
            const fu = new URL(finalUrl);
            if (isPrivateHost(fu.hostname)) return;
          } catch {
            return;
          }
          const len = Number(head.headers['content-length']);
          if (!Number.isNaN(len) && len > 0) item.sizeBytes = len;
          const mime = String(head.headers['content-type'] || '').split(';')[0];
          if (mime) item.mime = mime;
        } catch (e) {
          // If user/network cancelled the probing phase, propagate the cancel
          if (isCancelLikeError(e)) return;
          // some servers reject HEAD; not fatal
        } finally {
          probed += 1;
          emit({
            stage: 'probing',
            percent: 55 + Math.round((probed / Math.max(1, list.length)) * 40),
            message: `已探测 ${probed} / ${list.length}`,
            found: list.length,
            probed,
            total: list.length
          });
        }
      })
    )
  );

  checkCancel();
  emit({
    stage: 'done',
    percent: 100,
    message: `完成,共 ${list.length} 项`,
    found: list.length,
    probed: list.length,
    total: list.length
  });
  log(`sniff done: ${list.length} item(s)`);
  return { pageUrl, title, items: list, warnings };
}
