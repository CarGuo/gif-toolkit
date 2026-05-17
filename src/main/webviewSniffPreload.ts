/**
 * R-44 — Preload for the webview-sniff BrowserWindow.
 *
 * Runs in `contextIsolation: true, sandbox: true`, so we cannot use Node
 * APIs directly. We pull the per-window IPC channel name from
 * `process.argv` (populated via `webPreferences.additionalArguments` on the
 * main side), then bridge `window.postMessage({ __giftkWebview: '...' })`
 * events from the injected toolbar into a one-way `ipcRenderer.send` call.
 *
 * This is a one-way, non-privileged channel — the page can only emit
 * `'confirm'` or `'cancel'`, and we ignore everything else. No data flows
 * the other direction.
 *
 * NOTE: tsconfig.main does not include the DOM lib (preload/index.ts also
 * avoids browser APIs), so we type-cast the host as a minimal interface
 * rather than relying on `lib.dom.d.ts`.
 */
import { ipcRenderer } from 'electron';

interface WebviewMessageEvent {
  data?: unknown;
}
interface WebviewWindow {
  addEventListener: (
    type: 'message',
    listener: (ev: WebviewMessageEvent) => void
  ) => void;
}

const PREFIX = '--giftk-webview-channel=';

function readChannel(): string | null {
  for (const arg of process.argv) {
    if (typeof arg === 'string' && arg.startsWith(PREFIX)) {
      const v = arg.slice(PREFIX.length);
      // Whitelist: alphanumeric, dashes, dots only — defends against a hostile
      // page racing the preload init.
      if (/^[a-zA-Z0-9._-]{1,64}$/.test(v)) return v;
    }
  }
  return null;
}

const channel = readChannel();
const host = (globalThis as unknown as { window?: WebviewWindow }).window;
if (channel && host && typeof host.addEventListener === 'function') {
  host.addEventListener('message', (ev: WebviewMessageEvent) => {
    const data = ev.data;
    if (!data || typeof data !== 'object') return;
    const tag = (data as { __giftkWebview?: unknown }).__giftkWebview;
    if (tag === 'confirm' || tag === 'cancel') {
      try { ipcRenderer.send(channel, tag); } catch { /* ignore */ }
    }
  });
}
