import crypto from 'crypto';
import { log } from './logger';
import { resolveDirectUrl, YtDlpNotInstalledError } from './resolver/ytdlp';
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
 * Exported for unit testing in isolation from yt-dlp.
 */
export function buildSniffedMediaFromResolved(
  pageUrl: string,
  resolved: ResolvedMedia
): SniffedMedia {
  const kind = pickKind(resolved.mime);
  const id = `ytdlp-direct-${shortHash(resolved.url)}`;
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

  onProgress?.({ stage: 'fetching', percent: 5, message: '正在调用 yt-dlp 解析直链…' });

  let cancelHook: (() => void) | null = null;
  const cancelPromise = new Promise<never>((_, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(new Error('用户取消'));
      return;
    }
    cancelHook = (): void => reject(new Error('用户取消'));
    signal.addEventListener('abort', cancelHook, { once: true });
  });

  let resolved: ResolvedMedia;
  try {
    log(`[ytdlp-direct] resolving ${url}`);
    onProgress?.({ stage: 'parsing', percent: 35, message: '探测可用清晰度…' });
    const work = resolveDirectUrl(url);
    resolved = signal ? await Promise.race([work, cancelPromise]) : await work;
  } catch (e) {
    if (cancelHook && signal) {
      try { signal.removeEventListener('abort', cancelHook); } catch { /* ignore */ }
    }
    if (e instanceof YtDlpNotInstalledError) {
      throw new Error(
        'yt-dlp 不可用(可能离线且本地无缓存)。请联网后重试,或改用「嵌入式嗅探 / 真 Chrome 嗅探」。'
      );
    }
    const msg = (e as Error).message || String(e);
    if (msg === '用户取消' || msg === 'aborted') {
      throw new Error('用户取消');
    }
    if (/Unsupported URL/i.test(msg) || /no playable format/i.test(msg) || /no formats/i.test(msg)) {
      throw new Error(
        `yt-dlp 不支持该站点或未找到可下载的视频格式。请改用「嵌入式嗅探」或「真 Chrome 嗅探」。\n原始错误: ${msg}`
      );
    }
    throw new Error(`yt-dlp 解析失败: ${msg}`);
  } finally {
    if (cancelHook && signal) {
      try { signal.removeEventListener('abort', cancelHook); } catch { /* ignore */ }
    }
  }

  onProgress?.({ stage: 'probing', percent: 85, message: '收尾…' });
  const item = buildSniffedMediaFromResolved(url, resolved);
  onProgress?.({ stage: 'done', percent: 100, found: 1 });

  log(
    `[ytdlp-direct] ✓ ${resolved.qualityLabel ?? ''} ${resolved.width ?? '?'}x${resolved.height ?? '?'}` +
      ` (${resolved.extractor ?? 'unknown'})`
  );

  return {
    pageUrl: url,
    title: resolved.title,
    items: [item],
    warnings: []
  };
}
