import { BrowserWindow, app, ipcMain, screen, shell, clipboard } from 'electron';
import path from 'node:path';
import {
  DOCK_COLLAPSED_SIZE,
  DOCK_EXPANDED_SIZE,
  DOCK_ERROR_SIZE,
  DOCK_EDGE_PADDING,
  DOCK_RECORDER_IDLE_STATE,
  type DockActionKind,
  type DockActionMeta,
  type DockDragInput,
  type DockState,
  type DockRecorderState,
} from '../shared/types/dock';
import { sniffClipboardURL, openOutputDir, type TrayDeps } from './tray';
import { openRegionSelectorOverlay, showStaticOverlayForRegion, closeStaticOverlay } from './recorderOverlay';
import { startRecorder, stopRecorder, cancelRecorder, detectMacScreenDevice } from './recorder';
import { captureRegionInsideFrame, dockRecorderParams, maybeRecompressOversizeGif, getDockLongSide, setDockLongSide } from './dockRecording';
import { notifyDockRecordingFinished, notifyDockRecordingFailed } from './dockNotify';
import type { RecorderProgress, RecorderRegion } from '../shared/types/recorder';

const STATE_CHANNEL = 'dock:state';
const RECORDER_STATE_CHANNEL = 'dock:recorderState';
const ACTIONS_CHANNEL_INVOKE = 'dock:getActions';
const TRIGGER_CHANNEL_INVOKE = 'dock:trigger';
const DRAG_CHANNEL_INVOKE = 'dock:drag';
const EXPAND_CHANNEL_INVOKE = 'dock:setExpanded';
const HIDE_CHANNEL_INVOKE = 'dock:hide';
const RECORDER_GET_CHANNEL_INVOKE = 'dock:getRecorderState';
const REVEAL_LAST_CHANNEL_INVOKE = 'dock:revealLastRecording';
const COPY_ERROR_CHANNEL_INVOKE = 'dock:copyErrorMessage';
const GET_LONG_SIDE_CHANNEL_INVOKE = 'dock:getLongSide';
const SET_LONG_SIDE_CHANNEL_INVOKE = 'dock:setLongSide';

export interface DockDeps {
  /** 暴露给 dock 让它 show / hide / focus 主窗口；与 TrayDeps 共用一份。 */
  trayDeps: TrayDeps;
  log: (msg: string) => void;
}

let dockWindow: BrowserWindow | null = null;
let dockExpanded = false;
let ipcWired = false;
let depsRef: DockDeps | null = null;

/** dock 自治的录制会话（与主窗 RecorderPanel 平行）+ done toast 回 idle 定时器。 */
let recorderState: DockRecorderState = { ...DOCK_RECORDER_IDLE_STATE };
let recorderResetTimer: NodeJS.Timeout | null = null;

/** 纯函数:返回 dock 的全部 action metadata。新增 action 时在 dispatchDockAction 同步加 case。 */
export function dockActionMeta(): DockActionMeta[] {
  return [
    { kind: 'dock-record-region', label: '录屏',     icon: 'rec',      description: '就地框选区域并录制（无需打开主窗）', tone: 'primary' },
    { kind: 'dock-record-stop',   label: '停止',     icon: 'stop',     description: '停止当前录制并保存（仅在录制中可点）', tone: 'danger' },
    { kind: 'dock-record-cancel', label: '取消',     icon: 'cancel',   description: '取消当前录制并丢弃产物', tone: 'default' },
    { kind: 'sniff-clipboard',    label: '嗅探',     icon: 'link',     description: '读剪贴板 URL 并嗅探视频/GIF' },
    { kind: 'open-output-dir',    label: '产物目录', icon: 'folder',   description: '在文件管理器中打开默认输出目录' },
    { kind: 'open-toolbox',       label: '工具箱',   icon: 'toolbox',  description: '打开主窗口的 GIF 工具箱（裁剪/调速/压缩）' },
    { kind: 'open-recorder',      label: '录屏面板', icon: 'panel',    description: '打开主窗口的桌面区域录屏面板' },
    { kind: 'open-history',       label: '历史',     icon: 'history',  description: '打开主窗口的历史记录面板' },
    { kind: 'show-main',          label: '显示主窗', icon: 'show',     description: '把主窗口拉到前台并聚焦' },
    { kind: 'hide-main',          label: '隐藏主窗', icon: 'hide',     description: '隐藏主窗口（dock 保留，可随时再唤起）' },
    { kind: 'quit-app',           label: '退出',     icon: 'power',    description: '退出整个 Gif Toolkit' },
  ];
}

export function clampDockPosition(
  pos: { x: number; y: number },
  size: { width: number; height: number },
  workArea: { x: number; y: number; width: number; height: number },
): { x: number; y: number } {
  const minX = workArea.x + DOCK_EDGE_PADDING;
  const minY = workArea.y + DOCK_EDGE_PADDING;
  const maxX = workArea.x + workArea.width - size.width - DOCK_EDGE_PADDING;
  const maxY = workArea.y + workArea.height - size.height - DOCK_EDGE_PADDING;
  const x = Math.min(Math.max(Math.round(pos.x), minX), Math.max(minX, maxX));
  const y = Math.min(Math.max(Math.round(pos.y), minY), Math.max(minY, maxY));
  return { x, y };
}

/** 纯函数：根据起点 + 拖动光标，算出新的窗口左上角坐标（未 clamp）。 */
export function computeDockMoveTarget(input: DockDragInput, anchor: { offsetX: number; offsetY: number }): { x: number; y: number } {
  return {
    x: input.cursorScreenX - anchor.offsetX,
    y: input.cursorScreenY - anchor.offsetY,
  };
}

function dockOrbCenterOffset(size: { width: number; height: number }): { x: number; y: number } {
  const pad = size.width === DOCK_COLLAPSED_SIZE.width && size.height === DOCK_COLLAPSED_SIZE.height ? 0 : 6;
  return { x: pad + 26, y: size.height / 2 };
}

export function computeDockResizeTarget(
  bounds: { x: number; y: number; width: number; height: number },
  nextSize: { width: number; height: number },
): { x: number; y: number } {
  const from = dockOrbCenterOffset({ width: bounds.width, height: bounds.height });
  const to = dockOrbCenterOffset(nextSize);
  return { x: Math.round(bounds.x + from.x - to.x), y: Math.round(bounds.y + from.y - to.y) };
}

/** 纯函数：dock 录制态 reducer，方便测试。'progress' 事件仅在 phase==='recording'
 *  时更新 elapsedMs，避免 idle 时收到延迟到达的 progress 撑出错误的 recording。 */
export type DockRecorderEvent =
  | { type: 'select-start' }
  | { type: 'select-cancelled' }
  | { type: 'recording-start'; sessionId: string }
  | { type: 'progress'; sessionId: string; elapsedMs: number; substep: string }
  | { type: 'finalize-request' }
  | { type: 'done'; outputPath: string; region?: { x: number; y: number; w: number; h: number } }
  | { type: 'cancel-request' }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };

export function recorderStateReducer(prev: DockRecorderState, evt: DockRecorderEvent): DockRecorderState {
  switch (evt.type) {
    case 'select-start':
      return { ...DOCK_RECORDER_IDLE_STATE, phase: 'selecting' };
    case 'select-cancelled':
      return { ...DOCK_RECORDER_IDLE_STATE };
    case 'recording-start':
      return { phase: 'recording', sessionId: evt.sessionId, elapsedMs: 0, errorMessage: null, lastOutputPath: null };
    case 'progress':
      if (prev.phase !== 'recording' || prev.sessionId !== evt.sessionId) return prev;
      return { ...prev, elapsedMs: evt.elapsedMs };
    case 'finalize-request':
      if (prev.phase !== 'recording') return prev;
      return { ...prev, phase: 'finalizing' };
    case 'done':
      return { phase: 'done', sessionId: null, elapsedMs: prev.elapsedMs, errorMessage: null, lastOutputPath: evt.outputPath, lastRegion: evt.region ?? null };
    case 'cancel-request':
      if (prev.phase !== 'recording' && prev.phase !== 'finalizing') return prev;
      return { ...prev, phase: 'finalizing' };
    case 'cancelled':
      return { ...DOCK_RECORDER_IDLE_STATE };
    case 'error':
      return { phase: 'error', sessionId: null, elapsedMs: 0, errorMessage: evt.message, lastOutputPath: null };
    default: {
      const _exhaustive: never = evt;
      void _exhaustive;
      return prev;
    }
  }
}

function applyRecorderEvent(evt: DockRecorderEvent): void {
  const prevPhase = recorderState.phase;
  recorderState = recorderStateReducer(recorderState, evt);
  broadcastRecorderState();
  // R-DOCK-FLOATING #error-toast / #done-visible.
  if ((recorderState.phase === 'error' && prevPhase !== 'error')
      || (recorderState.phase === 'done' && prevPhase !== 'done')) {
    setDockSize(true);
  }
  // R-DOCK-FLOATING #done-autoclose — done 3.5s / error 5s 自动回 idle
  if (recorderState.phase === 'done' || recorderState.phase === 'error') {
    if (recorderResetTimer) { clearTimeout(recorderResetTimer); recorderResetTimer = null; }
    const delay = recorderState.phase === 'done' ? 8000 : 5000;
    const phaseAtSchedule = recorderState.phase;
    recorderResetTimer = setTimeout(() => {
      recorderResetTimer = null;
      if (recorderState.phase !== phaseAtSchedule) return;
      recorderState = { ...DOCK_RECORDER_IDLE_STATE };
      broadcastRecorderState();
      setDockSize(dockExpanded);
    }, delay);
  }
}

function broadcastState(): void {
  if (!dockWindow || dockWindow.isDestroyed() || !depsRef) return;
  const main = depsRef.trayDeps.getMainWindow();
  const state: DockState = {
    visible: dockWindow.isVisible(),
    expanded: dockExpanded,
    mainWindowVisible: !!(main && !main.isDestroyed() && main.isVisible()),
  };
  try { dockWindow.webContents.send(STATE_CHANNEL, state); }
  catch { /* best-effort */ }
  notifyMainOfDockVisibility();
}

/** R-DOCK-FLOATING #唤回路径 — 同步 dock visibility 给主窗 TopBar。 */
function notifyMainOfDockVisibility(): void {
  if (!depsRef) return;
  const main = depsRef.trayDeps.getMainWindow();
  if (!main || main.isDestroyed()) return;
  const visible = !!(dockWindow && !dockWindow.isDestroyed() && dockWindow.isVisible());
  try { main.webContents.send('dock:visibilityChanged', { visible }); }
  catch { /* best-effort */ }
}

function broadcastRecorderState(): void {
  if (!dockWindow || dockWindow.isDestroyed()) return;
  try { dockWindow.webContents.send(RECORDER_STATE_CHANNEL, recorderState); }
  catch { /* best-effort */ }
}

function setDockSize(expanded: boolean): void {
  if (!dockWindow || dockWindow.isDestroyed()) return;
  // error 态优先用 ERROR_SIZE，其它情况按 expanded/collapsed 走。
  const size = recorderState.phase === 'error'
    ? DOCK_ERROR_SIZE
    : (expanded ? DOCK_EXPANDED_SIZE : DOCK_COLLAPSED_SIZE);
  const bounds = dockWindow.getBounds();
  const target = computeDockResizeTarget(bounds, size);
  const anchor = dockOrbCenterOffset({ width: bounds.width, height: bounds.height });
  const display = screen.getDisplayNearestPoint({ x: bounds.x + anchor.x, y: bounds.y + anchor.y });
  const clamped = clampDockPosition(target, size, display.workArea);
  dockWindow.setBounds({ x: clamped.x, y: clamped.y, width: size.width, height: size.height });
  dockExpanded = expanded;
  // R-DOCK-FLOATING #no-backdrop — size 变化后强刷透明 backing。
  if (process.platform === 'darwin') {
    try { dockWindow.setBackgroundColor('#00000000'); } catch { /* ignore */ }
    try { dockWindow.invalidateShadow?.(); } catch { /* ignore */ }
  }
}

/** 主进程统一入口：开始 dock 就地录屏。show overlay → 拿 region → ffmpeg → 静态遮罩 → state=recording */
async function startDockRecording(deps: DockDeps): Promise<void> {
  if (recorderState.phase === 'selecting' || recorderState.phase === 'recording' || recorderState.phase === 'finalizing') {
    deps.log(`dock recording: ignored start, already in phase=${recorderState.phase}`);
    return;
  }
  applyRecorderEvent({ type: 'select-start' });
  // R-REC-DESKTOP-AREA #multi-display — 用 dock 球当前所在屏（不能 hard-code primary）
  const db = dockWindow?.getBounds();
  const anchor = db ? { x: db.x + Math.floor(db.width / 2), y: db.y + Math.floor(db.height / 2) } : null;
  const display = anchor ? screen.getDisplayNearestPoint(anchor) : screen.getPrimaryDisplay();
  deps.log(`dock recording: selector display id=${display.id} ${display.bounds.x},${display.bounds.y} ${display.bounds.width}x${display.bounds.height} sf=${display.scaleFactor}`);
  const result = await openRegionSelectorOverlay({ displayId: display.id });
  if (!result.ok || !result.region) {
    applyRecorderEvent({ type: 'select-cancelled' });
    return;
  }
  const visualRegion: RecorderRegion = result.region;
  // 红框只给用户看；ffmpeg 裁红框内侧，避免遮罩带进产物。
  const region = captureRegionInsideFrame(visualRegion);

  const params = dockRecorderParams(region);

  try {
    // R-REC-DESKTOP-AREA — region display 角色驱动 avf device idx(见
    // detectMacScreenDevice 注释),按 ordinal 取 devices[N] 是错的。
    const allDisplays = screen.getAllDisplays();
    const regionDisplay = allDisplays.find((d) => d.id === region.displayId) ?? screen.getPrimaryDisplay();
    const primaryId = screen.getPrimaryDisplay().id;
    const isPrimary = regionDisplay.id === primaryId;
    const secondaries = allDisplays.filter((d) => d.id !== primaryId);
    const secondaryOrdinal = Math.max(0, secondaries.findIndex((d) => d.id === regionDisplay.id));
    const macDeviceIdx = process.platform === 'darwin'
      ? await detectMacScreenDevice({ isPrimary, secondaryOrdinal })
      : undefined;
    deps.log(`dock recording: visualRegion=${visualRegion.x},${visualRegion.y} ${visualRegion.w}x${visualRegion.h} captureRegion=${region.x},${region.y} ${region.w}x${region.h} sf=${regionDisplay.scaleFactor} isPrimary=${isPrimary} secOrd=${secondaryOrdinal} avf=${macDeviceIdx}`);
    const outDirBase = deps.trayDeps.getDefaultOutDir?.() ?? '';
    const recOutDir = outDirBase ? path.join(outDirBase, 'recordings') : undefined;
    const { sessionId, done } = startRecorder({
      params,
      avfoundationDeviceIndex: macDeviceIdx,
      regionScaleFactor: regionDisplay.scaleFactor,
      outputDir: recOutDir,
      onProgress: (p: RecorderProgress) => {
        applyRecorderEvent({ type: 'progress', sessionId: p.sessionId, elapsedMs: p.elapsedMs, substep: p.substep });
      },
    });
    applyRecorderEvent({ type: 'recording-start', sessionId });
    showStaticOverlayForRegion({ displayId: visualRegion.displayId, region: visualRegion });

    done
      .then(async (r) => {
        closeStaticOverlay();
        if (r.cancelled) {
          applyRecorderEvent({ type: 'cancelled' });
        } else {
          // R-REC-DESKTOP-AREA #recompress-oversize — 超 maxBytes 才接 gif-optimize；progress fan-out 到主窗。
          const mainWin = deps.trayDeps.getMainWindow();
          const gifPath = await maybeRecompressOversizeGif({
            gifPath: r.outputPath,
            outputBaseDir: recOutDir ?? path.dirname(r.outputPath),
            params,
            emit: (p) => {
              deps.log(`dock recording: recompress chain ${p.status} ${p.percent}% ${p.message ?? ''}`);
              if (mainWin && !mainWin.isDestroyed()) {
                try { mainWin.webContents.send('process:progress', p); } catch { /* best-effort */ }
              }
            },
          });
          applyRecorderEvent({ type: 'done', outputPath: gifPath, region: { x: visualRegion.x, y: visualRegion.y, w: visualRegion.w, h: visualRegion.h } });
          // R-DOCK-FLOATING #notify — done 8s 后自动 reset，发系统通知避免用户错过。
          notifyDockRecordingFinished({ gifPath, log: deps.log });
        }
      })
      .catch((e: Error) => {
        closeStaticOverlay();
        applyRecorderEvent({ type: 'error', message: e.message });
        notifyDockRecordingFailed({ message: e.message, log: deps.log });
      });
  } catch (e) {
    closeStaticOverlay();
    applyRecorderEvent({ type: 'error', message: (e as Error).message });
  }
}

async function stopDockRecording(deps: DockDeps): Promise<void> {
  if (recorderState.phase !== 'recording' || !recorderState.sessionId) {
    deps.log(`dock recording: ignored stop, phase=${recorderState.phase}`);
    return;
  }
  applyRecorderEvent({ type: 'finalize-request' });
  try {
    await stopRecorder(recorderState.sessionId);
  } catch (e) {
    applyRecorderEvent({ type: 'error', message: (e as Error).message });
  }
}

async function cancelDockRecording(deps: DockDeps): Promise<void> {
  // R-DOCK-FLOATING #error-toast：error / done 阶段也接受 cancel 关闭 toast。
  if (recorderState.phase === 'idle') {
    return;
  }
  if (recorderState.phase === 'done' || recorderState.phase === 'error') {
    if (recorderResetTimer) { clearTimeout(recorderResetTimer); recorderResetTimer = null; }
    recorderState = { ...DOCK_RECORDER_IDLE_STATE };
    broadcastRecorderState();
    setDockSize(dockExpanded);
    return;
  }
  applyRecorderEvent({ type: 'cancel-request' });
  try {
    if (recorderState.sessionId) await cancelRecorder(recorderState.sessionId);
    closeStaticOverlay();
  } catch (e) {
    deps.log(`dock recording: cancel failed: ${(e as Error).message}`);
  }
}

export async function dispatchDockAction(action: DockActionKind, deps: DockDeps): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    switch (action) {
      case 'open-recorder': {
        await deps.trayDeps.showOrCreateMainWindow();
        const w = deps.trayDeps.getMainWindow();
        if (w && !w.isDestroyed()) w.webContents.send('tray:navigate', { tab: 'recorder' });
        break;
      }
      case 'open-toolbox': {
        await deps.trayDeps.showOrCreateMainWindow();
        const w = deps.trayDeps.getMainWindow();
        if (w && !w.isDestroyed()) w.webContents.send('tray:navigate', { tab: 'toolbox' });
        break;
      }
      case 'open-history': {
        await deps.trayDeps.showOrCreateMainWindow();
        const w = deps.trayDeps.getMainWindow();
        if (w && !w.isDestroyed()) w.webContents.send('tray:navigate', { tab: 'history' });
        break;
      }
      case 'sniff-clipboard': {
        await sniffClipboardURL(deps.trayDeps);
        break;
      }
      case 'open-output-dir': {
        await openOutputDir(deps.trayDeps);
        break;
      }
      case 'dock-record-region': { void startDockRecording(deps); break; }
      case 'dock-record-stop': { void stopDockRecording(deps); break; }
      case 'dock-record-cancel': { void cancelDockRecording(deps); break; }
      case 'show-main': { await deps.trayDeps.showOrCreateMainWindow(); break; }
      case 'hide-main': {
        const w = deps.trayDeps.getMainWindow();
        if (w && !w.isDestroyed()) w.hide();
        break;
      }
      case 'quit-app': { app.quit(); break; }
      default: {
        const exhaustive: never = action;
        return { ok: false, reason: `unknown action ${String(exhaustive)}` };
      }
    }
    broadcastState();
    return { ok: true };
  } catch (e) {
    deps.log(`dock.dispatchAction(${action}) failed: ${(e as Error).message}`);
    return { ok: false, reason: (e as Error).message };
  }
}

let dragAnchor: { offsetX: number; offsetY: number } | null = null;

function wireIpcOnce(deps: DockDeps): void {
  if (ipcWired) return;
  ipcWired = true;
  depsRef = deps;

  ipcMain.handle(ACTIONS_CHANNEL_INVOKE, () => dockActionMeta());

  ipcMain.handle(TRIGGER_CHANNEL_INVOKE, async (_e, raw: unknown) => {
    const action = raw as DockActionKind;
    return dispatchDockAction(action, deps);
  });

  ipcMain.handle(EXPAND_CHANNEL_INVOKE, (_e, expanded: unknown) => {
    setDockSize(!!expanded);
    broadcastState();
    return { ok: true };
  });

  ipcMain.handle(HIDE_CHANNEL_INVOKE, () => {
    if (dockWindow && !dockWindow.isDestroyed()) dockWindow.hide();
    broadcastState();
    return { ok: true };
  });

  ipcMain.handle(RECORDER_GET_CHANNEL_INVOKE, () => recorderState);

  ipcMain.handle(REVEAL_LAST_CHANNEL_INVOKE, () => {
    const p = recorderState.lastOutputPath;
    if (p) shell.showItemInFolder(p);
    return { ok: !!p };
  });

  // v2.2 错误复制:dock 错误 toast 的「复制」按钮走主进程 clipboard
  // (renderer 在 transparent + alwaysOnTop 里 navigator.clipboard 不
  // 稳定);超长截断到 16KB 防 clipboard 灾难。
  ipcMain.handle(COPY_ERROR_CHANNEL_INVOKE, (_e, raw: unknown) => {
    const text = typeof raw === 'string' ? raw : String(raw ?? '');
    const clipped = text.length > 16 * 1024 ? text.slice(0, 16 * 1024) : text;
    try {
      clipboard.writeText(clipped);
      return { ok: true };
    } catch (e) {
      deps.log(`dock copyErrorMessage failed: ${(e as Error).message}`);
      return { ok: false };
    }
  });

  // v2.3 最长边 chip：写入 dockRecording 模块级 lastLongSide。
  ipcMain.handle(GET_LONG_SIDE_CHANNEL_INVOKE, () => ({ longSide: getDockLongSide() }));
  ipcMain.handle(SET_LONG_SIDE_CHANNEL_INVOKE, (_e, raw: unknown) => {
    const n = typeof raw === 'number' ? raw : Number(raw);
    const ok = setDockLongSide(Number.isFinite(n) ? n : NaN);
    return { ok, longSide: getDockLongSide() };
  });

  ipcMain.handle(DRAG_CHANNEL_INVOKE, (_e, raw: unknown) => {
    if (!dockWindow || dockWindow.isDestroyed()) return { ok: false };
    if (!raw || typeof raw !== 'object') return { ok: false };
    const o = raw as Record<string, unknown>;
    const phase = String(o.phase ?? '');
    const input = o.input as DockDragInput | undefined;
    if (phase === 'start' && input) {
      dragAnchor = {
        offsetX: input.cursorScreenX - input.startWindowX,
        offsetY: input.cursorScreenY - input.startWindowY,
      };
      return { ok: true };
    }
    if (phase === 'move' && input && dragAnchor) {
      const size = dockExpanded ? DOCK_EXPANDED_SIZE : DOCK_COLLAPSED_SIZE;
      const target = computeDockMoveTarget(input, dragAnchor);
      const display = screen.getDisplayNearestPoint({ x: target.x, y: target.y });
      const clamped = clampDockPosition(target, size, display.workArea);
      dockWindow.setBounds({ x: clamped.x, y: clamped.y, width: size.width, height: size.height });
      return { ok: true };
    }
    if (phase === 'end') {
      dragAnchor = null;
      return { ok: true };
    }
    return { ok: false };
  });
}

export function isDockVisible(): boolean {
  return !!(dockWindow && !dockWindow.isDestroyed() && dockWindow.isVisible());
}

export function createDockWindow(deps: DockDeps): BrowserWindow {
  wireIpcOnce(deps);
  depsRef = deps;
  if (dockWindow && !dockWindow.isDestroyed()) {
    dockWindow.show();
    dockWindow.focus();
    broadcastState();
    broadcastRecorderState();
    return dockWindow;
  }

  const display = screen.getPrimaryDisplay();
  const size = DOCK_COLLAPSED_SIZE;
  const initial = clampDockPosition(
    {
      x: display.workArea.x + display.workArea.width - size.width - 24,
      y: display.workArea.y + display.workArea.height - size.height - 24,
    },
    size,
    display.workArea,
  );

  dockWindow = new BrowserWindow({
    x: initial.x,
    y: initial.y,
    width: size.width,
    height: size.height,
    frame: false,
    transparent: true,
    // R-DOCK-FLOATING #no-backdrop — 与 recorderOverlay 保持同款透明窗口参数。
    alwaysOnTop: true,
    fullscreenable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/dockOverlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  dockWindow.setBackgroundColor('#00000000');
  dockWindow.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') {
    dockWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  // R-REC-DESKTOP-AREA #overlay-not-captured — dock 浮球不能被录进产物。
  try { dockWindow.setContentProtection(true); } catch { /* older Electron, ignore */ }

  dockWindow.once('ready-to-show', () => {
    if (!dockWindow || dockWindow.isDestroyed()) return;
    dockWindow.showInactive();
    broadcastState();
    broadcastRecorderState();
  });

  dockWindow.on('closed', () => {
    dockWindow = null;
    dockExpanded = false;
    dragAnchor = null;
  });

  if (process.env.NODE_ENV === 'development') {
    dockWindow.loadURL('http://localhost:5173/dockOverlay.html').catch((e) => {
      deps.log(`dock loadURL failed: ${(e as Error).message}`);
    });
  } else {
    dockWindow.loadFile(path.join(__dirname, '../renderer/dockOverlay.html')).catch((e) => {
      deps.log(`dock loadFile failed: ${(e as Error).message}`);
    });
  }

  return dockWindow;
}

export function destroyDockWindow(): void {
  // 把进行中的录制 cancel 掉，避免遗留 ffmpeg；recorder.ts 的 SIGKILL
  // 兜底会确保进程死掉。
  if (recorderState.sessionId && (recorderState.phase === 'recording' || recorderState.phase === 'finalizing')) {
    try { void cancelRecorder(recorderState.sessionId); } catch { /* best-effort */ }
  }
  try { closeStaticOverlay(); } catch { /* best-effort */ }
  if (recorderResetTimer) { clearTimeout(recorderResetTimer); recorderResetTimer = null; }
  recorderState = { ...DOCK_RECORDER_IDLE_STATE };
  if (dockWindow && !dockWindow.isDestroyed()) {
    try { dockWindow.destroy(); } catch { /* best-effort */ }
  }
  dockWindow = null;
  dockExpanded = false;
  dragAnchor = null;
  // R-DOCK-FLOATING #唤回路径.
  notifyMainOfDockVisibility();
}

export function notifyDockStateChanged(_deps: DockDeps): void {
  broadcastState();
}

/** 主进程把 recorder progress 转给 dock(main/index.ts 的 fan-out)。 */
export function notifyDockRecorderProgress(p: RecorderProgress): void {
  if (recorderState.sessionId !== p.sessionId) return;
  if (p.substep === 'done' || p.substep === 'cancelled' || p.substep === 'error') {
    return; // 终态由 startDockRecording 的 done promise 处理
  }
  applyRecorderEvent({ type: 'progress', sessionId: p.sessionId, elapsedMs: p.elapsedMs, substep: p.substep });
}
