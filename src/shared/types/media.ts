import type { MediaKind } from '../mediaKind';
export type { MediaKind };

export interface ResolvedMedia {
  /** Direct streamable URL (mp4/m4s/webm/etc) extracted by the resolver. */
  url: string;
  mime?: string;
  /** Headers required by the CDN (e.g. Referer for Bilibili). Sanitised by main. */
  headers?: Record<string, string>;
  qualityLabel?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  sizeBytes?: number;
  /** Provider tag, currently always 'ytdlp'. */
  source: 'ytdlp';
  /** Extractor name reported by yt-dlp (e.g. "youtube", "twitter", "bilibili"). */
  extractor?: string;
  title?: string;
}

export interface SniffedMedia {
  id: string;
  url: string;
  kind: MediaKind;
  mime?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  sizeBytes?: number;
  poster?: string;
  source: 'video-tag' | 'source-tag' | 'img-tag' | 'og-meta' | 'link' | 'json-ld' | 'pattern' | 'iframe-embed' | 'webview' | 'ytdlp-direct';
  pageUrl: string;
  /** True for embeds (Vimeo / YouTube / etc.) whose underlying media stream
   *  cannot be retrieved via a plain HTTP GET. Renderer should disable the
   *  process action and surface a hint to the user instead. */
  requiresExternalDownload?: boolean;
  /** Hostname of the embed provider (e.g. "vimeo.com", "youtube.com").
   *  Only set when `requiresExternalDownload` is true. */
  embedHost?: string;
  /** Populated AFTER the user opts in to "解析直链". Once set, the embed
   *  becomes a regular video task: processor downloads `resolved.url`
   *  with `resolved.headers`. */
  resolved?: ResolvedMedia;
}

export interface SniffResult {
  pageUrl: string;
  title?: string;
  items: SniffedMedia[];
  /**
   * R-67 — Reserved for *real* failures the user needs to act on
   * (timeout, fetch error, headless crash, "no media found"). Renderer
   * shows these in red. New informational messages should go to
   * `infoNotices` instead so they don't masquerade as errors.
   */
  warnings: string[];
  /**
   * R-67 — Soft, by-design notices that are NOT failures. Examples:
   * "已自动过滤 N 个静态图像", "命中已知 embed,跳过 HEAD probe". Renderer
   * shows these in muted/info style. Optional for back-compat — older
   * call sites that emit only `warnings` continue to work unchanged.
   */
  infoNotices?: string[];
}

export type SniffStage =
  | 'fetching'   // downloading the article HTML
  | 'parsing'    // parsing DOM, extracting media tags
  | 'probing'    // HEAD requests to fill mime/size
  | 'done';

export interface SniffProgress {
  stage: SniffStage;
  percent: number;       // 0..100
  message?: string;
  found?: number;        // total media items discovered so far
  probed?: number;       // probed count (during 'probing')
  total?: number;        // total to probe
}
