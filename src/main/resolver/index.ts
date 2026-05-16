import type { SniffedMedia, ResolvedMedia } from '../../shared/types';
import { resolveDirectUrl, YtDlpNotInstalledError } from './ytdlp';
import { log } from '../logger';

/**
 * Resolver dispatcher. For now every supported host is delegated to yt-dlp,
 * which already covers YouTube / X / Bilibili / Vimeo / Twitch / Reddit /
 * 1800+ extractors. We keep the host whitelist explicit so resolver can
 * never be triggered on an arbitrary URL the user pasted (defense in
 * depth on top of R-14: bundled binary + auto-resolve).
 */

const SUPPORTED_HOSTS = new Set<string>([
  'youtube.com',
  'youtu.be',
  'm.youtube.com',
  'music.youtube.com',
  'twitter.com',
  'x.com',
  'mobile.twitter.com',
  'video.twimg.com',
  'bilibili.com',
  'm.bilibili.com',
  'b23.tv',
  'player.bilibili.com',
  'www.bilibili.com',
  'vimeo.com',
  'player.vimeo.com',
  'twitch.tv',
  'clips.twitch.tv',
  'www.twitch.tv',
  'reddit.com',
  'v.redd.it',
  'tiktok.com',
  'www.tiktok.com',
  'instagram.com',
  'www.instagram.com',
  'dailymotion.com',
  'www.dailymotion.com',
  'facebook.com',
  'www.facebook.com',
  'fb.watch'
]);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function isResolvable(media: SniffedMedia): boolean {
  if (!media.requiresExternalDownload) return false;
  // Strict allow-list — the embedHost was sanitised in main process; we also
  // double-check the actual URL's host for defense in depth.
  const host = (media.embedHost || hostOf(media.url)).toLowerCase();
  if (!host) return false;
  if (SUPPORTED_HOSTS.has(host)) return true;
  // Allow common subdomains (e.g. clips.twitch.tv was already explicit, but
  // catch user-recorded uploads like *.tiktokcdn.com via parent host match).
  for (const known of SUPPORTED_HOSTS) {
    if (host === known || host.endsWith('.' + known)) return true;
  }
  return false;
}

function redactUrls(s: string): string {
  return s.replace(/https?:\/\/\S+/g, '<url>');
}

export async function resolveEmbed(media: SniffedMedia): Promise<ResolvedMedia> {
  if (!isResolvable(media)) {
    throw new Error(`embed host not supported: ${media.embedHost || hostOf(media.url) || 'unknown'}`);
  }
  // Use the iframe `src` itself (which for sniffed embeds is e.g.
  // https://www.youtube.com/embed/<id> or https://player.bilibili.com/...)
  // — yt-dlp directly supports those embed URLs. The article page URL
  // (`media.pageUrl`) is unreliable: it is whatever the user pasted and
  // would force yt-dlp's generic extractor to scrape arbitrary HTML.
  const target = media.url;
  log(`resolver: ${media.embedHost} ← ${redactUrls(target)}`);
  try {
    const r = await resolveDirectUrl(target);
    log(`resolver: ok (${r.qualityLabel || 'unknown'} ${r.width || '?'}x${r.height || '?'})`);
    return r;
  } catch (e) {
    if (e instanceof YtDlpNotInstalledError) throw e;
    log(`resolver: failed: ${redactUrls((e as Error).message)}`);
    throw e;
  }
}

export { YtDlpNotInstalledError } from './ytdlp';
export { ytdlpBinaryPath, checkYtdlp, ensureYtdlp } from './ytdlp';
