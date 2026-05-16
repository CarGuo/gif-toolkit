import path from 'path';
import { promises as fsp } from 'fs';
import { app } from 'electron';
import { YtDlp, helpers, type VideoInfo, type VideoFormat } from 'ytdlp-nodejs';
import { log } from '../logger';
import { isPrivateHost } from '../helpers';
import type { ResolvedMedia } from '../../shared/types';

/**
 * yt-dlp wrapper used for "resolve embed → direct mp4" of YouTube / X /
 * Bilibili / etc. Strictly opt-in: never downloads the binary unless the
 * user explicitly clicks "解析直链" (renderer-side gate) or invokes
 * installYtdlp() via the dedicated IPC.
 *
 * Binary lives under `userData/bin/yt-dlp(.exe)` so it does NOT pollute the
 * install directory, can be removed by the user, and never ships with the
 * packaged installer (R-14: resolver is opt-in).
 */

let cached: YtDlp | null = null;
// Cached actual binary path (varies by platform: yt-dlp_macos / yt-dlp.exe /
// yt-dlp / yt-dlp_linux_aarch64 …). Populated by checkYtdlp / installYtdlp.
let cachedBinPath: string | null = null;

function userBinDir(): string {
  return path.join(app.getPath('userData'), 'bin');
}

/**
 * yt-dlp ships different binary names per OS/arch (see ytdlp-nodejs
 * helpers.downloadYtDlp source). Probe the bin dir for any matching file
 * rather than guessing.
 */
function platformCandidates(): string[] {
  if (process.platform === 'win32') return ['yt-dlp.exe', 'yt-dlp_x86.exe'];
  if (process.platform === 'darwin') return ['yt-dlp_macos'];
  if (process.platform === 'linux') {
    return ['yt-dlp', 'yt-dlp_linux_aarch64', 'yt-dlp_linux_armv7l'];
  }
  return ['yt-dlp'];
}

async function findInstalledBinary(): Promise<string | null> {
  if (cachedBinPath) {
    try {
      const st = await fsp.stat(cachedBinPath);
      if (st.isFile() && st.size > 0) return cachedBinPath;
    } catch { /* fall through */ }
    cachedBinPath = null;
  }
  const dir = userBinDir();
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
  return null;
}

/**
 * Public binary path. Returns the actual installed binary if present,
 * otherwise the canonical "expected" path (so the renderer's UI can show
 * the location it WILL be installed at).
 */
export function ytdlpBinaryPath(): string {
  if (cachedBinPath) return cachedBinPath;
  const dir = userBinDir();
  return path.join(dir, platformCandidates()[0]);
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

export async function checkYtdlp(): Promise<YtdlpStatus> {
  const found = await findInstalledBinary();
  const bin = found || ytdlpBinaryPath();
  const installed = !!found;
  let version: string | undefined;
  if (installed) {
    version = await readVersion(bin);
  }
  return { installed, binaryPath: bin, version, workingDir: userBinDir() };
}

/**
 * Download yt-dlp binary into userData/bin. Caller must explicitly request
 * this (after a UI confirmation dialog). Returns the final binary path.
 */
export async function installYtdlp(): Promise<YtdlpStatus> {
  const dir = userBinDir();
  await fsp.mkdir(dir, { recursive: true });
  log(`installing yt-dlp into ${dir}`);
  const finalPath = await downloadYtDlpInner(dir);
  cachedBinPath = finalPath;
  if (process.platform !== 'win32') {
    try { await fsp.chmod(finalPath, 0o755); } catch { /* ignore */ }
  }
  cached = null;
  const status = await checkYtdlp();
  log(`yt-dlp installed: path=${status.binaryPath} version=${status.version || 'unknown'}`);
  return status;
}

function getInstance(): YtDlp {
  if (!cached) {
    const bin = cachedBinPath || ytdlpBinaryPath();
    cached = new YtDlp({ binaryPath: bin });
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
  const status = await checkYtdlp();
  if (!status.installed) {
    throw new YtDlpNotInstalledError(status.binaryPath);
  }
  const yt = getInstance();
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
  constructor(binaryPath: string) {
    super('yt-dlp is not installed');
    this.name = 'YtDlpNotInstalledError';
    this.binaryPath = binaryPath;
  }
}

export async function uninstallYtdlp(): Promise<void> {
  const dir = userBinDir();
  cached = null;
  cachedBinPath = null;
  for (const name of platformCandidates()) {
    try { await fsp.unlink(path.join(dir, name)); } catch { /* ignore missing */ }
  }
}
