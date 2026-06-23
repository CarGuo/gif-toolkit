/**
 * R-DOCK-FLOATING — Floating dock UI (v2).
 *
 * 设计要点：
 *  - 折叠态：64×64 圆球，毛玻璃 + 浅描边 + 中心 SVG。idle = 麦克风风
 *    格录制图标；recording = 红色脉动 + 实时计时；done = ✓；error = !
 *  - 单击圆球：idle → 展开 action grid；recording → 直接停止（最快路
 *    径）；done → reveal 最后产物。
 *  - 长按拖动；双击 / 右键隐藏 dock。
 *  - 展开态横向 grid：10 个按钮（带 tone='danger' 的红色样式）。
 *  - 业务动作走 `window.giftkDock.trigger(action)`，UI 只画 + 拖动。
 *  - 录制态自动展示「● REC mm:ss」横幅 + 大停止按钮（不依赖用户先展开）。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  DockActionMeta,
  DockState,
  DockActionKind,
  DockRecorderState,
} from '../shared/types/dock';
import { DOCK_RECORDER_IDLE_STATE } from '../shared/types/dock';
import { RECORDER_LONG_SIDE_PRESETS } from '../shared/types/recorder';

declare global {
  interface Window {
    giftkDock: {
      getActions: () => Promise<DockActionMeta[]>;
      trigger: (action: DockActionKind) => Promise<{ ok: boolean; reason?: string }>;
      setExpanded: (expanded: boolean) => Promise<{ ok: boolean }>;
      drag: (
        phase: 'start' | 'move' | 'end',
        input?: { startWindowX: number; startWindowY: number; cursorScreenX: number; cursorScreenY: number },
      ) => Promise<{ ok: boolean }>;
      hide: () => Promise<{ ok: boolean }>;
      getRecorderState: () => Promise<DockRecorderState>;
      revealLastRecording: () => Promise<{ ok: boolean }>;
      copyErrorMessage: (text: string) => Promise<{ ok: boolean }>;
      getLongSide: () => Promise<{ longSide: number }>;
      setLongSide: (n: number) => Promise<{ ok: boolean; longSide: number }>;
      onState: (cb: (state: DockState) => void) => () => void;
      onRecorderState: (cb: (s: DockRecorderState) => void) => () => void;
    };
  }
}

/* ---------- SVG icon library — 单一 source，不要散到各处 ---------- */
function Icon({ id, size = 18 }: { id: string; size?: number }): React.ReactElement {
  const stroke = 'currentColor';
  const sw = 1.7;
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke, strokeWidth: sw, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (id) {
    case 'rec':       return <svg {...common}><circle cx="12" cy="12" r="6" fill={stroke} /></svg>;
    case 'stop':      return <svg {...common}><rect x="6" y="6" width="12" height="12" rx="2" fill={stroke} /></svg>;
    case 'cancel':    return <svg {...common}><path d="M6 6l12 12M18 6L6 18" /></svg>;
    case 'link':      return <svg {...common}><path d="M10 14a4 4 0 010-6l3-3a4 4 0 016 6l-2 2" /><path d="M14 10a4 4 0 010 6l-3 3a4 4 0 01-6-6l2-2" /></svg>;
    case 'folder':    return <svg {...common}><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" /></svg>;
    case 'toolbox':   return <svg {...common}><path d="M3 8h18v11a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" /><path d="M9 8V6a2 2 0 012-2h2a2 2 0 012 2v2" /></svg>;
    case 'panel':     return <svg {...common}><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M3 9h18" /></svg>;
    case 'history':   return <svg {...common}><path d="M3 12a9 9 0 109-9" /><path d="M3 4v5h5" /><path d="M12 7v5l3 2" /></svg>;
    case 'show':      return <svg {...common}><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>;
    case 'hide':      return <svg {...common}><path d="M3 3l18 18" /><path d="M10 6.5A10 10 0 0112 6c6 0 10 6 10 6a17.6 17.6 0 01-3 4" /><path d="M6 8a17.4 17.4 0 00-4 4s4 6 10 6a10 10 0 005-1.4" /></svg>;
    case 'power':     return <svg {...common}><path d="M12 4v8" /><path d="M7.8 6.8a7 7 0 108.4 0" /></svg>;
    default:          return <svg {...common}><circle cx="12" cy="12" r="9" /></svg>;
  }
}

/* ---------- 时间格式 mm:ss --- */
function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const C = {
  bgGlass: 'rgba(20,22,28,0.78)',
  bgGlassHi: 'rgba(36,40,50,0.88)',
  border: '#2a2f3a',
  borderHi: '#3a414f',
  text: '#e7ecf3',
  textDim: '#9aa3b2',
  primary: '#4fa3ff',
  danger: '#ff4f4f',
  ok: '#5fd07a',
};

function App(): React.ReactElement {
  const [actions, setActions] = useState<DockActionMeta[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<DockState>({ visible: true, expanded: false, mainWindowVisible: true });
  const [rec, setRec] = useState<DockRecorderState>(DOCK_RECORDER_IDLE_STATE);
  const [longSide, setLongSide] = useState<number>(800);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<{ started: boolean; moved: boolean } | null>(null);

  useEffect(() => {
    void window.giftkDock?.getActions().then(setActions).catch(() => undefined);
    void window.giftkDock?.getRecorderState().then(setRec).catch(() => undefined);
    void window.giftkDock?.getLongSide().then((r) => setLongSide(r.longSide)).catch(() => undefined);
    const off1 = window.giftkDock?.onState?.((s) => {
      setState(s);
      // R-DOCK-FLOATING #expand-flicker — onState 是主进程权威，本地若已
      // 处于目标态就别再 setExpanded（avoid redundant re-render；折叠路径
      // 本地先于主进程把 expanded 置为 false，主进程随后广播 expanded=false
      // 时不应再触发一次 false→false 的 React 调度）。
      setExpanded((prev) => (prev === s.expanded ? prev : s.expanded));
    });
    const off2 = window.giftkDock?.onRecorderState?.((s) => setRec(s));
    return () => { off1?.(); off2?.(); };
  }, []);

  const trigger = useCallback((kind: DockActionKind): void => {
    void window.giftkDock?.trigger(kind).catch(() => undefined);
  }, []);

  /** dock chip 切换 gif-direct 最长边。仅在 idle 阶段允许调整。 */
  const onPickLongSide = useCallback((n: number): void => {
    void window.giftkDock?.setLongSide(n).then((r) => {
      if (r?.ok) setLongSide(r.longSide);
    }).catch(() => undefined);
  }, []);

  const requestExpanded = useCallback((next: boolean): void => {
    // R-DOCK-FLOATING #expand-flicker — 展开/折叠 dock 时的视觉抖动消除。
    //
    // 历史顺序（错误）：先 `setExpanded(next)` 让 React 立刻渲染目标 DOM，
    // 再隔两帧 `setBounds`。问题：
    //   - 展开方向：collapsed 64×64 的透明窗口里突然多了 280×340 的面板，
    //     被 overflow:hidden 裁掉一帧；下一帧窗口才变大，面板从裁切位置
    //     「弹」出来 → 用户看到一次错位闪动。
    //   - 折叠方向：窗口先缩到 64×64，面板还没被 React 卸掉，整段被裁掉
    //     一帧 → 同样闪。
    //
    // 修复：按方向**反序**调度，避免裁切窗口出现。
    //   - 展开（true）：先 commit 主进程 setBounds 把窗口放大到能容纳面板，
    //     依赖主进程随后广播的 onState 让 setExpanded(true) 把面板贴进去，
    //     这样面板每一帧都在「足够大」的窗口里渲染，永远不会被裁。
    //   - 折叠（false）：先 setExpanded(false) 让 React 在下一帧卸掉面板，
    //     **再** rAF 后让主进程 setBounds 缩窗口，避免窗口先缩导致面板被裁。
    if (next) {
      void window.giftkDock?.setExpanded(true).catch(() => undefined);
      return;
    }
    setExpanded(false);
    requestAnimationFrame(() => {
      void window.giftkDock?.setExpanded(false).catch(() => undefined);
    });
  }, []);

  // 录制态时自动展开，让停止按钮一直可见
  const recording = rec.phase === 'recording' || rec.phase === 'finalizing';
  const showFinalToast = rec.phase === 'done' || rec.phase === 'error';
  useEffect(() => {
    if (recording || showFinalToast) {
      if (!state.expanded) requestExpanded(true);
    }
  }, [recording, showFinalToast, state.expanded, requestExpanded]);

  // 错误 toast 上的复制按钮：把当前 rec.errorMessage 写入剪贴板，
  // 1.5s 后回到「复制」字样。每次 errorMessage 变更（新错来了 / 退
  // 出 error 阶段）都清掉 copied flag 避免视觉残留。
  useEffect(() => {
    setCopied(false);
    if (copiedTimerRef.current) {
      clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = null;
    }
  }, [rec.errorMessage, rec.phase]);

  const onCopyError = useCallback(async (): Promise<void> => {
    const msg = rec.errorMessage ?? '';
    if (!msg) return;
    const res = await window.giftkDock?.copyErrorMessage(msg).catch(() => ({ ok: false }));
    if (!res?.ok) return;
    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => {
      setCopied(false);
      copiedTimerRef.current = null;
    }, 1500);
  }, [rec.errorMessage]);

  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  const onOrbClick = useCallback((): void => {
    if (dragRef.current?.moved) return;
    if (recording) { trigger('dock-record-stop'); return; }
    if (rec.phase === 'done') { void window.giftkDock?.revealLastRecording().catch(() => undefined); return; }
    requestExpanded(!expanded);
  }, [expanded, recording, rec.phase, requestExpanded, trigger]);

  /* ---------- drag ---------- */
  function onOrbMouseDown(e: React.MouseEvent): void {
    if (e.button !== 0) return;
    dragRef.current = { started: true, moved: false };
    void window.giftkDock?.drag('start', {
      startWindowX: window.screenX,
      startWindowY: window.screenY,
      cursorScreenX: e.screenX,
      cursorScreenY: e.screenY,
    });
    const onMove = (ev: MouseEvent): void => {
      if (!dragRef.current?.started) return;
      dragRef.current.moved = true;
      void window.giftkDock?.drag('move', {
        startWindowX: window.screenX,
        startWindowY: window.screenY,
        cursorScreenX: ev.screenX,
        cursorScreenY: ev.screenY,
      });
    };
    const onUp = (): void => {
      void window.giftkDock?.drag('end');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setTimeout(() => { dragRef.current = null; }, 100);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function onOrbDoubleClick(): void {
    /* v3.1 修复 SC-DOCK-DOUBLECLICK-QUIT —— 之前 dblclick = hide(),
       用户拖拽误触双击就 "球消失",感觉像 App 退出(其实从主窗"悬浮球"
       按钮可唤回,但用户不知道)。直接砍掉 dblclick 行为,改用右键菜单
       明确的"隐藏"语义。 */
  }
  function onOrbContextMenu(e: React.MouseEvent): void { e.preventDefault(); void window.giftkDock?.hide(); }

  /* ---------- action filter（show/hide-main 二选一 + recording 隐藏其它） ---------- */
  const filtered = actions.filter((a) => {
    if (a.kind === 'show-main' && state.mainWindowVisible) return false;
    if (a.kind === 'hide-main' && !state.mainWindowVisible) return false;
    // recording 期间只显示 stop/cancel；finalizing 同样
    if (recording) return a.kind === 'dock-record-stop' || a.kind === 'dock-record-cancel';
    // done/error 时把 record/stop/cancel 隐掉（done 用 reveal 内嵌按钮）
    if (showFinalToast) return a.kind !== 'dock-record-stop' && a.kind !== 'dock-record-cancel';
    // idle 时隐掉 stop / cancel（点了也无意义）
    return a.kind !== 'dock-record-stop' && a.kind !== 'dock-record-cancel';
  });

  /* ---------- orb 颜色 / 内容 ----------
   * 视觉契约（v2.1 修复）：
   *   - recording → 红底 + 计时（脉动），最强提示，因为有 stop 动作
   *   - done      → 绿底 + 录像 icon，几秒后回 idle
   *   - error     → 蓝底（同 idle）+ 右上角 mini red dot，错误内容走
   *                 底部独立 toast 气泡条；不再让圆球本身变红爆炸 + 大 `!`
   *                 （用户反馈太凶）。
   *   - idle      → 蓝底 + 录像 icon
   */
  const orbBg = recording ? C.danger : rec.phase === 'done' ? C.ok : C.primary;
  const orbContent: React.ReactNode = recording
    ? <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', letterSpacing: 0.5 }}>{fmtElapsed(rec.elapsedMs)}</span>
    : <Icon id="rec" size={22} />;
  const hasErrorDot = rec.phase === 'error';

  return (
    <div
      style={{
        position: 'fixed', inset: 0, padding: expanded || recording || showFinalToast ? 6 : 0,
        display: 'flex', alignItems: 'center', gap: 8,
        WebkitUserSelect: 'none', userSelect: 'none',
        color: C.text, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
        background: 'transparent',
        backgroundColor: 'transparent',
        overflow: 'hidden',
      }}
    >
      {/* R-DOCK-FLOATING #no-backdrop — 展开态的毛玻璃 panel 会让
          Chromium/macOS 走正确透明合成；折叠态没有 panel 时会露出 52×52
          白底。这个不可见 backdrop layer 只负责稳定折叠态 compositor。 */}
      <div
        aria-hidden
        style={{
          position: 'absolute', inset: 0,
          pointerEvents: 'none',
          background: 'rgba(0,0,0,0.001)',
          backdropFilter: 'blur(0.001px)',
          WebkitBackdropFilter: 'blur(0.001px)',
        }}
      />

      {/* 圆球容器（position:relative 承载右上角 mini error dot）
          v3.1 修复 SC-DOCK-SQUARE-HALO —— 外面再嵌一层硬 clip(border-radius+
          overflow:hidden+isolation:isolate),防 macOS layer-backed view 在
          transparent 窗口里把球底色/渐变以"方形"形式渲染到球外。 */}
      <div style={{
        position: 'relative',
        flexShrink: 0,
        width: 52,
        height: 52,
        boxSizing: 'border-box',
        borderRadius: '50%',
        overflow: 'hidden',
        isolation: 'isolate',
        clipPath: 'circle(50% at 50% 50%)',
        background: 'transparent',
      }}>
        <div
          onMouseDown={onOrbMouseDown}
          onClick={onOrbClick}
          onDoubleClick={onOrbDoubleClick}
          onContextMenu={onOrbContextMenu}
          title={recording ? '点击停止录制 / 右键隐藏（主窗"悬浮球"可重新唤回）' : rec.phase === 'done' ? '点击打开最后产物' : '点击展开 / 右键隐藏（主窗"悬浮球"可重新唤回）/ 拖动可移动'}
          style={{
            position: 'relative',
            width: 52, height: 52, borderRadius: '50%',
            boxSizing: 'border-box',
            /* 3D 球体:径向渐变(左上高光 → 球体色 → 右下暗端)+ 仅 inset
               高光/暗端营造立体感。**不用任何外阴影**——transparent 窗口在
               macOS 上同时被 `drop-shadow(filter)` 和外 `box-shadow` 都会
               按方形 alpha 留残影(看上去就像球外有一块白色方板,见 v3 用户
               反馈 SC-DOCK-SQUARE-HALO)。立体感靠 inset 高光 + 暗端足够。 */
            background: `
              radial-gradient(circle at 32% 28%, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.18) 18%, transparent 42%),
              radial-gradient(circle at 65% 75%, ${orbBg} 0%, ${darken(orbBg, 0.35)} 75%, ${darken(orbBg, 0.55)} 100%)
            `,
            border: `1px solid ${recording ? '#ff8a8a' : 'rgba(255,255,255,0.18)'}`,
            boxShadow: recording
              ? `
                  inset 0 1px 2px rgba(255,255,255,0.5),
                  inset 0 -8px 16px rgba(0,0,0,0.28)
                `
              : `
                  inset 0 1px 2px rgba(255,255,255,0.5),
                  inset 0 -8px 16px rgba(0,0,0,0.28)
                `,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff',
            textShadow: '0 1px 2px rgba(0,0,0,0.4)',
            cursor: 'pointer',
            transition: 'transform 120ms ease',
            animation: recording ? 'orb-pulse 1.4s ease-in-out infinite' : undefined,
          }}
        >
          {orbContent}
        </div>
        {/* error mini-dot：6×6 红点 + 白描边，不抢视觉 */}
        {hasErrorDot && (
          <div
            title={rec.errorMessage ?? '录制失败'}
            style={{
              position: 'absolute', top: 2, right: 2,
              width: 10, height: 10, borderRadius: '50%',
              background: C.danger,
              border: '2px solid rgba(20,22,28,0.95)',
              boxShadow: '0 0 6px rgba(255,79,79,0.7)',
              pointerEvents: 'none',
            }}
          />
        )}
      </div>

      {/* expanded panel 毛玻璃 —— 与圆球垂直居中对齐 */}
      {(expanded || recording || showFinalToast) && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 8px',
            background: C.bgGlass,
            backdropFilter: 'blur(14px) saturate(160%)',
            WebkitBackdropFilter: 'blur(14px) saturate(160%)',
            border: `1px solid ${C.border}`,
            borderRadius: 14,
            boxShadow: '0 12px 28px rgba(0,0,0,0.45)',
            overflow: 'hidden',
            alignSelf: 'center',
          }}
        >
          {recording && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px', height: 44 }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%', background: C.danger,
                boxShadow: '0 0 8px ' + C.danger, animation: 'rec-blink 1s ease-in-out infinite',
              }} />
              <span style={{ fontSize: 13, fontWeight: 600 }}>
                {rec.phase === 'finalizing' ? '正在保存…' : '录制中'}
              </span>
              <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', color: C.textDim }}>
                {fmtElapsed(rec.elapsedMs)}
              </span>
            </div>
          )}

          {rec.phase === 'done' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px', height: 44 }}>
              <span style={{ color: C.ok, fontWeight: 700 }}>✓</span>
              <span style={{ fontSize: 12 }}>
                录制完成
                {rec.lastRegion ? ` · ${rec.lastRegion.w}×${rec.lastRegion.h}@${rec.lastRegion.x},${rec.lastRegion.y}` : ''}
              </span>
              <button
                onClick={() => void window.giftkDock?.revealLastRecording().catch(() => undefined)}
                style={btnStyle('default')}
              >打开</button>
              {/* R-DOCK-FLOATING #done-autoclose — 手动 ✕ 立即关 done 气泡。
                  主进程 3.5s 自动 reset 已存在；这里走 cancel 让用户提前。 */}
              <button
                onClick={() => trigger('dock-record-cancel')}
                title="关闭"
                style={{
                  width: 22, height: 22, borderRadius: 6,
                  background: 'transparent', color: C.textDim,
                  border: `1px solid ${C.border}`,
                  cursor: 'pointer', fontSize: 12, lineHeight: 1,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0, marginLeft: 'auto',
                }}
              >✕</button>
            </div>
          )}

          <div style={{ display: 'flex', gap: 4, flexWrap: 'nowrap', alignItems: 'stretch' }}>
            {filtered.map((a) => (
              <button
                key={a.kind}
                onClick={() => trigger(a.kind)}
                title={a.description}
                style={btnStyle(a.tone ?? 'default')}
              >
                <Icon id={a.icon} size={16} />
                <span style={{
                  /* 4 字 label（"产物目录"/"隐藏主窗"）字号收紧到 9px
                     避免在 56px 宽内换两行破等高。≤3 字保持 11px。 */
                  fontSize: a.label.length >= 4 ? 9 : 11,
                  marginTop: 3, whiteSpace: 'nowrap',
                  maxWidth: 52, overflow: 'hidden', textOverflow: 'ellipsis',
                  lineHeight: 1.1,
                }}>{a.label}</span>
              </button>
            ))}
          </div>

          {/* v2.3 最长边 chip — 仅 idle 阶段显示，gif-direct scale 控制。 */}
          {!recording && !showFinalToast && (
            <div
              title="录屏最长边 (px)"
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '0 6px', borderLeft: `1px solid ${C.border}`, height: 44,
              }}
            >
              <span style={{ fontSize: 9, color: C.textDim, marginRight: 2, lineHeight: 1 }}>L</span>
              {RECORDER_LONG_SIDE_PRESETS.map((n) => (
                <button
                  key={n}
                  onClick={() => onPickLongSide(n)}
                  title={`最长边 ${n}px`}
                  style={chipBtn(longSide === n)}
                >{n}</button>
              ))}
              <button
                onClick={() => onPickLongSide(0)}
                title="原始分辨率（不缩放）"
                style={chipBtn(longSide === 0)}
              >原</button>
            </div>
          )}
        </div>
      )}

      {/* error toast：QQ 风格——贴圆球右侧上方（不再 absolute bottom 把球
          盖住），主进程窗口高度已扩到 DOCK_ERROR_SIZE.h，这里用普通流式
          布局 + alignSelf:'center' 让它和球水平对齐而不是顶部裁断。 */}
      {rec.phase === 'error' && (
        <div
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 8,
            padding: '10px 12px',
            background: 'rgba(40,16,16,0.94)',
            border: `1px solid ${C.danger}`,
            borderRadius: 12,
            boxShadow: '0 10px 24px rgba(0,0,0,0.5)',
            color: '#ffecec',
            alignSelf: 'center',
            maxWidth: 420, minWidth: 280,
          }}
        >
          <span style={{ color: C.danger, fontWeight: 800, fontSize: 16, lineHeight: 1, marginTop: 1 }}>!</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#fff' }}>录制失败</div>
              <button
                onClick={() => { void onCopyError(); }}
                title={copied ? '已复制到剪贴板' : '复制完整错误信息'}
                disabled={!rec.errorMessage}
                style={{
                  padding: '2px 8px', height: 20,
                  fontSize: 10, lineHeight: 1, fontWeight: 600,
                  borderRadius: 5, cursor: rec.errorMessage ? 'pointer' : 'not-allowed',
                  background: copied ? C.ok : 'rgba(255,255,255,0.08)',
                  color: copied ? '#0c1118' : '#ffd2d2',
                  border: `1px solid ${copied ? C.ok : 'rgba(255,255,255,0.18)'}`,
                  transition: 'background 120ms, color 120ms, border-color 120ms',
                }}
              >{copied ? '已复制' : '复制'}</button>
            </div>
            <div style={{
              fontSize: 11, color: '#ffd2d2', marginTop: 2,
              wordBreak: 'break-all', whiteSpace: 'pre-wrap',
              maxHeight: 72, overflowY: 'auto',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            }}>
              {rec.errorMessage ?? '未知错误'}
            </div>
          </div>
          <button
            onClick={() => trigger('dock-record-cancel')}
            title="关闭"
            style={{
              width: 22, height: 22, borderRadius: 6,
              background: 'transparent', color: '#ffd2d2',
              border: `1px solid ${C.danger}`,
              cursor: 'pointer', fontSize: 12, lineHeight: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}
          >✕</button>
        </div>
      )}

      <style>{`
        @keyframes orb-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.06); } }
        @keyframes rec-blink { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
        button:hover { filter: brightness(1.12); }
        button:active { transform: scale(0.95); }
      `}</style>
    </div>
  );
}

/** 把 #RRGGBB 颜色按比例朝黑色压暗（0..1）。给 orb 球体径向渐变做暗端用。 */
function darken(hex: string, amount: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.max(0, Math.round(((n >> 16) & 0xff) * (1 - amount)));
  const g = Math.max(0, Math.round(((n >> 8) & 0xff) * (1 - amount)));
  const b = Math.max(0, Math.round((n & 0xff) * (1 - amount)));
  return `rgb(${r},${g},${b})`;
}

function btnStyle(tone: 'danger' | 'primary' | 'default'): React.CSSProperties {
  const base: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    /* 固定 width / height 让 dock bar 里所有 item 视觉等高等宽——之前
       label 字数不同（"录屏"/"产物目录"/"隐藏主窗"）导致换行高度不齐。 */
    width: 56, height: 52,
    padding: '4px 4px',
    background: C.bgGlassHi, color: C.text,
    border: `1px solid ${C.border}`, borderRadius: 10,
    cursor: 'pointer',
    transition: 'background 120ms ease, transform 80ms ease, filter 120ms ease',
    flexShrink: 0,
  };
  if (tone === 'danger') return { ...base, background: C.danger, borderColor: '#ff8a8a', color: '#fff', fontWeight: 600 };
  if (tone === 'primary') return { ...base, background: C.primary, borderColor: '#7ab8ff', color: '#0c1118', fontWeight: 600 };
  return base;
}

/** dock chip：紧凑、单字号、active 高亮（蓝底）。用于最长边切换。 */
function chipBtn(active: boolean): React.CSSProperties {
  return {
    padding: '4px 7px', height: 22,
    fontSize: 10, lineHeight: 1, fontWeight: 600,
    borderRadius: 6,
    background: active ? C.primary : 'rgba(255,255,255,0.06)',
    color: active ? '#0c1118' : C.textDim,
    border: `1px solid ${active ? '#7ab8ff' : C.border}`,
    cursor: 'pointer',
    flexShrink: 0,
    transition: 'background 120ms, color 120ms, border-color 120ms',
  };
}

const el = document.getElementById('root');
if (el) createRoot(el).render(<App />);
