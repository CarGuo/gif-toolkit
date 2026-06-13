import path from 'path';
import { promises as fsp } from 'fs';
import { spawn } from 'child_process';
import { app } from 'electron';
import { helpers, type VideoInfo, type VideoFormat } from 'ytdlp-nodejs';
// R-84 — all `getInfo`/`download` work goes through getInfoSpawn /
// downloadYtdlpSections (raw spawn) so DEFAULT_UA + bilibili Referer are
// guaranteed on the command line. The `ytdlp-nodejs` YtDlp class is
// intentionally NOT instantiated anywhere in this module — using its
// `getInfoAsync()` would silently drop the headers and re-introduce
// HTTP 412 for the R-14 embed-resolve flow.
import { log } from '../logger';
import { isPrivateHost } from '../helpers';
import { sanitizeAllowlistedHeaders } from '../../shared/headers';
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

// R-84-ytdlp-default-headers — Bilibili (and a handful of other CN
// extractors) reject requests carrying yt-dlp's default User-Agent /
// missing Referer with HTTP 412 Precondition Failed. We always pass an
// evergreen desktop Chrome UA, and inject `Referer: https://www.bilibili.com`
// when the page URL is on a bilibili.com / b23.tv host. See
// rules/R-84-ytdlp-default-headers.md for full rationale + repro.
// R-84 — exported for ytdlpHeaders.test.ts regression. The test pins the
// exact UA string + bilibili host matcher so a future refactor cannot
// silently drop them and re-introduce the HTTP 412 path the rule fixed.
export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export function bilibiliReferer(pageUrl: string): string | null {
  try {
    const host = new URL(pageUrl).hostname.toLowerCase();
    if (
      host === 'bilibili.com' ||
      host.endsWith('.bilibili.com') ||
      host === 'b23.tv'
    ) return 'https://www.bilibili.com';
  } catch { /* ignore */ }
  return null;
}

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
  //
  // R-63 — `require.resolve('ytdlp-nodejs/package.json')` throws
  // ERR_PACKAGE_PATH_NOT_EXPORTED on Node 16+ because ytdlp-nodejs's
  // `exports` field does not list `./package.json` (the package is
  // ESM-only and only publicises the main entry). The outer try/catch
  // swallowed the throw and `dirs` ended up containing only
  // `userData/bin` — which on a fresh install is empty, so capability
  // probe + `findInstalledBinary` both reported the binary as missing
  // and triggered a misleading "yt-dlp 未就绪" toast despite the
  // bundled `node_modules/ytdlp-nodejs/bin/yt-dlp_macos` (etc.)
  // existing on disk. Walk the parent dirs instead.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { findPackageDir } = require('../binaries') as { findPackageDir: (n: string, s?: string) => string | null };
    const pkgDir = findPackageDir('ytdlp-nodejs');
    if (pkgDir) {
      const unpacked = pkgDir.replace(/[\\/]app\.asar[\\/]/, path.sep + 'app.asar.unpacked' + path.sep);
      dirs.push(path.join(unpacked, 'bin'));
      if (unpacked !== pkgDir) {
        // Dev / unbundled: also keep the original location.
        dirs.push(path.join(pkgDir, 'bin'));
      }
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

/**
 * R-63 — Synchronous "is any yt-dlp binary present on disk?" probe.
 *
 * `ytdlpBinaryPath()` only returns one canonical path which may not be
 * the one that actually exists (Linux ships `yt-dlp_linux_aarch64`
 * separately from `yt-dlp`, and the bundled location varies between
 * dev / packaged / userData fallback). This helper iterates every
 * candidate dir × platform-candidate filename, returning the first
 * existing absolute path or null. Used by `getCapabilityReport()` so
 * capability probe stops emitting a false "yt-dlp 未就绪" toast when
 * the binary is sitting one directory over from `ytdlpBinaryPath()`.
 *
 * Sync (statSync) on purpose — capability probe is a synchronous
 * boot-time call. The directory tree is shallow so the cost is sub-ms.
 */
export function findYtdlpBinarySync(): string | null {
  if (cachedBinPath) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { statSync } = require('fs') as typeof import('fs');
      if (statSync(cachedBinPath).isFile()) return cachedBinPath;
    } catch { /* fall through */ }
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { statSync } = require('fs') as typeof import('fs');
  for (const dir of candidateDirs()) {
    for (const name of platformCandidates()) {
      const p = path.join(dir, name);
      try {
        if (statSync(p).isFile()) return p;
      } catch { /* not present */ }
    }
  }
  return null;
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
      // R-84 / test-mockability — use the top-of-file spawn import so
      // vitest module mocks intercept; runtime requires no change.
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
    log(`yt-dlp downloaded: ${finalPath}`);
    return finalPath;
  })().finally(() => { ensureInflight = null; });
  return ensureInflight;
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

// Allowed CDN headers + sanitiser are now sourced from src/shared/headers.ts
// so renderer's IPC entry and this resolver share the same allow-list.
// Lifted in R-53 — historically these two paths drifted.
const sanitizeHeaders = sanitizeAllowlistedHeaders;

export function ensurePublicHttp(u: string): string {
  let parsed: URL;
  try { parsed = new URL(u); } catch { throw new Error('invalid resolved URL'); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('resolved URL must be http(s)');
  if (isPrivateHost(parsed.hostname.toLowerCase())) {
    throw new Error('resolved URL points at a private host (refused)');
  }
  return parsed.toString();
}

/**
 * R-53 — Spawn yt-dlp with `--dump-single-json` (or `-J` / `--print-json`)
 * so we get the same `VideoInfo`-shaped payload that `ytdlp-nodejs`
 * produces, but with a real `child` handle we can kill on AbortSignal.
 *
 * The default `getInfoAsync()` from `ytdlp-nodejs` does not expose the
 * underlying child process — calling `Promise.race(promise, abortPromise)`
 * only lets the *outer* promise reject, while the actual yt-dlp
 * subprocess keeps downloading the JSON metadata for many seconds.
 * That's the high-priority bug R-52 review caught: "Promise.race fake
 * cancel". This function fixes it by spawning the binary directly,
 * tracking the child, and SIGKILL'ing it the moment the signal fires.
 */
// R-84 — exported so ytdlpHeaders.test.ts can stub `spawn` and assert
// `--user-agent <DEFAULT_UA>` + `--referer <bilibili>` end up on the
// child-process argv without needing the full `ensureYtdlp()` bootstrap.
export function getInfoSpawn(bin: string, pageUrl: string, signal?: AbortSignal): Promise<VideoInfo> {
  return new Promise<VideoInfo>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    // R-84 / test-mockability — module-scope spawn so vitest mocks intercept.
    const args = [
      '--no-warnings',
      '--no-progress',
      '--no-playlist',
      '--socket-timeout', '15',
      // R-84-ytdlp-default-headers — see top-of-file comment. Bilibili
      // returns 412 without a real UA; --no-call-home was also dropped
      // here because yt-dlp 2026.03 deprecated it and it now emits a
      // warning into stderr that pollutes our error diagnostics.
      '--user-agent', DEFAULT_UA,
      '--dump-single-json'
    ];
    const ref = bilibiliReferer(pageUrl);
    if (ref) args.push('--referer', ref);
    args.push(pageUrl);
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdoutBuf = '';
    let stderrBuf = '';
    let killed = false;
    // Cap stdout / stderr so a malicious extractor cannot exhaust memory.
    const STDOUT_CAP = 32 * 1024 * 1024; // 32 MB JSON ought to be enough
    const STDERR_CAP = 256 * 1024;
    child.stdout?.on('data', (c: Buffer) => {
      if (stdoutBuf.length < STDOUT_CAP) stdoutBuf += c.toString();
    });
    child.stderr?.on('data', (c: Buffer) => {
      if (stderrBuf.length < STDERR_CAP) stderrBuf += c.toString();
    });
    const onAbort = (): void => {
      killed = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      // Hard kill after 1 s if SIGTERM didn't take.
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, 1000).unref();
      reject(new Error('aborted'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e: Error) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (!killed) reject(e);
    });
    child.on('close', (code: number | null) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (killed) return; // already rejected via abort path
      if (code !== 0) {
        const tail = stderrBuf.trim().slice(-500);
        reject(new Error(`yt-dlp exited with code ${code}: ${tail}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdoutBuf) as VideoInfo;
        resolve(parsed);
      } catch (e) {
        reject(new Error(`yt-dlp JSON parse failed: ${(e as Error).message}`));
      }
    });
  });
}

export async function resolveDirectUrl(pageUrl: string, signal?: AbortSignal): Promise<ResolvedMedia> {
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
  // R-84-ytdlp-default-headers — ALL callers (with or without signal)
  // must go through getInfoSpawn so DEFAULT_UA and the bilibili Referer
  // are guaranteed to land on the command line. The old `if (signal)`
  // fallback to `ytdlp-nodejs.getInfoAsync()` silently dropped those
  // headers and re-introduced HTTP 412 for the R-14 embed-resolve flow
  // (which calls resolveDirectUrl without a signal). getInfoSpawn already
  // treats `signal === undefined` as "no abort wiring", so unifying the
  // path costs nothing on the cancel side and closes the header hole.
  const info: VideoInfo = await getInfoSpawn(bin, pageUrl, signal);
  if (!info || !info.formats) throw new Error('yt-dlp returned no formats');
  const best = pickBestFormat(info.formats);
  if (!best || !best.url) throw new Error('no playable format found');
  const directUrl = ensurePublicHttp(best.url);
  // VideoFormat .d.ts doesn't expose http_headers but yt-dlp's JSON does.
  // Fall back to the top-level info.http_headers if format lacks them.
  const formatHeaders = (best as unknown as { http_headers?: unknown }).http_headers;
  const infoHeaders = (info as unknown as { http_headers?: unknown }).http_headers;
  const headers = sanitizeHeaders(formatHeaders ?? infoHeaders);
  // R-53 — best.ext can be missing or non-video (e.g. 'mhtml' filtered
  // earlier; 'jpg' for storyboards). Build a more defensive mime so we
  // don't end up advertising 'video/jpg' downstream.
  const ext = (best.ext || '').toLowerCase();
  const isVideoExt = /^(mp4|webm|mov|m4v|mkv|avi|flv|3gp|ts)$/.test(ext);
  const mime = isVideoExt
    ? (ext === 'mp4' ? 'video/mp4' : `video/${ext}`)
    : 'video/mp4';
  return {
    url: directUrl,
    mime,
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

/**
 * R-24: download ONLY the requested time ranges from a yt-dlp source page,
 * concatenated into a single mp4 at `outPath`. Saves bandwidth + local
 * decode time for long videos where the user has selected only a few
 * segments via the BatchSegmentModal / PreviewPanel.
 *
 * Each `range` is half-open `[startSec, endSec)` and forwarded to yt-dlp
 * as `--download-sections "*<start>-<end>"`. yt-dlp internally requests
 * byte ranges from the CDN where possible (HTTP Range / DASH / HLS) and
 * falls back to "download the whole stream then trim" only when the
 * extractor doesn't expose seekable ranges.
 *
 * Spawns the installed binary directly (not via ytdlp-nodejs) so the
 * --download-sections flag is reliably forwarded; ytdlp-nodejs wraps
 * info-extraction APIs but does not expose the section flag yet.
 */
export interface DownloadSection {
  startSec: number;
  endSec: number;
}

export async function downloadYtdlpSections(
  pageUrl: string,
  outPath: string,
  sections: DownloadSection[],
  signal?: AbortSignal
): Promise<void> {
  ensurePublicHttp(pageUrl);
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error('downloadYtdlpSections: sections must be non-empty');
  }
  const validated = sections
    .filter((s) => Number.isFinite(s.startSec) && Number.isFinite(s.endSec) && s.endSec > s.startSec)
    .map((s) => ({ startSec: Math.max(0, s.startSec), endSec: s.endSec }));
  if (validated.length === 0) throw new Error('downloadYtdlpSections: no valid sections');

  const bin = await ensureYtdlp();
  const args: string[] = [
    '--no-warnings',
    '--no-progress',
    '--no-playlist',
    '-o',
    outPath,
    '-f',
    'bv*+ba/b',
    '--merge-output-format',
    'mp4'
  ];
  for (const s of validated) {
    args.push('--download-sections', `*${s.startSec}-${s.endSec}`);
  }
  // R-84-ytdlp-default-headers — mirror the header injection done in
  // getInfoSpawn so the section download path also survives Bilibili's
  // 412 gate. Must come BEFORE the pageUrl positional.
  args.push('--user-agent', DEFAULT_UA);
  const ref = bilibiliReferer(pageUrl);
  if (ref) args.push('--referer', ref);
  args.push(pageUrl);

  // R-84 / test-mockability — module-scope spawn so vitest mocks intercept.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* ignore */ } };
    if (signal) {
      if (signal.aborted) { onAbort(); reject(new Error('aborted')); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('close', (code: number | null) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
    });
    child.on('error', (e: Error) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(e);
    });
  });
}
