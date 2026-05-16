import React, { useCallback, useEffect, useRef, useState } from 'react';

interface Props {
  duration: number;
  start: number;
  end: number;
  maxSegmentSec: number;
  currentTime: number;
  onChange: (start: number, end: number) => void;
  onSeek: (t: number) => void;
}

type DragMode = null | 'left' | 'right' | 'move' | 'seek';

interface DragOrigin {
  mode: DragMode;
  start: number;
  end: number;
  offset: number;
}

export const Timeline: React.FC<Props> = ({ duration, start, end, maxSegmentSec, currentTime, onChange, onSeek }) => {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragMode>(null);
  const dragOriginRef = useRef<DragOrigin | null>(null);

  const safeDur = duration > 0 ? duration : 1;
  const pct = (t: number) => `${Math.max(0, Math.min(100, (t / safeDur) * 100))}%`;

  const xToTime = useCallback(
    (clientX: number): number => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || duration <= 0) return 0;
      const r = (clientX - rect.left) / rect.width;
      return Math.max(0, Math.min(duration, r * duration));
    },
    [duration]
  );

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      if (duration <= 0) return;
      const orig = dragOriginRef.current;
      if (!orig) return;
      const t = xToTime(e.clientX);
      if (drag === 'left') {
        onChange(Math.min(t, orig.end - 0.5), orig.end);
      } else if (drag === 'right') {
        onChange(orig.start, Math.max(t, orig.start + 0.5));
      } else if (drag === 'move') {
        const len = orig.end - orig.start;
        let newStart = t - orig.offset;
        newStart = Math.max(0, Math.min(duration - len, newStart));
        onChange(newStart, newStart + len);
      } else if (drag === 'seek') {
        onSeek(t);
      }
    };
    const up = () => {
      setDrag(null);
      dragOriginRef.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [drag, duration, onChange, onSeek, xToTime]);

  const startDrag = (mode: Exclude<DragMode, null>, e: React.PointerEvent) => {
    if (duration <= 0) return;
    const t = xToTime(e.clientX);
    dragOriginRef.current = {
      mode,
      start,
      end,
      offset: mode === 'move' ? t - start : 0
    };
    setDrag(mode);
  };

  const segLen = Math.max(0, end - start);
  const overLimit = segLen > maxSegmentSec;

  return (
    <div className="timeline">
      <div
        className="timeline-track"
        ref={trackRef}
        onPointerDown={(e) => {
          if (duration <= 0) return;
          const t = xToTime(e.clientX);
          if (t >= start && t <= end) {
            startDrag('move', e);
          } else {
            onSeek(t);
            startDrag('seek', e);
          }
        }}
      >
        <div
          className="timeline-range"
          style={{ left: pct(start), width: `${Math.max(0, ((end - start) / safeDur) * 100)}%` }}
        >
          <div
            className="timeline-handle left"
            style={{ left: 0 }}
            role="slider"
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={start}
            tabIndex={0}
            onPointerDown={(e) => {
              e.stopPropagation();
              startDrag('left', e);
            }}
          />
          <div
            className="timeline-handle right"
            style={{ left: '100%' }}
            role="slider"
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={end}
            tabIndex={0}
            onPointerDown={(e) => {
              e.stopPropagation();
              startDrag('right', e);
            }}
          />
        </div>
        <div className="timeline-cursor" style={{ left: pct(currentTime) }} />
      </div>
      <div className="timeline-info">
        <span>开始 {start.toFixed(2)}s</span>
        <span style={{ color: overLimit ? 'var(--warn)' : 'var(--muted)' }}>
          段长 {segLen.toFixed(2)}s {overLimit ? `(超过 ${maxSegmentSec}s,将自动分段)` : ''}
        </span>
        <span>结束 {end.toFixed(2)}s</span>
        <span>总时长 {duration.toFixed(2)}s</span>
      </div>
    </div>
  );
};
