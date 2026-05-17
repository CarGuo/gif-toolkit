/**
 * R-47 — Chrome shell preload for the webview-sniff outer window.
 *
 * Runs in `contextIsolation: true, sandbox: true` against the outer
 * BrowserWindow that hosts the toolbar/address-bar (NOT the user's site).
 * Bridges the toolbar UI to the main process so the user can drive the
 * inner WebContentsView (back / forward / reload / navigate / finish /
 * cancel) without ever touching the target page's DOM.
 *
 * Two channels:
 *   - 'webview-sniff:chrome' (main → renderer): pushes
 *     { url, title, canGoBack, canGoForward, isLoading, progress } so the
 *     toolbar can mirror navigation state.
 *   - 'webview-sniff:chrome-cmd' (renderer → main): one-way command channel
 *     where the renderer sends `{ kind: 'back'|'forward'|'reload'|'finish'
 *     |'cancel'|'navigate', url? }`.
 */
import { ipcRenderer, contextBridge } from 'electron';

interface ChromeState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  progress: number;
  message?: string;
}

type ChromeCmd =
  | { kind: 'back' }
  | { kind: 'forward' }
  | { kind: 'reload' }
  | { kind: 'finish' }
  | { kind: 'cancel' }
  | { kind: 'navigate'; url: string };

contextBridge.exposeInMainWorld('giftkChrome', {
  send(cmd: ChromeCmd): void {
    try { ipcRenderer.send('webview-sniff:chrome-cmd', cmd); } catch { /* ignore */ }
  },
  onState(cb: (s: ChromeState) => void): () => void {
    const handler = (_e: unknown, s: ChromeState): void => { cb(s); };
    ipcRenderer.on('webview-sniff:chrome', handler);
    return () => ipcRenderer.removeListener('webview-sniff:chrome', handler);
  }
});
