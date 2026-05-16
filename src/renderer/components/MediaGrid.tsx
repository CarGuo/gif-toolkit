import React, { useEffect, useRef, useState } from 'react';
import type { SniffedMedia, ThumbnailResult } from '../../shared/types';

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
  | { status: 'ok'; dataUrl: string }
  | { status: 'error'; error: string };

const Thumb: React.FC<{ media: SniffedMedia }> = ({ media }) => {
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
            setState({ status: 'ok', dataUrl: r.dataUrl });
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
    <div ref={ref} className="card-thumb" title={state.status === 'error' ? state.error : undefined}>
      {state.status === 'ok' && <img src={state.dataUrl} alt="" loading="lazy" />}
      {state.status === 'loading' && <div className="thumb-skeleton" />}
      {state.status === 'idle' && <div className="thumb-skeleton dim" />}
      {state.status === 'error' && (
        <div className="thumb-error">
          <span>!</span>
        </div>
      )}
    </div>
  );
};

export const MediaGrid: React.FC<Props> = ({ items, selected, onToggle, onOpen, onProcessOne, isProcessing, onRetryResolve, isResolving, resolveErrorMap }) => {
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
              <label
                className="card-check"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  checked={isSel}
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
                <span
                  className="card-embed-tag resolving"
                  title={`正在解析 ${m.embedHost || '第三方'} 直链…`}
                >
                  ⏳ 解析中…
                </span>
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
