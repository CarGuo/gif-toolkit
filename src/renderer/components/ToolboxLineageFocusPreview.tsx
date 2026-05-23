/**
 * Focus-node preview surface — extracted from ToolboxLineageModal so
 * the modal stays under our 600-line file ceiling (R-TB-LOG-V1.1
 * follow-up).
 *
 * Auto-playing preview of the current focus node:
 *   - GIF / animated WebP / static image via <img>
 *   - Video (mp4/mov/webm/mkv/m4v) via muted-autoplay-loop <video>
 *
 * R-TB-CHAIN-V2.7 — error-handling: track `errored` via onError, fall
 * back to the panel-provided posterDataUrl, and finally to an explicit
 * "预览不可用" message so failures never look like a "黑屏 bug".
 *
 * R-COMPRESS-V1 #4 — When `trialPath` is set, the preview renders the
 * trial-run output (a 0.5s tmp clip under `os.tmpdir()/giftk-trial-*`)
 * instead of the focus node's path. Parent owns trialPath lifecycle.
 */
import { useEffect, useState } from 'react';

/** Custom protocol mirror of `src/main/offlineImport.ts#toGiftkLocalUrl`.
 *  Renderer-side helper because the path-to-URL mapping is symmetric
 *  and adding a preload bridge for one shape would be overkill. */
export function pathToLocalUrl(absPath: string): string {
  if (!absPath) return '';
  // Normalise path separators per platform; encode each segment so
  // characters like `?`, `#`, spaces, Chinese names survive the URL
  // round-trip cleanly. Win32: prepend `/` after the host.
  const sep = absPath.includes('\\') ? '\\' : '/';
  const parts = absPath.split(sep).map((seg) => encodeURIComponent(seg));
  const isWin = /^[a-zA-Z]:/.test(absPath);
  const joined = isWin ? '/' + parts.filter(Boolean).join('/') : parts.join('/');
  return `giftk-local://localhost${joined}`;
}

function detectKind(p: string | null | undefined): 'gif' | 'webp' | 'video' | 'image' | 'other' {
  if (!p) return 'other';
  const lower = p.toLowerCase();
  if (lower.endsWith('.gif')) return 'gif';
  if (lower.endsWith('.webp')) return 'webp';
  if (/\.(mp4|mov|webm|mkv|m4v)$/.test(lower)) return 'video';
  if (/\.(png|jpe?g|bmp)$/.test(lower)) return 'image';
  return 'other';
}

export interface FocusPreviewProps {
  path: string | null | undefined;
  posterDataUrl?: string | null;
  trialPath?: string | null;
}

export function FocusPreview({
  path,
  posterDataUrl,
  trialPath
}: FocusPreviewProps): JSX.Element {
  // Trial output (when present) takes precedence over focus path so
  // the user sees the would-be next-step output, not the input.
  const renderPath = trialPath || path || null;
  const kind = detectKind(renderPath);
  const url = renderPath ? pathToLocalUrl(renderPath) : '';
  const [errored, setErrored] = useState(false);
  useEffect(() => { setErrored(false); }, [url]);
  if (!url) {
    return <div className="tb-lineage-preview-empty" aria-hidden="true">🎞️</div>;
  }
  if (errored) {
    if (posterDataUrl) {
      return (
        <img
          className="tb-lineage-preview-media"
          src={posterDataUrl}
          alt="预览静态首帧"
          loading="eager"
        />
      );
    }
    return (
      <div className="tb-lineage-preview-error" role="status">
        <div className="tb-lineage-preview-error-icon" aria-hidden="true">⚠️</div>
        <div className="tb-lineage-preview-error-text">预览不可用</div>
        <div className="tb-lineage-preview-error-hint">文件可能已被移动或删除</div>
      </div>
    );
  }
  if (kind === 'video') {
    return (
      <video
        className="tb-lineage-preview-media"
        src={url}
        muted
        autoPlay
        loop
        playsInline
        preload="auto"
        onError={() => setErrored(true)}
      />
    );
  }
  // gif / webp / image — animated formats loop natively now that the
  // giftk-local:// protocol handler returns a proper Content-Type.
  return (
    <img
      className="tb-lineage-preview-media"
      src={url}
      alt=""
      loading="eager"
      onError={() => setErrored(true)}
    />
  );
}
