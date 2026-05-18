/**
 * R-44 — Tests for the webview-sniff pure helpers.
 *
 * These cover the non-Electron pieces of `webviewSniffUtils.ts`:
 *  - Content-Type → MediaKind classification (video/gif/animated webp).
 *  - Lightweight dedup key (host + pathname, query stripped).
 *  - Merge function: dedup, hard cap, source stamping.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyByContentType,
  mediaId,
  mergeWebviewMedia,
  webviewDedupKey,
  WEBVIEW_MAX_ITEMS,
  WEBVIEW_TOOLBAR_HEIGHT,
  innerViewBounds,
  buildSpoofedSecChUa,
  isCloudflareInfraHost,
  isHighProtectionHost,
  FINGERPRINT_PATCH_SCRIPT,
  SPOOF_CHROME_MAJOR,
  SPOOF_CHROME_FULL,
  acceptWebviewMedia
} from '../../src/main/webviewSniffUtils';
import type { SniffedMedia } from '../../src/shared/types';

describe('classifyByContentType', () => {
  it('returns null for empty / nullish / non-media types', () => {
    expect(classifyByContentType(null)).toBeNull();
    expect(classifyByContentType(undefined)).toBeNull();
    expect(classifyByContentType('')).toBeNull();
    expect(classifyByContentType('text/html; charset=utf-8')).toBeNull();
    expect(classifyByContentType('application/json')).toBeNull();
  });

  it('classifies video/* as video regardless of subtype', () => {
    expect(classifyByContentType('video/mp4')).toBe('video');
    expect(classifyByContentType('video/webm')).toBe('video');
    expect(classifyByContentType('VIDEO/QUICKTIME')).toBe('video');
  });

  it('classifies image/gif as gif (split out from generic image)', () => {
    expect(classifyByContentType('image/gif')).toBe('gif');
    // Confirm casing + parameter trailing does not regress the split:
    expect(classifyByContentType('Image/Gif; foo=bar')).toBe('gif');
  });

  it('reports image/webp + image/apng as gif (animated branch)', () => {
    expect(classifyByContentType('image/webp')).toBe('gif');
    expect(classifyByContentType('image/apng')).toBe('gif');
  });

  it('classifies remaining image/* as plain image', () => {
    expect(classifyByContentType('image/png')).toBe('image');
    expect(classifyByContentType('image/jpeg')).toBe('image');
    expect(classifyByContentType('image/avif')).toBe('image');
  });

  it('strips parameters before matching', () => {
    expect(classifyByContentType('video/mp4; codecs="avc1.42E01E"')).toBe('video');
  });
});

describe('webviewDedupKey', () => {
  it('combines host + pathname, lower-cased', () => {
    expect(webviewDedupKey('https://CDN.Example.com/Path/Foo.MP4')).toBe('cdn.example.com/path/foo.mp4');
  });

  it('strips query string and hash so cache-busters do not produce ghost duplicates', () => {
    const a = webviewDedupKey('https://x.com/a/b.gif?v=1');
    const b = webviewDedupKey('https://x.com/a/b.gif?v=2&token=abc#frag');
    expect(a).toBe(b);
  });

  it('falls back to raw url when not a valid URL', () => {
    expect(webviewDedupKey('not a url')).toBe('not a url');
  });
});

describe('mediaId', () => {
  it('produces a 16-char lowercase hex digest', () => {
    const id = mediaId('https://example.com/foo.gif');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for identical inputs', () => {
    expect(mediaId('a')).toBe(mediaId('a'));
    expect(mediaId('a')).not.toBe(mediaId('b'));
  });
});

describe('mergeWebviewMedia', () => {
  const PAGE = 'https://example.com/post/1';

  it('stamps every produced media with source="webview"', () => {
    const map = new Map<string, SniffedMedia>();
    mergeWebviewMedia(map, [
      { url: 'https://x.com/a.gif', kind: 'gif', pageUrl: PAGE }
    ]);
    expect(map.size).toBe(1);
    const m = Array.from(map.values())[0];
    expect(m.source).toBe('webview');
    expect(m.kind).toBe('gif');
    expect(m.pageUrl).toBe(PAGE);
    expect(m.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('first-write-wins: a later DOM-scan duplicate does not overwrite an earlier network capture', () => {
    const map = new Map<string, SniffedMedia>();
    mergeWebviewMedia(map, [
      { url: 'https://x.com/a.gif?v=net', kind: 'gif', mime: 'image/gif', pageUrl: PAGE }
    ]);
    mergeWebviewMedia(map, [
      // Same dedup key (query stripped); should be ignored.
      { url: 'https://x.com/a.gif?v=dom', kind: 'gif', pageUrl: PAGE }
    ]);
    expect(map.size).toBe(1);
    const m = Array.from(map.values())[0];
    expect(m.url).toBe('https://x.com/a.gif?v=net');
    expect(m.mime).toBe('image/gif');
  });

  it('respects the WEBVIEW_MAX_ITEMS cap', () => {
    const map = new Map<string, SniffedMedia>();
    const candidates = Array.from({ length: WEBVIEW_MAX_ITEMS + 5 }, (_, i) => ({
      url: `https://x.com/m${i}.mp4`,
      kind: 'video' as const,
      pageUrl: PAGE
    }));
    mergeWebviewMedia(map, candidates);
    expect(map.size).toBe(WEBVIEW_MAX_ITEMS);
  });

  it('preserves mime when provided', () => {
    const map = new Map<string, SniffedMedia>();
    mergeWebviewMedia(map, [
      { url: 'https://x.com/a.mp4', kind: 'video', mime: 'video/mp4', pageUrl: PAGE }
    ]);
    expect(Array.from(map.values())[0].mime).toBe('video/mp4');
  });
});

describe('innerViewBounds (R-47 chrome-shell layout)', () => {
  it('places the inner view directly below the toolbar', () => {
    const r = innerViewBounds(1100, 800);
    expect(r.x).toBe(0);
    expect(r.y).toBe(WEBVIEW_TOOLBAR_HEIGHT);
    expect(r.width).toBe(1100);
    expect(r.height).toBe(800 - WEBVIEW_TOOLBAR_HEIGHT);
  });

  it('floors fractional sizes (Electron content-bounds occasionally yields .5px)', () => {
    const r = innerViewBounds(1100.7, 800.9);
    expect(r.width).toBe(1100);
    expect(r.height).toBe(Math.floor(800.9 - WEBVIEW_TOOLBAR_HEIGHT));
  });

  it('clamps to zero rather than producing negative dimensions', () => {
    const r = innerViewBounds(0, 0);
    expect(r.width).toBe(0);
    expect(r.height).toBe(0);
    expect(r.y).toBe(WEBVIEW_TOOLBAR_HEIGHT);
  });

  it('clamps when content height is smaller than the toolbar', () => {
    const r = innerViewBounds(400, 20);
    expect(r.height).toBe(0);
  });
});

describe('buildSpoofedSecChUa (R-49 anti-fingerprint headers)', () => {
  it('emits the canonical Chrome 124 brand list with Chromium first', () => {
    const h = buildSpoofedSecChUa('"macOS"');
    // Brand-list ordering matters — Cloudflare's BFM probes brand[0] for
    // a quick literal match on `"Chromium";`.
    expect(h['sec-ch-ua']).toMatch(/^"Chromium";v="\d+", "Google Chrome";v="\d+", "Not-A.Brand";v="99"$/);
    expect(h['sec-ch-ua']).toContain(`"Chromium";v="${SPOOF_CHROME_MAJOR}"`);
    expect(h['sec-ch-ua']).toContain(`"Google Chrome";v="${SPOOF_CHROME_MAJOR}"`);
    // No "Electron" leakage.
    expect(h['sec-ch-ua'].toLowerCase()).not.toContain('electron');
  });

  it('includes a populated Sec-Ch-Ua-Full-Version-List with all three brands', () => {
    const h = buildSpoofedSecChUa('"Windows"');
    expect(h['sec-ch-ua-full-version-list']).toContain(`"Chromium";v="${SPOOF_CHROME_FULL}"`);
    expect(h['sec-ch-ua-full-version-list']).toContain(`"Google Chrome";v="${SPOOF_CHROME_FULL}"`);
    expect(h['sec-ch-ua-full-version-list']).toContain('"Not-A.Brand";v="99.0.0.0"');
  });

  it('always reports mobile=?0 (we are a desktop app on every platform)', () => {
    expect(buildSpoofedSecChUa('"macOS"')['sec-ch-ua-mobile']).toBe('?0');
    expect(buildSpoofedSecChUa('"Linux"')['sec-ch-ua-mobile']).toBe('?0');
  });

  it('passes the platform value through verbatim (caller pre-quotes per RFC8941)', () => {
    expect(buildSpoofedSecChUa('"macOS"')['sec-ch-ua-platform']).toBe('"macOS"');
    expect(buildSpoofedSecChUa('"Windows"')['sec-ch-ua-platform']).toBe('"Windows"');
  });

  it('uses lower-case keys (matches Electron normalised requestHeaders)', () => {
    const h = buildSpoofedSecChUa('"macOS"');
    for (const k of Object.keys(h)) {
      expect(k).toBe(k.toLowerCase());
    }
  });
});

describe('isCloudflareInfraHost (R-49 cert-error allow-list)', () => {
  it('matches challenges.cloudflare.com (Turnstile origin)', () => {
    expect(isCloudflareInfraHost('challenges.cloudflare.com')).toBe(true);
  });

  it('matches the cloudflareinsights analytics host', () => {
    expect(isCloudflareInfraHost('static.cloudflareinsights.com')).toBe(true);
  });

  it('matches arbitrary .cloudflare.com / .cloudflare.net subdomains', () => {
    expect(isCloudflareInfraHost('cdn.cloudflare.com')).toBe(true);
    expect(isCloudflareInfraHost('foo.bar.cloudflare.net')).toBe(true);
  });

  it('rejects non-CF hosts even if "cloudflare" appears mid-string', () => {
    // Substring "cloudflare" inside a longer label must not match.
    expect(isCloudflareInfraHost('not-cloudflare.example.com')).toBe(false);
    expect(isCloudflareInfraHost('cloudflare.evil.com')).toBe(false);
    expect(isCloudflareInfraHost('example.com')).toBe(false);
  });

  it('handles null / undefined / empty host without throwing', () => {
    expect(isCloudflareInfraHost(null)).toBe(false);
    expect(isCloudflareInfraHost(undefined)).toBe(false);
    expect(isCloudflareInfraHost('')).toBe(false);
  });
});

describe('isHighProtectionHost (R-49 banner trigger)', () => {
  it('flags openai / chatgpt / patreon / x.com / twitter / notion / ezgif', () => {
    expect(isHighProtectionHost('openai.com')).toBe(true);
    expect(isHighProtectionHost('chat.openai.com')).toBe(true);
    expect(isHighProtectionHost('chatgpt.com')).toBe(true);
    expect(isHighProtectionHost('www.patreon.com')).toBe(true);
    expect(isHighProtectionHost('x.com')).toBe(true);
    expect(isHighProtectionHost('twitter.com')).toBe(true);
    expect(isHighProtectionHost('www.notion.so')).toBe(true);
    expect(isHighProtectionHost('foo.notion.site')).toBe(true);
    expect(isHighProtectionHost('ezgif.com')).toBe(true);
  });

  it('does not match unrelated hosts', () => {
    expect(isHighProtectionHost('example.com')).toBe(false);
    expect(isHighProtectionHost('imgur.com')).toBe(false);
    expect(isHighProtectionHost('giphy.com')).toBe(false);
    // Substring containing "openai" must not false-match.
    expect(isHighProtectionHost('not-openai.com')).toBe(false);
  });

  it('handles null / undefined / empty host without throwing', () => {
    expect(isHighProtectionHost(null)).toBe(false);
    expect(isHighProtectionHost(undefined)).toBe(false);
    expect(isHighProtectionHost('')).toBe(false);
  });
});

describe('FINGERPRINT_PATCH_SCRIPT (R-49 client-side spoof)', () => {
  it('contains a non-trivial IIFE wrapper with a try/catch envelope', () => {
    expect(FINGERPRINT_PATCH_SCRIPT.startsWith('(() => { try {')).toBe(true);
    expect(FINGERPRINT_PATCH_SCRIPT).toContain('} catch (_)');
  });

  it('locks the brand list to "Chromium" + "Google Chrome" + "Not-A.Brand" (no Electron leak)', () => {
    expect(FINGERPRINT_PATCH_SCRIPT).toContain('"Chromium"');
    expect(FINGERPRINT_PATCH_SCRIPT).toContain('"Google Chrome"');
    expect(FINGERPRINT_PATCH_SCRIPT).toContain('"Not-A.Brand"');
    expect(FINGERPRINT_PATCH_SCRIPT.toLowerCase()).not.toContain('"electron"');
  });

  it('removes navigator.webdriver from the prototype chain', () => {
    expect(FINGERPRINT_PATCH_SCRIPT).toContain('delete Object.getPrototypeOf(navigator).webdriver');
    expect(FINGERPRINT_PATCH_SCRIPT).toContain("Object.defineProperty(navigator, 'webdriver'");
  });

  it('installs the chrome.runtime / chrome.csi / chrome.loadTimes stubs', () => {
    expect(FINGERPRINT_PATCH_SCRIPT).toContain('window.chrome.runtime');
    expect(FINGERPRINT_PATCH_SCRIPT).toContain('window.chrome.csi');
    expect(FINGERPRINT_PATCH_SCRIPT).toContain('window.chrome.loadTimes');
  });

  it('overrides navigator.plugins so a quick length sniff returns 5', () => {
    expect(FINGERPRINT_PATCH_SCRIPT).toContain("Object.defineProperty(navigator, 'plugins'");
    expect(FINGERPRINT_PATCH_SCRIPT).toContain('length: 5');
  });

  it('embeds the configured Chrome major version literal', () => {
    expect(FINGERPRINT_PATCH_SCRIPT).toContain(`const major = ${SPOOF_CHROME_MAJOR}`);
    expect(FINGERPRINT_PATCH_SCRIPT).toContain(SPOOF_CHROME_FULL);
  });
});

/**
 * R-50 — `acceptWebviewMedia` strict gate.
 *
 * Locked semantics:
 *  - explicit `video`/`gif` kinds always pass through (extension or
 *    mime classifier already trusted)
 *  - explicit `image` kind is dropped (png/jpg/svg/static webp noise)
 *  - `null` kind (extension-less CDN URLs) falls back to mime:
 *      - any `video/*` → 'video'
 *      - `image/gif` / `image/webp` / `image/apng` → 'gif'
 *      - everything else → drop
 *  - mime parameters / case / whitespace are tolerated.
 */
describe('acceptWebviewMedia (R-50 strict gate)', () => {
  it('passes through explicit video kind regardless of mime', () => {
    expect(acceptWebviewMedia('video', null)).toBe('video');
    expect(acceptWebviewMedia('video', 'image/png')).toBe('video');
    expect(acceptWebviewMedia('video', undefined)).toBe('video');
  });

  it('passes through explicit gif kind regardless of mime', () => {
    expect(acceptWebviewMedia('gif', null)).toBe('gif');
    expect(acceptWebviewMedia('gif', 'image/png')).toBe('gif');
  });

  it('drops explicit image kind even if mime would have matched', () => {
    expect(acceptWebviewMedia('image', 'image/png')).toBeNull();
    expect(acceptWebviewMedia('image', 'image/jpeg')).toBeNull();
    expect(acceptWebviewMedia('image', 'image/svg+xml')).toBeNull();
    // Defensive: even if a confused upstream tagged a row 'image' but
    // the response was actually a video, we still respect kind=image.
    expect(acceptWebviewMedia('image', 'video/mp4')).toBeNull();
  });

  it('drops null kind with null/empty mime', () => {
    expect(acceptWebviewMedia(null, null)).toBeNull();
    expect(acceptWebviewMedia(null, undefined)).toBeNull();
    expect(acceptWebviewMedia(null, '')).toBeNull();
    expect(acceptWebviewMedia(null, '   ')).toBeNull();
  });

  it('accepts null kind + video mime as video', () => {
    expect(acceptWebviewMedia(null, 'video/mp4')).toBe('video');
    expect(acceptWebviewMedia(null, 'video/webm')).toBe('video');
    expect(acceptWebviewMedia(null, 'video/quicktime')).toBe('video');
    // Note: HLS playlists ship as `application/vnd.apple.mpegurl` and
    // are deliberately NOT routed to video here — the sniffer's
    // ext-based classifier already covers `.m3u8`, and we want to
    // avoid dragging HTTP API JSON of vaguely-similar `application/*`
    // mimes into the grid.
    expect(acceptWebviewMedia(null, 'application/vnd.apple.mpegurl')).toBeNull();
  });

  it('accepts null kind + gif/webp/apng mime as gif', () => {
    expect(acceptWebviewMedia(null, 'image/gif')).toBe('gif');
    expect(acceptWebviewMedia(null, 'image/webp')).toBe('gif');
    expect(acceptWebviewMedia(null, 'image/apng')).toBe('gif');
  });

  it('drops null kind + still-image mime', () => {
    expect(acceptWebviewMedia(null, 'image/png')).toBeNull();
    expect(acceptWebviewMedia(null, 'image/jpeg')).toBeNull();
    expect(acceptWebviewMedia(null, 'image/svg+xml')).toBeNull();
    expect(acceptWebviewMedia(null, 'image/avif')).toBeNull();
  });

  it('drops null kind + non-media mime', () => {
    expect(acceptWebviewMedia(null, 'text/html')).toBeNull();
    expect(acceptWebviewMedia(null, 'application/json')).toBeNull();
    expect(acceptWebviewMedia(null, 'application/octet-stream')).toBeNull();
  });

  it('strips charset / boundary parameters and is case-insensitive', () => {
    expect(acceptWebviewMedia(null, 'Video/MP4; codecs="avc1.42E01E"')).toBe('video');
    expect(acceptWebviewMedia(null, '  IMAGE/GIF ; charset=binary')).toBe('gif');
    expect(acceptWebviewMedia(null, 'IMAGE/PNG; charset=binary')).toBeNull();
  });

  // R-70 — Regression lock for the real-Chrome png-leak.
  // The user reported that `.png` thumbnails were entering the grid
  // wearing a `gif` badge when sniffed via the system-Chrome CDP
  // backend. Root cause: that backend computed
  //     const accepted = acceptWebviewMedia(byMime || byExt, mime, url);
  // where `byMime = 'gif'` for `image/webp` short-circuited past the
  // `.png` extension. We've since removed that pre-resolution and
  // always pass `kind=null` so the unified `decideAcceptedKind` runs.
  // This test makes sure that when callers honour the new contract
  // (`kind=null` + url + mime), a `.png` URL with a transcoding-CDN
  // `image/webp` Content-Type is dropped, NOT promoted to gif.
  it('R-70: drops .png URL even when mime is image/webp (CDN transcode)', () => {
    expect(acceptWebviewMedia(null, 'image/webp', 'https://cdn.example.com/foo.png')).toBeNull();
    expect(acceptWebviewMedia(null, 'image/webp', 'https://cdn.example.com/foo.PNG?v=1')).toBeNull();
    // and the inverse: a real `.gif` URL must still pass even if the
    // CDN reports an unusual mime.
    expect(acceptWebviewMedia(null, 'application/octet-stream', 'https://cdn.example.com/foo.gif')).toBe('gif');
    // a bare CDN URL with no recognisable extension is the only place
    // where the mime header decides — `image/webp` correctly upgrades.
    expect(acceptWebviewMedia(null, 'image/webp', 'https://cdn.example.com/asset/abcd1234')).toBe('gif');
  });
});
