/**
 * R-44 — Pure helpers for the webview-sniff pipeline.
 *
 * Split out from `webviewSniff.ts` so unit tests can import these without
 * pulling in the full `electron` runtime (`BrowserWindow` / `session` /
 * `ipcMain` are not available under vitest's Node host).
 *
 * NOTE: this module deliberately does not import `sniffer.ts` (which
 * transitively imports `headlessFetch.ts` -> `electron`). Instead it
 * imports the pure mediaDedup helper so webview / real-Chrome / static
 * HTML sniff paths share the same host-agnostic transform canonicaliser.
 */
import crypto from 'crypto';
import type { SniffedMedia, MediaKind } from '../shared/types';
import { acceptSniffedKind, classifyByContentType } from '../shared/mediaKind';
import { canonicalMediaDedupKey, mediaVariantScore } from './mediaDedup';

const VIDEO_MIME = /^video\//i;
// Note: GIF_MIME / IMAGE_MIME used to be referenced by the local
// classifyByContentType / acceptWebviewMedia bodies; in R-63 we
// delegate both to `src/shared/mediaKind.ts`, leaving only the
// `VIDEO_MIME` regex as a backstop in the legacy fallback branch.

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
 * R-49 — Major Chrome version we impersonate end-to-end. Bumping this is
 * a single edit: the UA string in `webviewSniff.ts`, the spoofed
 * `Sec-Ch-Ua*` headers, and the injected `userAgentData.brands` all
 * derive from this constant so they stay internally consistent (a
 * mismatch is itself a fingerprintable signal — Cloudflare's Bot Fight
 * Mode rejects clients whose UA major version disagrees with the major
 * version reported in `Sec-Ch-Ua-Full-Version-List`).
 */
export const SPOOF_CHROME_MAJOR = 124;
export const SPOOF_CHROME_FULL = '124.0.6367.119';

/**
 * R-49 — Build the trio of Sec-Ch-Ua* headers that real Chrome 124
 * sends. The ordering of brand items inside `Sec-Ch-Ua` is deliberately
 * ("Chromium" first, real brand second, "Not-A.Brand" GREASE entry
 * third) — Cloudflare's reverse-engineered detector reads brand[0] for
 * a quick literal match. Returns lower-case header keys to match
 * Electron's normalised view of `requestHeaders`.
 *
 * @param platform Sec-Ch-Ua-Platform value, e.g. '"macOS"' or '"Windows"'.
 *                 Always wrapped in literal quotes per RFC8941 sf-string.
 */
export function buildSpoofedSecChUa(platform: string): Record<string, string> {
  const major = SPOOF_CHROME_MAJOR;
  const full = SPOOF_CHROME_FULL;
  const brands = `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not-A.Brand";v="99"`;
  const fullList =
    `"Chromium";v="${full}", ` +
    `"Google Chrome";v="${full}", ` +
    `"Not-A.Brand";v="99.0.0.0"`;
  return {
    'sec-ch-ua': brands,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': platform,
    'sec-ch-ua-full-version-list': fullList,
    'sec-ch-ua-full-version': `"${full}"`
  };
}

/** Hosts whose names clearly belong to Cloudflare's challenge / edge
 *  infrastructure. We never want to reject their certificates (that
 *  would kill Turnstile's own challenge endpoints which run on
 *  `challenges.cloudflare.com`) or rewrite their request headers
 *  (CF-internal ping back-ends are not browsers and care about the raw
 *  Electron headers — though in practice they ignore Sec-Ch-Ua, this is
 *  defence in depth). */
const CLOUDFLARE_HOST_RE = /(?:^|\.)cloudflare(?:-dns|insights)?\.com$|(?:^|\.)cloudflare\.net$/i;

/**
 * Returns true if the host is part of Cloudflare's own infrastructure
 * (CDN, Turnstile challenge, analytics). Used by the certificate-error
 * handler to never silently reject Cloudflare-issued certs and by the
 * banner detector as one of several "this site is bot-walled" signals.
 */
export function isCloudflareInfraHost(host: string | null | undefined): boolean {
  if (!host) return false;
  return CLOUDFLARE_HOST_RE.test(host);
}

/** Hosts known to apply maximum-strength bot protection (Cloudflare
 *  Turnstile + custom JS challenges). Even with full anti-fingerprint
 *  patches we cannot reliably get past these in an Electron-embedded
 *  webview, so the chrome shell surfaces a banner suggesting the user
 *  switch to the system browser. The list is intentionally short and
 *  conservative — false positives just nag the user. */
const HIGH_PROTECTION_HOST_RE =
  /(?:^|\.)(?:openai\.com|chatgpt\.com|chat\.openai\.com|patreon\.com|x\.com|twitter\.com|notion\.so|notion\.site|ezgif\.com)$/i;

/**
 * Whether the host is on the well-known "this will fingerprint you to
 * death" list. The check is host-only; subdomains all share the same
 * verdict because the bot policy is set at the apex.
 */
export function isHighProtectionHost(host: string | null | undefined): boolean {
  if (!host) return false;
  return HIGH_PROTECTION_HOST_RE.test(host);
}

/**
 * R-49 — JavaScript snippet injected into every frame on `dom-ready`
 * that papers over the most common Electron-vs-Chrome fingerprint
 * differences:
 *
 *  1. `navigator.userAgentData.brands` — Electron 31 advertises
 *     "Electron" as one of the brand strings; Cloudflare's BFM checks
 *     a literal blacklist `[electron, cypress, playwright, headless]`.
 *     We replace the property with a stub returning Chrome 124's
 *     canonical brands array.
 *  2. `navigator.webdriver` — defaults to `false` in Electron, which
 *     is correct, but several stealth-test sites probe it via
 *     `Object.getOwnPropertyDescriptor`. We delete the property
 *     entirely (matching what an un-instrumented Chrome looks like).
 *  3. `window.chrome.runtime` — real Chrome 124 has `chrome.runtime`,
 *     `chrome.csi`, `chrome.loadTimes`. Electron has none of those.
 *     We add minimal no-op stubs so feature-detection passes.
 *  4. `navigator.plugins.length` — Chrome on macOS reports 5 (PDF
 *     viewer + 4 internal plugins). Electron reports 0. We can't
 *     synthesise real PluginArray entries safely, but we can fix the
 *     length sniff that's the most common quick-and-dirty check.
 *
 * The script is wrapped in a try/catch + IIFE so any property descriptor
 * mismatch on a future Electron version doesn't crash the page.
 *
 * Exported so the unit test can lock the literal contents (a typo in
 * the brands array would silently break the spoof until a user reports
 * it).
 */
export const FINGERPRINT_PATCH_SCRIPT = `(() => { try {
  const major = ${SPOOF_CHROME_MAJOR};
  const brands = [
    { brand: "Chromium", version: String(major) },
    { brand: "Google Chrome", version: String(major) },
    { brand: "Not-A.Brand", version: "99" }
  ];
  const fullVersionList = [
    { brand: "Chromium", version: "${SPOOF_CHROME_FULL}" },
    { brand: "Google Chrome", version: "${SPOOF_CHROME_FULL}" },
    { brand: "Not-A.Brand", version: "99.0.0.0" }
  ];
  // 1. userAgentData spoof.
  if (navigator.userAgentData) {
    try {
      Object.defineProperty(navigator.userAgentData, 'brands', {
        get: () => brands.slice(),
        configurable: true
      });
      const orig = navigator.userAgentData.getHighEntropyValues
        ? navigator.userAgentData.getHighEntropyValues.bind(navigator.userAgentData)
        : null;
      navigator.userAgentData.getHighEntropyValues = function (hints) {
        return (orig ? orig(hints) : Promise.resolve({})).then((r) => {
          const out = Object.assign({}, r);
          out.brands = brands.slice();
          out.fullVersionList = fullVersionList.slice();
          out.uaFullVersion = "${SPOOF_CHROME_FULL}";
          return out;
        });
      };
    } catch (_) {}
  }
  // 2. webdriver.
  try { delete Object.getPrototypeOf(navigator).webdriver; } catch (_) {}
  try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (_) {}
  // 3. window.chrome runtime stub.
  if (!window.chrome) { window.chrome = {}; }
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', UPDATE: 'update' },
      PlatformOs: { MAC: 'mac', WIN: 'win', LINUX: 'linux' },
      id: undefined
    };
  }
  if (!window.chrome.csi) { window.chrome.csi = function () { return {}; }; }
  if (!window.chrome.loadTimes) {
    window.chrome.loadTimes = function () {
      return { requestTime: performance.timeOrigin / 1000, startLoadTime: performance.timeOrigin / 1000,
        commitLoadTime: 0, finishDocumentLoadTime: 0, finishLoadTime: 0, firstPaintTime: 0,
        firstPaintAfterLoadTime: 0, navigationType: 'Other', wasFetchedViaSpdy: true,
        wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false,
        connectionInfo: 'h2' };
    };
  }
  // 4. Plugin count sniff.
  try {
    Object.defineProperty(navigator, 'plugins', {
      get: () => ({ length: 5, item: () => null, namedItem: () => null,
        refresh: () => undefined, [Symbol.iterator]: function* () {} }),
      configurable: true
    });
  } catch (_) {}
} catch (_) { /* swallow — page rendering must continue regardless */ } })();`;

/**
 * R-50 (rev R-63) — Strict "what counts as a useful capture" filter.
 *
 * The pre-R-63 implementation took `kind = byMime || byExt` from the
 * caller, which let `image/webp` mime upgrade a `.png` URL to `'gif'`
 * (the user reported "明明是 png,结果进来了还写了 gif"). We now route
 * the decision through the unified `decideAcceptedKind` so the URL
 * extension is the authoritative source whenever it disagrees with the
 * Content-Type header.
 *
 * Public contract is unchanged:
 *  - returns `'video'` / `'gif'` to keep, `null` to drop
 *  - the legacy `kind` argument is honoured ONLY when it's `'video'` or
 *    `'gif'` (DOM-scan path that already trusted its own classifier);
 *    `'image'` is always dropped, and `null` means "decide for me".
 */
export function acceptWebviewMedia(
  kind: MediaKind | null,
  mime: string | null | undefined,
  url?: string
): 'video' | 'gif' | null {
  if (kind === 'video') return 'video';
  if (kind === 'gif') return 'gif';
  if (kind === 'image') return null;
  // kind === null branch: defer to the unified decision so the URL
  // extension can override a transcoding-CDN mime header.
  if (typeof url === 'string' && url) {
    return acceptSniffedKind(null, url, mime ?? null);
  }
  // Legacy fallback: callers that don't yet pass the URL still get the
  // mime-only behaviour (kept for backwards compatibility with one
  // call site in the DOM-scan path that always supplies a real
  // `MediaKind` and never reaches this branch).
  if (!mime) return null;
  const head = mime.split(';')[0].trim().toLowerCase();
  if (!head) return null;
  if (VIDEO_MIME.test(head)) return 'video';
  if (head === 'image/gif' || head === 'image/webp' || head === 'image/apng') return 'gif';
  return null;
}

/**
 * Translate a `Content-Type` response header into our 3-way `MediaKind`.
 *
 * R-63 — Now a thin re-export of the unified helper in
 * `src/shared/mediaKind.ts`. The legacy implementation in this file
 * was kept identical in semantics; consolidating it removes the risk
 * that future tweaks to the gif/webp/apng heuristics drift between the
 * sniffer and the webview helpers.
 */
export { classifyByContentType };

/**
 * Pick a deterministic id for a webview-sourced media. Uses sha256 of the
 * URL truncated to 16 hex chars to stay consistent with `sniffer.ts:id()`.
 */
export function mediaId(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Shared dedup key for webview / real-Chrome captures. It strips generic
 * presentation transforms (resize / format / quality / cache signatures)
 * without relying on host-specific branches.
 */
export function webviewDedupKey(url: string): string {
  return canonicalMediaDedupKey(url);
}

/**
 * Merge raw URLs collected from the webview with the running map of
 * SniffedMedia, applying our shared dedup so a user toggling between
 * `sniff:url` and `sniff:webview` does not see ghost duplicates in the
 * grid.
 *
 * - Stops accepting new entries once `map.size >= WEBVIEW_MAX_ITEMS`.
 * - On dedup, keeps the better-looking variant while preserving the
 *   original id so renderer selection state stays stable.
 */
export function mergeWebviewMedia(
  map: Map<string, SniffedMedia>,
  candidates: Array<{ url: string; kind: MediaKind; mime?: string; pageUrl: string }>
): void {
  for (const c of candidates) {
    if (map.size >= WEBVIEW_MAX_ITEMS) break;
    const key = webviewDedupKey(c.url);
    const m: SniffedMedia = {
      id: mediaId(c.url),
      url: c.url,
      kind: c.kind,
      pageUrl: c.pageUrl,
      source: 'webview',
      mime: c.mime
    };
    const existing = map.get(key);
    if (existing) {
      if (mediaVariantScore(m) > mediaVariantScore(existing)) {
        map.set(key, { ...m, id: existing.id });
      }
      continue;
    }
    map.set(key, m);
  }
}
