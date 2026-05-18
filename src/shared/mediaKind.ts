/**
 * R-63 — Single source of truth for the (url, mime) → MediaKind decision.
 *
 * Background: prior to R-63 this project shipped THREE independent copies
 * of `classifyByExt` (in main/sniffer.ts, main/offlineImport.ts and the
 * helper bundle main/webviewSniffUtils.ts), and the four sniff backends
 * (URL-only, embedded webview, real-Chrome CDP, offline import,
 * yt-dlp direct) each combined ext + mime in subtly different ways.
 *
 * The most acute regression: the real-Chrome backend used
 * `acceptWebviewMedia(byMime || byExt, mime)` with `byMime` mapping
 * `image/webp` and `image/apng` to `'gif'`. That mapping was correct for
 * Content-Type-only decisions (animated webp / apng deserve the gif
 * pipeline) but it silently overrode an unambiguous `.png` URL extension
 * whenever a CDN returned `image/webp` (Cloudflare Image / Imagekit /
 * cloudinary auto-transcode, or server-side mime mis-config). Result:
 * a static `.png` URL was filed under `kind: 'gif'` and surfaced in the
 * grid as if it were animated, producing exactly the user-reported
 * "明明是 png,结果进来了还写了 gif" symptom.
 *
 * This module replaces all three local copies. The decision pipeline is:
 *
 *   1. `classifyByExt(url)`  — derive a kind from the path extension.
 *      Trusted absolutely when present (an extension is the strongest
 *      signal we have; no CDN auto-transcode actually rewrites the URL).
 *   2. `classifyByContentType(mime)` — derive a kind from the response
 *      header. Used only when ext is `null` (no extension, e.g. opaque
 *      CDN URLs). Animated container heuristics (image/webp / image/apng
 *      → 'gif') live here.
 *   3. `decideAcceptedKind({ url, mime })` — combine the two with the
 *      conflict-resolution rule: **extension wins when it disagrees**.
 *      A `.png` with mime `image/webp` is `image` (drop), NOT `gif`.
 *      A bare CDN URL with mime `image/webp` is `gif` (keep).
 *
 * Every sniff backend MUST funnel candidates through `decideAcceptedKind`
 * exactly once. This is enforced indirectly by the pure unit tests in
 * `tests/shared/mediaKind.test.ts` plus by deleting the old
 * per-module copies — there is no longer a private `classifyByExt` to
 * accidentally call.
 */

export type MediaKind = 'video' | 'gif' | 'image';

const VIDEO_EXTS = ['.mp4', '.webm', '.m4v', '.mov', '.mkv'];
const GIF_EXTS = ['.gif'];
const STATIC_IMG_EXTS = ['.png', '.jpg', '.jpeg', '.bmp', '.avif', '.svg', '.ico'];
const ANIMATED_IMG_EXTS = ['.webp', '.apng'];

const VIDEO_MIME_RE = /^video\//i;
const IMAGE_MIME_RE = /^image\//i;

function extOfUrl(url: string): string {
  if (!url) return '';
  const noQuery = url.split('?')[0].split('#')[0];
  const dot = noQuery.lastIndexOf('.');
  if (dot < 0) return '';
  const slash = noQuery.lastIndexOf('/');
  if (dot < slash) return '';
  return noQuery.slice(dot).toLowerCase();
}

/**
 * Path-extension classification.
 *
 *   `.mp4 / .webm / .m4v / .mov / .mkv` → 'video'
 *   `.gif`                              → 'gif'
 *   `.webp / .apng`                     → 'gif'   (animated containers
 *                                                  are treated as gifs
 *                                                  throughout the app)
 *   `.png / .jpg / .jpeg / .bmp / .avif
 *    / .svg / .ico`                     → 'image' (static; usually dropped)
 *   anything else                       → null
 *
 * Extensions are matched case-insensitively after stripping query and
 * hash. We deliberately accept full URLs and bare paths so callers do
 * not need to normalise first.
 */
export function classifyByExt(url: string): MediaKind | null {
  const ext = extOfUrl(url);
  if (!ext) return null;
  if (VIDEO_EXTS.includes(ext)) return 'video';
  if (GIF_EXTS.includes(ext)) return 'gif';
  if (ANIMATED_IMG_EXTS.includes(ext)) return 'gif';
  if (STATIC_IMG_EXTS.includes(ext)) return 'image';
  return null;
}

/**
 * Content-Type header classification. Strips parameters and is
 * case-insensitive. Animated containers (image/webp / image/apng) report
 * as `'gif'` because they share the gif pipeline downstream.
 */
export function classifyByContentType(contentType: string | undefined | null): MediaKind | null {
  if (!contentType) return null;
  const head = contentType.split(';')[0].trim().toLowerCase();
  if (!head) return null;
  if (VIDEO_MIME_RE.test(head)) return 'video';
  if (head === 'image/gif') return 'gif';
  if (head === 'image/webp' || head === 'image/apng') return 'gif';
  if (IMAGE_MIME_RE.test(head)) return 'image';
  return null;
}

export interface AcceptInput {
  url: string;
  mime?: string | null | undefined;
}

/**
 * R-63 unified accept decision used by ALL sniff backends.
 *
 * Returns the kind to file the resource under, or `null` when it must
 * be dropped (static image with no opt-in, unknown / non-media payload).
 *
 * Conflict-resolution rule: when the URL extension is recognised it is
 * trusted absolutely — a `.png` URL is image even if the server (or a
 * CDN proxy) reports `image/webp`. This fixes the real-Chrome backend
 * regression where Cloudflare Image / Imagekit transcoded responses
 * caused PNGs to be surfaced as gifs.
 *
 * `includeStatic` controls whether `'image'` candidates pass through.
 * The default is `false` (production sniff UX wants gif/video only); the
 * offline-import backend toggles this on when the user opts to "include
 * static images" via the import dialog.
 */
export function decideAcceptedKind(
  input: AcceptInput,
  opts: { includeStatic?: boolean } = {}
): MediaKind | null {
  const byExt = classifyByExt(input.url);
  const byMime = classifyByContentType(input.mime);

  let resolved: MediaKind | null;
  if (byExt) {
    // Extension wins. Mime cannot upgrade `'image'` to `'gif'`.
    resolved = byExt;
  } else if (byMime) {
    resolved = byMime;
  } else {
    resolved = null;
  }

  if (resolved === 'image' && !opts.includeStatic) return null;
  return resolved;
}

/**
 * Compatibility shim — same shape as the pre-R-63 webview helper but
 * now backed by `decideAcceptedKind`. Kept so call sites that pass an
 * already-resolved `MediaKind` (the DOM-scan path) don't all need to
 * be rewritten.
 *
 *   - When `kind` is given we trust it but still strip `'image'` (the
 *     "no static images in the grid" R-50 invariant).
 *   - When `kind` is null we delegate to `decideAcceptedKind` which
 *     consults both the URL extension AND the mime header.
 */
export function acceptSniffedKind(
  kind: MediaKind | null,
  url: string,
  mime: string | null | undefined,
  opts: { includeStatic?: boolean } = {}
): 'video' | 'gif' | null {
  if (kind === 'video') return 'video';
  if (kind === 'gif') return 'gif';
  if (kind === 'image') return opts.includeStatic ? null : null; // never surface static images here
  const resolved = decideAcceptedKind({ url, mime }, opts);
  if (resolved === 'video') return 'video';
  if (resolved === 'gif') return 'gif';
  return null;
}
