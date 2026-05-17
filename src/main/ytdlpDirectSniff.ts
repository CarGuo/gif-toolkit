import crypto from 'crypto';
import { log } from './logger';
import { resolveDirectUrl, YtDlpNotInstalledError, ensurePublicHttp } from './resolver/ytdlp';
import type { SniffResult, SniffedMedia, SniffProgress, ResolvedMedia, MediaKind } from '../shared/types';

/**
 * R-52 — yt-dlp direct sniff. The third tier in the sniff cascade,
 * complementing R-44 (embedded webview) and R-51 (real-Chrome + CDP):
 *
 *   ① embedded webview    → fast, fails on heavy Cloudflare TLS/JA3
 *   ② real-Chrome + CDP   → bypasses Cloudflare via real browser TLS
 *   ③ yt-dlp direct (R-52)→ no webview at all, hand the page URL to
 *                            yt-dlp's 1900+ extractors (YouTube /
 *                            Twitter / TikTok / Bilibili / Reddit / …),
 *                            return the resolved direct media as a
 *                            single SniffedMedia.
 *
 * This path is intentionally NOT a generic webpage scraper — it ONLY
 * works when the URL maps to one of yt-dlp's extractors. For an
 * arbitrary blog/news page, yt-dlp will fail and we surface a clear
 * Chinese hint telling the user to fall back to ① or ②.
 *
 * R-53 hardening:
 *   - signal is now propagated all the way down to the spawned yt-dlp
 *     child process so the user's "取消" button actually kills the
 *     subprocess (the previous Promise.race only let the outer promise
 *     reject while yt-dlp kept running for many seconds).
 *   - input URL is normalised through ensurePublicHttp so an SSRF / IPv6
 *     literal cannot reach yt-dlp.
 *   - error classification distinguishes login-wall / 403 / 429 / network
 *     so the renderer surface a more actionable hint.
 */

export interface YtdlpDirectSniffOpts {
  onProgress?: (p: SniffProgress) => void;
  signal?: AbortSignal;
}

function pickKind(mime?: string): MediaKind {
  if (!mime) return 'video';
  const lower = mime.toLowerCase();
  if (lower.startsWith('image/gif')) return 'gif';
  if (lower.startsWith('image/')) return 'image';
  return 'video';
}

function shortHash(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
}

/**
 * Build a single SniffedMedia from a ResolvedMedia returned by
 * resolveDirectUrl(). The renderer can dispatch this straight into the
 * processor — `requiresExternalDownload` is false because the direct
 * URL is already in `resolved.url`.
 *
 * R-53 — id is derived from the *page URL* rather than the resolved
 * direct URL. Many sites (YouTube googlevideo, Bilibili szbdyd) sign
 * direct URLs with a one-shot expiring token; using `resolved.url` for
 * the ID would yield a fresh ID on every retry and break dedup against
 * a sniff history that pinned the page. Page URL is stable per-video
 * even when the underlying CDN URL rotates.
 *
 * Exported for unit testing in isolation from yt-dlp.
 */
export function buildSniffedMediaFromResolved(
  pageUrl: string,
  resolved: ResolvedMedia
): SniffedMedia {
  const kind = pickKind(resolved.mime);
  const id = `ytdlp-direct-${shortHash(pageUrl)}`;
  return {
    id,
    url: resolved.url,
    kind,
    mime: resolved.mime,
    width: resolved.width,
    height: resolved.height,
    durationSec: resolved.durationSec,
    sizeBytes: resolved.sizeBytes,
    source: 'ytdlp-direct',
    pageUrl,
    requiresExternalDownload: false,
    resolved
  };
}

/**
 * R-53 — Map yt-dlp stderr / Error.message to a user-facing Chinese hint.
 * Five categories are recognised:
 *   - not-installed → friendly offline notice
 *   - aborted       → user cancel
 *   - unsupported   → site not in extractor list
 *   - login-wall    → private / age-gated / region-locked / pay-walled
 *   - rate-limit    → 429 / 403 / "Sign in to confirm you're not a bot"
 *   - network       → generic socket / DNS / TLS failure
 */
function classifyYtdlpError(err: Error): Error {
  if (err instanceof YtDlpNotInstalledError) {
    return new Error(
      'yt-dlp 不可用(可能离线且本地无缓存)。请联网后重试,或改用「嵌入式嗅探 / 真 Chrome 嗅探」。'
    );
  }
  const msg = err.message || String(err);
  if (msg === '用户取消' || msg === 'aborted') {
    return new Error('用户取消');
  }
  // Login wall / private / region locked / age gate.
  if (
    /sign in|log in|login required|private video|members[- ]only|age[- ]restricted|geo[- ]restricted|not available in your country|account.*required|confirm you're not a bot/i.test(msg)
  ) {
    return new Error(
      `该资源需要登录 / 已设私密 / 被地区限制。请改用「真 Chrome 嗅探」并在浏览器内完成登录。\n原始错误: ${msg.slice(0, 280)}`
    );
  }
  // Rate-limit / blocked.
  if (/HTTP Error 429|HTTP Error 403|too many requests|throttle|blocked by|rate.?limit/i.test(msg)) {
    return new Error(
      `站点限流或临时拒绝 (429 / 403)。请稍后重试,或改用「真 Chrome 嗅探」走真实浏览器握手。\n原始错误: ${msg.slice(0, 280)}`
    );
  }
  // Unsupported / no formats.
  if (/Unsupported URL|no playable format|no formats|no video formats found/i.test(msg)) {
    return new Error(
      `yt-dlp 不支持该站点或未找到可下载的视频格式。请改用「嵌入式嗅探」或「真 Chrome 嗅探」。\n原始错误: ${msg.slice(0, 280)}`
    );
  }
  // Network-ish.
  if (/getaddrinfo|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up|TLS|SSL/i.test(msg)) {
    return new Error(`网络错误: ${msg.slice(0, 280)}`);
  }
  return new Error(`yt-dlp 解析失败: ${msg.slice(0, 280)}`);
}

/**
 * Hand `url` directly to yt-dlp; resolve the best progressive format and
 * return it as a 1-item SniffResult. If yt-dlp doesn't recognise the
 * site OR the network call fails, throw with a friendly Chinese message
 * so the renderer can surface "请改用嵌入式 / 真 Chrome 嗅探".
 */
export async function sniffViaYtdlp(
  url: string,
  opts: YtdlpDirectSniffOpts = {}
): Promise<SniffResult> {
  const { onProgress, signal } = opts;
  if (signal?.aborted) {
    throw new Error('用户取消');
  }
  // R-53 — validate input through the same SSRF-blocking gate the
  // resolver uses so a forged renderer payload (or a stale renderer
  // pointing at 127.0.0.1) cannot reach yt-dlp.
  let safeUrl: string;
  try {
    safeUrl = ensurePublicHttp(url);
  } catch (e) {
    throw new Error(`URL 不可用: ${(e as Error).message}`);
  }

  onProgress?.({ stage: 'fetching', percent: 5, message: '正在调用 yt-dlp 解析直链…' });

  let resolved: ResolvedMedia;
  try {
    log(`[ytdlp-direct] resolving ${safeUrl}`);
    onProgress?.({ stage: 'parsing', percent: 35, message: '探测可用清晰度…' });
    // R-53 — pass signal through so abort actually kills the spawned
    // yt-dlp child (see resolver/ytdlp.ts getInfoSpawn).
    resolved = await resolveDirectUrl(safeUrl, signal);
  } catch (e) {
    throw classifyYtdlpError(e as Error);
  }

  onProgress?.({ stage: 'parsing', percent: 85, message: '收尾…' });
  const item = buildSniffedMediaFromResolved(safeUrl, resolved);
  onProgress?.({ stage: 'done', percent: 100, found: 1 });

  log(
    `[ytdlp-direct] ✓ ${resolved.qualityLabel ?? ''} ${resolved.width ?? '?'}x${resolved.height ?? '?'}` +
      ` (${resolved.extractor ?? 'unknown'})`
  );

  return {
    pageUrl: safeUrl,
    title: resolved.title,
    items: [item],
    warnings: []
  };
}
