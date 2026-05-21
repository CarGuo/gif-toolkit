import { app, Tray, Menu, nativeImage, shell, clipboard, BrowserWindow, MenuItemConstructorOptions } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

export interface TrayDeps {
  getMainWindow: () => BrowserWindow | null;
  showOrCreateMainWindow: () => Promise<void> | void;
  getDefaultOutDir: () => string | null;
  log: (msg: string) => void;
}

let trayInstance: Tray | null = null;

const HTTP_PROBE = /^https?:\/\/\S+$/i;

function pickTrayIconPath(): string | null {
  const candidates = process.platform === 'darwin'
    ? ['build/icons/16x16.png', 'build/icons/32x32.png']
    : ['build/icons/32x32.png', 'build/icons/64x64.png', 'build/icon.png'];
  for (const rel of candidates) {
    const abs = path.resolve(app.getAppPath(), rel);
    if (fs.existsSync(abs)) return abs;
    const cwdAbs = path.resolve(process.cwd(), rel);
    if (fs.existsSync(cwdAbs)) return cwdAbs;
  }
  return null;
}

function buildTrayImage(): Electron.NativeImage {
  const p = pickTrayIconPath();
  if (!p) return nativeImage.createEmpty();
  const img = nativeImage.createFromPath(p);
  // We deliberately do NOT call setTemplateImage(true) on macOS:
  // template images require a single-colour mask (black + alpha)
  // and Electron will collapse our full-colour brand logo into a
  // solid white/black blob in the menu bar. Without template mode
  // the icon stays full-colour and is recognisable. The visual
  // trade-off is that it won't auto-invert with menu bar dark mode,
  // but a recognisable colour logo beats an unidentifiable blob.
  if (process.platform === 'darwin') {
    return img.resize({ width: 18, height: 18 });
  }
  return img.resize({ width: 16, height: 16 });
}

export function isUrlLikeClipboard(): { ok: true; url: string } | { ok: false } {
  const raw = clipboard.readText('clipboard') || '';
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 4096) return { ok: false };
  if (!HTTP_PROBE.test(trimmed)) return { ok: false };
  return { ok: true, url: trimmed };
}

export async function sniffClipboardURL(deps: TrayDeps): Promise<void> {
  const result = isUrlLikeClipboard();
  await deps.showOrCreateMainWindow();
  const win = deps.getMainWindow();
  if (!win || win.isDestroyed()) {
    deps.log('tray.sniffClipboard: no main window after show');
    return;
  }
  const wc = win.webContents;
  if (!result.ok) {
    wc.send('tray:toast', { level: 'warn', message: '剪贴板没有可识别的 URL(需以 http/https 开头)' });
    return;
  }
  wc.send('tray:sniff-url', { url: result.url });
  deps.log(`tray.sniffClipboard: dispatched url=${result.url.slice(0, 80)}`);
}

export async function openOutputDir(deps: TrayDeps): Promise<void> {
  const dir = deps.getDefaultOutDir();
  if (!dir) {
    deps.log('tray.openOutputDir: defaultOutDir unavailable');
    const win = deps.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('tray:toast', { level: 'warn', message: '尚未确定输出目录,请先在 App 内运行一次任务' });
    }
    return;
  }
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const errMsg = await shell.openPath(dir);
    if (errMsg) deps.log(`tray.openOutputDir: shell.openPath returned ${errMsg}`);
  } catch (e) {
    deps.log(`tray.openOutputDir failed: ${(e as Error).message}`);
  }
}

function buildContextMenu(deps: TrayDeps): Menu {
  const items: MenuItemConstructorOptions[] = [
    {
      label: '显示主窗',
      click: () => { void deps.showOrCreateMainWindow(); },
    },
    {
      label: '从剪贴板嗅探 URL',
      click: () => { void sniffClipboardURL(deps); },
    },
    {
      label: '打开输出目录',
      click: () => { void openOutputDir(deps); },
    },
    { type: 'separator' },
    {
      label: '上次任务回看',
      click: () => {
        void deps.showOrCreateMainWindow();
        const win = deps.getMainWindow();
        if (win && !win.isDestroyed()) {
          deps.log('tray menu click: 上次任务回看 -> tray:navigate { tab: history }');
          win.webContents.send('tray:navigate', { tab: 'history' });
        } else {
          deps.log('tray menu click: 上次任务回看 -> mainWindow gone, IPC dropped');
        }
      },
    },
    {
      label: '一键重传最近产物',
      click: () => {
        void deps.showOrCreateMainWindow();
        const win = deps.getMainWindow();
        if (win && !win.isDestroyed()) {
          deps.log('tray menu click: 一键重传最近产物 -> tray:reupload-latest');
          win.webContents.send('tray:reupload-latest');
        } else {
          deps.log('tray menu click: 一键重传最近产物 -> mainWindow gone, IPC dropped');
        }
      },
    },
    { type: 'separator' },
    {
      label: `关于 Gif Toolkit ${app.getVersion()}`,
      click: () => { app.showAboutPanel(); },
    },
    {
      label: '退出',
      // We use an explicit click + accelerator instead of `role: 'quit'`
      // because on macOS Electron 31's tray-menu rendering of `role: 'quit'`
      // injects a leading icon for the row, which forces the menu's
      // icon column on for the entire menu and visibly mis-indents
      // every other (icon-less) item. Going through app.quit() keeps
      // the standard quit semantics + Cmd+Q accelerator without the
      // decoration, so all rows align flush-left.
      accelerator: process.platform === 'darwin' ? 'Command+Q' : 'Control+Q',
      click: () => { app.quit(); },
    },
  ];
  return Menu.buildFromTemplate(items);
}

export function setupTray(deps: TrayDeps): Tray | null {
  if (trayInstance) return trayInstance;
  try {
    const image = buildTrayImage();
    const tray = new Tray(image);
    tray.setToolTip('Gif Toolkit');
    const refreshMenu = (): void => { tray.setContextMenu(buildContextMenu(deps)); };
    refreshMenu();
    if (process.platform !== 'darwin') {
      tray.on('click', () => { void deps.showOrCreateMainWindow(); });
    }
    tray.on('right-click', () => { refreshMenu(); tray.popUpContextMenu(); });
    trayInstance = tray;
    deps.log('tray: ready');
    return tray;
  } catch (e) {
    deps.log(`tray: setup failed: ${(e as Error).message}`);
    return null;
  }
}

export function destroyTray(): void {
  if (trayInstance && !trayInstance.isDestroyed()) {
    try { trayInstance.destroy(); } catch { /* best-effort */ }
  }
  trayInstance = null;
}
