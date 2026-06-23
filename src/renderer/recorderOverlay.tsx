/**
 * Recorder region-selector overlay UI.
 *
 * R-REC-DESKTOP-AREA #snap-default-and-adjust（v3 起）：
 *  - 打开默认 = window-snap 模式：hover 自动高亮所在窗口边界
 *  - 鼠标按下 + 移动 ≥ 5px 自动切到 drag 模式（一气呵成无须 Tab）
 *  - 锁定后矩形支持：8 把 resize handle（四角 + 四边中点）+ 中心拖动 reposition
 *  - hover hint 显示「app — title  ·  W×H」
 *
 * Vanilla React + canvas-less：full-screen tint with cut-out rect + 边框 + size badge。
 * Wired via `window.giftkRecOverlay.{onConfig, finish, cancel}`（preload）。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

declare global {
  interface Window {
    giftkRecOverlay: {
      onConfig: (cb: (cfg: { displayId: number; bounds: { x: number; y: number; width: number; height: number }; scaleFactor: number; windows?: WindowSnap[]; needsPermission?: boolean }) => void) => void;
      onStaticConfig: (cb: (cfg: { displayId: number; bounds: { x: number; y: number; width: number; height: number }; scaleFactor: number; region: { displayId: number; x: number; y: number; w: number; h: number } }) => void) => void;
      finish: (region: { displayId: number; x: number; y: number; w: number; h: number }) => void;
      cancel: () => void;
      openAxSettings?: () => Promise<void>;
    };
  }
}

interface WindowSnap {
  x: number;
  y: number;
  w: number;
  h: number;
  app: string;
  title: string;
}

interface Cfg {
  displayId: number;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  windows?: WindowSnap[];
  needsPermission?: boolean;
}

interface StaticCfg extends Cfg {
  region: { displayId: number; x: number; y: number; w: number; h: number };
}

const MIN_SIDE = 50;
const DRAG_THRESHOLD = 5;

/**
 * R-REC-DESKTOP-AREA #window-snap — 在 windows 数组里找最上层（最后一项视为
 * 最近 push 进来的；但 System Events 顺序未定，所以用「面积最小的命中窗口」
 * 作为代理：用户 hover 一个小工具栏时优先吸它而不是它后面的大文档窗口）。
 */
export function pickWindowAt(windows: WindowSnap[] | undefined, px: number, py: number): WindowSnap | null {
  if (!windows || windows.length === 0) return null;
  let best: WindowSnap | null = null;
  let bestArea = Infinity;
  for (const w of windows) {
    if (px < w.x || py < w.y) continue;
    if (px > w.x + w.w || py > w.y + w.h) continue;
    const area = w.w * w.h;
    if (area < bestArea) { best = w; bestArea = area; }
  }
  return best;
}

/** 8 resize handle 名 + 中心 move。 */
type HandleKey = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move';

/**
 * R-REC-DESKTOP-AREA #snap-default-and-adjust — resize 纯函数。
 * 给定初始 rect + handle + 鼠标 delta，输出新 rect（已 clamp 到 bounds 并保最小尺寸）。
 */
export function applyResize(
  base: { x: number; y: number; w: number; h: number },
  handle: HandleKey,
  dx: number,
  dy: number,
  bounds: { width: number; height: number },
  minSide = MIN_SIDE,
): { x: number; y: number; w: number; h: number } {
  let { x, y, w, h } = base;
  if (handle === 'move') {
    x = clamp(x + dx, 0, bounds.width - w);
    y = clamp(y + dy, 0, bounds.height - h);
    return { x, y, w, h };
  }
  if (handle.includes('w')) {
    const nx = clamp(x + dx, 0, x + w - minSide);
    w = w + (x - nx); x = nx;
  }
  if (handle.includes('e')) {
    w = clamp(w + dx, minSide, bounds.width - x);
  }
  if (handle.includes('n')) {
    const ny = clamp(y + dy, 0, y + h - minSide);
    h = h + (y - ny); y = ny;
  }
  if (handle.includes('s')) {
    h = clamp(h + dy, minSide, bounds.height - y);
  }
  return { x, y, w, h };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function StaticReadOnlyOverlay({ cfg }: { cfg: StaticCfg }): React.ReactElement {
  // 显示一个有「窗口外蒙灰、选区透明」的只读高亮，配一个「录制中」红
  // chip。pointerEvents=none 让用户能穿透继续操作桌面（窗口本身也
  // setIgnoreMouseEvents=true）。
  const { region } = cfg;
  return (
    <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: region.x,
          top: region.y,
          width: region.w,
          height: region.h,
          // 外蒙灰 + **内嵌**红框（inset shadow），不画在选区外侧。
          // 哪怕 setContentProtection 在某些 macOS 版本失效、overlay 被
          // 录进帧，红框也只会落在选区**内边缘** 2px，不会出现"框外多
          // 一条红线"——见 SC-REC-RED-LINE-IN-CAPTURE。
          boxShadow: '0 0 0 9999px rgba(0,0,0,0.28), inset 0 0 0 2px #ff4f4f',
          borderRadius: 2,
          animation: 'rec-pulse 1.6s ease-in-out infinite',
        }}
      />
      <div
        style={{
          position: 'fixed',
          top: 16,
          left: '50%',
          transform: 'translateX(-50%)',
          padding: '6px 12px',
          background: 'rgba(20,22,28,0.85)',
          border: '1px solid #ff4f4f',
          borderRadius: 999,
          fontSize: 12,
          color: '#fff',
          letterSpacing: 0.2,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ff4f4f', boxShadow: '0 0 8px #ff4f4f', animation: 'rec-blink 1s ease-in-out infinite' }} />
        正在录制 · 在悬浮球点 ⏹ 停止
      </div>
      <style>{`
        @keyframes rec-blink { 0%,100%{opacity:1} 50%{opacity:.35} }
        @keyframes rec-pulse { 0%,100%{opacity:1} 50%{opacity:.7} }
      `}</style>
    </div>
  );
}

interface Rect { x: number; y: number; w: number; h: number }

function App(): React.ReactElement {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [staticCfg, setStaticCfg] = useState<StaticCfg | null>(null);
  /** 锁定后的最终 rect（吸附完成 / 拖框完成 / resize 完成都进这里）。 */
  const [rect, setRect] = useState<Rect | null>(null);
  /** 进行中的拖框（未锁定）。 */
  const [drag, setDrag] = useState<null | { x0: number; y0: number; x1: number; y1: number }>(null);
  /** 进行中的 resize/move：base 是按下瞬间的 rect 副本。 */
  const dragOpRef = useRef<null | { handle: HandleKey; sx: number; sy: number; base: Rect }>(null);
  /** 鼠标按下还未确定是 snap-click 还是 drag-out 的临时状态。 */
  const pressRef = useRef<null | { sx: number; sy: number; movedToDrag: boolean }>(null);
  // 默认 window-snap；windowList 为空时强制 drag。
  const [mode, setMode] = useState<'drag' | 'window'>('window');
  const [hoverWin, setHoverWin] = useState<WindowSnap | null>(null);

  useEffect(() => {
    window.giftkRecOverlay?.onConfig((c) => {
      setCfg(c);
      const hasWins = !!(c.windows && c.windows.length > 0);
      setMode(hasWins ? 'window' : 'drag');
    });
    window.giftkRecOverlay?.onStaticConfig?.((c) => setStaticCfg(c));
  }, []);

  const hasWindows = !!(cfg?.windows && cfg.windows.length > 0);
  const bounds = useMemo(
    () => (cfg ? { width: cfg.bounds.width, height: cfg.bounds.height } : { width: 0, height: 0 }),
    [cfg],
  );

  const confirmRegion = useCallback((): void => {
    if (!cfg || !rect) return;
    const r = {
      x: Math.round(clamp(rect.x, 0, bounds.width)),
      y: Math.round(clamp(rect.y, 0, bounds.height)),
      w: Math.round(Math.max(MIN_SIDE, rect.w)),
      h: Math.round(Math.max(MIN_SIDE, rect.h)),
    };
    console.log('[recorderOverlay] finish region', { displayId: cfg.displayId, ...r, bounds });
    window.giftkRecOverlay?.finish({ displayId: cfg.displayId, ...r });
  }, [cfg, rect, bounds]);

  // ESC 取消 / Enter 确认 / Tab 切模式
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (rect) { setRect(null); setDrag(null); return; }
        window.giftkRecOverlay?.cancel();
      }
      if (e.key === 'Enter' && rect) confirmRegion();
      if (e.key === 'Tab' && hasWindows) {
        e.preventDefault();
        setMode((m) => (m === 'drag' ? 'window' : 'drag'));
        setRect(null); setDrag(null); setHoverWin(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rect, confirmRegion, hasWindows]);

  // 全局 pointermove / pointerup（resize / move / drag-out 中跟踪鼠标）。
  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const op = dragOpRef.current;
      if (op) {
        const next = applyResize(op.base, op.handle, e.clientX - op.sx, e.clientY - op.sy, bounds);
        setRect(next);
        return;
      }
      const pr = pressRef.current;
      if (pr && !pr.movedToDrag) {
        if (Math.abs(e.clientX - pr.sx) + Math.abs(e.clientY - pr.sy) > DRAG_THRESHOLD) {
          // 按住后拖开 → 切 drag-out（即使当前 mode=window）
          pr.movedToDrag = true;
          setRect(null); setHoverWin(null);
          setDrag({ x0: pr.sx, y0: pr.sy, x1: e.clientX, y1: e.clientY });
        }
        return;
      }
      if (drag) setDrag({ ...drag, x1: e.clientX, y1: e.clientY });
    };
    const onUp = (e: PointerEvent): void => {
      const op = dragOpRef.current;
      if (op) { dragOpRef.current = null; return; }
      const pr = pressRef.current;
      pressRef.current = null;
      if (pr && !pr.movedToDrag) {
        // 单击未移动 → 若 mode=window 且 hover 命中，则吸附为 rect
        if (mode === 'window' && cfg) {
          const win = pickWindowAt(cfg.windows, pr.sx, pr.sy);
          if (win) {
            setRect({
              x: clamp(win.x, 0, bounds.width - MIN_SIDE),
              y: clamp(win.y, 0, bounds.height - MIN_SIDE),
              w: Math.min(win.w, bounds.width - Math.max(0, win.x)),
              h: Math.min(win.h, bounds.height - Math.max(0, win.y)),
            });
          }
        }
        return;
      }
      if (drag) {
        const w = Math.abs(drag.x1 - drag.x0);
        const h = Math.abs(drag.y1 - drag.y0);
        if (w >= MIN_SIDE && h >= MIN_SIDE) {
          setRect({
            x: Math.min(drag.x0, drag.x1),
            y: Math.min(drag.y0, drag.y1),
            w, h,
          });
        }
        setDrag(null);
      }
      // 防止误报未使用
      void e;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag, mode, cfg, bounds]);

  // 仅 hover hint（无 button down 时更新）
  function onRootPointerMove(e: React.PointerEvent): void {
    if (dragOpRef.current || pressRef.current || drag || rect) return;
    if (mode === 'window') setHoverWin(pickWindowAt(cfg?.windows, e.clientX, e.clientY));
  }

  function onRootPointerDown(e: React.PointerEvent): void {
    if (rect) return; // 已锁定，由 rect 上的 handler 接管
    pressRef.current = { sx: e.clientX, sy: e.clientY, movedToDrag: false };
  }

  function onHandlePointerDown(handle: HandleKey, e: React.PointerEvent): void {
    if (!rect) return;
    e.stopPropagation();
    dragOpRef.current = { handle, sx: e.clientX, sy: e.clientY, base: { ...rect } };
  }

  // 实时显示框：优先级 rect > drag > hoverWin
  const liveRect = rect
    ? rect
    : drag
      ? {
          x: Math.min(drag.x0, drag.x1),
          y: Math.min(drag.y0, drag.y1),
          w: Math.abs(drag.x1 - drag.x0),
          h: Math.abs(drag.y1 - drag.y0),
        }
      : mode === 'window' && hoverWin
        ? { x: hoverWin.x, y: hoverWin.y, w: hoverWin.w, h: hoverWin.h }
        : null;
  const snapUnavailableText = cfg?.needsPermission === true ? '未获得辅助功能权限' : '当前屏未找到可吸附窗口';

  if (!cfg && !staticCfg) {
    return (
      <div
        style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.30)',
          display: 'grid', placeItems: 'center', color: '#cfd5df',
          fontSize: 13, letterSpacing: 0.2, pointerEvents: 'none',
        }}
      >
        正在读取窗口列表...
      </div>
    );
  }

  return (
    staticCfg ? <StaticReadOnlyOverlay cfg={staticCfg} /> :
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.30)',
        cursor: mode === 'window' && !rect ? 'pointer' : 'crosshair',
      }}
      onPointerDown={onRootPointerDown}
      onPointerMove={onRootPointerMove}
    >
      {liveRect && (
        <div
          style={{
            position: 'absolute',
            left: liveRect.x, top: liveRect.y,
            width: liveRect.w, height: liveRect.h,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)',
            outline: rect ? '2px solid #4fa3ff' : (mode === 'window' ? '2px dashed #4fd1ff' : '2px solid #4fa3ff'),
            cursor: rect ? 'move' : (mode === 'window' ? 'pointer' : 'crosshair'),
            pointerEvents: rect ? 'auto' : 'none',
          }}
          onPointerDown={(e) => rect && onHandlePointerDown('move', e)}
        />
      )}
      {/* 8 resize handles（仅锁定后） */}
      {rect && cfg && (
        <>
          {(['nw','n','ne','e','se','s','sw','w'] as HandleKey[]).map((h) => {
            const pos = handlePos(h, rect);
            return (
              <div
                key={h}
                onPointerDown={(e) => onHandlePointerDown(h, e)}
                style={{
                  position: 'absolute',
                  left: pos.left - 6, top: pos.top - 6,
                  width: 12, height: 12,
                  background: '#fff', border: '1px solid #4fa3ff',
                  borderRadius: 2, cursor: handleCursor(h),
                  boxShadow: '0 1px 2px rgba(0,0,0,0.4)',
                  zIndex: 5,
                }}
              />
            );
          })}
        </>
      )}
      {/* 模式切换 chip：左上 */}
      <div
        style={{
          position: 'fixed', top: 16, left: 16,
          display: 'flex', gap: 4, padding: 4,
          background: 'rgba(20,22,28,0.85)', border: '1px solid #2a2f3a',
          borderRadius: 999, fontSize: 12,
        }}
      >
        {cfg?.needsPermission === true ? (
          <button
            onClick={() => { void window.giftkRecOverlay?.openAxSettings?.(); }}
            title="打开「系统设置 → 隐私与安全性 → 辅助功能」授予 Gif Toolkit 权限后即可吸附窗口"
            style={chipStyle(false, true)}
          >
            🔓 授予辅助功能权限
          </button>
        ) : (
          <button
            onClick={() => { setMode('window'); setRect(null); setDrag(null); setHoverWin(null); }}
            disabled={!hasWindows}
            title={hasWindows ? '点窗口直接吸附为选区（Tab 切换）' : snapUnavailableText}
            style={chipStyle(mode === 'window', hasWindows)}
          >
            吸附窗口{hasWindows ? '' : '（无窗口）'}
          </button>
        )}
        <button
          onClick={() => { setMode('drag'); setRect(null); setDrag(null); setHoverWin(null); }}
          style={chipStyle(mode === 'drag', true)}
        >
          拖框
        </button>
      </div>
      <div
        style={{
          position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)',
          padding: '8px 14px',
          background: 'rgba(20,22,28,0.85)', border: '1px solid #2a2f3a',
          borderRadius: 8, fontSize: 13, letterSpacing: 0.2,
          pointerEvents: 'none', maxWidth: '60vw', textAlign: 'center', color: '#cfd5df',
        }}
      >
        {rect
          ? `区域 ${Math.round(rect.w)}×${Math.round(rect.h)}  ·  拖边/角调整 · 拖中心移动 · Enter 确认 · Esc 重选`
          : drag
            ? `${Math.round(Math.abs(drag.x1 - drag.x0))}×${Math.round(Math.abs(drag.y1 - drag.y0))}  ·  松开锁定（至少 ${MIN_SIDE}×${MIN_SIDE}）`
            : mode === 'window'
              ? (hoverWin
                ? `吸附：${hoverWin.app}${hoverWin.title ? ' — ' + hoverWin.title : ''}  ${hoverWin.w}×${hoverWin.h}  ·  单击确认 · 按住拖动改框 · Tab 切拖框 · Esc 取消`
                : `Hover 任意窗口自动吸附其边界  ·  按住拖动可手动框选  ·  Tab 切拖框  ·  Esc 取消${hasWindows ? '' : '（未找到可吸附窗口，已降级到拖框）'}`)
              : `拖拽框选要录制的区域（至少 ${MIN_SIDE}×${MIN_SIDE}）${hasWindows ? '  ·  Tab 切吸附' : ''}  ·  Esc 取消`}
      </div>
      {rect && (
        <div
          style={{
            position: 'absolute',
            left: clamp(rect.x, 0, bounds.width - 280),
            top: Math.min(rect.y + rect.h + 8, bounds.height - 40),
            display: 'flex', gap: 8, zIndex: 10,
          }}
        >
          <button onClick={confirmRegion} style={primaryBtn}>开始录制</button>
          <button onClick={() => { setRect(null); setHoverWin(null); }} style={secondaryBtn}>重选</button>
          <button onClick={() => window.giftkRecOverlay?.cancel()} style={secondaryBtn}>取消</button>
        </div>
      )}
    </div>
  );
}

function handlePos(h: HandleKey, r: Rect): { left: number; top: number } {
  switch (h) {
    case 'nw': return { left: r.x, top: r.y };
    case 'n': return { left: r.x + r.w / 2, top: r.y };
    case 'ne': return { left: r.x + r.w, top: r.y };
    case 'e': return { left: r.x + r.w, top: r.y + r.h / 2 };
    case 'se': return { left: r.x + r.w, top: r.y + r.h };
    case 's': return { left: r.x + r.w / 2, top: r.y + r.h };
    case 'sw': return { left: r.x, top: r.y + r.h };
    case 'w': return { left: r.x, top: r.y + r.h / 2 };
    default: return { left: r.x, top: r.y };
  }
}

function handleCursor(h: HandleKey): string {
  if (h === 'nw' || h === 'se') return 'nwse-resize';
  if (h === 'ne' || h === 'sw') return 'nesw-resize';
  if (h === 'n' || h === 's') return 'ns-resize';
  if (h === 'e' || h === 'w') return 'ew-resize';
  return 'move';
}

function chipStyle(active: boolean, enabled: boolean): React.CSSProperties {
  return {
    padding: '4px 12px',
    background: active ? '#4fa3ff' : 'transparent',
    color: active ? '#0c1118' : (enabled ? '#cfd5df' : '#5a6170'),
    border: 0, borderRadius: 999,
    cursor: enabled ? 'pointer' : 'not-allowed',
    fontWeight: 600,
  };
}

const primaryBtn: React.CSSProperties = {
  padding: '6px 14px', background: '#4fa3ff', color: '#0c1118',
  border: 0, borderRadius: 6, fontWeight: 600, cursor: 'pointer',
};
const secondaryBtn: React.CSSProperties = {
  padding: '6px 14px', background: '#1f242d', color: '#cfd5df',
  border: '1px solid #2a2f3a', borderRadius: 6, cursor: 'pointer',
};

const el = document.getElementById('root');
if (el) createRoot(el).render(<App />);
