/**
 * R-51 — Spawn-real-Chrome + CDP sniff path.
 *
 * Why this exists:
 *   Cloudflare's Bot Management lane uses TLS JA3/JA4 + HTTP/2 SETTINGS
 *   frame fingerprints as its FIRST gate (weight ≈ 97% per 2026
 *   benchmarks). Electron's network layer ships its own BoringSSL which
 *   does not match real Chrome on the wire, so even after R-49's
 *   navigator/`Sec-Ch-Ua-*`/`chrome.runtime` patches the inner
 *   `WebContentsView` is denied at the handshake — the user never even
 *   gets a real Turnstile to manually click through. By driving the
 *   user's *actual* installed Chrome (or Edge / Brave) and recording its
 *   DevTools `Network` events over CDP, the handshake comes from a
 *   browser whose JA3 IS in CF's whitelist. The user logs in / clicks
 *   the Turnstile checkbox in that real browser; we passively scrape the
 *   network log and run a final DOM scan, then return the same
 *   `SniffResult` shape `sniff:url` and `sniff:webview` already produce.
 *
 * Design notes:
 *   - `findInstalledBrowsers()` is exposed as its own IPC so the
 *     renderer can preflight before showing the menu (gives us a
 *     deterministic "Chrome not installed" error path).
 *   - We always launch Chrome into an *isolated* user-data-dir keyed by
 *     URL host. Cookies / login persist per host; we do NOT pollute the
 *     user's real Chrome profile, and parallel sniffs of two different
 *     hosts can run without locking each other out.
 *   - We try `--remote-debugging-port=0` and read the actual chosen port
 *     from `<userDataDir>/DevToolsActivePort` (Chrome writes it there
 *     immediately after the WebSocket server is up). This is more
 *     reliable than parsing stdout, which is not always inherited on
 *     Windows.
 *   - We deliberately do NOT set `--headless` — the whole point is to
 *     show a real browser window the user can interact with.
 */
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { app } from 'electron';
import CDP from 'chrome-remote-interface';
import type { SniffResult, SniffedMedia, MediaKind, SniffProgress } from '../shared/types';
import { classifyByExt, matchEmbedProvider } from './sniffer';
import {
  acceptWebviewMedia,
  classifyByContentType,
  mergeWebviewMedia,
  webviewDedupKey,
  WEBVIEW_MAX_ITEMS as MAX_ITEMS,
  mediaId
} from './webviewSniffUtils';
import { DOM_SCAN_SCRIPT } from './webviewSniff';
import {
  getCandidatePaths,
  parseDevToolsPort,
  deriveProfileDirName,
  buildChromeArgs,
  extractCdpCandidate,
  type BrowserCandidate,
  type CdpResponseReceivedParams
} from './systemChromeSniffUtils';
import { log } from './logger';

interface CapturedResource {
  url: string;
  kind: MediaKind;
  mime?: string;
}

/**
 * Public preflight: walk the per-platform candidate list and return the
 * subset whose `exePath` is `fs.existsSync`-true. Used by the renderer to
 * decide whether to surface the "真 Chrome 嗅探" entry at all and, if
 * the user picks an unavailable mode, to render an actionable error
 * (with download links) before we attempt to spawn anything.
 */
export function findInstalledBrowsers(): BrowserCandidate[] {
  const home = os.homedir();
  const candidates = getCandidatePaths(process.platform, home);
  const found: BrowserCandidate[] = [];
  const seenIds = new Set<string>();
  for (const c of candidates) {
    try {
      if (!fs.existsSync(c.exePath)) continue;
    } catch { continue; }
    // Dedup by id so the dropdown only shows one entry per browser
    // family even if both system-wide and per-user installs exist.
    if (seenIds.has(c.id)) continue;
    seenIds.add(c.id);
    found.push(c);
  }
  return found;
}

/** Returned by `sniffViaSystemChrome`. Same envelope as embedded webview
 *  sniff so the renderer can pipe it into the existing dedupe / history
 *  flow without branching. */

const SUPPORTED_EVENT_TYPES = new Set([
  'Image', 'Media', 'Fetch', 'XHR', 'Other', 'Font'
]);

interface SniffOpts {
  /**
   * If supplied, ONLY launch this exe. Otherwise we pick the first
   * available candidate via `findInstalledBrowsers()`. Renderer passes
   * this when the user explicitly picks "Edge" / "Brave" from a
   * sub-menu; for now we keep the API generic.
   */
  preferredExePath?: string;
  /**
   * Renderer-driven progress callback. Mirrors webview-sniff's progress
   * channel so the existing 嗅探中… spinner / progress bar can keep
   * working unchanged.
   */
  onProgress?: (p: SniffProgress) => void;
  /**
   * Cooperative cancel — when fired, we close CDP, kill Chrome, and
   * resolve with whatever we captured so far (warnings flagged).
   */
  signal?: AbortSignal;
  /**
   * R-55 Fix #2 — Cooperative *finalize* signal (distinct from cancel).
   * When fired, the function treats the situation as "user finished
   * sniffing" — it will:
   *
   *  1. Stop waiting for Chrome's parent process to exit (root cause
   *     of the "stuck at 60%" report when Chrome merges into a
   *     pre-existing user instance and `child.exit` never fires).
   *  2. Run one final DOM scan synchronously.
   *  3. Tear down Chrome cleanly (SIGTERM → SIGKILL fallback) just
   *     like the user-closed-window path.
   *  4. Return the captured media — NOT mark the run as cancelled.
   *
   * This is wired to a「✓ 完成嗅探」button on the renderer that
   * appears at the 60% stage so users no longer have to fight Chrome
   * lifecycle to get their results out.
   */
  finalizeSignal?: AbortSignal;
}

/** Wait for Chrome to print/write the chosen debugger port. We poll the
 *  DevToolsActivePort file (written by Chrome the moment the WS server
 *  is listening) and ALSO listen on stdout/stderr for the banner — first
 *  one to fire wins. Times out after 8s.
 *
 *  R-53 — exit listener is now passed through `child.once`, AND we
 *  explicitly remove it via `child.off` in `cleanup()` so a long-lived
 *  Chrome process whose `exit` fires AFTER the port was acquired does
 *  not try to settle a Promise that has already resolved (which silently
 *  rejected the wrong path before — see review comment #4). */
async function waitForDevToolsPort(opts: {
  child: ChildProcess;
  userDataDir: string;
  signal?: AbortSignal;
}): Promise<number> {
  const { child, userDataDir, signal } = opts;
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + 8000;

  return new Promise<number>((resolve, reject) => {
    let done = false;
    const settle = (port: number | null, err?: Error): void => {
      if (done) return;
      done = true;
      cleanup();
      if (port == null) reject(err || new Error('Chrome 未在 8s 内打印 DevTools 端口'));
      else resolve(port);
    };

    const onStd = (chunk: Buffer | string): void => {
      const text = chunk.toString();
      // Chrome may print the banner across multiple writes, so split.
      for (const line of text.split(/\r?\n/)) {
        const p = parseDevToolsPort(line);
        if (p != null) { settle(p); return; }
      }
    };
    const onExit = (code: number | null): void => {
      settle(null, new Error(`Chrome 进程在握手前退出 (code=${code ?? 'unknown'})`));
    };
    child.stdout?.on('data', onStd);
    child.stderr?.on('data', onStd);
    child.once('exit', onExit);

    const onAbort = (): void => settle(null, new Error('用户取消'));
    if (signal) {
      if (signal.aborted) { settle(null, new Error('用户取消')); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const tick = setInterval(() => {
      if (Date.now() > deadline) {
        settle(null, new Error('Chrome 未在 8s 内打印 DevTools 端口'));
        return;
      }
      try {
        if (!fs.existsSync(portFile)) return;
        const raw = fs.readFileSync(portFile, 'utf8');
        const firstLine = raw.split(/\r?\n/)[0];
        const port = Number(firstLine);
        if (Number.isFinite(port) && port > 0 && port <= 65535) {
          settle(port);
        }
      } catch { /* ignore — keep polling */ }
    }, 120);

    const cleanup = (): void => {
      try { clearInterval(tick); } catch { /* ignore */ }
      try { child.stdout?.off('data', onStd); } catch { /* ignore */ }
      try { child.stderr?.off('data', onStd); } catch { /* ignore */ }
      try { child.off('exit', onExit); } catch { /* ignore */ }
      if (signal) {
        try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
      }
    };
  });
}

/**
 * Core entry. Spawns a real Chrome window pointed at `url`, listens for
 * Network events + final DOM snapshot via CDP, and resolves once the
 * user closes the window (sniff = 完成) or the abort signal fires
 * (sniff = 取消).
 *
 * Throws if no supported browser is installed or the spawn / CDP
 * handshake fails. Caller (`ipcMain.handle('sniff:system-chrome')`) is
 * expected to convert thrown errors into `{ items:[], warnings:[msg] }`
 * the renderer already knows how to surface.
 */
export async function sniffViaSystemChrome(
  url: string,
  opts: SniffOpts = {}
): Promise<SniffResult> {
  const browsers = findInstalledBrowsers();
  if (browsers.length === 0) {
    throw new Error(
      '本机未检测到 Chrome / Edge / Brave。请安装其中之一(推荐 Chrome:https://www.google.com/chrome/),或改用「嵌入式嗅探」。'
    );
  }
  const target = opts.preferredExePath
    ? browsers.find((b) => b.exePath === opts.preferredExePath) || browsers[0]
    : browsers[0];

  const userDataRoot = path.join(app.getPath('userData'), 'system-chrome-profiles');
  const userDataDir = path.join(userDataRoot, deriveProfileDirName(url));
  try { fs.mkdirSync(userDataDir, { recursive: true }); } catch (e) {
    throw new Error(`无法创建 Chrome 隔离用户目录: ${(e as Error).message}`);
  }
  // We MUST clear the previous DevToolsActivePort or our poll loop will
  // see a stale port from the prior run before Chrome rewrites it.
  // R-53 — Same logic for SingletonLock / SingletonCookie / SingletonSocket
  // so a previous hard-killed Chrome can't permanently brick the profile.
  for (const name of ['DevToolsActivePort', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.unlinkSync(path.join(userDataDir, name)); } catch { /* ignore */ }
  }

  const args = buildChromeArgs({ url, userDataDir, port: 0 });
  log(`[system-chrome-sniff] launching ${target.label} -> ${target.exePath}`);
  opts.onProgress?.({ stage: 'fetching', percent: 5 });

  let child: ChildProcess;
  try {
    child = spawn(target.exePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });
  } catch (e) {
    throw new Error(`启动 ${target.label} 失败: ${(e as Error).message}`);
  }

  const port = await waitForDevToolsPort({
    child, userDataDir, signal: opts.signal
  }).catch((e) => {
    // R-53 — pre-CDP failure path: SIGKILL bound to a 1 s deadline so
    // a wedged Chrome cannot keep the userDataDir locked, and clear
    // singleton lock files so the next launch can reuse the profile.
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, 1000).unref();
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try { fs.unlinkSync(path.join(userDataDir, name)); } catch { /* ignore */ }
    }
    throw e;
  });

  log(`[system-chrome-sniff] CDP port ready: ${port}`);
  opts.onProgress?.({ stage: 'fetching', percent: 25 });

  const captured = new Map<string, CapturedResource>();
  let pageUrl = url;
  let pageTitle: string | undefined;
  let client: Awaited<ReturnType<typeof CDP>> | null = null;
  // R-53 — Robust child teardown:
  //   1. SIGTERM (graceful) — Chrome closes its windows + flushes profile
  //   2. After 1.5 s, SIGKILL fallback if still alive (some platforms
  //      where Chrome's signal handler is wedged by the renderer crash);
  //   3. Always remove SingletonLock / SingletonCookie / SingletonSocket
  //      from the isolated user-data-dir AFTER the process is gone, so
  //      the next sniff against the same host won't refuse to launch
  //      with "The profile appears to be in use by another Chrome
  //      process". Without this, a hard-killed Chrome leaves stale
  //      lock files around forever (Chrome itself only clears them on
  //      a clean exit).
  const cleanup = async (): Promise<void> => {
    if (client) {
      try { await client.close(); } catch { /* ignore */ }
      client = null;
    }
    // Skip kill if Chrome already exited (user-closed window).
    if (child && child.exitCode == null && !child.killed) {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      const waitExit = new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
          resolve();
        }, 1500);
        child.once('exit', () => { clearTimeout(t); resolve(); });
      });
      try { await waitExit; } catch { /* ignore */ }
    }
    // Best-effort lock cleanup. We only delete files that are SymLinks
    // or harmless ".Lock"-style markers; never rm-rf the whole dir.
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try { fs.unlinkSync(path.join(userDataDir, name)); } catch { /* ignore */ }
    }
  };

  try {
    // chrome-remote-interface's first connection lands on the browser
    // target by default; we need a *page* target to subscribe to
    // Network/Page events. List targets, pick the first `page`-type one
    // (which Chrome opens for our URL because we passed it as a launch
    // arg), and connect there.
    let pageTargetId: string | null = null;
    const listDeadline = Date.now() + 5000;
    while (Date.now() < listDeadline) {
      try {
        const list = await CDP.List({ port });
        const pageT = list.find((t) => t.type === 'page');
        if (pageT) { pageTargetId = pageT.id; break; }
      } catch { /* ignore — retry */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!pageTargetId) {
      throw new Error('CDP 未发现 page target,Chrome 启动可能失败');
    }
    client = await CDP({ port, target: pageTargetId });
    opts.onProgress?.({ stage: 'parsing', percent: 40 });

    const { Network, Page, Runtime } = client;
    await Network.enable();
    await Page.enable();
    await Runtime.enable();

    Network.responseReceived((params: CdpResponseReceivedParams) => {
      if (captured.size >= MAX_ITEMS) return;
      // Cheap pre-filter: skip resource types CDP marks as definitely
      // not-media (Document, Stylesheet, Script, Manifest, Ping, ...).
      const t = typeof params.type === 'string' ? params.type : '';
      if (t && !SUPPORTED_EVENT_TYPES.has(t)) return;

      const cand = extractCdpCandidate(params);
      if (!cand) return;
      const byMime = classifyByContentType(cand.mime);
      const byExt = classifyByExt(cand.url);
      const accepted = acceptWebviewMedia(byMime || byExt, cand.mime);
      if (!accepted) return;
      const key = webviewDedupKey(cand.url);
      if (captured.has(key)) return;
      captured.set(key, { url: cand.url, kind: accepted, mime: cand.mime ?? undefined });
    });

    // Track the user's navigation so when they finish, we know the real
    // landing URL (e.g. after CF challenge redirect).
    Page.frameNavigated(({ frame }) => {
      if (frame && !frame.parentId && typeof frame.url === 'string' && /^https?:/i.test(frame.url)) {
        pageUrl = frame.url;
      }
    });

    // Resolution path: the user closes the Chrome window OR we get
    // aborted OR (R-55) the renderer fires the finalize signal because
    // the user clicked「✓ 完成嗅探」. Chrome's parent process exit
    // fires `child.exit`, which is what we listen to for the "user
    // closed everything" path. The finalize path is treated like
    // user-closed for result purposes (userClosed stays true).
    let userClosed = false;
    let finalizedByUser = false;
    const finished = new Promise<void>((resolve) => {
      child.once('exit', () => { userClosed = true; resolve(); });
      if (opts.signal) {
        if (opts.signal.aborted) resolve();
        else opts.signal.addEventListener('abort', () => resolve(), { once: true });
      }
      if (opts.finalizeSignal) {
        const onFinalize = (): void => {
          finalizedByUser = true;
          userClosed = true;
          resolve();
        };
        if (opts.finalizeSignal.aborted) onFinalize();
        else opts.finalizeSignal.addEventListener('abort', onFinalize, { once: true });
      }
    });
    opts.onProgress?.({ stage: 'parsing', percent: 60, message: '在 Chrome 中浏览/登录,然后点「✓ 完成嗅探」或关闭整个 Chrome 即可结束' });

    // While waiting, run a final DOM scan periodically as a safety net
    // (some users may not navigate at all — they just want what's on
    // screen). We snapshot every 4s; final answer is the LAST snapshot.
    let lastDom: { media: string[]; iframes: string[] } = { media: [], iframes: [] };
    const domTick = setInterval(async () => {
      if (!client) return;
      try {
        const { result } = await client.Runtime.evaluate({
          expression: DOM_SCAN_SCRIPT,
          returnByValue: true
        });
        const v = result?.value as { media?: unknown; iframes?: unknown } | undefined;
        if (v && Array.isArray(v.media) && Array.isArray(v.iframes)) {
          lastDom = {
            media: v.media.filter((x) => typeof x === 'string') as string[],
            iframes: v.iframes.filter((x) => typeof x === 'string') as string[]
          };
        }
        // Also pick up the latest title for history.
        try {
          const { result: tr } = await client.Runtime.evaluate({
            expression: 'document.title || ""',
            returnByValue: true
          });
          if (typeof tr?.value === 'string' && tr.value.trim()) {
            pageTitle = tr.value;
          }
        } catch { /* ignore */ }
      } catch { /* ignore — page may be navigating */ }
    }, 4000);

    await finished;
    try { clearInterval(domTick); } catch { /* ignore */ }
    // R-55: only treat the run as aborted if the caller's cancel
    // signal fired AND it wasn't an explicit finalize click.
    if (opts.signal?.aborted && !finalizedByUser) userClosed = false;

    opts.onProgress?.({
      stage: 'parsing',
      percent: 90,
      message: finalizedByUser ? '正在收尾,处理 DOM 扫描结果…' : undefined
    });

    // Try one last DOM scan synchronously before tearing down (only if
    // page is still alive).
    if (client && userClosed === false /* aborted */) {
      // Aborted path: don't bother — page may be in a bad state.
    } else if (client) {
      try {
        const { result } = await client.Runtime.evaluate({
          expression: DOM_SCAN_SCRIPT,
          returnByValue: true
        });
        const v = result?.value as { media?: unknown; iframes?: unknown } | undefined;
        if (v && Array.isArray(v.media) && Array.isArray(v.iframes)) {
          lastDom = {
            media: v.media.filter((x) => typeof x === 'string') as string[],
            iframes: v.iframes.filter((x) => typeof x === 'string') as string[]
          };
        }
      } catch { /* ignore */ }
    }

    // Merge captured network responses + final DOM scan into a single
    // SniffedMedia map — same logic the embedded webview path uses, so
    // downstream dedup / history flow stays consistent.
    const merged = new Map<string, SniffedMedia>();
    mergeWebviewMedia(
      merged,
      Array.from(captured.values()).map((r) => ({
        url: r.url, kind: r.kind, mime: r.mime, pageUrl
      }))
    );
    const dom: Array<{ url: string; kind: MediaKind; pageUrl: string }> = [];
    for (const u of lastDom.media) {
      const accepted = acceptWebviewMedia(classifyByExt(u), null);
      if (!accepted) continue;
      dom.push({ url: u, kind: accepted, pageUrl });
    }
    mergeWebviewMedia(merged, dom);
    for (const u of lastDom.iframes) {
      if (merged.size >= MAX_ITEMS) break;
      let host: string | null = null;
      try { host = new URL(u).host.toLowerCase(); } catch { continue; }
      const provider = matchEmbedProvider(host, u);
      if (!provider) continue;
      const key = webviewDedupKey(u);
      if (merged.has(key)) continue;
      merged.set(key, {
        id: mediaId(u),
        url: u,
        kind: 'video',
        pageUrl,
        source: 'iframe-embed',
        requiresExternalDownload: true,
        embedHost: provider
      });
    }

    const items = Array.from(merged.values());
    log(`[system-chrome-sniff] finished captured=${captured.size} merged=${items.length} via=${target.label}`);
    return {
      pageUrl,
      title: pageTitle,
      items,
      warnings: opts.signal?.aborted ? ['用户取消;仅返回截至取消前网络日志命中的媒体'] : []
    };
  } finally {
    await cleanup();
  }
}
