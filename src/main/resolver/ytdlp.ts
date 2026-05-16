import path from 'path';
import { promises as fsp } from 'fs';
import { app } from 'electron';
import { YtDlp, helpers, type VideoInfo, type VideoFormat } from 'ytdlp-nodejs';
import { log } from '../logger';
import { isPrivateHost } from '../helpers';
import type { ResolvedMedia } from '../../shared/types';

/**
 * yt-dlp wrapper used for "resolve embed → direct mp4" of YouTube / X /
 * Bilibili / etc.
 *
 * Resolution strategy (R-14, since 2026.05): the yt-dlp binary is shipped
 * inside the installer (electron-builder asarUnpack copies
 * `node_modules/ytdlp-nodejs/bin/**` into `app.asar.unpacked/...`). The
 * resolver therefore tries, in order:
 *   1. packaged binary       (production: app.asar.unpacked/.../bin/<name>)
 *   2. dev node_modules/bin  (development: node_modules/ytdlp-nodejs/bin/<name>)
 *   3. userData/bin/<name>   (legacy installs / offline-cached binary)
 *   4. download into userData/bin and use that  (network fallback)
 *
 * Step 4 only runs when steps 1-3 all miss — which is rare in production
 * because step 1 always resolves on a packaged build. The renderer treats
 * resolver as "always-available out-of-the-box"; we never block the UI on
 * a confirm dialog. If step 4 is also unreachable (offline + missing
 * binary, e.g. air-gapped corporate machine), the resolver throws
 * YtDlpNotInstalledError so the renderer can show a per-card retry hint.
 */

let cached: YtDlp | null = null;
// Cached actual binary path (varies by platform: yt-dlp_macos / yt-dlp.exe /
// yt-dlp / yt-dlp_linux_aarch64 …). Populated by checkYtdlp / ensureYtdlp.
let cachedBinPath: string | null = null;
// One-shot in-flight ensure() so concurrent resolveEmbed calls coalesce on
// a single download attempt instead of racing each other.
let ensureInflight: Promise<string> | null = null;

function userBinDir(): string {
  return path.join(app.getPath('userData'), 'bin');
}

/**
 * yt-dlp ships different binary names per OS/arch (see ytdlp-nodejs
 * helpers.downloadYtDlp source). Probe each candidate location for any
 * matching file rather than guessing.
 */
function platformCandidates(): string[] {
  if (process.platform === 'win32') return ['yt-dlp.exe', 'yt-dlp_x86.exe'];
  if (process.platform === 'darwin') return ['yt-dlp_macos'];
  if (process.platform === 'linux') {
    return ['yt-dlp', 'yt-dlp_linux_aarch64', 'yt-dlp_linux_armv7l'];
  }
  return ['yt-dlp'];
}

/**
 * Locations to look for an already-present yt-dlp binary, in priority
 * order. The first existing file wins.
 */
function candidateDirs(): string[] {
  const dirs: string[] = [];
  // 1) Packaged: electron-builder asarUnpack mirrors node_modules into
  //    app.asar.unpacked. require.resolve points into app.asar; we replace
  //    the segment so fs operations go to the unpacked copy.
  try {
    // Resolve via require so it works whether the renderer/main path layout
    // is `dist/main/...` or `build/...` — we only need the package.json's
    // directory, not the JS entry.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkgPath = require.resolve('ytdlp-nodejs/package.json');
    const pkgDir = path.dirname(pkgPath);
    const unpacked = pkgDir.replace(/[\\/]app\.asar[\\/]/, path.sep + 'app.asar.unpacked' + path.sep);
    dirs.push(path.join(unpacked, 'bin'));
    if (unpacked !== pkgDir) {
      // Dev / unbundled: also keep the original location.
      dirs.push(path.join(pkgDir, 'bin'));
    }
  } catch { /* ignore — package not resolvable, fall through */ }
  // 2) helpers.BIN_DIR — what `helpers.downloadYtDlp()` would write into
  //    when called with no arg. Useful when the bundle layout changes.
  try {
    const binDir = (helpers as unknown as { BIN_DIR?: string }).BIN_DIR;
    if (typeof binDir === 'string' && binDir) dirs.push(binDir);
  } catch { /* ignore */ }
  // 3) userData/bin — legacy install location and the network-fallback
  //    target. Always checked last.
  dirs.push(userBinDir());
  return dirs;
}

async function findInstalledBinary(): Promise<string | null> {
  if (cachedBinPath) {
    try {
      const st = await fsp.stat(cachedBinPath);
      if (st.isFile() && st.size > 0) return cachedBinPath;
    } catch { /* fall through */ }
    cachedBinPath = null;
  }
  for (const dir of candidateDirs()) {
    for (const name of platformCandidates()) {
      const p = path.join(dir, name);
      try {
        const st = await fsp.stat(p);
        if (st.isFile() && st.size > 0) {
          cachedBinPath = p;
          return p;
        }
      } catch { /* not present */ }
    }
  }
  return null;
}

/**
 * Public binary path. Returns the actual installed binary if known;
 * otherwise the canonical "expected" packaged path (so diagnostics in the
 * renderer can show where we WOULD load from).
 */
export function ytdlpBinaryPath(): string {
  if (cachedBinPath) return cachedBinPath;
  const dirs = candidateDirs();
  return path.join(dirs[0] || userBinDir(), platformCandidates()[0]);
}

async function downloadYtDlpInner(targetDir: string): Promise<string> {
  // `helpers.downloadYtDlp(out)` treats `out` as a *directory* and writes
  // the platform-specific binary inside (e.g. yt-dlp_macos / yt-dlp.exe).
  // Returns the actual final binary path.
  const finalPath = await helpers.downloadYtDlp(targetDir);
  return finalPath;
}

export interface YtdlpStatus {
  installed: boolean;
  binaryPath: string;
  version?: string;
  workingDir: string;
  /** Where the binary was discovered: 'packaged' (shipped with the app),
   *  'userData' (downloaded fallback), or 'missing' when not found. */
  source: 'packaged' | 'userData' | 'missing';
}

async function readVersion(bin: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      // Lazy import to avoid pulling child_process at module load time.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { spawn } = require('child_process') as typeof import('child_process');
      const child = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        resolve(undefined);
      }, 5000);
      child.on('close', () => {
        clearTimeout(timer);
        const v = out.trim().split('\n')[0];
        resolve(v || undefined);
      });
      child.on('error', () => { clearTimeout(timer); resolve(undefined); });
    } catch {
      resolve(undefined);
    }
  });
}

function classifySource(p: string | null): YtdlpStatus['source'] {
  if (!p) return 'missing';
  if (p.startsWith(userBinDir())) return 'userData';
  return 'packaged';
}

export async function checkYtdlp(): Promise<YtdlpStatus> {
  const found = await findInstalledBinary();
  const bin = found || ytdlpBinaryPath();
  const installed = !!found;
  let version: string | undefined;
  if (installed) {
    version = await readVersion(bin);
  }
  return {
    installed,
    binaryPath: bin,
    version,
    workingDir: userBinDir(),
    source: classifySource(found)
  };
}

/**
 * Make sure a working yt-dlp binary is reachable. Tries the packaged copy
 * first; if missing (e.g. legacy install, partial extraction), falls back
 * to downloading into userData/bin. Concurrent callers share a single
 * in-flight download via `ensureInflight`.
 *
 * This function is intentionally side-effect-free for the common
 * production case where the packaged binary is found instantly: it just
 * returns the cached path without spawning anything.
 */
export async function ensureYtdlp(): Promise<string> {
  const found = await findInstalledBinary();
  if (found) return found;
  if (ensureInflight) return ensureInflight;
  ensureInflight = (async () => {
    const dir = userBinDir();
    await fsp.mkdir(dir, { recursive: true });
    log(`yt-dlp binary not found in packaged bundle, downloading into ${dir} (one-time fallback)`);
    const finalPath = await downloadYtDlpInner(dir);
    cachedBinPath = finalPath;
    if (process.platform !== 'win32') {
      try { await fsp.chmod(finalPath, 0o755); } catch { /* ignore */ }
    }
    cached = null;
    log(`yt-dlp downloaded: ${finalPath}`);
    return finalPath;
  })().finally(() => { ensureInflight = null; });
  return ensureInflight;
}

function getInstance(bin: string): YtDlp {
  // Always rebuild if the binary path changed (e.g. ensure() just downloaded).
  if (!cached || (cached as unknown as { _binaryPath?: string })._binaryPath !== bin) {
    cached = new YtDlp({ binaryPath: bin });
    (cached as unknown as { _binaryPath?: string })._binaryPath = bin;
  }
  return cached;
}

/**
 * Choose the best mp4-ish progressive format with both audio+video.
 * Falls back to highest-quality video-only if no progressive is available
 * (caller will then pick audio separately for muxing — but for GIFs we
 * actually drop audio entirely, so video-only is fine too).
 */
function pickBestFormat(formats: VideoFormat[]): VideoFormat | undefined {
  if (!formats || formats.length === 0) return undefined;
  const score = (f: VideoFormat): number => {
    let s = 0;
    const isProgressive = f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none';
    if (isProgressive) s += 100_000;
    if (f.ext === 'mp4') s += 5_000;
    if (typeof f.height === 'number') s += Math.min(2160, f.height) * 10;
    if (typeof f.tbr === 'number') s += Math.min(5000, f.tbr);
    // Prefer plain http(s) over hls/dash for direct ffmpeg/axios consumption.
    if (f.protocol && /^https?$/.test(f.protocol)) s += 200;
    return s;
  };
  return [...formats]
    .filter((f) => {
      if (!f.url) return false;
      if (f.vcodec === 'none') return false;
      // Reject manifest / segmented protocols — downloader.ts pipes through
      // axios as a single-file stream and ffmpeg's videoToGifPalette expects
      // a local mp4/webm/mov, not an .m3u8 / .mpd / .mhtml manifest.
      const proto = (f.protocol || '').toLowerCase();
      if (/^m3u8/.test(proto)) return false;
      if (/dash_segments/.test(proto)) return false;
      if (/^mhtml/.test(proto)) return false;
      // Tighten by ext too — yt-dlp sometimes returns protocol=https but
      // ext=mhtml for storyboards.
      const ext = (f.ext || '').toLowerCase();
      if (ext === 'mhtml' || ext === 'm3u8' || ext === 'mpd') return false;
      return true;
    })
    .sort((a, b) => score(b) - score(a))[0];
}

// Allow only headers that are useful for fetching CDN content (UA, Referer,
// Origin, Accept-*, Range). Reject everything else by default — yt-dlp's
// extractor can return arbitrary headers and we MUST NOT forward authn /
// proxy / host-overriding fields to the eventual axios/ffmpeg request.
const HEADER_ALLOWLIST = new Set<string>([
  'user-agent',
  'referer',
  'origin',
  'accept',
  'accept-language',
  'accept-encoding',
  'range',
  'x-csrf-token',
  'x-requested-with'
]);

function sanitizeHeaders(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h || typeof h !== 'object') return out;
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
    if (typeof k !== 'string') continue;
    if (typeof v !== 'string') continue;
    if (!/^[A-Za-z0-9-]+$/.test(k)) continue;
    if (!HEADER_ALLOWLIST.has(k.toLowerCase())) continue;
    if (v.length > 1024) continue;
    if (/[\r\n]/.test(v) || v.indexOf('\u0000') !== -1) continue;
    out[k] = v;
  }
  return out;
}

function ensurePublicHttp(u: string): string {
  let parsed: URL;
  try { parsed = new URL(u); } catch { throw new Error('invalid resolved URL'); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('resolved URL must be http(s)');
  if (isPrivateHost(parsed.hostname.toLowerCase())) {
    throw new Error('resolved URL points at a private host (refused)');
  }
  return parsed.toString();
}

export async function resolveDirectUrl(pageUrl: string): Promise<ResolvedMedia> {
  // Validate input so we never spawn yt-dlp with a non-http target.
  ensurePublicHttp(pageUrl);
  // ensureYtdlp() returns the actual binary path. In production this is
  // always the packaged binary (instant); in legacy installs / dev it may
  // trigger a one-time download. If the download itself fails (offline +
  // no cached binary), surface a typed error so the renderer can decide
  // what to show on the card.
  let bin: string;
  try {
    bin = await ensureYtdlp();
  } catch (e) {
    throw new YtDlpNotInstalledError(ytdlpBinaryPath(), (e as Error).message);
  }
  const yt = getInstance(bin);
  const info = (await yt.getInfoAsync(pageUrl)) as VideoInfo;
  if (!info || !info.formats) throw new Error('yt-dlp returned no formats');
  const best = pickBestFormat(info.formats);
  if (!best || !best.url) throw new Error('no playable format found');
  const directUrl = ensurePublicHttp(best.url);
  // VideoFormat .d.ts doesn't expose http_headers but yt-dlp's JSON does.
  // Fall back to the top-level info.http_headers if format lacks them.
  const formatHeaders = (best as unknown as { http_headers?: unknown }).http_headers;
  const infoHeaders = (info as unknown as { http_headers?: unknown }).http_headers;
  const headers = sanitizeHeaders(formatHeaders ?? infoHeaders);
  return {
    url: directUrl,
    mime: best.ext === 'mp4' ? 'video/mp4' : `video/${best.ext}`,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    qualityLabel: best.format_note || best.resolution || (best.height ? `${best.height}p` : undefined),
    width: typeof best.width === 'number' ? best.width : undefined,
    height: typeof best.height === 'number' ? best.height : undefined,
    durationSec: typeof info.duration === 'number' ? info.duration : undefined,
    sizeBytes: typeof best.filesize === 'number' ? best.filesize : undefined,
    source: 'ytdlp',
    extractor: info.extractor || info.extractor_key,
    title: info.title
  };
}

export class YtDlpNotInstalledError extends Error {
  binaryPath: string;
  constructor(binaryPath: string, reason?: string) {
    super(reason ? `yt-dlp not available: ${reason}` : 'yt-dlp not available');
    this.name = 'YtDlpNotInstalledError';
    this.binaryPath = binaryPath;
  }
}
