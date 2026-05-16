import { BrowserWindow, session as electronSession } from 'electron';
import { URL } from 'url';
import { isPrivateHost } from './helpers';
import { log } from './logger';

const HEADLESS_TIMEOUT_MS = 60000;
const HEADLESS_QUIET_MS = 2500;
const HEADLESS_HARD_TTL_MS = 75000;
const HEADLESS_POST_LOAD_MS = 5000;
const HEADLESS_PARTITION = 'persist:gif-toolkit-sniffer';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface HeadlessResult {
  finalUrl: string;
  html: string;
  iframes: string[];
}

function assertSafeUrl(u: string): URL {
  const parsed = new URL(u);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('only http(s) URLs are allowed');
  if (isPrivateHost(parsed.hostname)) throw new Error('host is private/loopback and is not allowed');
  return parsed;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchRenderedDom(pageUrl: string): Promise<HeadlessResult> {
  assertSafeUrl(pageUrl);

  const ses = electronSession.fromPartition(HEADLESS_PARTITION);
  ses.setUserAgent(UA);

  // Some sites (Cloudflare, OpenAI's CDN, etc.) sniff Client Hints and the
  // `Sec-CH-UA` header to detect Headless Chromium / Electron. Override these
  // headers per-request so the request looks like a real Chrome session.
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const headers = { ...details.requestHeaders };
    headers['User-Agent'] = UA;
    headers['Sec-CH-UA'] = '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"';
    headers['Sec-CH-UA-Mobile'] = '?0';
    headers['Sec-CH-UA-Platform'] = '"macOS"';
    headers['Accept-Language'] = headers['Accept-Language'] || 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7';
    if (!headers['Accept']) {
      headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
    }
    cb({ requestHeaders: headers });
  });

  const win = new BrowserWindow({
    show: false,
    width: 1366,
    height: 900,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      javascript: true,
      images: true,
      webSecurity: true,
      offscreen: false,
      backgroundThrottling: false
    }
  });

  let networkIdleTimer: NodeJS.Timeout | null = null;
  let resolved = false;
  const inflight = new Set<string>();

  const onRequestStart = (_e: unknown, details: { id: number | string }): void => {
    inflight.add(String(details.id));
    if (networkIdleTimer) {
      clearTimeout(networkIdleTimer);
      networkIdleTimer = null;
    }
  };
  const onRequestEnd = (_e: unknown, details: { id: number | string }): void => {
    inflight.delete(String(details.id));
  };

  win.webContents.on('did-start-navigation', () => {
    if (networkIdleTimer) {
      clearTimeout(networkIdleTimer);
      networkIdleTimer = null;
    }
  });

  try {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    win.webContents.on('did-start-loading', () => undefined);
    win.webContents.session.webRequest.onSendHeaders((details) => {
      onRequestStart(undefined, details);
    });
    win.webContents.session.webRequest.onCompleted((details) => {
      onRequestEnd(undefined, details);
    });
    win.webContents.session.webRequest.onErrorOccurred((details) => {
      onRequestEnd(undefined, details);
    });

    log(`headless: loading ${pageUrl}`);
    const finishedPromise = new Promise<void>((resolve) => {
      const onFinish = (): void => {
        win.webContents.removeListener('did-finish-load', onFinish);
        resolve();
      };
      win.webContents.on('did-finish-load', onFinish);
    });
    const navPromise = win.loadURL(pageUrl, { userAgent: UA }).catch((e: Error) => {
      // ERR_ABORTED happens when the page itself navigates / soft-redirects;
      // not fatal — we still want to read whatever DOM is currently live.
      log(`headless: loadURL rejected (continuing): ${e.message}`);
    });

    const timeoutPromise = delay(HEADLESS_TIMEOUT_MS).then(() => {
      throw new Error('headless navigation timeout');
    });
    await Promise.race([Promise.all([navPromise, finishedPromise]), timeoutPromise]);

    // Give the page a moment to hydrate (React / Next.js / Vue tend to insert
    // <iframe>/<video> AFTER the initial document is "loaded").
    await delay(HEADLESS_POST_LOAD_MS);

    const idlePromise = new Promise<void>((resolve) => {
      const tick = (): void => {
        if (resolved) return;
        if (inflight.size === 0) {
          networkIdleTimer = setTimeout(() => {
            resolved = true;
            resolve();
          }, HEADLESS_QUIET_MS);
        } else {
          networkIdleTimer = setTimeout(tick, 250);
        }
      };
      tick();
    });
    const ttlPromise = delay(HEADLESS_HARD_TTL_MS).then(() => {
      resolved = true;
    });
    await Promise.race([idlePromise, ttlPromise]);

    const html = await win.webContents.executeJavaScript(
      'document.documentElement ? document.documentElement.outerHTML : ""'
    );

    const iframes = (await win.webContents.executeJavaScript(
      'Array.from(document.querySelectorAll("iframe")).map(f => f.src).filter(Boolean)'
    )) as string[];

    const finalUrl = win.webContents.getURL() || pageUrl;
    log(`headless: done ${finalUrl}, iframes=${iframes.length}, html=${html.length}b`);
    return { finalUrl, html: String(html || ''), iframes: iframes.slice(0, 200) };
  } finally {
    if (networkIdleTimer) {
      clearTimeout(networkIdleTimer);
      networkIdleTimer = null;
    }
    try {
      win.destroy();
    } catch {
      /* ignore */
    }
  }
}
