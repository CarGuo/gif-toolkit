/**
 * R-REC-DESKTOP-AREA — region selector overlay (main-process side).
 *
 * 行为：
 *   1. `openRegionSelectorOverlay(displayId)` 在指定 display 上拉一个
 *      transparent / frame-less / alwaysOnTop / fullscreen BrowserWindow。
 *   2. overlay 的渲染端（src/renderer/recorderOverlay.html）画一层半透明
 *      遮罩 + 拖框选区 + ESC/确认按钮，结果通过 IPC `recorder-overlay:result`
 *      回传 `{ ok, region? }`。
 *   3. 主进程 promise resolve 后立刻 destroy 窗口（不复用），避免悬留。
 *   4. **不**给 overlay 注入完整 preload。它只暴露 minimum：onConfig /
 *      finish / cancel 三件套 → 见 [src/preload/recorderOverlay.ts]。
 */

import { BrowserWindow, ipcMain, screen, shell, systemPreferences } from 'electron';
import path from 'path';
import { log } from './logger';
import type { RecorderRegion } from '../shared/types/recorder';
import { listVisibleWindows, excludeSelfWindows, type VisibleWindow } from './windowList';

const RESULT_CHANNEL = 'recorder-overlay:result';
const CONFIG_CHANNEL = 'recorder-overlay:config';

export interface OpenOverlayInput {
  /** Electron display id（screen.getAllDisplays() 来源）。 */
  displayId: number;
}

export interface OpenOverlayResult {
  ok: boolean;
  region?: RecorderRegion;
  cancelled?: boolean;
}

let pending: {
  win: BrowserWindow;
  resolve: (r: OpenOverlayResult) => void;
  display: Electron.Display;
} | null = null;

/** R-REC-DESKTOP-AREA #overlay-content-vs-display (SC-REC-OVERLAY-MENU-BAR) —
 *  mac 上 `transparent + frame:false` BrowserWindow 把 frame bounds 设到
 *  display.bounds（含 menu bar 区域）时，**webContents 渲染区域仍会被系统
 *  自动避开 menu bar / notch**：overlay-renderer 看到的 CSS (0,0) ≈
 *  `display.workArea.top` 而不是 `display.bounds.top`。
 *
 *  ⚠️ 不要用 `win.getContentBounds()`：mac transparent + frameless 窗口它
 *  会返回 frame bounds（= display.bounds），delta 算成 0，等于没修。要拿
 *  「被 menu bar 推下来的 CSS 偏移」，正确做法是直接读 [Electron Display.workArea](https://www.electronjs.org/zh/docs/latest/api/structures/display)
 *  —— 它**契约保证**等于 display.bounds 减去 menu bar / dock。
 *
 *  双向校正：
 *    1. selector overlay 回传的 region 是 overlay-local CSS（≈ workArea 起点），
 *       要 +(workArea − bounds) 偏移成 display-local CSS，主进程 buildRecorderArgs
 *       才能把它 ×scaleFactor 转成正确的 device px crop offset；
 *    2. static overlay 收到的 region 是 display-local CSS，要 −(workArea − bounds)
 *       才能在 overlay-local CSS 里画到对的位置。
 *
 *  win/linux：display.workArea.y === display.bounds.y → delta=0，跨平台等价。
 *
 *  现象排查记忆点：如果产物上多了一条 macOS title bar / 主窗 logo 行 +
 *  底部被截一段 ≈ menu bar 高度的内容 = ffmpeg crop offset y 偏小 = 这里
 *  delta 没加上去。 */
export function applyOverlayContentDelta(
  raw: RecorderRegion,
  workArea: { x: number; y: number },
  displayBounds: { x: number; y: number },
): RecorderRegion {
  const deltaX = workArea.x - displayBounds.x;
  const deltaY = workArea.y - displayBounds.y;
  return {
    ...raw,
    x: raw.x + deltaX,
    y: raw.y + deltaY,
  };
}

function correctRegionFromOverlayLocal(
  display: Electron.Display,
  raw: RecorderRegion,
): RecorderRegion {
  const corrected = applyOverlayContentDelta(raw, display.workArea, display.bounds);
  if (process.env.NODE_ENV === 'development') {
    log(`overlay region correct: raw=${raw.x},${raw.y} ${raw.w}x${raw.h} `
      + `displayBounds=${display.bounds.x},${display.bounds.y} `
      + `workArea=${display.workArea.x},${display.workArea.y} `
      + `corrected=${corrected.x},${corrected.y}`);
  }
  return corrected;
}

function ensureGlobalIpcOnce(): void {
  if ((ensureGlobalIpcOnce as unknown as { wired?: boolean }).wired) return;
  (ensureGlobalIpcOnce as unknown as { wired?: boolean }).wired = true;
  ipcMain.on(RESULT_CHANNEL, (_e, payload) => {
    if (!pending) return;
    const { win, resolve, display } = pending;
    pending = null;
    if (!payload || typeof payload !== 'object') {
      try { win.destroy(); } catch { /* ignore */ }
      resolve({ ok: false, cancelled: true });
      return;
    }
    const obj = payload as { ok?: boolean; cancelled?: boolean; region?: RecorderRegion };
    if (obj.ok && obj.region) {
      const corrected = correctRegionFromOverlayLocal(display, obj.region);
      try { win.destroy(); } catch { /* ignore */ }
      resolve({ ok: true, region: corrected });
    } else {
      try { win.destroy(); } catch { /* ignore */ }
      resolve({ ok: false, cancelled: !!obj.cancelled });
    }
  });
  // R-REC-DESKTOP-AREA #ax-perm — selector overlay 在 mac 上检测到无辅助
  // 功能权限时,会暴露「🔓 授予辅助功能权限」chip,点击走这条 IPC 直接
  // 把用户深链到「系统设置 → 隐私与安全性 → 辅助功能」面板。
  ipcMain.handle('recorder-overlay:open-ax-settings', () => {
    if (process.platform === 'darwin') {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    }
  });
}

export function openRegionSelectorOverlay(input: OpenOverlayInput): Promise<OpenOverlayResult> {
  ensureGlobalIpcOnce();
  // 已有 overlay 在等结果：拒绝并发，让上一个先结束（取消）。
  if (pending) {
    try { pending.win.destroy(); } catch { /* ignore */ }
    const prev = pending;
    pending = null;
    prev.resolve({ ok: false, cancelled: true });
  }

  const target = screen.getAllDisplays().find((d) => d.id === input.displayId)
    ?? screen.getPrimaryDisplay();
  const { x, y, width, height } = target.bounds;

  const win = new BrowserWindow({
    x, y, width, height,
    frame: false,
    transparent: true,
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
      preload: path.join(__dirname, '../preload/recorderOverlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // 跨平台「真正置顶」+ 不要进 mac mission control。
  win.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
    // R-REC-DESKTOP-AREA #window-snap — 一次性把窗口快照塞进 cfg，让
    // renderer 实现 hover-to-snap：拿到的 windows 是全局桌面坐标，
    // renderer 按 bounds.x/y 偏移到屏内相对 px 再 hit-test。mac 上 osascript
    // 可能因辅助功能权限失败，此时返回 []，renderer 自动降级到普通拖框。
    void (async (): Promise<void> => {
      // R-REC-DESKTOP-AREA #ax-perm — 先探测辅助功能权限，listVisibleWindows
      // 在 mac 上依赖 System Events / JXA，需要 Accessibility 授权才能拿到
      // 窗口列表。把这一位 needsPermission 透回 renderer，让 selector 在
      // 「吸附窗口（不可用）」chip 位置展示「🔓 授予辅助功能权限」可点 chip。
      //
      // ⚠️ #no-prompt — 调用 `osascript` 跑 JXA 调用 System Events 会**主动
      // 触发** macOS 的辅助功能权限授权弹窗（即便 isTrustedAccessibilityClient
      // 传 false 不主动 prompt，spawn 命令本身仍会触发系统对话框）。
      // 因此必须先用 isTrustedAccessibilityClient 短路：未授权时直接给空
      // windows 数组 + needsPermission=true，让 selector 走降级链路，
      // **绝不**在未授权时调 listVisibleWindows（SC-REC-AX-PROMPT）。
      const hasAxPerm = process.platform === 'darwin'
        ? systemPreferences.isTrustedAccessibilityClient(false)
        : true;
      let windows: VisibleWindow[] = [];
      if (hasAxPerm) {
        try { windows = await listVisibleWindows(); } catch { windows = []; }
      }
      // #self-window-exclude 三道闸：(1)JXA 内 SELF_APP_NAMES 跳过 (2)parseJxaOutput
      // 兜底 (3)按当前所有 BrowserWindow.bounds 做 IoU 剔重叠，覆盖 productName 撞名场景。
      const selfBounds = BrowserWindow.getAllWindows()
        .filter((bw) => !bw.isDestroyed() && bw.id !== win.id)
        .map((bw) => bw.getBounds());
      windows = excludeSelfWindows(windows, selfBounds);
      // 把 windows 坐标提前转成「相对当前屏的 CSS px」，renderer 直接 hit-test。
      const winsForDisplay = windows
        .map((w) => ({
          x: w.x - target.bounds.x,
          y: w.y - target.bounds.y,
          w: w.w,
          h: w.h,
          app: w.app,
          title: w.title,
        }))
        .filter((w) => w.x + w.w > 0 && w.y + w.h > 0
          && w.x < target.bounds.width && w.y < target.bounds.height);
      if (win.isDestroyed()) return;
      log(`overlay cfg: hasAxPerm=${hasAxPerm} windowsCount=${winsForDisplay.length}`);
      // needsPermission 只表示系统明确没给辅助功能权限。窗口列表为空不能等价
      // 为没授权：可能只是当前屏没有可吸附窗口 / JXA 超时。此时保留拖框
      // 链路，避免把用户卡在一个错误的授权 chip 上。
      const needsPermission = !hasAxPerm;
      win.webContents.send(CONFIG_CHANNEL, {
        displayId: input.displayId,
        bounds: target.bounds,
        scaleFactor: target.scaleFactor,
        windows: winsForDisplay,
        needsPermission,
      });
    })();
  });

  win.on('closed', () => {
    if (pending && pending.win === win) {
      const prev = pending;
      pending = null;
      prev.resolve({ ok: false, cancelled: true });
    }
  });

  const promise = new Promise<OpenOverlayResult>((resolve) => {
    pending = { win, resolve, display: target };
  });

  if (process.env.NODE_ENV === 'development') {
    win.loadURL('http://localhost:5173/recorderOverlay.html').catch((e) => {
      log(`overlay loadURL failed: ${(e as Error).message}`);
    });
  } else {
    win.loadFile(path.join(__dirname, '../renderer/recorderOverlay.html')).catch((e) => {
      log(`overlay loadFile failed: ${(e as Error).message}`);
    });
  }

  return promise;
}

export function cancelOverlayIfAny(): void {
  if (!pending) return;
  const prev = pending;
  pending = null;
  try { prev.win.destroy(); } catch { /* ignore */ }
  prev.resolve({ ok: false, cancelled: true });
}

/* ------------------------------------------------------------------
 * R-DOCK-FLOATING v2 / R-REC-DESKTOP-AREA #6 — 「录制中只读遮罩」
 *
 * dock 的就地录屏全程都要让用户能看到「现在在录哪儿」。我们用同一份
 * recorderOverlay.html，但传入 `mode='static'` + `region`，让 overlay
 * 只画静态高亮框 + 「录制中」横幅，不再响应 ESC / 拖动 / 确认按钮。
 *
 * `showStaticOverlayForRegion` 和 `openRegionSelectorOverlay` **互斥**
 * （都用 RESULT_CHANNEL）。因为录制过程的 overlay 没有结果回传，我们
 * 用单独的 module-scoped 变量持有，调用 closeStaticOverlay 立即 destroy。
 * 这种 read-only 形态点击穿透——通过 `setIgnoreMouseEvents(true)` 让用
 * 户依然能与桌面交互，dock 浮在最上面控制停止。
 * ------------------------------------------------------------------ */

let staticOverlay: BrowserWindow | null = null;

export interface ShowStaticOverlayInput {
  displayId: number;
  region: RecorderRegion;
}

const STATIC_CONFIG_CHANNEL = 'recorder-overlay:static-config';

export function showStaticOverlayForRegion(input: ShowStaticOverlayInput): void {
  log(`staticOverlay: region=${input.region.x},${input.region.y} ${input.region.w}x${input.region.h} displayId=${input.region.displayId}`);
  closeStaticOverlay();
  const target = screen.getAllDisplays().find((d) => d.id === input.displayId)
    ?? screen.getPrimaryDisplay();
  const { x, y, width, height } = target.bounds;

  staticOverlay = new BrowserWindow({
    x, y, width, height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    fullscreenable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/recorderOverlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  staticOverlay.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') {
    staticOverlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  // 点击穿透——遮罩只是视觉提示，不抢用户的桌面操作。dock 浮在更上层。
  staticOverlay.setIgnoreMouseEvents(true, { forward: true });
  // R-REC-DESKTOP-AREA #overlay-not-captured —— 关键：让 avfoundation/gdigrab
  // 抓帧时**看不到**这个红框 overlay。否则用户截图能看到"产物里多一条红线"
  // (outline 像素被真实拍进帧；见 SC-REC-RED-LINE-IN-CAPTURE)。mac+win 都支持。
  try { staticOverlay.setContentProtection(true); } catch { /* older Electron, ignore */ }

  const w = staticOverlay;
  staticOverlay.once('ready-to-show', () => {
    if (!w || w.isDestroyed()) return;
    w.showInactive();
    // 反向校正：input.region 是 display-local CSS（已被 selector 端 +delta
    // 修正过），但 staticOverlay 渲染端的 CSS 起点同样会被 mac menu bar
    // 推下来 ≈ workArea。所以把 region 减去 (workArea - display.bounds)
    // 再发给渲染端，红框就能落到「即将被 ffmpeg crop 的同一块 device px」
    // 对应的 overlay-local CSS 位置上（见 SC-REC-OVERLAY-MENU-BAR）。
    // 用 workArea 而非 getContentBounds：mac transparent + frameless 窗口
    // getContentBounds 返回 frame bounds，delta 算成 0。
    const deltaX = target.workArea.x - target.bounds.x;
    const deltaY = target.workArea.y - target.bounds.y;
    const renderRegion = {
      ...input.region,
      x: input.region.x - deltaX,
      y: input.region.y - deltaY,
    };
    w.webContents.send(STATIC_CONFIG_CHANNEL, {
      displayId: input.displayId,
      bounds: target.bounds,
      scaleFactor: target.scaleFactor,
      region: renderRegion,
    });
  });
  staticOverlay.on('closed', () => {
    if (staticOverlay === w) staticOverlay = null;
  });

  if (process.env.NODE_ENV === 'development') {
    staticOverlay.loadURL('http://localhost:5173/recorderOverlay.html').catch((e) => {
      log(`static overlay loadURL failed: ${(e as Error).message}`);
    });
  } else {
    staticOverlay.loadFile(path.join(__dirname, '../renderer/recorderOverlay.html')).catch((e) => {
      log(`static overlay loadFile failed: ${(e as Error).message}`);
    });
  }
}

export function closeStaticOverlay(): void {
  if (staticOverlay && !staticOverlay.isDestroyed()) {
    try { staticOverlay.destroy(); } catch { /* ignore */ }
  }
  staticOverlay = null;
}
