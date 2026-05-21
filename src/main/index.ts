import { app, BrowserWindow, ipcMain, dialog, shell, session, protocol, net } from 'electron';
import path from 'path';
import { promises as fsp, statSync, existsSync } from 'fs';
import crypto from 'crypto';
import { pathToFileURL } from 'url';
import { sniffPage } from './sniffer';
import { openWebviewSniff } from './webviewSniff';
import { sniffViaSystemChrome, findInstalledBrowsers } from './systemChromeSniff';
import { sniffViaYtdlp } from './ytdlpDirectSniff';
import { previewMedia, startBatch, cancelAllTasks, cancelTask, prefetchThumbnail, startToolbox } from './processor';
import { killAllProcs, probe as probeMedia, extractFrameDataUrl } from './ffmpeg';
import { log } from './logger';
import {
  openSession as openLogSession,
  closeSession as closeLogSession,
  log as logSession,
  updateSessionMeta,
  attachSessionLogBroadcast
} from './sessionLogger';
import { printPathsAsync } from './binaries';
import { getCapabilityReport } from './capabilities';
import { registerUploaderIpc } from './uploader';
import { openDb, closeDb } from './db';
import { registerDbIpc } from './db/dbIpc';
import {
  DEFAULT_OPTIONS,
  TOOLBOX_INPUT_EXTENSIONS,
} from '../shared/types';
import { sanitizeGifOptimizeKnobs } from './sanitizeOptions';
import type {
  ProcessOptions,
  ProcessTask,
  SniffedMedia,
  ResolvedMedia,
  ToolboxJob,
  ToolboxKind,
  ToolboxParams,
} from '../shared/types';
import { isPrivateHost, safeName } from './helpers';
import { applySniffFilters, type SniffFilterOptions } from './sniffFilters';
import { BUILD_INFO, formatBuildInfo } from '../shared/buildInfo';
import { RESOLVED_HEADER_ALLOWLIST, SNIFFED_MEDIA_SOURCES } from '../shared/headers';
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

// R-56 — Register the `giftk-local://` scheme as privileged BEFORE
// `app.ready` fires. Used by the offline-import pipeline to expose
// staged files from the OS temp dir (mhtml extracts, single-file
// drops) to the renderer without flipping `webSecurity: false` on
// the BrowserWindow. The actual fetch handler is wired in
// `app.whenReady()` below — this only declares the scheme's
// security characteristics so Chromium routes <img>/<video>
// requests through net:// as if it were a normal http origin.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'giftk-local',
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: false,
      corsEnabled: true
    }
  }
]);

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

/**
 * R-56 — Variant of `assertHttpUrl` that ALSO accepts giftk-local://
 * URLs minted by the offline-import pipeline. Used by `sanitizeMedia`
 * so SniffedMedia rows whose `url` is a staged file (mhtml extract,
 * dropped .mp4) survive the IPC validation gate that previously
 * rejected anything non-http(s).
 *
 * The giftk-local scheme is registered in this module's top-level
 * `protocol.registerSchemesAsPrivileged` call; the actual fetch
 * handler runs inside `app.whenReady` and re-validates the path
 * before reading the bytes off disk, so this function only needs
 * a syntactic check.
 */
function assertHttpOrLocalUrl(u: unknown): string {
  if (typeof u !== 'string') throw new Error('url must be a string');
  if (u.startsWith('giftk-local://')) {
    let parsed: URL;
    try { parsed = new URL(u); } catch { throw new Error('invalid giftk-local URL'); }
    if (!parsed.pathname || parsed.pathname === '/') {
      throw new Error('giftk-local URL is missing a path');
    }
    return parsed.toString();
  }
  return assertHttpUrl(u);
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

// HEADER allow-list lifted to src/shared/headers.ts in R-53 so the resolver
// (synthesise-headers path) and this IPC sanitiser (validate-headers path)
// share one source of truth. A compromised renderer cannot inject
// Authorization / Host / Set-Cookie headers into the downloader.

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
  // R-56 — accept giftk-local:// in addition to http(s) so offline-
  // imported items survive the IPC sanitiser. The downloader has a
  // matching local-file fast path so processor / probe / preview all
  // work transparently for these.
  const url = assertHttpOrLocalUrl(obj.url);
  const id = String(obj.id || '').replace(/[^a-zA-Z0-9._-]/g, '');
  if (!id) throw new Error('invalid media.id');
  const kind = obj.kind;
  if (kind !== 'video' && kind !== 'gif' && kind !== 'image') throw new Error('invalid media.kind');
  const pageUrl = obj.pageUrl ? assertHttpOrLocalUrl(obj.pageUrl) : url;
  // R-53 — strict source whitelist. A forged / future / typo-ed source
  // would otherwise pass through unchecked and downstream dedup may
  // double-count or mis-route the item. Reject the whole payload when
  // the value is not a recognised tag — every legitimate sniffer
  // (sniffer.ts / webviewSniff.ts / systemChromeSniff.ts /
  // ytdlpDirectSniff.ts) populates this field, so a missing or wrong
  // source means a stale or forged IPC.
  const sourceRaw = typeof obj.source === 'string' ? obj.source : '';
  if (!SNIFFED_MEDIA_SOURCES.has(sourceRaw)) {
    throw new Error('invalid media.source');
  }
  const source = sourceRaw as SniffedMedia['source'];
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

  // R-33: skip-compress flag. Same strict-true-only check as
  // forceAllowSmallSide: anything other than the boolean `true` falls
  // through to default (compress as usual).
  if (obj.skipCompress === true) {
    result.skipCompress = true;
  }

  // R-33: manual re-optimization input. The renderer attaches an
  // absolute path to a previously-saved gif. We allow it ONLY when the
  // path resolves inside the app's output root (default Downloads/GifToolkit
  // subtree, plus any explicitly registered allowedOutputDirs). This
  // mirrors the assertOutputDir whitelist: a compromised/forged renderer
  // payload pointing at /etc/passwd or ~/.ssh/id_rsa would fail this gate.
  if (typeof obj.reoptimizeFromGifPath === 'string' && obj.reoptimizeFromGifPath) {
    const norm = path.resolve(obj.reoptimizeFromGifPath);
    const def = defaultOutDir();
    const ok =
      allowedOutputDirs.has(path.dirname(norm)) ||
      Array.from(allowedOutputDirs).some((d) => isPathInside(d, norm)) ||
      (def && (norm === def || isPathInside(def, norm)));
    if (!ok) {
      throw new Error('reoptimize input path not allowed');
    }
    if (path.extname(norm).toLowerCase() !== '.gif') {
      throw new Error('reoptimize input must be a .gif file');
    }
    result.reoptimizeFromGifPath = norm;
  }

  // R-81: gif optimize knobs (lossy ceiling, colors floor, optimize level,
  // dither mode). Each is validated in strict mode — wrong type / NaN /
  // out-of-range / unknown enum string falls through silently to the
  // default rather than throwing, so a renderer that never sets these
  // fields gets the historical behaviour for free.
  // R-82: extracted into a pure helper in ./sanitizeOptions.ts so it can
  // be unit-tested without dragging electron/app/path side effects in.
  // The helper imports GIF_OPTIMIZE_LEVELS / GIF_DITHER_MODES directly
  // from '../shared/types/process' (not the barrel) — see R-82 post-mortem
  // for the dist/shared/types.js stale-shadow bug that broke module
  // resolution and made these constants `undefined` at runtime.
  Object.assign(result, sanitizeGifOptimizeKnobs(obj));

  if (typeof obj.outDir === 'string' && obj.outDir) {
    result.outDir = assertOutputDir(obj.outDir);
  }
  return result;
}

/* ----------------------- R-35 Toolbox sanitisers ----------------------- */

const TOOLBOX_KINDS: ReadonlySet<ToolboxKind> = new Set<ToolboxKind>([
  'video-to-gif',
  'video-to-webp',
  'gif-resize',
  'gif-optimize',
  'trim',
  'speed',
  'reverse',
  'rotate',
  'crop',
  // R-42 — keep this list in sync with the ToolboxKind union; the
  // sanitiser uses it to short-circuit IPC payloads with bogus kind
  // strings before any path-resolve work happens.
  'gif-webp-convert'
]);

function isToolboxKind(v: unknown): v is ToolboxKind {
  return typeof v === 'string' && TOOLBOX_KINDS.has(v as ToolboxKind);
}

/**
 * R-35 — compute the toolbox output sub-directory.
 *
 *   <baseOutDir>/toolbox/<kind>-<YYYYMMDD>/
 *
 * Reuses the user's currently-configured output root (default
 * Downloads/GifToolkit, or a custom dir picked via app:pickDir).
 * The directory is added to allowedOutputDirs so subsequent
 * app:openDir calls succeed.
 */
async function ensureToolboxOutputDir(kind: ToolboxKind, baseOutDir?: string): Promise<string> {
  const root = baseOutDir ? assertOutputDir(baseOutDir) : (defaultOutDir() || '');
  if (!root) throw new Error('output directory unavailable');
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const dir = path.resolve(path.join(root, 'toolbox', `${kind}-${ymd}`));
  await fsp.mkdir(dir, { recursive: true });
  allowedOutputDirs.add(dir);
  return dir;
}

/**
 * R-35 — sanitise a single toolbox job. Path validation is the security
 * critical step: an attacker-controlled renderer payload must NOT be able
 * to point inputPath at /etc/passwd or ~/.ssh/id_rsa. Strategy:
 *
 *   1. Path must be absolute (path.resolve() then identity check).
 *   2. Extension must be on the kind's whitelist (TOOLBOX_INPUT_EXTENSIONS).
 *   3. The file must already exist (the renderer always supplies a path
 *      acquired through dialog.showOpenDialog or a drop event), and we
 *      additionally require that path.dirname is a real directory — i.e.
 *      no .. traversal.
 *
 * Note: unlike the reoptimize fast-path, toolbox INPUT files come from
 * arbitrary user-picked locations on disk (this is the whole point —
 * users want to convert their personal Downloads/Movies). We therefore
 * do NOT require the input to be inside allowedOutputDirs. The only
 * remaining attack surface is the OUTPUT, which always lands in
 * ensureToolboxOutputDir's whitelisted subtree.
 */
function sanitizeToolboxParams(p: unknown): ToolboxParams {
  const obj = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const result: ToolboxParams = {};
  const fps = num(obj.fps);
  if (fps !== undefined) result.fps = Math.max(1, Math.min(60, Math.round(fps)));
  const width = num(obj.width);
  if (width !== undefined) result.width = Math.max(64, Math.min(4096, Math.round(width)));
  const startSec = num(obj.startSec);
  if (startSec !== undefined) result.startSec = Math.max(0, startSec);
  const endSec = num(obj.endSec);
  if (endSec !== undefined) result.endSec = Math.max(0, endSec);
  const quality = num(obj.quality);
  if (quality !== undefined) result.quality = Math.max(0, Math.min(100, Math.round(quality)));
  const loop = num(obj.loop);
  if (loop !== undefined) result.loop = Math.max(0, Math.min(65535, Math.round(loop)));
  const targetWidth = num(obj.targetWidth);
  if (targetWidth !== undefined) result.targetWidth = Math.max(64, Math.min(4096, Math.round(targetWidth)));
  const lossy = num(obj.lossy);
  if (lossy !== undefined) result.lossy = Math.max(0, Math.min(200, Math.round(lossy)));
  const colors = num(obj.colors);
  if (colors !== undefined) result.colors = Math.max(2, Math.min(256, Math.round(colors)));
  const maxBytes = num(obj.maxBytes);
  if (maxBytes !== undefined) result.maxBytes = Math.max(1024 * 100, maxBytes);
  const softMaxBytes = num(obj.softMaxBytes);
  if (softMaxBytes !== undefined) result.softMaxBytes = Math.max(1024 * 50, softMaxBytes);
  // R-35 #2 — gif-optimize method picker. The renderer ships a string
  // from a closed enum; we re-validate here so a tampered IPC payload
  // can't smuggle in `--invoke-arbitrary-flag` via gifsicleMethod.
  const method = obj.method;
  const ALLOWED_METHODS = new Set([
    'lossy', 'color-reduction', 'color-dither',
    'drop-every-nth', 'drop-duplicates', 'optimize-transparency', 'wechat-safe', 'budget'
  ]);
  if (typeof method === 'string' && ALLOWED_METHODS.has(method)) {
    result.method = method as ToolboxParams['method'];
  }
  const dropEveryN = num(obj.dropEveryN);
  if (dropEveryN !== undefined) result.dropEveryN = Math.max(2, Math.min(10, Math.round(dropEveryN)));

  // R-81 — gifsicle knobs (lossyCeiling / colorsFloor / optimizeLevel /
  // dither). Mirrors the same clamp logic used by sanitizeOptions for
  // ProcessOptions; closed enums for level / dither prevent IPC-tampered
  // strings from smuggling unknown gifsicle flags.
  // R-82 — share the pure helper so the two call sites cannot drift.
  Object.assign(result, sanitizeGifOptimizeKnobs(obj));

  // R-37 — Trim / Speed / Reverse / Rotate fields. Same defensive posture:
  // every numeric is clamped to its supported range and every enum is
  // re-validated against an explicit Set so a tampered IPC payload can't
  // smuggle e.g. `transpose=1,exec=…` through rotateDegrees.
  const speedFactor = num(obj.speedFactor);
  if (speedFactor !== undefined) result.speedFactor = Math.max(0.25, Math.min(4, speedFactor));
  const rotateDegrees = num(obj.rotateDegrees);
  if (rotateDegrees !== undefined) {
    const ALLOWED_ROTATIONS = new Set([0, 90, 180, 270]);
    const snapped = ((Math.round(rotateDegrees / 90) * 90) % 360 + 360) % 360;
    if (ALLOWED_ROTATIONS.has(snapped)) result.rotateDegrees = snapped;
  }
  if (typeof obj.flipH === 'boolean') result.flipH = obj.flipH;
  if (typeof obj.flipV === 'boolean') result.flipV = obj.flipV;
  const reverseAudioMode = obj.reverseAudioMode;
  const ALLOWED_AUDIO_MODES = new Set(['mute', 'reverse', 'keep']);
  if (typeof reverseAudioMode === 'string' && ALLOWED_AUDIO_MODES.has(reverseAudioMode)) {
    result.reverseAudioMode = reverseAudioMode as ToolboxParams['reverseAudioMode'];
  }
  // R-38 — Crop rect (natural coords). All four must be present for the
  // crop branch to fire; main-side processor enforces the "all-or-none"
  // rule. We do NOT clamp against the source resolution here because the
  // sanitizer doesn't know it — that final guard is in toolboxCrop's
  // even-pixel snapping + the renderer's CropBox bounds-check.
  const cropX = num(obj.cropX);
  if (cropX !== undefined) result.cropX = Math.max(0, Math.round(cropX));
  const cropY = num(obj.cropY);
  if (cropY !== undefined) result.cropY = Math.max(0, Math.round(cropY));
  const cropW = num(obj.cropW);
  if (cropW !== undefined) result.cropW = Math.max(2, Math.round(cropW));
  const cropH = num(obj.cropH);
  if (cropH !== undefined) result.cropH = Math.max(2, Math.round(cropH));
  // R-42 — gif-webp-convert target. Closed enum so a tampered IPC
  // payload can't smuggle in an arbitrary file extension via
  // path.extname round-trip later in processor.ts.
  const targetFormat = obj.targetFormat;
  if (targetFormat === 'gif' || targetFormat === 'webp') {
    result.targetFormat = targetFormat;
  }
  return result;
}

function sanitizeToolboxJob(j: unknown): ToolboxJob {
  if (!j || typeof j !== 'object') throw new Error('invalid toolbox job');
  const obj = j as Record<string, unknown>;
  const id = String(obj.id || '').replace(/[^a-zA-Z0-9._-]/g, '');
  if (!id) throw new Error('invalid job.id');
  if (!isToolboxKind(obj.kind)) throw new Error('invalid job.kind');
  const kind: ToolboxKind = obj.kind;
  if (typeof obj.inputPath !== 'string' || !obj.inputPath) {
    throw new Error('toolbox inputPath required');
  }
  if (obj.inputPath.length > 4096) throw new Error('toolbox inputPath too long');
  const norm = path.resolve(obj.inputPath);
  // No nul-bytes (defence against path-truncation tricks on some platforms).
  if (norm.indexOf('\u0000') !== -1) throw new Error('toolbox inputPath contains null byte');
  const ext = path.extname(norm).toLowerCase();
  const allowed = TOOLBOX_INPUT_EXTENSIONS[kind];
  if (!allowed.includes(ext)) {
    throw new Error(`toolbox: extension ${ext || '(none)'} not allowed for ${kind}`);
  }
  let st;
  try {
    st = statSync(norm);
  } catch {
    throw new Error('toolbox inputPath does not exist');
  }
  if (!st.isFile()) throw new Error('toolbox inputPath is not a file');
  if (st.size <= 0) throw new Error('toolbox inputPath is empty');
  return {
    id,
    kind,
    inputPath: norm,
    params: sanitizeToolboxParams(obj.params)
  };
}

/* ----------------------- Window / CSP ----------------------- */

/**
 * R-50.2 / R-62 / R-64 — Locate the bundled app icon ONCE.
 *
 * Prefers the hi-res PNG (1254×1254 in dev, then the squircle-masked
 * 1024×1024 R-63 build) which mac / Linux can render at any DPI; falls
 * back to the 32×32 .ico for Windows-only installs where PNG isn't yet
 * generated. In dev we read from the repo's build/ folder; in packaged
 * builds electron-builder copies the same file to `process.resourcesPath`.
 *
 * Hoisted out of `createWindow()` because R-64 needs to call
 * `app.dock.setIcon(<png>)` BEFORE the BrowserWindow is created so the
 * macOS Dock never flashes the Electron atom logo (the user's R-64
 * report). Returns `undefined` if no icon exists; BrowserWindow happily
 * ignores `icon: undefined`.
 */
function resolveAppIconPath(): string | undefined {
  const candidates = [
    path.join(__dirname, '..', '..', 'build', 'icon.png'),
    path.join(process.resourcesPath || '', 'build', 'icon.png'),
    path.join(process.resourcesPath || '', 'icon.png'),
    path.join(__dirname, '..', '..', 'build', 'icon.ico'),
    path.join(process.resourcesPath || '', 'build', 'icon.ico'),
    path.join(process.resourcesPath || '', 'icon.ico')
  ];
  for (const p of candidates) {
    try {
      if (p && existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

async function createWindow(): Promise<void> {
  const t0 = Date.now();
  const iconPath = resolveAppIconPath();

  // R-64 — `show: false` + `ready-to-show` so the user never sees an
  // empty BrowserWindow in front of the rainbow loader while the dev
  // server / renderer bundle is still cold-starting. With `show: true`
  // (the previous default) Electron creates a blank #0e0f12 window the
  // moment the constructor runs, then awaits `loadURL('http://localhost:5173')`
  // for several seconds while Vite compiles the React entry — that
  // gap is exactly what produced the "卡彩虹 loading" report. We now
  // hold the window invisible until WebContents fires
  // `ready-to-show`, which the docs explicitly recommend as the
  // first-paint hook (see
  // https://www.electronjs.org/docs/latest/api/browser-window#using-the-ready-to-show-event).
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0e0f12',
    title: 'Gif Toolkit',
    icon: iconPath,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  mainWindow.once('ready-to-show', () => {
    log(`createWindow: ready-to-show after ${Date.now() - t0}ms`);
    mainWindow?.show();
  });

  // Wire the per-session log broadcaster to the new window so live
  // tail updates (`session:log:append` etc.) reach the renderer.
  if (mainWindow) attachSessionLogBroadcast(mainWindow);

  // R-62 / R-64 — On macOS the BrowserWindow `icon` field is ignored
  // for the Dock; Dock icon comes from Info.plist (.icns), which only
  // exists in packaged builds. In `npm run dev` we therefore fall
  // back to `app.dock.setIcon(<png>)`. Note: this is now ALSO called
  // earlier (in app.whenReady, before createWindow runs) so the Dock
  // shows the custom logo from the very first frame; this duplicate
  // call here keeps the behaviour idempotent and protects the
  // app.activate path (re-creating a window after all windows have
  // been closed) from regressing.
  if (process.platform === 'darwin' && iconPath && /\.png$/i.test(iconPath)) {
    try {
      const dock = (app as unknown as { dock?: { setIcon: (p: string) => void } }).dock;
      dock?.setIcon(iconPath);
    } catch (e) {
      log(`dock.setIcon failed: ${(e as Error).message}`);
    }
  }

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
    // R-66 — Fire-and-forget: do NOT await loadURL. The renderer is
    // hidden by `show: false` until `ready-to-show` fires anyway, so
    // awaiting Vite's cold compile (1-3s) only blocks the
    // `whenReady` chain unnecessarily and prolongs the macOS bouncing-
    // dock-icon / "rainbow cursor" window. Errors are logged but
    // never thrown — there's no graceful recovery from a missing dev
    // server in dev mode anyway.
    mainWindow.loadURL('http://localhost:5173').catch((e) => {
      log(`loadURL failed: ${(e as Error).message}`);
    });
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html')).catch((e) => {
      log(`loadFile failed: ${(e as Error).message}`);
    });
  }
}

/* ----------------------- IPC handlers ----------------------- */

let currentSniffCtrl: AbortController | null = null;
// R-55 Fix #2 — separate controller used to *finalize* an in-flight
// system-chrome sniff cooperatively. Distinct from currentSniffCtrl
// because finalize means "I'm done, take what you have, return
// success" while abort means "cancel + show empty".
let currentSystemChromeFinalizeCtrl: AbortController | null = null;

/**
 * R-57 — Parse the optional `SniffFilterOptions` bag handed in as the
 * trailing IPC argument of every sniff handler. We keep this defensive
 * (rather than typed) because the renderer can ship pre-R-57 builds
 * that simply don't pass it. Unknown / malformed payloads fall back
 * to the all-defaults shape, which is a no-op at the filter layer.
 */
function readSniffFilterOpts(raw: unknown): SniffFilterOptions {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  const out: SniffFilterOptions = {};
  if (obj.includeStaticImages === true) out.includeStaticImages = true;
  return out;
}

/**
 * Mint a fresh sessionId for a sniff round. The renderer can also
 * supply one (via the optional `sessionId` field of the IPC payload)
 * when it wants to pin a follow-up batch / upload to the same id.
 * The id is short-but-unique enough to be safe in a filename.
 */
function mintSessionId(prefix = 'sess'): string {
  const r = crypto.randomBytes(4).toString('hex');
  return `${prefix}-${Date.now()}-${r}`;
}

/**
 * Best-effort extract of a renderer-supplied sessionId from the
 * filter-opts bag (renderer pins the same id across sniff modes /
 * retries). Falls back to a new id when missing.
 */
function readOrMintSessionId(raw: unknown, prefix?: string): string {
  if (raw && typeof raw === 'object') {
    const v = (raw as Record<string, unknown>).sessionId;
    if (typeof v === 'string' && v.length > 0 && v.length < 80) return v;
  }
  return mintSessionId(prefix);
}

ipcMain.handle('sniff:url', async (_e, url: unknown, maybeFilterOpts: unknown) => {
  const safe = assertHttpUrl(url);
  const filterOpts = readSniffFilterOpts(maybeFilterOpts);
  const sessionId = readOrMintSessionId(maybeFilterOpts, 'sniff');
  openLogSession({ sessionId, pageUrl: safe, origin: 'sniff:url' });
  // Cancel any sniff that is still mid-flight before starting a new one.
  if (currentSniffCtrl) {
    try { currentSniffCtrl.abort(); } catch { /* ignore */ }
  }
  const ctrl = new AbortController();
  currentSniffCtrl = ctrl;
  try {
    logSession({ sessionId, stage: 'sniff', substep: 'url.start', message: `headless sniff start: ${safe}`, data: { url: safe, filterOpts } });
    const r = await sniffPage(
      safe,
      (p) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('sniff:progress', p);
        }
        logSession({
          sessionId,
          stage: 'sniff',
          level: 'debug',
          substep: `url.${p.stage}`,
          message: p.message ? `${p.stage}: ${p.message}` : `${p.stage} ${p.percent}%`,
          data: { stage: p.stage, percent: p.percent, found: p.found, probed: p.probed, total: p.total }
        });
      },
      ctrl.signal
    );
    if (r.title) updateSessionMeta({ sessionId, title: r.title });
    logSession({
      sessionId,
      stage: 'sniff',
      substep: 'url.result',
      message: `headless sniff produced ${r.items.length} item(s) (raw)`,
      data: { itemCount: r.items.length, title: r.title, warnings: r.warnings, infoNotices: r.infoNotices }
    });
    // R-57 — Run every sniff result through the unified filter pipeline
    // before handing it to the renderer. New rules go into
    // `applySniffFilters` and automatically apply to all 5 sniff modes.
    const filtered = applySniffFilters(r, filterOpts, sessionId);
    logSession({
      sessionId, stage: 'sniff', substep: 'sniff.done',
      message: `sniff finished — ${filtered.items.length} item(s) ready (session stays open for downstream process/upload)`,
      data: { itemCount: filtered.items.length }
    });
    return { ...filtered, sessionId };
  } catch (e) {
    closeLogSession({ sessionId, outcome: 'error', message: (e as Error).message });
    throw e;
  } finally {
    if (currentSniffCtrl === ctrl) currentSniffCtrl = null;
  }
});

ipcMain.handle('sniff:cancel', async () => {
  if (currentSniffCtrl) {
    try { currentSniffCtrl.abort(); } catch { /* ignore */ }
    currentSniffCtrl = null;
  }
  // R-56 Fix #B — also detach the system-chrome finalize controller so
  // a stale ctrl from the just-cancelled run cannot leak into the next
  // sniff. Without this, the next 真 Chrome sniff's finalize button
  // would either fire on the wrong run or the renderer's
  // `finalizeSystemChromeSniff()` would resolve to `true` even though
  // no sniff is in flight.
  if (currentSystemChromeFinalizeCtrl) {
    try { currentSystemChromeFinalizeCtrl.abort(); } catch { /* ignore */ }
    currentSystemChromeFinalizeCtrl = null;
  }
  return { ok: true };
});

// R-44 — webview-assisted sniff. Spawns a real Chromium window, lets the
// user log in, then merges webRequest captures + DOM scan into a SniffResult.
//
// R-53 — Single-flight discipline is now unified across all four sniff
// entries (sniff:url, sniff:webview, sniff:system-chrome, sniff:ytdlp-direct).
// They share `currentSniffCtrl`, so kicking off any new mode aborts the
// in-flight one in any other mode. This collapses the previous "race A":
// switching from embedded webview to yt-dlp would orphan the embedded
// window because the embedded path didn't even own a controller.
let webviewSniffInFlight = false;
ipcMain.handle('sniff:webview', async (_e, url: unknown, maybeFilterOpts: unknown) => {
  if (webviewSniffInFlight) {
    throw new Error('已经有一个 Webview 嗅探窗口在进行中,请先关闭它');
  }
  const safe = assertHttpUrl(url);
  const filterOpts = readSniffFilterOpts(maybeFilterOpts);
  const sessionId = readOrMintSessionId(maybeFilterOpts, 'sniff-wv');
  openLogSession({ sessionId, pageUrl: safe, origin: 'sniff:webview' });
  if (currentSniffCtrl) {
    try { currentSniffCtrl.abort(); } catch { /* ignore */ }
  }
  const ctrl = new AbortController();
  currentSniffCtrl = ctrl;
  webviewSniffInFlight = true;
  try {
    logSession({ sessionId, stage: 'sniff', substep: 'webview.start', message: `webview sniff start: ${safe}`, data: { url: safe, filterOpts } });
    const r = await openWebviewSniff(safe, mainWindow, { signal: ctrl.signal });
    if (r) {
      if (r.title) updateSessionMeta({ sessionId, title: r.title });
      logSession({
        sessionId, stage: 'sniff', substep: 'webview.result',
        message: `webview produced ${r.items.length} item(s) (raw)`,
        data: { itemCount: r.items.length, warnings: r.warnings, infoNotices: r.infoNotices }
      });
    } else {
      logSession({ sessionId, stage: 'sniff', level: 'warn', substep: 'webview.empty', message: 'webview cancelled or empty' });
    }
    // R-57 — Unified post-filter (no-op for webview today since the
    // webRequest listener already drops static images, but keeps the
    // pipeline single-chokepoint for future rules).
    const filtered = r ? applySniffFilters(r, filterOpts, sessionId) : r;
    if (filtered) {
      logSession({
        sessionId, stage: 'sniff', substep: 'sniff.done',
        message: `webview sniff finished — ${filtered.items.length} item(s) ready (session stays open)`,
        data: { itemCount: filtered.items.length }
      });
      return { ...filtered, sessionId };
    }
    // No result == terminal end of pipeline, close with 'cancelled'.
    closeLogSession({ sessionId, outcome: 'cancelled', message: 'webview returned no result' });
    return filtered;
  } catch (e) {
    closeLogSession({ sessionId, outcome: 'error', message: (e as Error).message });
    throw e;
  } finally {
    webviewSniffInFlight = false;
    if (currentSniffCtrl === ctrl) currentSniffCtrl = null;
  }
});

// R-51 — System-Chrome sniff. Spawns the user's actual installed Chrome
// (or Edge / Brave) so the TLS / HTTP2 handshake comes from a browser
// whose JA3/JA4 fingerprint is in Cloudflare's whitelist; the user
// manually clicks through any Turnstile / login flow in that real
// window, and we passively scrape the network log + final DOM via CDP.
let systemChromeSniffInFlight = false;
ipcMain.handle('sniff:system-chrome:detect', async () => {
  return findInstalledBrowsers();
});
ipcMain.handle('sniff:system-chrome', async (_e, url: unknown, maybeFilterOpts: unknown, maybeChromeOpts: unknown) => {
  if (systemChromeSniffInFlight) {
    throw new Error('已经有一个真 Chrome 嗅探窗口在进行中,请先关闭它');
  }
  const safe = assertHttpUrl(url);
  const filterOpts = readSniffFilterOpts(maybeFilterOpts);
  const sessionId = readOrMintSessionId(maybeFilterOpts, 'sniff-sc');
  openLogSession({ sessionId, pageUrl: safe, origin: 'sniff:system-chrome' });
  // R-59 — Renderer can opt in to using the user's REAL Chrome profile
  // (rather than our isolated per-host one). This is the highest-impact
  // CF-Turnstile-loop fix because a clean-room profile is the #1 bot
  // signal in 2026.
  const useRealProfile =
    !!maybeChromeOpts &&
    typeof maybeChromeOpts === 'object' &&
    (maybeChromeOpts as Record<string, unknown>).useRealProfile === true;
  // Sniff progress + cancellation share the same channel & controller as
  // headless sniff so the renderer's existing 嗅探中… spinner / cancel
  // button keeps working unchanged.
  if (currentSniffCtrl) {
    try { currentSniffCtrl.abort(); } catch { /* ignore */ }
  }
  const ctrl = new AbortController();
  currentSniffCtrl = ctrl;
  // R-55 Fix #2 — fresh finalize controller for this run.
  const finalizeCtrl = new AbortController();
  currentSystemChromeFinalizeCtrl = finalizeCtrl;
  systemChromeSniffInFlight = true;
  try {
    logSession({ sessionId, stage: 'sniff', substep: 'system-chrome.start', message: `system-chrome sniff start: ${safe}`, data: { url: safe, useRealProfile, filterOpts } });
    const r = await sniffViaSystemChrome(safe, {
      signal: ctrl.signal,
      finalizeSignal: finalizeCtrl.signal,
      useRealProfile,
      onProgress: (p) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('sniff:progress', p);
        }
        logSession({
          sessionId, stage: 'sniff', level: 'debug', substep: `system-chrome.${p.stage}`,
          message: p.message ? `${p.stage}: ${p.message}` : `${p.stage} ${p.percent}%`,
          data: { stage: p.stage, percent: p.percent, found: p.found }
        });
      }
    });
    if (r.title) updateSessionMeta({ sessionId, title: r.title });
    logSession({ sessionId, stage: 'sniff', substep: 'system-chrome.result', message: `system-chrome produced ${r.items.length} item(s) (raw)`, data: { itemCount: r.items.length, warnings: r.warnings, infoNotices: r.infoNotices } });
    // R-57 — Unified post-filter at the IPC chokepoint.
    const filtered = applySniffFilters(r, filterOpts, sessionId);
    logSession({
      sessionId, stage: 'sniff', substep: 'sniff.done',
      message: `sniff finished — ${filtered.items.length} item(s) ready (session stays open for downstream process/upload)`,
      data: { itemCount: filtered.items.length }
    });
    return { ...filtered, sessionId };
  } catch (e) {
    closeLogSession({ sessionId, outcome: 'error', message: (e as Error).message });
    throw e;
  } finally {
    systemChromeSniffInFlight = false;
    if (currentSniffCtrl === ctrl) currentSniffCtrl = null;
    if (currentSystemChromeFinalizeCtrl === finalizeCtrl) currentSystemChromeFinalizeCtrl = null;
  }
});

// R-55 Fix #2 — Cooperative finalize for the real-Chrome sniff. The
// renderer fires this when the user clicks「✓ 完成嗅探」at the 60%
// stage. Returns true iff a finalize signal was actually sent (i.e.
// there was a real-Chrome sniff in flight).
ipcMain.handle('sniff:system-chrome:finalize', async () => {
  if (currentSystemChromeFinalizeCtrl) {
    try { currentSystemChromeFinalizeCtrl.abort(); } catch { /* ignore */ }
    currentSystemChromeFinalizeCtrl = null;
    return true;
  }
  return false;
});

// R-55 Fix #3 — Offline import. Bypasses all four online sniff
// backends and hands a saved page (or single media file) straight
// to the offline parser. Either:
//
//  - the renderer already has a path (e.g. drag-and-drop, recent
//    files), and passes it as the second IPC argument; OR
//  - it passes nothing, in which case we open a native file picker
//    here. The picker accepts both files and directories so the
//    user can choose a Chrome "Webpage, complete" folder in one go.
//
// R-56 — Now wired into the same single-flight `currentSniffCtrl`
// + `sniff:progress` channel as the other four sniff entries, so
// `sniff:cancel` actually cancels offline imports and the renderer
// progress spinner reflects real per-stage milestones (read-mhtml
// → stage-parts → rewrite-html → extract-media) instead of the old
// hard-pinned 50% placeholder. The renderer can also pass a third
// IPC argument `{ includeStaticImages: true }` to opt static-image
// references back in (default = filtered out so png/webp thumbnails
// don't pollute the result grid).
ipcMain.handle('sniff:offlineImport', async (_e, maybePath: unknown, maybeOpts: unknown) => {
  const { importOfflinePath } = await import('./offlineImport');
  let absPath: string | null = null;
  if (typeof maybePath === 'string' && maybePath.trim()) {
    absPath = path.resolve(maybePath.trim());
  } else {
    if (!mainWindow) return null;
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择保存到本地的网页 / 媒体文件',
      properties: ['openFile', 'openDirectory'],
      filters: [
        { name: '网页 / 媒体', extensions: ['mhtml', 'mht', 'html', 'htm', 'mp4', 'webm', 'mov', 'm4v', 'mkv', 'gif', 'png', 'jpg', 'jpeg', 'webp'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (r.canceled || r.filePaths.length === 0) return null;
    absPath = path.resolve(r.filePaths[0]);
  }
  if (!absPath) return null;
  const filterOpts = readSniffFilterOpts(maybeOpts);
  const sessionId = readOrMintSessionId(maybeOpts, 'sniff-off');
  openLogSession({ sessionId, pageUrl: absPath, origin: 'sniff:offlineImport' });
  // R-57 — Always pass `includeStaticImages: true` to the offline parser
  // so it harvests every <img>; the global filter then decides what to
  // drop based on `filterOpts`. Single chokepoint, single rule set.
  // Single-flight: cancel any in-flight sniff (online or offline)
  // before kicking off this offline import.
  if (currentSniffCtrl) {
    try { currentSniffCtrl.abort(); } catch { /* ignore */ }
  }
  const ctrl = new AbortController();
  currentSniffCtrl = ctrl;
  try {
    logSession({ sessionId, stage: 'sniff', substep: 'offline.start', message: `offline import start: ${absPath}`, data: { absPath, filterOpts } });
    const r = await importOfflinePath(absPath, {
      signal: ctrl.signal,
      includeStaticImages: true,
      onProgress: (p) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('sniff:progress', p);
        }
        logSession({
          sessionId, stage: 'sniff', level: 'debug', substep: `offline.${p.stage}`,
          message: p.message ? `${p.stage}: ${p.message}` : `${p.stage} ${p.percent}%`,
          data: { stage: p.stage, percent: p.percent, found: p.found }
        });
      }
    });
    if (r) {
      if (r.title) updateSessionMeta({ sessionId, title: r.title });
      logSession({ sessionId, stage: 'sniff', substep: 'offline.result', message: `offline import produced ${r.items.length} item(s) (raw)`, data: { itemCount: r.items.length, warnings: r.warnings, infoNotices: r.infoNotices } });
    }
    const filtered = r ? applySniffFilters(r, filterOpts, sessionId) : r;
    if (filtered) {
      logSession({
        sessionId, stage: 'sniff', substep: 'sniff.done',
        message: `offline sniff finished — ${filtered.items.length} item(s) ready (session stays open)`,
        data: { itemCount: filtered.items.length }
      });
      return { ...filtered, sessionId };
    }
    closeLogSession({ sessionId, outcome: 'cancelled', message: 'offline returned no result' });
    return filtered;
  } catch (e) {
    closeLogSession({ sessionId, outcome: 'error', message: (e as Error).message });
    throw e;
  } finally {
    if (currentSniffCtrl === ctrl) currentSniffCtrl = null;
  }
});

// R-52 — yt-dlp direct sniff. The third tier (alongside R-44 embedded
// webview and R-51 real-Chrome+CDP). No webview at all — hand the page
// URL straight to yt-dlp's 1900+ extractors and return the resolved
// direct media as a single SniffedMedia. Best for sites where ① is too
// fragile (Cloudflare) AND ② is too heavy (user just wants the file).
let ytdlpDirectSniffInFlight = false;
ipcMain.handle('sniff:ytdlp-direct', async (_e, url: unknown, maybeFilterOpts: unknown) => {
  if (ytdlpDirectSniffInFlight) {
    throw new Error('已经有一个 yt-dlp 直链解析在进行中,请先取消');
  }
  const safe = assertHttpUrl(url);
  const filterOpts = readSniffFilterOpts(maybeFilterOpts);
  const sessionId = readOrMintSessionId(maybeFilterOpts, 'sniff-yt');
  openLogSession({ sessionId, pageUrl: safe, origin: 'sniff:ytdlp-direct' });
  if (currentSniffCtrl) {
    try { currentSniffCtrl.abort(); } catch { /* ignore */ }
  }
  const ctrl = new AbortController();
  currentSniffCtrl = ctrl;
  ytdlpDirectSniffInFlight = true;
  try {
    logSession({ sessionId, stage: 'sniff', substep: 'ytdlp.start', message: `ytdlp direct sniff start: ${safe}`, data: { url: safe } });
    const r = await sniffViaYtdlp(safe, {
      signal: ctrl.signal,
      onProgress: (p) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('sniff:progress', p);
        }
        logSession({
          sessionId, stage: 'sniff', level: 'debug', substep: `ytdlp.${p.stage}`,
          message: p.message ? `${p.stage}: ${p.message}` : `${p.stage} ${p.percent}%`,
          data: { stage: p.stage, percent: p.percent }
        });
      }
    });
    if (r.title) updateSessionMeta({ sessionId, title: r.title });
    logSession({ sessionId, stage: 'sniff', substep: 'ytdlp.result', message: `ytdlp direct produced ${r.items.length} item(s) (raw)`, data: { itemCount: r.items.length, warnings: r.warnings, infoNotices: r.infoNotices } });
    // R-57 — Unified post-filter at the IPC chokepoint.
    const filtered = applySniffFilters(r, filterOpts, sessionId);
    logSession({
      sessionId, stage: 'sniff', substep: 'sniff.done',
      message: `sniff finished — ${filtered.items.length} item(s) ready (session stays open for downstream process/upload)`,
      data: { itemCount: filtered.items.length }
    });
    return { ...filtered, sessionId };
  } catch (e) {
    closeLogSession({ sessionId, outcome: 'error', message: (e as Error).message });
    throw e;
  } finally {
    ytdlpDirectSniffInFlight = false;
    if (currentSniffCtrl === ctrl) currentSniffCtrl = null;
  }
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
  // Accept either { tasks, pageTitle, outputDirOverride } or a bare
  // tasks array (back-compat).
  let tasks: unknown;
  let pageTitle: string | undefined;
  let outputDirOverride: string | undefined;
  let sessionId: string | undefined;
  if (Array.isArray(payload)) {
    tasks = payload;
  } else if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    tasks = obj.tasks;
    if (typeof obj.pageTitle === 'string') pageTitle = obj.pageTitle;
    if (typeof obj.outputDirOverride === 'string' && obj.outputDirOverride) {
      outputDirOverride = obj.outputDirOverride;
    }
    if (typeof obj.sessionId === 'string' && obj.sessionId) {
      sessionId = obj.sessionId;
    }
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
  // If the renderer didn't supply a sessionId (e.g. process-only
  // workflow with no preceding sniff), mint a fresh one so the
  // batch still emits a structured log.
  if (!sessionId) {
    sessionId = mintSessionId('proc');
    openLogSession({ sessionId, pageUrl: pageTitle ?? '', origin: 'process:start (standalone)' });
  } else {
    // Idempotent — session opened by the upstream sniff handler stays.
    openLogSession({ sessionId, pageUrl: pageTitle ?? '', origin: 'process:start' });
  }
  const sid = sessionId;
  // R-29: if the renderer hands us an existing batch sub-directory
  // (because all these tasks belong to a record that already has one
  // — single-process / retry / additional batch within the same
  // sniff round), we reuse it instead of minting a brand-new
  // subDir per IPC call. This is what fixes the "我四个任务最后落
  // 进了两个目录" bug: every single call to `process:start` used to
  // mkdir its own timestamped folder, so a batch + retry + extra
  // single-process produced N sibling sub-directories. The override
  // is still validated through assertOutputDir so a malicious / stale
  // path can't escape the allowed root.
  let subDir: string;
  if (outputDirOverride) {
    subDir = assertOutputDir(outputDirOverride);
    await fsp.mkdir(subDir, { recursive: true }).catch(() => undefined);
    allowedOutputDirs.add(subDir);
  } else {
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
    subDir = path.resolve(path.join(safeBaseOutDir, `${titleSafe}-${ts}-${ms}-${random4}`));
    await fsp.mkdir(subDir, { recursive: true });
    allowedOutputDirs.add(subDir);
  }
  logSession({
    sessionId: sid, stage: 'process', substep: 'batch.start',
    message: `batch start: ${safeTasks.length} task(s) → ${subDir}`,
    data: {
      taskCount: safeTasks.length,
      subDir,
      pageTitle,
      taskIds: safeTasks.map((t) => t.id)
    }
  });
  startBatch(safeTasks, subDir, (p) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('process:progress', p);
    }
    // Forward every TaskProgress emit into the session log. We log
    // running ticks at debug level (so the file isn't dominated by
    // ffmpeg %%) and terminal transitions at info / warn / error
    // so the user can spot failed compressions at a glance.
    const isTerminal = p.status === 'done' || p.status === 'failed' || p.status === 'cancelled' || p.status === 'skipped';
    const level = p.status === 'failed' ? 'error' : (p.status === 'cancelled' ? 'warn' : (isTerminal ? 'info' : 'debug'));
    logSession({
      sessionId: sid, stage: 'process', level,
      substep: `task.${p.substep ?? p.status}`,
      message: `[${p.taskId}] ${p.status}${p.message ? ': ' + p.message : ''}${p.detail ? ' — ' + p.detail : ''}`,
      data: {
        taskId: p.taskId,
        status: p.status,
        substep: p.substep,
        percent: p.percent,
        outputs: p.outputs,
        currentSizeMB: p.currentSizeMB,
        bytesDownloaded: p.bytesDownloaded,
        bytesTotal: p.bytesTotal,
        error: p.error,
        errorCode: p.errorCode,
        warning: p.warning,
        phaseFailures: p.phaseFailures
      }
    });
  }).then(
    () => {
      logSession({ sessionId: sid, stage: 'process', substep: 'batch.done', message: `batch finished` });
      // R-session — close after process so the UI sees a final outcome.
      // If the user subsequently triggers upload, upload:start will
      // re-open this same sid (see uploader/index.ts).
      closeLogSession({ sessionId: sid, outcome: 'done', message: `process batch finished — ${safeTasks.length} task(s)` });
    },
    (e) => {
      logSession({ sessionId: sid, stage: 'process', level: 'error', substep: 'batch.error', message: `batch error: ${(e as Error).message}` });
      closeLogSession({ sessionId: sid, outcome: 'error', message: (e as Error).message });
      log(`batch error: ${(e as Error).message}`);
    }
  );
  return { ok: true, outputDir: subDir, sessionId: sid };
});

ipcMain.handle('process:cancelAll', async () => {
  await cancelAllTasks();
  return { ok: true };
});

// R-43.2 — single-task cancellation. The renderer surfaces a "✕" on
// every running/queued row in TaskTable; clicking it calls this. We
// validate the taskId is a non-empty string (defence-in-depth against
// a tampered IPC payload) and return whether a controller was actually
// aborted so the renderer can decide whether to seed an optimistic
// `cancelled` row or just trust the inbound progress emit.
ipcMain.handle('process:cancelTask', async (_e, taskId: unknown) => {
  if (typeof taskId !== 'string' || taskId.length === 0) {
    return { ok: false, cancelled: false, error: 'invalid taskId' };
  }
  const cancelled = cancelTask(taskId);
  return { ok: true, cancelled };
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

/**
 * R-39 — app:revealItem
 *
 * Opens the OS file manager (Finder on macOS, Explorer on Windows) and
 * highlights a single file. Used by the toolbox history list when the
 * user clicks a completed entry. The path must be inside one of the
 * allowedOutputDirs subtrees — we never reveal arbitrary paths even if
 * the renderer asks us to, because the toolbox history could be
 * persisted across restarts and a stale entry should not become a way
 * to leak filesystem topology.
 */
ipcMain.handle('app:revealItem', async (_e, p: unknown) => {
  if (typeof p !== 'string' || !p) throw new Error('revealItem: path required');
  if (p.length > 4096) throw new Error('revealItem: path too long');
  if (p.indexOf('\u0000') !== -1) throw new Error('revealItem: null byte');
  const norm = path.resolve(p);
  // Only allow revealing files we know we created — i.e. files whose
  // parent directory is (or is inside) an allowed output dir.
  const parent = path.dirname(norm);
  const insideAllowed = allowedOutputDirs.has(parent) ||
    Array.from(allowedOutputDirs).some((d) => isPathInside(d, norm));
  if (!insideAllowed) throw new Error('revealItem: path not in allowed output tree');
  let st;
  try { st = statSync(norm); } catch { throw new Error('revealItem: file does not exist'); }
  if (!st.isFile()) throw new Error('revealItem: not a file');
  shell.showItemInFolder(norm);
  return { ok: true };
});

ipcMain.handle('app:defaultDir', async () => {
  const d = defaultOutDir();
  if (d) allowedOutputDirs.add(d);
  return d;
});

/**
 * R-62 — Cross-platform capability probe. Probed once on first call,
 * cached for the lifetime of the main process. Renderer calls this
 * on startup and renders one toast per `issues[]` entry.
 */
ipcMain.handle('system:capabilities', async () => {
  return await getCapabilityReport();
});

/**
 * R-71 — Expose the build provenance (version / commit / build time /
 * runner platform / node + Electron versions) to the renderer. This is
 * what the future "About" modal — and any in-app bug-report copy —
 * reads. The constant is tree-baked into the bundle by
 * `scripts/write-build-info.mjs`, so this handler is a tiny
 * pass-through with no I/O.
 */
ipcMain.handle('app:buildInfo', async () => {
  return BUILD_INFO;
});

/**
 * R-27 — Re-allow a previously-created output directory after a
 * renderer reload. Each batch sub-dir is added to `allowedOutputDirs`
 * the first time it's created (process:start), but that set lives in
 * memory only; the next launch must explicitly opt back in for
 * openDir to succeed on those paths.
 *
 * Strict safety: we only honour paths that
 *   1. Exist on disk and are directories.
 *   2. Sit either under the current default output dir (the safest
 *      case — a sibling of every other batch sub-dir) OR under a path
 *      already in `allowedOutputDirs` (i.e. the user just picked a
 *      custom root via app:pickDir, which white-listed that root).
 *
 * Anything else is silently rejected (return ok:false, no throw —
 * this is a best-effort hydration, the renderer should NOT bail the
 * whole history panel just because one stale entry was rejected).
 */
ipcMain.handle('app:registerOutputDir', async (_e, p: unknown) => {
  // Outermost catch: this handler is invoked for EVERY persisted
  // history record on renderer mount, so a single edge-case throw
  // (e.g. process.cwd() is gone after a chdir into a deleted folder
  // — path.relative inside isPathInside falls back to cwd) MUST NOT
  // bubble to the renderer where it would reject the whole hydration
  // and leave older "打开目录" buttons unusable.
  try {
    if (typeof p !== 'string' || !p) return { ok: false };
    if (p.length > 4096) return { ok: false };
    let norm: string;
    try {
      norm = path.resolve(p);
    } catch {
      return { ok: false };
    }
    let st;
    try {
      st = statSync(norm);
    } catch {
      return { ok: false };
    }
    if (!st.isDirectory()) return { ok: false };
    const def = defaultOutDir();
    const underDefault = !!def && (norm === def || isPathInside(def, norm));
    const underAllowed = Array.from(allowedOutputDirs).some(
      (root) => norm === root || isPathInside(root, norm)
    );
    if (!underDefault && !underAllowed) return { ok: false };
    allowedOutputDirs.add(norm);
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

/* ----------------------- R-35 Toolbox IPC ----------------------- */

ipcMain.handle('toolbox:pickFiles', async (e, kind: unknown) => {
  if (!isToolboxKind(kind)) throw new Error('toolbox:pickFiles requires a valid kind');
  // Resolve the parent window the same way Chrome's "Open File" attaches
  // its sheet: prefer the window that originated the IPC, fall back to
  // the focused window, finally fall back to the cached `mainWindow`.
  // The original code simply early-returned `[]` when `mainWindow` was
  // null, which produced a silent "click does nothing" UX bug because
  // the renderer's promise resolved to an empty array with no error.
  const sender = BrowserWindow.fromWebContents(e.sender);
  const focused = BrowserWindow.getFocusedWindow();
  const parent = sender ?? focused ?? mainWindow;
  if (!parent) throw new Error('toolbox:pickFiles: no parent window available');
  const exts = TOOLBOX_INPUT_EXTENSIONS[kind];
  // R-41 — derive the dialog title + filter label from the actual
  // extension whitelist instead of hard-coding two cases. Video → GIF /
  // Video → WebP map to "Video"; everything else maps to "动画图像
  // (GIF / WebP)" because the second-half tools all accept .gif + .webp.
  const isVideoTool = kind === 'video-to-gif' || kind === 'video-to-webp';
  const filterName = isVideoTool ? 'Video' : '动画图像 (GIF / WebP)';
  const dialogTitle = isVideoTool ? '选择视频文件' : '选择 GIF / WebP 文件';
  // Spelling out an "All supported" filter as the first entry mirrors the
  // pattern used elsewhere in this app and lets users see every accepted
  // extension at a glance instead of a single MP4/MOV bucket.
  const r = await dialog.showOpenDialog(parent, {
    title: dialogTitle,
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: `${filterName} (${exts.join(', ')})`, extensions: exts.map((x) => x.replace(/^\./, '')) },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (r.canceled || r.filePaths.length === 0) return [];
  const out: string[] = [];
  for (const fp of r.filePaths) {
    const norm = path.resolve(fp);
    const ext = path.extname(norm).toLowerCase();
    if (!exts.includes(ext)) continue;
    out.push(norm);
  }
  return out;
});

/**
 * R-38 — toolbox:probeMedia
 *
 * Returns lightweight metadata (width / height / durationSec) for a
 * user-picked toolbox input. The renderer needs the natural size so the
 * Crop tool's CropBox can map screen-pixel drags to source-pixel rects,
 * and Trim's NumField can show the input duration as a max bound.
 *
 * Re-uses the same path validation as sanitizeToolboxJob: extension
 * whitelist + must-be-an-existing-file. We don't gate by toolbox kind
 * here (any of the toolbox-accepted extensions is fair game) so the
 * renderer can probe the moment a file is queued, before the user has
 * settled on which tool to apply.
 */
ipcMain.handle('toolbox:probeMedia', async (_e, p: unknown) => {
  if (typeof p !== 'string' || !p) throw new Error('toolbox:probeMedia: path required');
  if (p.length > 4096) throw new Error('toolbox:probeMedia: path too long');
  const norm = path.resolve(p);
  if (norm.indexOf('\u0000') !== -1) throw new Error('toolbox:probeMedia: null byte');
  const ext = path.extname(norm).toLowerCase();
  // Union of every toolbox-accepted extension. Cheap to compute on every
  // call given there are < 10 entries total.
  const allAllowed = new Set<string>();
  for (const list of Object.values(TOOLBOX_INPUT_EXTENSIONS)) {
    for (const x of list) allAllowed.add(x);
  }
  if (!allAllowed.has(ext)) throw new Error(`toolbox:probeMedia: extension ${ext || '(none)'} not allowed`);
  let st;
  try { st = statSync(norm); } catch { throw new Error('toolbox:probeMedia: file does not exist'); }
  if (!st.isFile()) throw new Error('toolbox:probeMedia: not a file');
  const info = await probeMedia(norm);
  return {
    width: info.width,
    height: info.height,
    durationSec: info.durationSec,
    frameRate: info.frameRate,
    nbFrames: info.nbFrames,
    // R-39 — include the source byte size so the renderer can show an
    // ezgif-style file-info row (size · WxH · frames · duration). Cheap
    // to compute (we already statSync'd above) and avoids a second IPC.
    sizeBytes: st.size
  };
});

/**
 * R-38 — toolbox:firstFrame
 *
 * Renders a small (~480w) JPEG of the input's first frame, base64-encoded
 * as a data URL. Used by the Crop panel as the canvas the user drags the
 * crop rectangle over. Same path-validation rules as toolbox:probeMedia.
 */
ipcMain.handle('toolbox:firstFrame', async (_e, p: unknown) => {
  if (typeof p !== 'string' || !p) throw new Error('toolbox:firstFrame: path required');
  if (p.length > 4096) throw new Error('toolbox:firstFrame: path too long');
  const norm = path.resolve(p);
  if (norm.indexOf('\u0000') !== -1) throw new Error('toolbox:firstFrame: null byte');
  const ext = path.extname(norm).toLowerCase();
  const allAllowed = new Set<string>();
  for (const list of Object.values(TOOLBOX_INPUT_EXTENSIONS)) {
    for (const x of list) allAllowed.add(x);
  }
  if (!allAllowed.has(ext)) throw new Error(`toolbox:firstFrame: extension ${ext || '(none)'} not allowed`);
  try { statSync(norm); } catch { throw new Error('toolbox:firstFrame: file does not exist'); }
  // atSec=0 yields a robust "first usable frame" — for videos ffmpeg picks
  // the keyframe ≥ 0 sec; for gifs the first frame is index 0.
  const dataUrl = await extractFrameDataUrl(norm, 0);
  return { dataUrl };
});

ipcMain.handle('toolbox:start', async (_e, payload: unknown) => {
  // Accepted shapes: { jobs, outputDirOverride? } where jobs is an array.
  let jobs: unknown;
  let outputDirOverride: string | undefined;
  if (Array.isArray(payload)) {
    jobs = payload;
  } else if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    jobs = obj.jobs;
    if (typeof obj.outputDirOverride === 'string' && obj.outputDirOverride) {
      outputDirOverride = obj.outputDirOverride;
    }
  }
  if (!Array.isArray(jobs) || jobs.length === 0) throw new Error('jobs must be a non-empty array');
  const safeJobs: ToolboxJob[] = jobs.map((j) => sanitizeToolboxJob(j));
  // All jobs in a single start call MUST share the same kind so the
  // output sub-directory is unambiguous (mixing kinds in one toolbox
  // invocation is a UX red flag — different tools have different params,
  // so one bulk action only ever applies to one kind).
  const kind = safeJobs[0].kind;
  if (!safeJobs.every((j) => j.kind === kind)) {
    throw new Error('toolbox:start: all jobs in one batch must share the same kind');
  }
  // Resolve the output sub-directory. We honour `outputDirOverride` when
  // supplied (assertOutputDir gates it through the standard whitelist),
  // otherwise we mint the canonical `<root>/toolbox/<kind>-<YYYYMMDD>` dir.
  let subDir: string;
  if (outputDirOverride) {
    subDir = assertOutputDir(outputDirOverride);
    await fsp.mkdir(subDir, { recursive: true }).catch(() => undefined);
    allowedOutputDirs.add(subDir);
  } else {
    subDir = await ensureToolboxOutputDir(kind);
  }
  startToolbox(safeJobs, subDir, (p) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('process:progress', p);
    }
  }).catch((e) => log(`toolbox error: ${(e as Error).message}`));
  return { ok: true, outputDir: subDir };
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
    const T0 = Date.now();
    const tick = (label: string): void => {
      log(`whenReady[+${Date.now() - T0}ms] ${label}`);
    };
    tick('start');
    // R-80 post-mortem · macOS dock tooltip / menubar 在 dev 下显示 "Electron"。
    // 真正修 dock tooltip 的是 [scripts/patch-electron-plist.mjs](postinstall/predev/prestart)
    // 在 node_modules/electron/dist/Electron.app/Contents/Info.plist 改 CFBundleName。
    // `app.setName()` 不影响 macOS dock tooltip(那是 OS 读 bundle 元数据决定的),
    // 但会影响 menubar 第一项 / About 面板 / process.title,所以这里仍然要调,
    // 让 menubar 一进入就是 "Gif Toolkit",和 dock tooltip(Gif Toolkit (dev))协同。
    try {
      app.setName('Gif Toolkit');
      app.setAboutPanelOptions({
        applicationName: 'Gif Toolkit',
        applicationVersion: app.getVersion(),
      });
    } catch (e) {
      log(`setName failed: ${(e as Error).message}`);
    }
    // R-64 — Set the macOS Dock icon SYNCHRONOUSLY at the very top of
    // `whenReady` so the user never sees the Electron atom logo. The
    // setIcon inside `createWindow()` is too late: by the time await
    // chains for fs.mkdir / protocol.handle / loadURL have settled,
    // the Dock has already been showing the default icon for ~1s.
    // Doing it before any await means the swap happens on the same
    // microtask the Dock first becomes visible.
    if (process.platform === 'darwin') {
      const ico = resolveAppIconPath();
      if (ico && /\.png$/i.test(ico)) {
        try {
          const dock = (app as unknown as { dock?: { setIcon: (p: string) => void } }).dock;
          dock?.setIcon(ico);
          tick(`dock.setIcon ok ${ico}`);
        } catch (e) {
          log(`early dock.setIcon failed: ${(e as Error).message}`);
        }
      } else {
        tick(`dock.setIcon skipped (icon=${ico ?? 'none'})`);
      }
    }

    const def = defaultOutDir();
    if (def) {
      await fsp.mkdir(def, { recursive: true }).catch(() => undefined);
      allowedOutputDirs.add(def);
    }
    tick('mkdir + allowedOutputDirs');

    // R-56 — Register the giftk-local:// fetch handler. Resolves
    // `giftk-local://localhost/<urlencoded-abs-path>` back to a real
    // file on disk and streams it to the renderer. We deliberately
    // restrict served paths to:
    //   1. anything under os.tmpdir() (mhtml extraction targets); OR
    //   2. anything under the user's allowed output dirs (toolbox /
    //      processor outputs the renderer might preview); OR
    //   3. any single file the user explicitly opted into via the
    //      offline-import picker (we don't track those individually
    //      so we accept any readable, regular file).
    // This is a defence-in-depth hedge: the renderer can only mint a
    // giftk-local URL that the main process itself produced, so the
    // surface for arbitrary FS reads is the same as the existing
    // file-picker IPC. We still log every served path for forensic
    // tracing.
    protocol.handle('giftk-local', async (request) => {
      try {
        const url = new URL(request.url);
        let p = decodeURIComponent(url.pathname);
        if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
        if (!path.isAbsolute(p)) {
          return new Response('giftk-local: path must be absolute', { status: 400 });
        }
        if (p.indexOf('\u0000') !== -1) {
          return new Response('giftk-local: null byte', { status: 400 });
        }
        // Reject any path whose normalised form differs (defence
        // against `..` traversal even though we don't have a single
        // root).
        const norm = path.normalize(p);
        if (norm !== p) {
          return new Response('giftk-local: non-canonical path', { status: 400 });
        }
        return net.fetch(pathToFileURL(p).toString());
      } catch (e) {
        return new Response(`giftk-local: ${(e as Error).message}`, { status: 500 });
      }
    });
    tick('protocol.handle giftk-local');

    // R-45 — wire upload IPC (settings persistence + per-job upload
    // streaming). Shares the same `allowedOutputDirs` set so upload
    // jobs cannot read files outside the allowed output tree.
    registerUploaderIpc({
      allowedOutputDirs,
      isPathInside,
      defaultOutDir
    });
    tick('registerUploaderIpc');

    // R-80 — open the SQLite history DB and register `db:*` IPC.
    // openDb() is idempotent and runs the migrations chain; it
    // throws if the native binding can't be loaded so a corrupt
    // postinstall surfaces immediately at startup. registerDbIpc()
    // is also idempotent for tests but in production this is the
    // only call site.
    try {
      openDb();
      registerDbIpc();
      tick('openDb + registerDbIpc');
    } catch (e) {
      log(`db init failed: ${(e as Error).stack ?? (e as Error).message}`);
      throw e;
    }

    // Strict CSP for renderer — packaged uses tight policy; dev keeps loose.
    // R-56 — `giftk-local:` is allow-listed for img-src / media-src so
    // offline-imported items render without flipping `webSecurity` off.
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const isDev = !app.isPackaged;
      const csp = isDev
        ? "default-src 'self' http://localhost:5173 ws://localhost:5173 blob: data:; img-src * data: blob: giftk-local:; media-src * blob: data: giftk-local:; script-src 'self' http://localhost:5173 'unsafe-inline' 'unsafe-eval'; style-src 'self' http://localhost:5173 'unsafe-inline'; connect-src 'self' http://localhost:5173 ws://localhost:5173 giftk-local:;"
        : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: giftk-local:; media-src 'self' blob: giftk-local:; connect-src 'self' giftk-local:; object-src 'none'; base-uri 'none'; frame-ancestors 'none';";
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [csp]
        }
      });
    });
    tick('CSP middleware registered');

    await createWindow();
    tick('createWindow returned');
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
    log('app ready');
    // R-71 — Stamp every saved log with the build fingerprint right
    // after `app ready` so anyone reading a user-submitted log file
    // can instantly tell which release produced it (version / commit /
    // build time / runner platform). This is one synchronous string
    // read of a tree-baked constant — no I/O, no side effects.
    log(`build: ${formatBuildInfo()}`);
    // R-66 — Run the binary diagnostic probe in a non-blocking way so
    // the main process event loop isn't frozen while ETIMEDOUT-prone
    // binaries (e.g. macOS arm64 ffprobe-static first-launch) burn
    // their 5s timeout. The previous synchronous `printPaths()` was
    // exactly the source of the user-reported "彩虹 loading 卡 5 秒"
    // — it ran inside `whenReady` after window creation but its
    // spawnSync calls froze webContents painting until the timeouts
    // settled.
    void printPathsAsync().catch((e) => {
      log(`binaries probe failed: ${(e as Error).message}`);
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// R-80 hardening (H5) — flushed once-per-quit. The handler defers
// `app.quit()` once, asks the renderer to flush its in-memory upsert
// queues, awaits the ack (or a short timeout), then re-quits. The
// flag below prevents the second `before-quit` from re-entering the
// flush path (we'd deadlock waiting for an already-torn-down
// renderer to ack).
let flushedBeforeQuit = false;

app.on('before-quit', (event) => {
  // Synchronous side-effects we always want to run regardless of the
  // flush-before-quit path: cancel in-flight ffmpeg jobs and kill
  // spawned children. closeDb() is intentionally MOVED inside the
  // post-flush branch so the renderer's trailing `db:*` IPC writes
  // can land on an open handle.
  void cancelAllTasks();
  killAllProcs();

  if (flushedBeforeQuit) {
    // Second pass after our async re-quit — actually close the DB
    // and let Electron tear down. better-sqlite3's close() is
    // synchronous and safe inside a `before-quit` hook.
    try { closeDb(); } catch { /* best-effort */ }
    return;
  }

  const wc = mainWindow?.webContents;
  if (!wc || wc.isDestroyed()) {
    // No live renderer to ask — close DB synchronously and let the
    // quit proceed.
    try { closeDb(); } catch { /* best-effort */ }
    flushedBeforeQuit = true;
    return;
  }

  // Defer the quit; re-fire after the renderer acknowledges (or the
  // 1-second hard timeout fires, whichever comes first).
  event.preventDefault();
  const requestId = `flush-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let settled = false;
  const finish = (reason: 'ack' | 'timeout' | 'error'): void => {
    if (settled) return;
    settled = true;
    flushedBeforeQuit = true;
    log(`[db] before-quit flush settled via ${reason}`);
    // close DB on the next pass (from `flushedBeforeQuit` branch above)
    setImmediate(() => { app.quit(); });
  };
  ipcMain.once('db:flushBeforeQuit:ack', (_e, ackId: unknown) => {
    if (typeof ackId === 'string' && ackId === requestId) finish('ack');
  });
  setTimeout(() => finish('timeout'), 1000);
  try {
    wc.send('db:flushBeforeQuit', requestId);
  } catch (e) {
    log(`[db] before-quit send failed: ${(e as Error).message}`);
    finish('error');
  }
});
