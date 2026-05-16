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

ipcMain.handle('app:logBuffer', () => buffer.slice());
