import React, { useEffect, useRef, useState } from 'react';
import type { SniffedMedia, ThumbnailResult, TaskStatus } from '../../shared/types';

interface Props {
  items: SniffedMedia[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  onProcessOne?: (id: string) => void;
  isProcessing?: (id: string) => boolean;
  /** Triggered when the user clicks "重试解析" on an embed card whose
   *  auto-resolve failed. R-14 moved bulk resolve into App's useEffect, so
   *  the grid only needs the retry callback (no host allow-list, no
   *  first-time confirm). */
  onRetryResolve?: (id: string) => void;
  /** True while a resolve request is mid-flight for a given embed. */
  isResolving?: (id: string) => boolean;
  /** Per-item resolve error message (sticky until retry). */
  resolveErrorMap?: Record<string, string>;
  /** R-30 #3: per-task processing status. When supplied (history
   *  detail modal does), each card paints a small chip on the
   *  bottom-right of the thumbnail so the user can see at a glance
   *  whether a given item succeeded / failed / is still running.
   *  The home view leaves this undefined — the home TaskTable below
   *  the grid already shows the same data, so a second indicator
   *  would be redundant. */
  taskStatusMap?: Record<string, TaskStatus>;
}

function fmtBytes(n?: number): string {
  if (!n || n <= 0) return '';
  const mb = n / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(2)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

function fmtDuration(sec?: number): string {
  if (!sec || sec <= 0) return '';
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fileName(u: string): string {
  try {
    const p = new URL(u).pathname;
    return p.split('/').pop() || u;
  } catch {
    return u;
  }
}

type ThumbState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; dataUrl: string; playable?: { url: string; kind: 'video' | 'gif' | 'image' } }
  | { status: 'error'; error: string };

/** Mirrors `ToolboxLineageModal#pathToLocalUrl` — kept inline so this
 *  module stays free of cross-component imports. Encodes the absolute
 *  path segments for safe `giftk-local://` round-trips. */
function pathToLocalUrl(absPath: string): string {
  if (!absPath) return '';
  const sep = absPath.includes('\\') ? '\\' : '/';
  const parts = absPath.split(sep).map((seg) => encodeURIComponent(seg));
  const isWin = /^[a-zA-Z]:/.test(absPath);
  const joined = isWin ? '/' + parts.filter(Boolean).join('/') : parts.join('/');
  return `giftk-local://localhost${joined}`;
}

/**
 * R-26 #1 — While yt-dlp resolves an embed there is no real progress
 * channel back to the renderer (the resolver awaits the binary then
 * returns one shot). Instead of leaving the chip on a static "解析中…"
 * label that makes users think the app froze, we walk a deterministic
 * sequence of stage labels every ~1.5s so the user gets a *signal*
 * that work is happening — same trick as the sniff-progress label
 * pump. Once the resolve actually completes (or errors), the chip is
 * unmounted by the parent so this hook is moot.
 */
const RESOLVE_STAGE_LABELS = [
  '联系视频站点…',
  '提取视频信息…',
  '匹配最佳格式…',
  '准备直链…'
] as const;

function useResolveStageLabel(active: boolean): string {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (!active) {
      setIdx(0);
      return;
    }
    setIdx(0);
    // Bias towards advancing — most yt-dlp resolves finish in 1-3s, so
    // a 1500ms tick gets the user past the first 2 stages before they
    // get bored. We cap at the last stage so a 10s+ resolve doesn't
    // wrap back to "联系视频站点…" and look like it restarted.
    const id = window.setInterval(() => {
      setIdx((cur) => Math.min(cur + 1, RESOLVE_STAGE_LABELS.length - 1));
    }, 1500);
    return () => window.clearInterval(id);
  }, [active]);
  return RESOLVE_STAGE_LABELS[idx];
}

const ResolvingChip: React.FC<{ host?: string }> = ({ host }) => {
  const stage = useResolveStageLabel(true);
  return (
    <span
      className="card-embed-tag resolving"
      title={`正在解析 ${host || '第三方'} 直链 — ${stage}`}
      role="status"
      aria-live="polite"
    >
      <span className="card-embed-spinner" aria-hidden="true" />
      <span className="card-embed-stage">{stage}</span>
    </span>
  );
};

/** Lazy-loading thumbnail fetcher. Exported so HistoryPanel (R-30 #2)
 *  can reuse the exact same IPC + IntersectionObserver path for its
 *  per-record cover image without re-implementing the protocol. */
export const Thumb: React.FC<{ media: SniffedMedia }> = ({ media }) => {
  const [state, setState] = useState<ThumbState>({ status: 'idle' });
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let started = false;
    setState({ status: 'idle' });

    const el = ref.current;
    if (!el) return;

    const trigger = () => {
      if (started || cancelled) return;
      started = true;
      setState({ status: 'loading' });
      const api = (window as unknown as { giftk: { thumbnail: (m: SniffedMedia) => Promise<ThumbnailResult> } }).giftk;
      api
        .thumbnail(media)
        .then((r) => {
          if (cancelled) return;
          if (r.status === 'ok' && r.dataUrl) {
            // R-WS-90 P5h follow-up — animate GIF/WebP/video by
            // pointing a live giftk-local:// URL at the cached
            // source whenever the main process surfaces one.
            const playable = r.localPath && (r.kind === 'gif' || r.kind === 'video')
              ? { url: pathToLocalUrl(r.localPath), kind: r.kind }
              : undefined;
            setState({ status: 'ok', dataUrl: r.dataUrl, playable });
          } else {
            setState({ status: 'error', error: r.error || 'thumbnail failed' });
          }
        })
        .catch((e: Error) => {
          if (cancelled) return;
          setState({ status: 'error', error: e.message || String(e) });
        });
    };

    if (typeof IntersectionObserver === 'undefined') {
      trigger();
      return () => {
        cancelled = true;
      };
    }

    const root = el.closest('.media-grid') as Element | null;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            trigger();
            io.disconnect();
            break;
          }
        }
      },
      { root, rootMargin: '200px' }
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [media, media.id, media.url]);

  return (
    <div
      ref={ref}
      className="card-thumb"
      title={
        state.status === 'error'
          ? `缩略图生成失败:${state.error}\n(仅缩略图链路失败,不影响后续解析与转换尝试)`
          : undefined
      }
    >
      {state.status === 'ok' && state.playable
        ? (state.playable.kind === 'video'
            ? (
              <video
                className="card-thumb-media"
                src={state.playable.url}
                muted
                autoPlay
                loop
                playsInline
                preload="auto"
                poster={state.dataUrl}
              />
            )
            : (
              <img src={state.playable.url} alt="" loading="lazy" />
            ))
        : state.status === 'ok' && <img src={state.dataUrl} alt="" loading="lazy" />}
      {state.status === 'loading' && <div className="thumb-skeleton" />}
      {state.status === 'idle' && <div className="thumb-skeleton dim" />}
      {state.status === 'error' && (
        <>
          <div className="thumb-skeleton dim" />
          <div className="thumb-error-center" aria-label="缩略图生成失败">
            <span>!</span>
          </div>
        </>
      )}
    </div>
  );
};

export const MediaGrid: React.FC<Props> = ({ items, selected, onToggle, onOpen, onProcessOne, isProcessing, onRetryResolve, isResolving, resolveErrorMap, taskStatusMap }) => {
  if (items.length === 0) {
    return (
      <div className="media-grid empty">
        <div className="grid-empty">暂无媒体,先嗅探一个 URL 吧。</div>
      </div>
    );
  }
  return (
    <div className="media-grid">
      {items.map((m) => {
        const isSel = selected.has(m.id);
        const dim = m.width && m.height ? `${m.width}×${m.height}` : '';
        const dur = fmtDuration(m.durationSec);
        const isEmbed = !!m.requiresExternalDownload;
        const isResolved = !!m.resolved;
        const canProcess = !!onProcessOne && (m.kind === 'video' || m.kind === 'gif') && (!isEmbed || isResolved);
        const busy = !!isProcessing && isProcessing(m.id);
        const resolving = !!isResolving && isResolving(m.id);
        const resolveError = resolveErrorMap?.[m.id];
        const handleProcess = (e: React.SyntheticEvent) => {
          e.stopPropagation();
          e.preventDefault();
          if (!onProcessOne || busy) return;
          onProcessOne(m.id);
        };
        const handleRetry = (e: React.SyntheticEvent) => {
          e.stopPropagation();
          e.preventDefault();
          if (!onRetryResolve || resolving) return;
          onRetryResolve(m.id);
        };
        return (
          <div
            key={m.id}
            className={`media-card ${isSel ? 'checked' : ''}`}
            tabIndex={0}
            role="button"
            aria-pressed={isSel}
            onClick={() => onOpen(m.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              onOpen(m.id);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpen(m.id);
              }
            }}
          >
            <div className="card-thumb-wrap">
              <Thumb media={m} />
              <span className={`badge ${m.kind} card-badge`}>{m.kind}</span>
              {/* R-30 #3: per-task status chip on the bottom-right
                  of the thumbnail. Only rendered when the parent
                  passes a taskStatusMap (history detail modal) and
                  this item has an entry in it. The "in-flight"
                  bucket covers every non-terminal status so the
                  user sees a single rotating indicator while a job
                  is running rather than 5 different glyphs as it
                  walks through downloading/segmenting/converting/
                  compressing. */}
              {(() => {
                const st = taskStatusMap?.[m.id];
                if (!st) return null;
                if (st === 'done') {
                  return (
                    <span className="card-status-chip done" title="处理成功" aria-label="done">
                      ✓
                    </span>
                  );
                }
                if (st === 'failed') {
                  return (
                    <span className="card-status-chip failed" title="处理失败" aria-label="failed">
                      ✗
                    </span>
                  );
                }
                if (st === 'cancelled') {
                  return (
                    <span className="card-status-chip cancelled" title="已取消" aria-label="cancelled">
                      ⊘
                    </span>
                  );
                }
                if (st === 'skipped') {
                  return (
                    <span className="card-status-chip skipped" title="已跳过" aria-label="skipped">
                      –
                    </span>
                  );
                }
                // pending / downloading / probing / segmenting /
                // converting / compressing — collapse into one
                // rotating chip.
                return (
                  <span
                    className="card-status-chip running"
                    title={`处理中 · ${st}`}
                    aria-label="running"
                  >
                    <span className="card-status-spinner" aria-hidden />
                  </span>
                );
              })()}
              <label
                className="card-check"
                onClick={(e) => e.stopPropagation()}
                title={
                  isEmbed && !isResolved
                    ? (resolving
                        ? '解析中,完成后会自动勾选'
                        : '该 embed 未解析直链,无法勾选(等解析完成或点击 ↻ 重试)')
                    : undefined
                }
              >
                <input
                  type="checkbox"
                  checked={isSel}
                  // F1 (post R-27): embed videos cannot be ticked until
                  // yt-dlp returns a resolved direct URL. Disabling here
                  // (in tandem with App.tsx toggleSelected guard) makes
                  // the affordance match the underlying capability.
                  disabled={isEmbed && !isResolved}
                  onChange={() => onToggle(m.id)}
                  onClick={(e) => e.stopPropagation()}
                />
              </label>
              {canProcess ? (
                <button
                  type="button"
                  className={`card-process-btn ${busy ? 'busy' : ''}`}
                  tabIndex={0}
                  aria-label="处理此项"
                  title={busy ? '该项正在处理中…' : '处理此项'}
                  disabled={busy}
                  onClick={handleProcess}
                  onMouseDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      handleProcess(e);
                    }
                  }}
                >
                  {busy ? '处理中…' : isResolved ? '▶ 处理(已解析)' : '▶ 处理此项'}
                </button>
              ) : isEmbed && !isResolved && resolving ? (
                <ResolvingChip host={m.embedHost} />
              ) : isEmbed && !isResolved && resolveError ? (
                <button
                  type="button"
                  className="card-resolve-retry"
                  tabIndex={0}
                  aria-label="重试解析"
                  title={`解析失败:${resolveError} · 点击重试`}
                  onClick={handleRetry}
                  onMouseDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      handleRetry(e);
                    }
                  }}
                >
                  ↻ 重试解析
                </button>
              ) : isEmbed && !isResolved ? (
                <span
                  className="card-embed-tag"
                  title={`视频由 ${m.embedHost || '第三方'} 嵌入,等待自动解析…`}
                >
                  {m.embedHost || '第三方'} 嵌入
                </span>
              ) : null}
              {isResolved ? (
                <span
                  className="card-resolved-tag"
                  title={`已解析 · ${m.resolved?.qualityLabel || ''} ${m.resolved?.extractor || ''}`}
                >
                  ✓ 已解析{m.resolved?.qualityLabel ? ` · ${m.resolved.qualityLabel}` : ''}
                </span>
              ) : null}
            </div>
            <div className="card-meta">
              <div className="card-name" title={m.url}>{fileName(m.url)}</div>
              <div className="card-info">
                {dim ? <span>{dim}</span> : null}
                {dur ? <span>{dur}</span> : null}
                {m.sizeBytes ? <span>{fmtBytes(m.sizeBytes)}</span> : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
