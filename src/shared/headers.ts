/**
 * R-53 — Single source of truth for the "outbound CDN headers we are
 * willing to forward" allow-list.
 *
 * Two paths historically maintained their own near-identical Set:
 *   - src/main/resolver/ytdlp.ts → sanitizeHeaders() (synthesises headers
 *     from yt-dlp's extractor JSON)
 *   - src/main/index.ts → sanitizeResolved() (validates ResolvedMedia
 *     payloads coming back from the renderer)
 *
 * They drifted (R-52 review caught a missing entry) so we lift the list
 * here and re-export `as const` so any future addition is one edit and
 * the TypeScript compiler refuses imports that try to local-shadow it.
 *
 * What may pass:
 *   - User-Agent / Referer / Origin           → CDN bot detection
 *   - Accept / Accept-Language / Accept-Encoding → content negotiation
 *   - Range                                   → progressive video fetch
 *   - X-CSRF-Token / X-Requested-With         → some Bilibili / TikTok m3u8
 *
 * What is rejected by intent:
 *   - Authorization / Cookie / Set-Cookie     → never proxy authn
 *   - Host / :authority                       → must match the URL
 *   - Proxy-* / Forwarded                     → infrastructure-only
 *   - Anything else not on the allowlist
 */
export const RESOLVED_HEADER_ALLOWLIST = new Set<string>([
  'user-agent',
  'referer',
  'origin',
  'accept',
  'accept-language',
  'accept-encoding',
  'range',
  'x-csrf-token',
  'x-requested-with'
]);

/**
 * Whitelist for `SniffedMedia.source` literals, used by main's
 * sanitizeMedia to refuse forged / future / typo-ed source tags.
 *
 * Keep in 1:1 sync with the union in src/shared/types.ts → SniffedMedia.source.
 * If you add a new sniffer that produces a new source tag, you must also
 * add it here, otherwise main will silently drop the tag and downstream
 * dedup may treat the same URL twice.
 */
export const SNIFFED_MEDIA_SOURCES = new Set<string>([
  'video-tag',
  'source-tag',
  'img-tag',
  'og-meta',
  'link',
  'json-ld',
  'pattern',
  'iframe-embed',
  'webview',
  'ytdlp-direct'
]);

/**
 * Generic header sanitiser used by both main entry points. Returns a new
 * object containing only header pairs that pass:
 *   - key matches /^[A-Za-z0-9-]+$/
 *   - key (lowercased) is in RESOLVED_HEADER_ALLOWLIST
 *   - value is a string ≤ 1024 chars with no CR/LF/NUL
 */
export function sanitizeAllowlistedHeaders(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h || typeof h !== 'object') return out;
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
    if (typeof k !== 'string') continue;
    if (typeof v !== 'string') continue;
    if (!/^[A-Za-z0-9-]+$/.test(k)) continue;
    if (!RESOLVED_HEADER_ALLOWLIST.has(k.toLowerCase())) continue;
    if (v.length > 1024) continue;
    if (/[\r\n]/.test(v) || v.indexOf('\u0000') !== -1) continue;
    out[k] = v;
  }
  return out;
}
