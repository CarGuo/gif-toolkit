/**
 * R-47 — Browser-shell webview sniffing.
 *
 * Spawns a real Chromium window with our own native-feeling chrome on top
 * (back / forward / reload / address bar / progress / finish / cancel) and
 * embeds the user's target URL in a sibling `WebContentsView` mounted just
 * below the toolbar. The toolbar lives in the **outer** window and is
 * therefore always interactive — it does not depend on the target page
 * loading or honouring our injected DOM, which used to break on:
 *   - SPA navigations that wiped our toolbar element
 *   - sites whose CSP rejected inline `<script>`
 *   - third-party iframes (OpenAI's Cloudflare verification, Patreon
 *     OAuth) that rendered while the host page was still blank
 *
 * The session partition (`persist:webview-sniff`) is kept so the user's
 * cookies survive across runs. While the user browses the inner view, we
 * passively record media-shaped responses through
 * `session.webRequest.onCompleted`. On "完成嗅探", we additionally run a
 * DOM-walking script in the **inner** view to merge in `<img src>` /
 * `<video src>` / CSS `background-image`. Both sources are deduped and
 * resolved as a `SniffResult`.
 */
import { BrowserWindow, WebContentsView, session, ipcMain, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import type { SniffedMedia, SniffResult, MediaKind } from '../shared/types';
import { classifyByExt } from './sniffer';
import {
  classifyByContentType,
  mergeWebviewMedia,
  webviewDedupKey,
  WEBVIEW_MAX_ITEMS as MAX_ITEMS,
  WEBVIEW_TOOLBAR_HEIGHT as TOOLBAR_HEIGHT,
  innerViewBounds
} from './webviewSniffUtils';
import { log } from './logger';

const PARTITION = 'persist:webview-sniff';
/** Most-recent stable Chrome on macOS. Picked deliberately so the inner
 *  view does not advertise itself as `Electron/...` (some Cloudflare /
 *  hCaptcha challenges flag the default UA as a bot). */
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

interface CapturedResource {
  url: string;
  kind: MediaKind;
  mime?: string;
}

/**
 * Subscribe the partition's `webRequest.onCompleted` and push every
 * media-shaped response into `out`. Returns a detach handle so the
 * partition does not keep accumulating after the window is closed.
 */
function attachNetworkRecorder(out: Map<string, CapturedResource>, partition: string): () => void {
  const ses = session.fromPartition(partition);
  const handler = (details: Electron.OnCompletedListenerDetails) => {
    if (out.size >= MAX_ITEMS) return;
    if (details.statusCode >= 400) return;
    const url = details.url;
    if (!/^https?:/i.test(url)) return;
    const headers = details.responseHeaders || {};
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
    if (kind === 'image' && byMime !== 'image') return;
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

/** R-47 — Chrome HTML loaded into the outer window's webContents.
 *  We fold it into a `data:text/html;base64,...` URL so we do not need a
 *  filesystem-resident html asset (keeps the build script untouched).
 *  The toolbar talks to the main process exclusively through the preload-
 *  exposed `window.giftkChrome` API.
 *
 *  R-48 — Progress bar reworked into a 4px high element with an
 *  indeterminate slider keyframe animation (so the user sees something
 *  moving even before any `did-frame-finish-load` event fires) layered
 *  under a determinate fill driven by `state.progress`. Also adds a
 *  「🧭 系统浏览器」 button that delegates to `shell.openExternal` for
 *  users who want to debug / inspect the page in their real browser. */
function buildChromeHtml(): string {
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8" />
<title>GIF Toolkit — 网页嗅探</title>
<style>
  :root { --bg:#1a1b1f; --bg-2:#23252b; --line:rgba(255,255,255,0.08);
    --fg:#e6e7eb; --muted:#9aa0aa; --accent:#2a7; --accent-2:#5cf;
    --warn:#ef5b6e; }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; height:100%; background:var(--bg); color:var(--fg);
    font: 13px -apple-system, system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  #bar { height:${TOOLBAR_HEIGHT}px; display:flex; align-items:center; gap:6px; padding:0 8px;
    background:var(--bg-2); border-bottom:1px solid var(--line); position:relative; z-index:2; }
  #bar button { flex:0 0 auto; height:28px; min-width:28px; padding:0 8px; background:transparent;
    color:var(--fg); border:1px solid var(--line); border-radius:4px; cursor:pointer; font:inherit;
    line-height:1; white-space:nowrap; }
  #bar button:hover:not(:disabled) { background:rgba(255,255,255,0.06); }
  #bar button:disabled { opacity:0.4; cursor:not-allowed; }
  #bar button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
  #bar button.primary:hover:not(:disabled) { filter:brightness(1.1); }
  #bar button.danger:hover:not(:disabled) { background:rgba(239,91,110,0.15);
    border-color:var(--warn); color:var(--warn); }
  #addr { flex:1; min-width:0; height:28px; padding:0 10px; background:var(--bg); color:var(--fg);
    border:1px solid var(--line); border-radius:14px; font:inherit; outline:none; }
  #addr:focus { border-color:var(--accent); }
  #status { flex:0 0 auto; font-size:11px; color:var(--muted); max-width:240px; overflow:hidden;
    text-overflow:ellipsis; white-space:nowrap; }
  /* R-48 progress bar — 4px tall, two layers:
     1. .indet — indeterminate sliding gradient (visible whenever
        isLoading is true, so the user sees motion immediately even
        before our pushState catches up to the inner view).
     2. .det  — determinate fill driven by state.progress (0..100).
     Both fade out together once isLoading flips false. */
  #progress { position:absolute; left:0; right:0; bottom:-1px; height:4px;
    pointer-events:none; overflow:hidden; opacity:0; transition:opacity 220ms linear; }
  #progress.loading { opacity:1; }
  #progress .indet { position:absolute; inset:0; background:
    linear-gradient(90deg, transparent 0%, var(--accent-2) 35%, var(--accent) 65%, transparent 100%);
    background-size: 40% 100%; background-repeat: no-repeat;
    animation: indet 1.1s linear infinite; }
  #progress .det { position:absolute; left:0; top:0; bottom:0; width:0%;
    background:var(--accent); transition:width 220ms ease-out; }
  @keyframes indet {
    0%   { background-position: -40% 0; }
    100% { background-position: 140% 0; }
  }
  .sep { width:1px; height:18px; background:var(--line); margin:0 4px; }
</style>
</head><body>
<div id="bar" role="toolbar" aria-label="嗅探浏览器顶栏">
  <button id="b-back" title="后退" aria-label="后退" disabled>◀</button>
  <button id="b-forward" title="前进" aria-label="前进" disabled>▶</button>
  <button id="b-reload" title="刷新" aria-label="刷新">⟳</button>
  <input id="addr" type="text" spellcheck="false" placeholder="https://..." />
  <span id="status" aria-live="polite"></span>
  <button id="b-external" title="在系统浏览器打开当前地址(用于调试或继续在浏览器里浏览)">🧭 系统浏览器</button>
  <span class="sep" aria-hidden="true"></span>
  <button id="b-finish" class="primary" title="从当前页面收集媒体">✅ 完成嗅探</button>
  <button id="b-cancel" class="danger" title="取消并关闭">✕ 关闭</button>
  <div id="progress" aria-hidden="true">
    <div class="indet"></div>
    <div class="det"></div>
  </div>
</div>
<script>
  // The page CSP we ship is permissive on inline-script for this single
  // chrome page; the outer window only ever loads this exact HTML, so
  // there is no untrusted-input surface here.
  const $ = (id) => document.getElementById(id);
  const send = (cmd) => { try { window.giftkChrome.send(cmd); } catch (_) {} };
  $('b-back').addEventListener('click', () => send({ kind: 'back' }));
  $('b-forward').addEventListener('click', () => send({ kind: 'forward' }));
  $('b-reload').addEventListener('click', () => send({ kind: 'reload' }));
  $('b-external').addEventListener('click', () => send({ kind: 'open-external' }));
  $('b-finish').addEventListener('click', () => send({ kind: 'finish' }));
  $('b-cancel').addEventListener('click', () => send({ kind: 'cancel' }));
  $('addr').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      let v = $('addr').value.trim();
      if (!v) return;
      if (!/^https?:\\/\\//i.test(v)) v = 'https://' + v;
      send({ kind: 'navigate', url: v });
    }
  });
  let lastUrl = '';
  const det = $('progress').querySelector('.det');
  window.giftkChrome.onState((s) => {
    $('b-back').disabled = !s.canGoBack;
    $('b-forward').disabled = !s.canGoForward;
    if (s.url && s.url !== lastUrl && document.activeElement !== $('addr')) {
      $('addr').value = s.url;
      lastUrl = s.url;
    }
    $('status').textContent = s.message || s.title || '';
    $('progress').classList.toggle('loading', !!s.isLoading);
    const p = s.isLoading ? Math.max(8, Math.min(95, s.progress || 30)) : 100;
    det.style.width = p + '%';
  });
</script>
</body></html>`;
}

function chromeDataUrl(): string {
  const html = buildChromeHtml();
  return 'data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64');
}

/**
 * Main entry: open a chrome-shell window pointed at `targetUrl`, wait for
 * the user to either confirm or close, then resolve with the deduped
 * media list.
 */
export async function openWebviewSniff(
  targetUrl: string,
  parent?: BrowserWindow | null
): Promise<SniffResult> {
  const captured = new Map<string, CapturedResource>();
  const detach = attachNetworkRecorder(captured, PARTITION);

  // Outer window — hosts our chrome-shell HTML.
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    parent: parent || undefined,
    title: 'GIF Toolkit — 网页嗅探',
    backgroundColor: '#1a1b1f',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: resolveChromePreload()
    }
  });

  // Inner view — actually loads the user's URL. Lives in the same window
  // as a sibling content view, positioned just below the toolbar.
  // R-48 perf flags:
  //  - backgroundThrottling:false — keep timers/RAF running at full
  //    speed even when the user briefly focuses the host app's main
  //    window during sniff (otherwise lazy-loaded media may stall).
  //  - spellcheck:false — disable the spellchecker we never need
  //    (saves ~20-40 MB and a noticeable amount of init time).
  //  - v8CacheOptions:'code' — let V8 cache compiled JS to disk so
  //    re-visits of the same site re-enter steady state faster.
  const view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
      v8CacheOptions: 'code'
    }
  });
  view.webContents.setUserAgent(CHROME_UA);
  win.contentView.addChildView(view);

  const layout = (): void => {
    const [w, h] = win.getContentSize();
    view.setBounds(innerViewBounds(w, h));
  };
  layout();
  win.on('resize', layout);

  return new Promise<SniffResult>((resolve) => {
    let settled = false;
    let pageUrl = targetUrl;
    let pageTitle: string | undefined;

    const pushState = (extra?: { message?: string; progress?: number; isLoading?: boolean }): void => {
      if (win.isDestroyed()) return;
      try {
        const wc = view.webContents;
        const nh = (wc as unknown as { navigationHistory?: { canGoBack(): boolean; canGoForward(): boolean } }).navigationHistory;
        const state = {
          url: wc.getURL() || pageUrl,
          title: wc.getTitle() || '',
          canGoBack: nh ? nh.canGoBack() : (wc as unknown as { canGoBack(): boolean }).canGoBack(),
          canGoForward: nh ? nh.canGoForward() : (wc as unknown as { canGoForward(): boolean }).canGoForward(),
          isLoading: extra?.isLoading ?? wc.isLoading(),
          progress: extra?.progress ?? (wc.isLoading() ? 50 : 100),
          message: extra?.message
        };
        win.webContents.send('webview-sniff:chrome', state);
      } catch { /* ignore */ }
    };

    // R-48 — Stage-based progress so the user always sees motion even
    // when an event upstream fires once and then the page stalls
    // (Cloudflare verification, hCaptcha, OpenAI's blank pre-hydration
    // shell). The numbers do not need to be accurate; they just need to
    // *move*.
    let lastStageProgress = 5;
    const stage = (n: number, message?: string): void => {
      lastStageProgress = Math.max(lastStageProgress, n);
      pushState({ isLoading: lastStageProgress < 100, progress: lastStageProgress, message });
    };
    view.webContents.on('did-start-loading', () => { lastStageProgress = 0; stage(15, '正在连接…'); });
    view.webContents.on('dom-ready', () => stage(55, '正在解析…'));
    view.webContents.on('did-frame-finish-load', (_e, isMainFrame) => {
      if (isMainFrame) stage(80, '资源加载中…');
    });
    view.webContents.on('did-stop-loading', () => stage(100));
    view.webContents.on('did-navigate', () => pushState());
    view.webContents.on('did-navigate-in-page', () => pushState());
    view.webContents.on('page-title-updated', () => pushState());
    view.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
      // Sub-resource failures (Cloudflare CT pings, third-party trackers)
      // are noisy and not actionable. Only surface main-frame failures.
      if (!isMainFrame) return;
      pushState({ message: `加载失败:${desc} (${code})`, isLoading: false, progress: 100 });
    });

    // Tolerant TLS for sub-resources (third-party widgets often have
    // mismatched certs that would otherwise dump red into stderr without
    // affecting functionality). Main-frame errors still surface above.
    view.webContents.on('certificate-error', (event, _url, _err, _cert, callback) => {
      event.preventDefault();
      callback(false);
    });

    // R-48 — Heartbeat so the toolbar always reflects current state even
    // if upstream events bunch up or fire before the chrome HTML's IPC
    // listener is wired. Cleared by finish() / window close.
    const heartbeat = setInterval(() => {
      if (settled || win.isDestroyed()) return;
      pushState();
    }, 800);
    const stopHeartbeat = (): void => { try { clearInterval(heartbeat); } catch { /* ignore */ } };

    const finish = async (mode: 'confirm' | 'cancel' | 'closed'): Promise<void> => {
      if (settled) return;
      settled = true;
      stopHeartbeat();
      try {
        if (!view.webContents.isDestroyed()) {
          pageUrl = view.webContents.getURL() || pageUrl;
          pageTitle = view.webContents.getTitle() || undefined;
        }
      } catch { /* ignore */ }

      const merged = new Map<string, SniffedMedia>();
      mergeWebviewMedia(
        merged,
        Array.from(captured.values()).map((r) => ({
          url: r.url, kind: r.kind, mime: r.mime, pageUrl
        }))
      );

      if (mode === 'confirm' && !view.webContents.isDestroyed()) {
        try {
          const urls: string[] = await view.webContents.executeJavaScript(DOM_SCAN_SCRIPT, true);
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
      ipcMain.removeAllListeners('webview-sniff:chrome-cmd');
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

    // Drive inner view from the chrome.
    const cmdHandler = (_e: Electron.IpcMainEvent, cmd: unknown): void => {
      if (!cmd || typeof cmd !== 'object') return;
      const c = cmd as { kind?: string; url?: string };
      const wc = view.webContents;
      const nh = (wc as unknown as { navigationHistory?: { canGoBack(): boolean; canGoForward(): boolean; goBack(): void; goForward(): void } }).navigationHistory;
      const goBack = (): void => { if (nh) nh.goBack(); else (wc as unknown as { goBack(): void }).goBack(); };
      const goForward = (): void => { if (nh) nh.goForward(); else (wc as unknown as { goForward(): void }).goForward(); };
      const canBack = (): boolean => nh ? nh.canGoBack() : (wc as unknown as { canGoBack(): boolean }).canGoBack();
      const canForward = (): boolean => nh ? nh.canGoForward() : (wc as unknown as { canGoForward(): boolean }).canGoForward();
      switch (c.kind) {
        case 'back':
          if (canBack()) goBack();
          break;
        case 'forward':
          if (canForward()) goForward();
          break;
        case 'reload':
          wc.reload();
          break;
        case 'navigate':
          if (typeof c.url === 'string' && /^https?:\/\//i.test(c.url)) {
            void wc.loadURL(c.url).catch(() => undefined);
          }
          break;
        case 'open-external': {
          // R-48 — Hand the current URL off to the system browser. We
          // deliberately do NOT join the user's session there (cookies /
          // localStorage / SW are isolated per-process), so this is a
          // browse-only escape hatch — useful for users who want to
          // continue reading the article in their real browser, or
          // sanity-check a page that misbehaves inside our shell.
          // Validate the protocol before handing off so we never feed
          // shell.openExternal a `file://` / `javascript:` URL.
          const u = wc.getURL();
          if (typeof u === 'string' && /^https?:\/\//i.test(u)) {
            void shell.openExternal(u).catch((e) => {
              log(`[webview-sniff] openExternal failed: ${(e as Error).message}`);
            });
          }
          break;
        }
        case 'finish':
          void finish('confirm');
          break;
        case 'cancel':
          void finish('cancel');
          break;
      }
    };
    ipcMain.on('webview-sniff:chrome-cmd', cmdHandler);

    win.on('closed', () => { void finish('closed'); });

    // R-48 — Critical ordering: load the chrome HTML *first*, wait for
    // its preload to register the `webview-sniff:chrome` listener, then
    // kick off the inner-view navigation. Otherwise the very first
    // `did-start-loading` event arrives before the renderer is wired
    // and the toolbar stays in its idle state forever (which the user
    // perceived as "the webview never opens").
    win.webContents.once('did-finish-load', () => {
      // Push an immediate state with the requested URL so the address
      // bar shows what we are about to load (the inner view's getURL()
      // is still 'about:blank' at this instant).
      try {
        win.webContents.send('webview-sniff:chrome', {
          url: targetUrl,
          title: '',
          canGoBack: false,
          canGoForward: false,
          isLoading: true,
          progress: 10,
          message: '正在打开…'
        });
      } catch { /* ignore */ }
      // Now actually start the inner navigation.
      view.webContents.loadURL(targetUrl).catch((e) => {
        log(`[webview-sniff] inner load failed: ${(e as Error).message}`);
        pushState({ message: `加载失败:${(e as Error).message}`, isLoading: false, progress: 100 });
      });
    });

    void win.loadURL(chromeDataUrl()).catch((e) => {
      log(`[webview-sniff] chrome load failed: ${(e as Error).message}`);
      void finish('cancel');
    });
  });
}

/**
 * Locate the compiled chrome preload. In dev (`tsc --watch`) it lives at
 * `dist/main/webviewSniffChromePreload.js`; in production the same path
 * applies because we ship the entire `dist/` tree via electron-builder.
 */
function resolveChromePreload(): string {
  const candidate = path.join(__dirname, 'webviewSniffChromePreload.js');
  if (fs.existsSync(candidate)) return candidate;
  // Fallback — when running from an unbuilt source tree some tests stub
  // the resolver. Don't crash; just return the candidate anyway.
  return candidate;
}
