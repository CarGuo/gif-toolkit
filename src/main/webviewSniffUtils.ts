/**
 * R-44 — Pure helpers for the webview-sniff pipeline.
 *
 * Split out from `webviewSniff.ts` so unit tests can import these without
 * pulling in the full `electron` runtime (`BrowserWindow` / `session` /
 * `ipcMain` are not available under vitest's Node host).
 *
 * NOTE: this module deliberately does not import `sniffer.ts` (which
 * transitively imports `headlessFetch.ts` -> `electron`); we use a
 * lightweight dedup key here that covers the cases webview-captured
 * URLs hit in practice (host + pathname, lower-cased, query stripped).
 * The fancier path-segment normaliser in `sniffer.ts:dedupKey()` is
 * tuned for HTML scrape variants (Wikipedia thumbs, Cloudinary
 * transforms, ...) which the network/DOM observer here does not see.
 */
import crypto from 'crypto';
import type { SniffedMedia, MediaKind } from '../shared/types';

const VIDEO_MIME = /^video\//i;
const GIF_MIME = /^image\/gif$/i;
const IMAGE_MIME = /^image\//i;

/** Hard ceiling shared with `webviewSniff.ts` so a hostile auto-loaded
 *  page cannot grow the result set unboundedly. */
export const WEBVIEW_MAX_ITEMS = 200;

/** R-47 — Height of the chrome toolbar in CSS px. Mirrored in the
 *  inline HTML in `webviewSniff.ts` so the inner WebContentsView can be
 *  positioned right below the bar without overlap. Pulled out for unit
 *  tests so we can lock the layout math without spinning up Electron. */
export const WEBVIEW_TOOLBAR_HEIGHT = 44;

/**
 * Compute the bounds of the inner page-host view inside an outer window
 * of given content size, leaving room for the chrome toolbar at the top.
 * Negative inputs clamp to zero so a freshly-created (0×0) window does
 * not try to set a `WebContentsView` to negative dimensions.
 */
export function innerViewBounds(contentWidth: number, contentHeight: number): { x: number; y: number; width: number; height: number } {
  const w = Math.max(0, Math.floor(contentWidth));
  const h = Math.max(0, Math.floor(contentHeight - WEBVIEW_TOOLBAR_HEIGHT));
  return { x: 0, y: WEBVIEW_TOOLBAR_HEIGHT, width: w, height: h };
}

/**
 * Translate a `Content-Type` response header into our 3-way `MediaKind`.
 *
 * We deliberately split GIF out before the generic image branch because
 * the rest of the app branches between gif-only and image-only flows;
 * `image/gif` would otherwise be lumped with stills and lose the
 * animated-resize toolbox affordance.
 *
 * `image/webp` and `image/apng` are also reported as `gif` so the
 * renderer surfaces the animated branch by default — still images get
 * filtered out by the calling code via the `byMime !== 'image'` guard.
 */
export function classifyByContentType(contentType: string | undefined | null): MediaKind | null {
  if (!contentType) return null;
  const head = contentType.split(';')[0].trim().toLowerCase();
  if (!head) return null;
  if (VIDEO_MIME.test(head)) return 'video';
  if (GIF_MIME.test(head)) return 'gif';
  if (head === 'image/webp' || head === 'image/apng') return 'gif';
  if (IMAGE_MIME.test(head)) return 'image';
  return null;
}

/**
 * Pick a deterministic id for a webview-sourced media. Uses sha256 of the
 * URL truncated to 16 hex chars to stay consistent with `sniffer.ts:id()`.
 */
export function mediaId(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Lightweight dedup key: lower-case host + pathname, query/hash stripped.
 * Matches the level of variation a real-time network observer is likely
 * to see (CDN cache-busting tokens, tracking params, fragment IDs); it
 * intentionally does NOT try to canonicalise sizing variants — those
 * come from HTML scrape paths and are handled by `sniffer.ts:dedupKey`.
 */
export function webviewDedupKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host.toLowerCase()}${u.pathname.toLowerCase()}`;
  } catch {
    return url;
  }
}

/**
 * Merge raw URLs collected from the webview with the running map of
 * SniffedMedia, applying our lightweight dedup so a user toggling between
 * `sniff:url` and `sniff:webview` does not see ghost duplicates in the
 * grid.
 *
 * - Stops accepting new entries once `map.size >= WEBVIEW_MAX_ITEMS`.
 * - First-write-wins on dedup: webRequest captures (called first by the
 *   caller) take priority over later DOM-scan entries.
 */
export function mergeWebviewMedia(
  map: Map<string, SniffedMedia>,
  candidates: Array<{ url: string; kind: MediaKind; mime?: string; pageUrl: string }>
): void {
  for (const c of candidates) {
    if (map.size >= WEBVIEW_MAX_ITEMS) break;
    const key = webviewDedupKey(c.url);
    if (map.has(key)) continue;
    const m: SniffedMedia = {
      id: mediaId(c.url),
      url: c.url,
      kind: c.kind,
      pageUrl: c.pageUrl,
      source: 'webview',
      mime: c.mime
    };
    map.set(key, m);
  }
}
