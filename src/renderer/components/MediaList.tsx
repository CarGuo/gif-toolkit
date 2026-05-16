import React, { useEffect, useRef, useState } from 'react';
import type { SniffedMedia, ThumbnailResult } from '../../shared/types';

interface Props {
  items: SniffedMedia[];
  selected: Set<string>;
  activeId: string | null;
  onToggle: (id: string) => void;
  onActivate: (id: string) => void;
}

function fmtBytes(n?: number): string {
  if (!n || n <= 0) return '';
  const mb = n / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(2)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
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

    // Use the closest scrollable list as root so off-screen rows don't fire too early.
    const root = el.closest('.media-list') as Element | null;
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
    <div ref={ref} className="thumb" title={state.status === 'error' ? state.error : undefined}>
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

export const MediaList: React.FC<Props> = ({ items, selected, activeId, onToggle, onActivate }) => {
  if (items.length === 0) {
    return (
      <div className="media-list" style={{ color: 'var(--muted)', padding: 16 }}>
        暂无媒体,先嗅探一个 URL 吧。
      </div>
    );
  }
  return (
    <div className="media-list">
      {items.map((m) => {
        const isSel = selected.has(m.id);
        const isAct = activeId === m.id;
        return (
          <div
            key={m.id}
            className={`media-item ${isSel ? 'checked' : ''} ${isAct ? 'selected' : ''}`}
            onClick={() => onActivate(m.id)}
          >
            <div
              className="check"
              onClick={(e) => {
                e.stopPropagation();
                onToggle(m.id);
              }}
            />
            <Thumb media={m} />
            <div className="meta">
              <div className="name">
                <span className={`badge ${m.kind}`}>{m.kind}</span>
                {fileName(m.url)}
              </div>
              <div className="info">
                {m.source} · {fmtBytes(m.sizeBytes)} {m.mime ? ` · ${m.mime}` : ''}
              </div>
              <div className="info" style={{ opacity: 0.6 }}>
                {m.url.length > 70 ? m.url.slice(0, 70) + '…' : m.url}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
