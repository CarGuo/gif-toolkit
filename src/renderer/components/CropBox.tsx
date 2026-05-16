import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface CropRect { x: number; y: number; w: number; h: number; }

interface Props {
  naturalSize: { w: number; h: number };
  /** The actual image/video element whose visible bounding box defines crop coordinates. */
  targetEl: HTMLElement | null;
  value?: CropRect;
  onChange: (rect: CropRect | undefined) => void;
}

type Drag =
  | { kind: 'create'; sx: number; sy: number; committed: boolean }
  | { kind: 'move'; sx: number; sy: number; orig: CropRect }
  | { kind: 'resize'; sx: number; sy: number; orig: CropRect; corner: 'tl' | 'tr' | 'bl' | 'br' }
  | null;

const CREATE_THRESHOLD = 3;
const MIN_SIZE = 4;

export const CropBox: React.FC<Props> = ({ naturalSize, targetEl, value, onChange }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<Drag>(null);
  const [, force] = useState(0);
  const setDrag = (d: Drag) => {
    dragRef.current = d;
    force((n) => n + 1);
  };

  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number }>({
    left: 0, top: 0, width: 0, height: 0
  });

  const recomputeBox = useCallback(() => {
    const el = targetEl;
    const host = ref.current?.parentElement;
    if (!el || !host) return;
    const elRect = el.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    setBox((prev) => {
      const next = {
        left: elRect.left - hostRect.left,
        top: elRect.top - hostRect.top,
        width: elRect.width,
        height: elRect.height
      };
      if (
        prev.left === next.left &&
        prev.top === next.top &&
        prev.width === next.width &&
        prev.height === next.height
      ) return prev;
      return next;
    });
  }, [targetEl]);

  useLayoutEffect(() => {
    recomputeBox();
  }, [recomputeBox, naturalSize.w, naturalSize.h]);

  useEffect(() => {
    if (!targetEl) return;
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => recomputeBox());
    ro.observe(targetEl);
    const onWin = () => recomputeBox();
    window.addEventListener('resize', onWin);
    window.addEventListener('scroll', onWin, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onWin);
      window.removeEventListener('scroll', onWin, true);
    };
  }, [targetEl, recomputeBox]);

  const ratioX = naturalSize.w && box.width ? box.width / naturalSize.w : 1;
  const ratioY = naturalSize.h && box.height ? box.height / naturalSize.h : 1;

  const toScreen = (r: CropRect) => ({
    left: box.left + r.x * ratioX,
    top: box.top + r.y * ratioY,
    width: r.w * ratioX,
    height: r.h * ratioY
  });

  const screenToNatural = useCallback(
    (sx: number, sy: number) => {
      const host = ref.current?.parentElement;
      if (!host) return { x: 0, y: 0 };
      const hostRect = host.getBoundingClientRect();
      const x = (sx - hostRect.left - box.left) / (ratioX || 1);
      const y = (sy - hostRect.top - box.top) / (ratioY || 1);
      return {
        x: Math.max(0, Math.min(naturalSize.w, x)),
        y: Math.max(0, Math.min(naturalSize.h, y))
      };
    },
    [box.left, box.top, ratioX, ratioY, naturalSize.w, naturalSize.h]
  );

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.target !== ref.current) return;
    const p = screenToNatural(e.clientX, e.clientY);
    setDrag({ kind: 'create', sx: p.x, sy: p.y, committed: false });
    try { (e.target as Element).setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const p = screenToNatural(e.clientX, e.clientY);
      if (drag.kind === 'create') {
        const dx = Math.abs(p.x - drag.sx);
        const dy = Math.abs(p.y - drag.sy);
        if (!drag.committed && dx < CREATE_THRESHOLD && dy < CREATE_THRESHOLD) return;
        if (!drag.committed) {
          dragRef.current = { ...drag, committed: true };
        }
        const x = Math.min(drag.sx, p.x);
        const y = Math.min(drag.sy, p.y);
        let w = Math.abs(p.x - drag.sx);
        let h = Math.abs(p.y - drag.sy);
        w = Math.max(MIN_SIZE, Math.min(naturalSize.w - x, w));
        h = Math.max(MIN_SIZE, Math.min(naturalSize.h - y, h));
        onChange({ x, y, w, h });
      } else if (drag.kind === 'move') {
        const dx = p.x - drag.sx;
        const dy = p.y - drag.sy;
        const nx = Math.max(0, Math.min(naturalSize.w - drag.orig.w, drag.orig.x + dx));
        const ny = Math.max(0, Math.min(naturalSize.h - drag.orig.h, drag.orig.y + dy));
        onChange({ ...drag.orig, x: nx, y: ny });
      } else if (drag.kind === 'resize') {
        const o = drag.orig;
        let x = o.x;
        let y = o.y;
        let w = o.w;
        let h = o.h;
        const dx = p.x - drag.sx;
        const dy = p.y - drag.sy;
        if (drag.corner === 'tl') { x = o.x + dx; y = o.y + dy; w = o.w - dx; h = o.h - dy; }
        if (drag.corner === 'tr') { y = o.y + dy; w = o.w + dx; h = o.h - dy; }
        if (drag.corner === 'bl') { x = o.x + dx; w = o.w - dx; h = o.h + dy; }
        if (drag.corner === 'br') { w = o.w + dx; h = o.h + dy; }
        if (w < MIN_SIZE) { x += w - MIN_SIZE; w = MIN_SIZE; }
        if (h < MIN_SIZE) { y += h - MIN_SIZE; h = MIN_SIZE; }
        x = Math.max(0, Math.min(naturalSize.w - w, x));
        y = Math.max(0, Math.min(naturalSize.h - h, y));
        w = Math.min(naturalSize.w - x, w);
        h = Math.min(naturalSize.h - y, h);
        onChange({ x, y, w, h });
      }
    };
    const up = () => {
      setDrag(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && value) onChange(undefined);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', onKey);
    };
  }, [naturalSize.h, naturalSize.w, onChange, screenToNatural, value]);

  const startMove = (e: React.PointerEvent) => {
    if (!value) return;
    e.stopPropagation();
    const p = screenToNatural(e.clientX, e.clientY);
    setDrag({ kind: 'move', sx: p.x, sy: p.y, orig: value });
    try { (e.currentTarget as Element).setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
  };

  const startResize = (corner: 'tl' | 'tr' | 'bl' | 'br') => (e: React.PointerEvent) => {
    if (!value) return;
    e.stopPropagation();
    const p = screenToNatural(e.clientX, e.clientY);
    setDrag({ kind: 'resize', sx: p.x, sy: p.y, orig: value, corner });
    try { (e.currentTarget as Element).setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
  };

  const overlayStyle: React.CSSProperties = {
    position: 'absolute',
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    cursor: 'crosshair',
    pointerEvents: box.width > 0 ? 'auto' : 'none'
  };

  return (
    <>
      <div ref={ref} style={overlayStyle} onPointerDown={onPointerDown} />
      {value && box.width > 0 && (
        <div
          className="crop-rect"
          style={{ position: 'absolute', ...toScreen(value) }}
          onPointerDown={startMove}
        >
          <div className="handle tl" onPointerDown={startResize('tl')} />
          <div className="handle tr" onPointerDown={startResize('tr')} />
          <div className="handle bl" onPointerDown={startResize('bl')} />
          <div className="handle br" onPointerDown={startResize('br')} />
        </div>
      )}
    </>
  );
};
