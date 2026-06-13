import { BrowserWindow, ipcMain, app } from 'electron';

const buffer: string[] = [];
const MAX = 500;

export function log(line: string): void {
  const ts = new Date().toISOString();
  const msg = `[${ts}] ${line}`;
  // eslint-disable-next-line no-console
  console.log(msg);
  buffer.push(msg);
  if (buffer.length > MAX) buffer.shift();
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      try {
        w.webContents.send('app:log', msg);
      } catch {
        // ignore (e.g. webContents destroyed mid-send)
      }
    }
  }
}

export function dumpLogPath(): string {
  return `${app.getPath('userData')}/app.log`;
}

let bufferHandlerRegistered = false;

/**
 * R-LOGGER-LAZY — Lazily register the `app:logBuffer` IPC handler.
 *
 * Why lazy: this module is imported by virtually every main-process
 * file (helpers, processors, resolvers). When test/smoke scripts
 * stub `electron` (vi.mock or a node-side runner), the top-level
 * `ipcMain.handle(...)` would crash on import because the stub
 * exposes only the symbols the test cares about. Folding the
 * registration into an explicit call lets the real main bootstrap
 * pay for it once while keeping the module import side-effect free.
 */
export function registerLoggerIpc(): void {
  if (bufferHandlerRegistered) return;
  bufferHandlerRegistered = true;
  ipcMain.handle('app:logBuffer', () => buffer.slice());
}
