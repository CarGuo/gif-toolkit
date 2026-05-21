/**
 * R-WS-90 P5h — 本地产物文件缩略图 hook.
 *
 * Why:
 *   上传历史 / 历史详情的产物列表里,用户希望"一眼看出每行是哪个图",
 *   纯文件名易看错且没有视觉锚点。给每行加一张小缩略图能让筛选/复制
 *   url 时识别正确目标的成本接近 0。
 *
 * 渲染策略 (按成本从低到高):
 *   1. 已上传成功 (status === 'done' && url) → 直接 <img src={url}>。
 *      远端 CDN 已经缓存,浏览器还会本地缓存 — 零额外 IPC,首屏最快。
 *   2. 否则 → 调用主进程 `toolbox:firstFrame` 拿首帧 JPEG dataUrl。
 *      已存在的 IPC,扩展名白名单覆盖 .gif/.webp/.mp4/.mov/.webm/.mkv/.m4v
 *      — 这正是上传产物会出现的全部类型。
 *   3. 失败/不支持 → 返回 null,上层渲染降级占位符 (扩展名徽标)。
 *
 * 注意:
 *   - hook 内部维护一个 module-scope LRU 缓存,避免页面切换/上拖回滚
 *     时反复触发 ffmpeg 抽帧 (每次 ~30ms-200ms)。LRU 上限 256 项
 *     (最坏情况 256 * ~50KB JPEG ≈ 12MB,可接受)。
 *   - 跑在 vitest jsdom 环境时 `window.giftk` 不存在 → hook 直接返回
 *     loading=false / dataUrl=null,组件可以无侵入地降级到占位符。
 */
import { useEffect, useRef, useState } from 'react';

/** Module-scope LRU. Map 保证插入顺序,超容量时丢弃最久没访问的 key. */
const CACHE = new Map<string, string | null>();
const CACHE_MAX = 256;

function cacheGet(key: string): string | null | undefined {
  if (!CACHE.has(key)) return undefined;
  const v = CACHE.get(key) ?? null;
  // LRU touch — 删除再插入即把它移到最近一次访问位置.
  CACHE.delete(key);
  CACHE.set(key, v);
  return v;
}
function cacheSet(key: string, value: string | null): void {
  if (CACHE.has(key)) CACHE.delete(key);
  CACHE.set(key, value);
  while (CACHE.size > CACHE_MAX) {
    const first = CACHE.keys().next().value;
    if (typeof first !== 'string') break;
    CACHE.delete(first);
  }
}

export interface FileThumbnailState {
  /** 解析完成的 dataUrl (or 远端 url),或 null 表示降级占位符. */
  src: string | null;
  /** 是否还在拉取中 (仅本地路径分支才会经历此态). */
  loading: boolean;
}

/**
 * 给一个本地产物路径取小缩略图。
 *
 * @param filePath 绝对磁盘路径 (上传产物的 filePath)。
 * @param remoteUrl 已上传成功后的远端 URL，传入后直接复用、不再调用 IPC。
 */
export function useFileThumbnail(
  filePath: string | undefined | null,
  remoteUrl?: string | undefined | null
): FileThumbnailState {
  const [state, setState] = useState<FileThumbnailState>(() => {
    if (typeof remoteUrl === 'string' && remoteUrl.length > 0) {
      return { src: remoteUrl, loading: false };
    }
    if (typeof filePath === 'string' && filePath.length > 0) {
      const cached = cacheGet(filePath);
      if (cached !== undefined) return { src: cached, loading: false };
    }
    return { src: null, loading: !!filePath };
  });
  // 防止已 unmount 的 setState.
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  useEffect(() => {
    // 远端 URL 优先 — 0 成本.
    if (typeof remoteUrl === 'string' && remoteUrl.length > 0) {
      setState({ src: remoteUrl, loading: false });
      return;
    }
    if (typeof filePath !== 'string' || filePath.length === 0) {
      setState({ src: null, loading: false });
      return;
    }
    const cached = cacheGet(filePath);
    if (cached !== undefined) {
      setState({ src: cached, loading: false });
      return;
    }
    const giftk = (typeof window !== 'undefined' ? window.giftk : undefined);
    if (!giftk || typeof giftk.toolboxFirstFrame !== 'function') {
      // 测试环境或老 build — 直接降级,不抛错.
      cacheSet(filePath, null);
      setState({ src: null, loading: false });
      return;
    }
    setState({ src: null, loading: true });
    let cancelled = false;
    void (async () => {
      try {
        const r = await giftk.toolboxFirstFrame(filePath);
        if (cancelled || !aliveRef.current) return;
        const url = (r && typeof r.dataUrl === 'string' && r.dataUrl.length > 0)
          ? r.dataUrl
          : null;
        cacheSet(filePath, url);
        setState({ src: url, loading: false });
      } catch {
        // ffmpeg 失败 / 扩展名不支持 / 文件被移走 — 全部降级占位符,
        // 缓存 null 也防止对同一坏路径反复重试.
        if (cancelled || !aliveRef.current) return;
        cacheSet(filePath, null);
        setState({ src: null, loading: false });
      }
    })();
    return () => { cancelled = true; };
  }, [filePath, remoteUrl]);

  return state;
}

/** 测试钩子:清空模块缓存。仅供单测重置用,不在生产代码调用。 */
export function __resetFileThumbnailCacheForTests(): void {
  CACHE.clear();
}
