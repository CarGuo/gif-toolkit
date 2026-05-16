import { app, BrowserWindow, ipcMain, dialog, shell, session } from 'electron';
import path from 'path';
import { promises as fsp, statSync } from 'fs';
import crypto from 'crypto';
import { sniffPage } from './sniffer';
import { previewMedia, startBatch, cancelAllTasks, prefetchThumbnail } from './processor';
import { killAllProcs } from './ffmpeg';
import { log } from './logger';
import { printPaths } from './binaries';
import { DEFAULT_OPTIONS } from '../shared/types';
import type { ProcessOptions, ProcessTask, SniffedMedia, ResolvedMedia } from '../shared/types';
import { isPrivateHost, safeName } from './helpers';
import {
  resolveEmbed,
  isResolvable,
  checkYtdlp,
  YtDlpNotInstalledError
} from './resolver';

// Some networks block UDP/QUIC which makes Chromium's TLS over QUIC fall back
// to a hard ERR_CONNECTION_RESET on the headless sniffer fallback. Disabling
// QUIC keeps HTTP traffic on TCP/TLS where axios already proves the route works.
app.commandLine.appendSwitch('disable-quic');
app.commandLine.appendSwitch('disable-features', 'NetworkServiceCodeIntegrity,IsolateOrigins,site-per-process');

let mainWindow: BrowserWindow | null = null;
const allowedOutputDirs: Set<string> = new Set();

function safeAppGetPath(name: 'downloads' | 'userData' | 'desktop' | 'documents' | 'home'): string {
  try {
    return app.getPath(name);
  } catch {
    return '';
  }
}

function defaultOutDir(): string {
  const downloads = safeAppGetPath('downloads');
  if (!downloads) return '';
  return path.resolve(path.join(downloads, 'GifToolkit'));
}

function assertHttpUrl(u: unknown): string {
  if (typeof u !== 'string') throw new Error('url must be a string');
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    throw new Error('invalid URL');
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('only http(s) URLs are allowed');
  // Lower-case host for consistent comparison
  parsed.hostname = parsed.hostname.toLowerCase();
  if (!parsed.hostname) throw new Error('host is empty');
  if (isPrivateHost(parsed.hostname)) {
    throw new Error('host is private/loopback and is not allowed');
  }
  return parsed.toString();
}

function isPathInside(parent: string, child: string): boolean {
  if (!parent || !child) return false;
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function assertOutputDir(p: unknown): string {
  if (typeof p !== 'string' || !p) throw new Error('outDir required');
  const norm = path.resolve(p);
  const def = defaultOutDir();
  // Whitelist: explicit picks (pickDir) + sub-batch dirs registered + default Downloads/GifToolkit (and its subtree)
  const ok =
    allowedOutputDirs.has(norm) ||
    (def && (norm === def || isPathInside(def, norm)));
  if (!ok) throw new Error('output directory not allowed');
  return norm;
}

/* ----------------------- Input sanitisers ----------------------- */

// Mirror src/main/resolver/ytdlp.ts HEADER_ALLOWLIST — IPC payloads coming
// back from the renderer must be subject to the same strict allow-list as
// what we synthesise inside the resolver, so a compromised renderer cannot
// inject Authorization / Host / Set-Cookie headers into the downloader.
const RESOLVED_HEADER_ALLOWLIST = new Set<string>([
  'user-agent', 'referer', 'origin',
  'accept', 'accept-language', 'accept-encoding',
  'range', 'x-csrf-token', 'x-requested-with'
]);

function sanitizeResolved(r: unknown): ResolvedMedia | undefined {
  if (!r || typeof r !== 'object') return undefined;
  const obj = r as Record<string, unknown>;
  let url: string;
  try { url = assertHttpUrl(obj.url); } catch { return undefined; }
  const headers: Record<string, string> = {};
  if (obj.headers && typeof obj.headers === 'object') {
    for (const [k, v] of Object.entries(obj.headers as Record<string, unknown>)) {
      if (typeof k !== 'string' || typeof v !== 'string') continue;
      if (!/^[A-Za-z0-9-]+$/.test(k)) continue;
      if (!RESOLVED_HEADER_ALLOWLIST.has(k.toLowerCase())) continue;
      if (v.length > 1024) continue;
      if (/[\r\n]/.test(v) || v.indexOf('\u0000') !== -1) continue;
      headers[k] = v;
    }
  }
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const str = (v: unknown, max = 200): string | undefined => {
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    if (!t || t.length > max) return undefined;
    if (/[\r\n]/.test(t) || t.indexOf('\u0000') !== -1) return undefined;
    return t;
  };
  const source = obj.source === 'ytdlp' ? 'ytdlp' : undefined;
  if (!source) return undefined;
  return {
    url,
    mime: str(obj.mime, 100),
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    qualityLabel: str(obj.qualityLabel, 60),
    width: num(obj.width),
    height: num(obj.height),
    durationSec: num(obj.durationSec),
    sizeBytes: num(obj.sizeBytes),
    source,
    extractor: str(obj.extractor, 60),
    title: str(obj.title, 300)
  };
}

function sanitizeMedia(m: unknown): SniffedMedia {
  if (!m || typeof m !== 'object') throw new Error('invalid media');
  const obj = m as Record<string, unknown>;
  const url = assertHttpUrl(obj.url);
  const id = String(obj.id || '').replace(/[^a-zA-Z0-9._-]/g, '');
  if (!id) throw new Error('invalid media.id');
  const kind = obj.kind;
  if (kind !== 'video' && kind !== 'gif' && kind !== 'image') throw new Error('invalid media.kind');
  const pageUrl = obj.pageUrl ? assertHttpUrl(obj.pageUrl) : url;
  const source = obj.source as SniffedMedia['source'];
  // Preserve embed-only flags so the main-process security boundary can refuse
  // a task even if a stale renderer payload slips them past the UI guard.
  const requiresExternalDownload = obj.requiresExternalDownload === true;
  const embedHostRaw = typeof obj.embedHost === 'string' ? obj.embedHost.toLowerCase().trim() : undefined;
  const embedHost =
    embedHostRaw && /^[a-z0-9.-]+$/.test(embedHostRaw) && embedHostRaw.length <= 64
      ? embedHostRaw
      : undefined;
  return {
    id,
    url,
    kind,
    pageUrl,
    source,
    mime: typeof obj.mime === 'string' ? obj.mime : undefined,
    width: typeof obj.width === 'number' && Number.isFinite(obj.width) ? obj.width : undefined,
    height: typeof obj.height === 'number' && Number.isFinite(obj.height) ? obj.height : undefined,
    durationSec:
      typeof obj.durationSec === 'number' && Number.isFinite(obj.durationSec) ? obj.durationSec : undefined,
    sizeBytes:
      typeof obj.sizeBytes === 'number' && Number.isFinite(obj.sizeBytes) ? obj.sizeBytes : undefined,
    poster: typeof obj.poster === 'string' ? obj.poster : undefined,
    requiresExternalDownload: requiresExternalDownload || undefined,
    embedHost,
    resolved: sanitizeResolved(obj.resolved)
  };
}

function sanitizeOptions(o: unknown): ProcessOptions {
  const obj = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const num = (v: unknown, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : d;

  const minSizeRaw = Math.max(64, num(obj.minSize, DEFAULT_OPTIONS.minSize));
  const maxWidthRaw = Math.max(120, Math.min(4096, num(obj.maxWidth, DEFAULT_OPTIONS.maxWidth)));
  // Ensure minSize <= maxWidth (clamp minSize to maxWidth if it exceeds)
  const minSize = Math.min(minSizeRaw, maxWidthRaw);

  const hardBytes = Math.max(1024 * 100, num(obj.maxBytes, DEFAULT_OPTIONS.maxBytes));
  const softBytesRaw = num(obj.softMaxBytes, DEFAULT_OPTIONS.softMaxBytes);
  const softBytes = Math.max(1024 * 50, Math.min(hardBytes, softBytesRaw));

  const result: ProcessOptions = {
    maxBytes: hardBytes,
    softMaxBytes: softBytes,
    maxWidth: maxWidthRaw,
    minSize,
    maxSegmentSec: Math.max(1, Math.min(120, num(obj.maxSegmentSec, DEFAULT_OPTIONS.maxSegmentSec))),
    fps: Math.max(1, Math.min(60, num(obj.fps, DEFAULT_OPTIONS.fps))),
    speed: Math.max(0.25, Math.min(8, num(obj.speed, DEFAULT_OPTIONS.speed)))
  };

  if (typeof obj.concurrency === 'number' && Number.isFinite(obj.concurrency)) {
    result.concurrency = Math.max(1, Math.min(8, Math.round(obj.concurrency)));
  }

  if (typeof obj.startSec === 'number' && Number.isFinite(obj.startSec)) {
    result.startSec = Math.max(0, obj.startSec);
  }
  if (typeof obj.endSec === 'number' && Number.isFinite(obj.endSec)) {
    result.endSec = Math.max(0, obj.endSec);
  }

  // R-22: selectedSegments — non-negative integers, deduped, sorted ascending.
  // Out-of-range values are intentionally NOT clamped here (the renderer may
  // submit before reading actual video duration); processor.ts re-validates
  // against the live segment count in filterSelectedSegments().
  if (Array.isArray(obj.selectedSegments)) {
    const cleaned = Array.from(
      new Set(
        (obj.selectedSegments as unknown[])
          .filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 1000)
      )
    ).sort((a, b) => a - b);
    if (cleaned.length > 0) {
      result.selectedSegments = cleaned;
    }
  }

  if (obj.cropRect && typeof obj.cropRect === 'object') {
    const r = obj.cropRect as Record<string, unknown>;
    result.cropRect = {
      x: Math.max(0, num(r.x, 0)),
      y: Math.max(0, num(r.y, 0)),
      w: Math.max(1, num(r.w, 1)),
      h: Math.max(1, num(r.h, 1))
    };
  }

  // R-26: per-task escape hatch for the aspect-ratio-too-elongated guard.
  // ONLY accepted when the renderer explicitly asserts the boolean — any
  // other shape (truthy strings, numbers, objects) is dropped to prevent
  // accidental enablement via stale/forged IPC payloads.
  if (obj.forceAllowSmallSide === true) {
    result.forceAllowSmallSide = true;
  }

  if (typeof obj.outDir === 'string' && obj.outDir) {
    result.outDir = assertOutputDir(obj.outDir);
  }
  return result;
}

/* ----------------------- Window / CSP ----------------------- */

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0e0f12',
    title: 'Gif Toolkit',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  // Block all new window opens (e.g. external links)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) {
      shell.openExternal(url).catch(() => undefined);
    }
    return { action: 'deny' };
  });

  // Restrict navigation to dev server / local file
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const ok =
      (process.env.NODE_ENV === 'development' && url.startsWith('http://localhost:5173')) ||
      url.startsWith('file://');
    if (!ok) {
      e.preventDefault();
      shell.openExternal(url).catch(() => undefined);
    }
  });

  // Deny permission requests
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  if (process.env.NODE_ENV === 'development') {
    await mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

/* ----------------------- IPC handlers ----------------------- */

let currentSniffCtrl: AbortController | null = null;

ipcMain.handle('sniff:url', async (_e, url: unknown) => {
  const safe = assertHttpUrl(url);
  // Cancel any sniff that is still mid-flight before starting a new one.
  if (currentSniffCtrl) {
    try { currentSniffCtrl.abort(); } catch { /* ignore */ }
  }
  const ctrl = new AbortController();
  currentSniffCtrl = ctrl;
  try {
    return await sniffPage(
      safe,
      (p) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('sniff:progress', p);
        }
      },
      ctrl.signal
    );
  } finally {
    if (currentSniffCtrl === ctrl) currentSniffCtrl = null;
  }
});

ipcMain.handle('sniff:cancel', async () => {
  if (currentSniffCtrl) {
    try { currentSniffCtrl.abort(); } catch { /* ignore */ }
    currentSniffCtrl = null;
  }
  return { ok: true };
});

ipcMain.handle('media:preview', async (_e, media: unknown, options: unknown) => {
  const m = sanitizeMedia(media);
  const o = sanitizeOptions(options);
  return previewMedia(m, o);
});

ipcMain.handle('media:thumbnail', async (_e, media: unknown) => {
  try {
    const m = sanitizeMedia(media);
    return await prefetchThumbnail(m);
  } catch (e) {
    return { id: '', status: 'error', error: (e as Error).message };
  }
});

ipcMain.handle('process:start', async (_e, payload: unknown) => {
  // Accept either { tasks, pageTitle } or a bare tasks array (back-compat)
  let tasks: unknown;
  let pageTitle: string | undefined;
  if (Array.isArray(payload)) {
    tasks = payload;
  } else if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    tasks = obj.tasks;
    if (typeof obj.pageTitle === 'string') pageTitle = obj.pageTitle;
  }
  if (!Array.isArray(tasks)) throw new Error('tasks must be an array');
  const safeTasks: ProcessTask[] = tasks.map((t) => {
    const obj = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
    const id = String(obj.id || '').replace(/[^a-zA-Z0-9._-]/g, '');
    if (!id) throw new Error('invalid task.id');
    return {
      id,
      media: sanitizeMedia(obj.media),
      options: sanitizeOptions(obj.options)
    };
  });
  const baseOutDir = safeTasks[0]?.options.outDir || defaultOutDir();
  if (!baseOutDir) throw new Error('output directory unavailable');
  const safeBaseOutDir = assertOutputDir(baseOutDir);
  const titleSafe = ((): string => {
    const cleaned = safeName(pageTitle || '');
    return cleaned && cleaned !== '_' ? cleaned.slice(0, 60) : 'batch';
  })();
  const ts = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .replace(/\..+$/, '');
  const ms = Date.now() % 1000;
  const random4 = crypto.randomBytes(2).toString('hex'); // 4 hex chars
  const subDir = path.resolve(path.join(safeBaseOutDir, `${titleSafe}-${ts}-${ms}-${random4}`));
  await fsp.mkdir(subDir, { recursive: true });
  allowedOutputDirs.add(subDir);
  startBatch(safeTasks, subDir, (p) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('process:progress', p);
    }
  }).catch((e) => log(`batch error: ${(e as Error).message}`));
  return { ok: true, outputDir: subDir };
});

ipcMain.handle('process:cancelAll', async () => {
  await cancelAllTasks();
  return { ok: true };
});

ipcMain.handle('app:pickDir', async () => {
  if (!mainWindow) return null;
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  });
  if (r.canceled || r.filePaths.length === 0) return null;
  const picked = path.resolve(r.filePaths[0]);
  allowedOutputDirs.add(picked);
  return picked;
});

ipcMain.handle('app:openDir', async (_e, p: unknown) => {
  const safe = assertOutputDir(p);
  let st;
  try {
    st = statSync(safe);
  } catch {
    throw new Error('path does not exist');
  }
  if (!st.isDirectory()) throw new Error('path is not a directory');
  await shell.openPath(safe);
  return { ok: true };
});

ipcMain.handle('app:defaultDir', async () => {
  const d = defaultOutDir();
  if (d) allowedOutputDirs.add(d);
  return d;
});

/* ----------------------- Resolver IPC (yt-dlp) ----------------------- */

ipcMain.handle('resolve:checkYtdlp', async () => {
  return checkYtdlp();
});

ipcMain.handle('resolve:embed', async (_e, media: unknown) => {
  // Reuse the same sanitiser the batch pipeline uses so the resolver only ever
  // sees clean SniffedMedia objects (host already lower-cased + length-bounded).
  const m = sanitizeMedia(media);
  if (!m.requiresExternalDownload) {
    throw new Error('media is not an embed (resolve:embed only works on embed-only items)');
  }
  if (!isResolvable(m)) {
    throw new Error(`embed host not in resolver allow-list: ${m.embedHost || 'unknown'}`);
  }
  try {
    return await resolveEmbed(m);
  } catch (e) {
    if (e instanceof YtDlpNotInstalledError) {
      // Bundled-by-default (R-14): the only way we hit this branch is an
      // air-gapped machine whose packaged binary is missing AND who can't
      // reach github releases for the fallback download. Surface a typed
      // error so the renderer can show a per-card retry hint.
      throw new Error('YT_DLP_UNAVAILABLE');
    }
    throw e;
  }
});

/* ----------------------- App lifecycle ----------------------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const def = defaultOutDir();
    if (def) {
      await fsp.mkdir(def, { recursive: true }).catch(() => undefined);
      allowedOutputDirs.add(def);
    }

    // Strict CSP for renderer — packaged uses tight policy; dev keeps loose.
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const isDev = !app.isPackaged;
      const csp = isDev
        ? "default-src 'self' http://localhost:5173 ws://localhost:5173 blob: data:; img-src * data: blob:; media-src * blob: data:; script-src 'self' http://localhost:5173 'unsafe-inline' 'unsafe-eval'; style-src 'self' http://localhost:5173 'unsafe-inline'; connect-src 'self' http://localhost:5173 ws://localhost:5173;"
        : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none';";
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [csp]
        }
      });
    });

    await createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
    log('app ready');
    try {
      printPaths();
    } catch (e) {
      log(`binaries probe failed: ${(e as Error).message}`);
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // Fire-and-forget: cancelAllTasks is async but the lifecycle hook is sync.
  // killAllProcs() is synchronous and ensures spawned children die before the
  // process actually exits.
  void cancelAllTasks();
  killAllProcs();
});
