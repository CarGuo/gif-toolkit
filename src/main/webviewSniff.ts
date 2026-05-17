/**
 * R-44 — Webview-assisted sniffing.
 *
 * Some pages (Medium private posts, Twitter/X media tabs, members-only
 * Patreon attachments, ...) only render their media after the user signs in
 * inside a real Chromium UI. The headless `sniffPage()` path cannot reach
 * these resources because it never sees a session cookie.
 *
 * This module spawns a dedicated `BrowserWindow` backed by a persistent
 * partition (`persist:webview-sniff`) so the same login survives across
 * runs. While the user browses, we passively record every media-shaped
 * network response via `session.webRequest.onCompleted`. When the user
 * clicks "✅ 完成嗅探" in our injected toolbar, we additionally execute a
 * DOM-walking script as a fallback (covers `<img src>`, `<video src>`,
 * `<source src>`, and CSS `background-image:url(...)`), then merge both
 * sources, dedupe, and resolve the IPC promise back to the renderer.
 */
import { BrowserWindow, session, ipcMain } from 'electron';
import path from 'path';
import type { SniffedMedia, SniffResult, MediaKind } from '../shared/types';
import { classifyByExt } from './sniffer';
import {
  classifyByContentType,
  mergeWebviewMedia,
  webviewDedupKey,
  WEBVIEW_MAX_ITEMS as MAX_ITEMS
} from './webviewSniffUtils';
import { log } from './logger';

const PARTITION = 'persist:webview-sniff';

interface CapturedResource {
  url: string;
  kind: MediaKind;
  mime?: string;
}

/**
 * Internal: subscribe to the partition's `webRequest.onCompleted` and push
 * every media-shaped response into `out`. The returned function detaches the
 * listener so the partition does not keep accumulating after the window is
 * closed.
 */
function attachNetworkRecorder(out: Map<string, CapturedResource>, partition: string): () => void {
  const ses = session.fromPartition(partition);
  const handler = (details: Electron.OnCompletedListenerDetails) => {
    if (out.size >= MAX_ITEMS) return;
    if (details.statusCode >= 400) return;
    const url = details.url;
    if (!/^https?:/i.test(url)) return;
    const headers = details.responseHeaders || {};
    // Header keys can be either casing; normalise once.
    let ct: string | undefined;
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'content-type') {
        const v = headers[k];
        ct = Array.isArray(v) ? v[0] : (v as unknown as string | undefined);
        break;
      }
    }
    const byMime = classifyByContentType(ct);
    const byExt = classifyByExt(url);
    const kind = byMime || byExt;
    if (!kind) return;
    if (kind === 'image' && byMime !== 'image') {
      // Pure stills get noisy fast (icons, avatars). Only keep them when the
      // server explicitly declares `image/*` (so a misnamed `.jpg` URL that
      // is actually an HTML 404 page does not slip through).
      return;
    }
    const key = webviewDedupKey(url);
    if (out.has(key)) return;
    out.set(key, { url, kind, mime: ct });
  };
  ses.webRequest.onCompleted({ urls: ['http://*/*', 'https://*/*'] }, handler);
  return () => {
    // onCompleted has no native unsubscribe; passing null clears the filter.
    ses.webRequest.onCompleted(null);
  };
}

/**
 * Browser-side script run on the user's page. Returns plain JSON (URLs only)
 * so we can re-classify and dedupe in the main process where our helpers live.
 */
const DOM_SCAN_SCRIPT = `(() => {
  const out = [];
  const push = (raw) => {
    if (!raw || typeof raw !== 'string') return;
    if (raw.startsWith('data:') || raw.startsWith('blob:')) return;
    try {
      const u = new URL(raw, location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
      out.push(u.toString());
    } catch (_) { /* ignore */ }
  };
  document.querySelectorAll('img').forEach((el) => {
    push(el.currentSrc || el.src);
    const ss = el.getAttribute('srcset');
    if (ss) ss.split(',').forEach((part) => push(part.trim().split(/\\s+/)[0]));
  });
  document.querySelectorAll('video').forEach((el) => {
    push(el.currentSrc || el.src);
    push(el.poster);
  });
  document.querySelectorAll('source').forEach((el) => push(el.src));
  // CSS background-image scan — covers Pinterest-style overlays.
  document.querySelectorAll('*').forEach((el) => {
    try {
      const bg = getComputedStyle(el).backgroundImage;
      if (!bg || bg === 'none') return;
      const m = bg.match(/url\\(([^)]+)\\)/g);
      if (!m) return;
      m.forEach((entry) => {
        const inner = entry.slice(4, -1).replace(/^['"]|['"]$/g, '');
        push(inner);
      });
    } catch (_) { /* ignore */ }
  });
  return Array.from(new Set(out)).slice(0, 500);
})();`;

/**
 * Toolbar HTML injected into the top of the user's webview. Keeps things
 * dead simple: two buttons, no framework. Buttons message the host via
 * `window.giftkWebview.<event>()`, which we wire up via a preload script.
 */
const TOOLBAR_HTML = `
<style>
  #giftk-webview-bar {
    position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
    display: flex; align-items: center; gap: 8px;
    padding: 6px 12px;
    background: rgba(20, 20, 24, 0.92); color: #fff;
    font: 12px -apple-system, system-ui, sans-serif;
    box-shadow: 0 1px 3px rgba(0,0,0,0.4);
  }
  #giftk-webview-bar .label { opacity: 0.75; flex: 1; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #giftk-webview-bar button {
    border: 1px solid rgba(255,255,255,0.18);
    background: rgba(255,255,255,0.08); color: #fff;
    padding: 4px 10px; border-radius: 4px; cursor: pointer; font: inherit;
  }
  #giftk-webview-bar button.primary { background: #2a7; border-color: #2a7; }
  #giftk-webview-bar button:hover { filter: brightness(1.15); }
  body { padding-top: 32px !important; }
</style>
<div id="giftk-webview-bar" role="toolbar" aria-label="webview sniff toolbar">
  <span class="label">登录后点「完成嗅探」从当前页面收集媒体</span>
  <button type="button" id="giftk-webview-confirm" class="primary">✅ 完成嗅探</button>
  <button type="button" id="giftk-webview-cancel">✕ 关闭</button>
</div>
<script>
(() => {
  const fire = (name) => { try { window.postMessage({ __giftkWebview: name }, '*'); } catch (_) {} };
  document.getElementById('giftk-webview-confirm').addEventListener('click', () => fire('confirm'));
  document.getElementById('giftk-webview-cancel').addEventListener('click', () => fire('cancel'));
})();
</script>
`;

const INJECT_TOOLBAR_SCRIPT = `(() => {
  if (document.getElementById('giftk-webview-bar')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = ${JSON.stringify(TOOLBAR_HTML)};
  // Append children one by one so the inline <script> actually runs.
  while (wrap.firstChild) document.body.appendChild(wrap.firstChild);
})();`;

/**
 * Main entry: open a window pointed at `targetUrl`, wait for the user to
 * either confirm or close, then resolve with the deduped media list.
 *
 * The window is *not* modal — we want users to be able to alt-tab to a
 * password manager, paste a 2FA code, etc.
 */
export async function openWebviewSniff(
  targetUrl: string,
  parent?: BrowserWindow | null
): Promise<SniffResult> {
  const captured = new Map<string, CapturedResource>();
  const detach = attachNetworkRecorder(captured, PARTITION);
  // Per-window correlation id for the message channel.
  const channelId = `webview-sniff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    parent: parent || undefined,
    title: 'GIF Toolkit — Webview 登录嗅探',
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'webviewSniffPreload.js'),
      // The preload script reads this argv entry to know which IPC channel
      // belongs to this specific window. We avoid mutating the loaded URL
      // (some auth providers reject unexpected query params).
      additionalArguments: [`--giftk-webview-channel=${channelId}`]
    }
  });

  // Inject the toolbar after every navigation so SPA route changes still keep
  // the floating bar visible.
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(INJECT_TOOLBAR_SCRIPT, true).catch(() => undefined);
  });

  return new Promise<SniffResult>((resolve) => {
    let settled = false;
    let pageUrl = targetUrl;
    let pageTitle: string | undefined;

    const finish = async (mode: 'confirm' | 'cancel' | 'closed') => {
      if (settled) return;
      settled = true;
      // Best-effort: capture the latest URL/title before tearing down so the
      // returned SniffResult is anchored at where the user actually ended up.
      try {
        if (!win.isDestroyed()) {
          pageUrl = win.webContents.getURL() || pageUrl;
          pageTitle = win.webContents.getTitle() || undefined;
        }
      } catch { /* ignore */ }

      const merged = new Map<string, SniffedMedia>();
      // Phase A — webRequest captures.
      mergeWebviewMedia(
        merged,
        Array.from(captured.values()).map((r) => ({
          url: r.url, kind: r.kind, mime: r.mime, pageUrl
        }))
      );

      // Phase B — DOM scan (only on confirm; if user cancelled we trust the
      // network log alone to avoid running JS in a window that might already
      // be in a weird half-navigated state).
      if (mode === 'confirm' && !win.isDestroyed()) {
        try {
          const urls: string[] = await win.webContents.executeJavaScript(DOM_SCAN_SCRIPT, true);
          if (Array.isArray(urls)) {
            const dom: Array<{ url: string; kind: MediaKind; pageUrl: string }> = [];
            for (const u of urls) {
              if (typeof u !== 'string') continue;
              const k = classifyByExt(u);
              if (!k) continue;
              dom.push({ url: u, kind: k, pageUrl });
            }
            mergeWebviewMedia(merged, dom);
          }
        } catch (e) {
          log(`[webview-sniff] DOM scan failed: ${(e as Error).message}`);
        }
      }

      detach();
      ipcMain.removeAllListeners(channelId);
      try { if (!win.isDestroyed()) win.close(); } catch { /* ignore */ }

      const items = Array.from(merged.values());
      log(`[webview-sniff] finished mode=${mode} captured=${captured.size} dom-merged=${items.length}`);
      resolve({
        pageUrl,
        title: pageTitle,
        items,
        warnings: mode === 'cancel' ? ['用户取消;仅返回网络日志命中的媒体'] : []
      });
    };

    // The preload bridges window-side `postMessage({ __giftkWebview })` events
    // into IPC so we can hear them in main without renderer indirection.
    ipcMain.on(channelId, (_e, msg: unknown) => {
      if (msg === 'confirm') void finish('confirm');
      else if (msg === 'cancel') void finish('cancel');
    });

    // Load the user's URL untouched.
    win.on('closed', () => { void finish('closed'); });

    win.loadURL(targetUrl).catch((e) => {
      log(`[webview-sniff] load failed: ${(e as Error).message}`);
      void finish('cancel');
    });
  });
}
