import path from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { spawn, spawnSync } from 'child_process';
import { app } from 'electron';
import { log } from './logger';

/**
 * R-69 — Platform-aware probe timeout policy.
 *
 * Background: the user reported `ffprobe 不可用` and `cap probe ytdlp:
 * timeout` toasts on macOS even though both binaries were installed.
 * Manual timing on the user's box revealed the root cause:
 *   - ffprobe-static/.../arm64/ffprobe is actually a x86_64 Mach-O
 *     (ffprobe-static packaging quirk), so it runs through Rosetta 2.
 *     First-launch Rosetta translation + Gatekeeper verification +
 *     `com.apple.provenance` quarantine check =  6.7 s on the user's
 *     M-series Mac. Second invocation: 0.035 s.
 *   - yt-dlp_macos is a PyInstaller bundle. First launch self-extracts
 *     a Python distribution into ~/.cache and validates signatures —
 *     measured 26.7 s cold, < 0.1 s warm.
 *
 * Pre-R-69 every probe used a flat 5 s timeout, identical across all
 * three platforms. That's wildly insufficient for macOS cold launches
 * and produced false-positive "binary missing" toasts on every fresh
 * install / update of the app. The capability subsystem's spec says
 * issues should only mark "this feature is genuinely unusable in this
 * session", so a slow first launch must NOT be reported as an error.
 *
 * Per-platform cold-start budget (only used the first time we probe
 * after the binary's mtime changes — see `binariesWarmCache`):
 *   - darwin : 30 s (Rosetta JIT + Gatekeeper + quarantine)
 *   - win32  : 15 s (Defender first-scan + SmartScreen)
 *   - linux  :  8 s (no translation layer; mostly disk + ld.so cost)
 *
 * Warm-path budget (every subsequent probe across the app's lifetime
 * once we've seen the binary report a real version once):
 *   - all platforms : 5 s (matches pre-R-69 baseline)
 *
 * The warm marker is keyed by `<absolutePath>|<mtimeMs>` and kept
 * in `<userData>/binaries-warm.json`. Touching / replacing the binary
 * resets the marker and we go through the cold budget again.
 */
function coldProbeTimeoutMs(): number {
  switch (process.platform) {
    case 'darwin': return 30_000;
    case 'win32':  return 15_000;
    default:       return 8_000;
  }
}
function warmProbeTimeoutMs(): number {
  return 5_000;
}

interface WarmEntry {
  path: string;
  mtimeMs: number;
  version: string;
}
let warmCache: Record<string, WarmEntry> | null = null;
function warmCachePath(): string | null {
  // app may be undefined under unit-test imports — gracefully degrade
  // to in-memory only in that case.
  if (!app || typeof app.getPath !== 'function') return null;
  try {
    const dir = app.getPath('userData');
    return path.join(dir, 'binaries-warm.json');
  } catch {
    return null;
  }
}
function loadWarmCache(): Record<string, WarmEntry> {
  if (warmCache) return warmCache;
  const p = warmCachePath();
  if (!p) { warmCache = {}; return warmCache; }
  try {
    const raw = readFileSync(p, 'utf8');
    const j = JSON.parse(raw) as Record<string, WarmEntry>;
    warmCache = j && typeof j === 'object' ? j : {};
  } catch {
    warmCache = {};
  }
  return warmCache;
}
function saveWarmCache(): void {
  const p = warmCachePath();
  if (!p || !warmCache) return;
  try {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(warmCache));
  } catch (e) {
    log(`warmCache: write failed ${(e as Error).message}`);
  }
}
function fileMtimeMs(bin: string): number | null {
  try {
    return statSync(bin).mtimeMs;
  } catch {
    return null;
  }
}
function isWarm(label: string, bin: string): boolean {
  const cache = loadWarmCache();
  const entry = cache[label];
  if (!entry) return false;
  if (entry.path !== bin) return false;
  const m = fileMtimeMs(bin);
  if (m === null) return false;
  return Math.abs(entry.mtimeMs - m) < 1; // mtimeMs has float precision noise
}
function markWarm(label: string, bin: string, version: string): void {
  const cache = loadWarmCache();
  const m = fileMtimeMs(bin);
  if (m === null) return;
  cache[label] = { path: bin, mtimeMs: m, version };
  saveWarmCache();
}

/** Test-only — drop the in-memory warm cache so each test starts clean. */
export function _resetWarmCacheForTest(): void {
  warmCache = null;
}

function resolveBin(staticPath: string | null | undefined, fallbackName: string): string {
  if (!staticPath) return fallbackName;
  if (app && app.isPackaged) {
    return staticPath.replace(/app\.asar([\\/]|$)/, 'app.asar.unpacked$1');
  }
  return staticPath;
}

/**
 * R-63 — Locate an ESM-only npm package's directory without going
 * through `require.resolve('<pkg>/package.json')`.
 *
 * Why: Node's CJS loader checks the package's `exports` map BEFORE
 * trying any literal file path. If `exports` doesn't list
 * `./package.json` (`@343dev/gifsicle` and `ytdlp-nodejs` both omit it),
 * the call throws ERR_PACKAGE_PATH_NOT_EXPORTED — even though the file
 * is sitting right there on disk. The thrown error was being swallowed
 * by an outer try/catch and we were silently falling through to the
 * "system PATH" branch, which produced spurious "gifsicle 不可用" /
 * "yt-dlp 未就绪" capability toasts on machines where the bundled
 * binaries actually existed.
 *
 * Walk-up search instead: from `__dirname` (or any caller-provided
 * start dir) look for `node_modules/<scope>/<name>` going up the tree.
 * Returns the first match's absolute directory, or `null` if none.
 */
export function findPackageDir(pkgName: string, startFrom: string = __dirname): string | null {
  let cur = startFrom;
  for (;;) {
    const candidate = path.join(cur, 'node_modules', ...pkgName.split('/'));
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

let cachedFfmpeg: string | null = null;
let cachedFfprobe: string | null = null;
let cachedGifsicle: string | null = null;

export function getFfmpegPath(): string {
  if (cachedFfmpeg) return cachedFfmpeg;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ffmpegStatic = require('ffmpeg-static') as string | null;
    cachedFfmpeg = resolveBin(ffmpegStatic, 'ffmpeg');
  } catch (e) {
    log(`ffmpeg-static load failed: ${(e as Error).message}`);
    cachedFfmpeg = 'ffmpeg';
  }
  return cachedFfmpeg!;
}

export function getFfprobePath(): string {
  if (cachedFfprobe) return cachedFfprobe;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ffprobeStatic = require('ffprobe-static') as { path: string } | null;
    cachedFfprobe = resolveBin(ffprobeStatic?.path ?? null, 'ffprobe');
  } catch (e) {
    log(`ffprobe-static load failed: ${(e as Error).message}`);
    cachedFfprobe = 'ffprobe';
  }
  return cachedFfprobe!;
}

export function getGifsiclePath(): string {
  if (cachedGifsicle) return cachedGifsicle;
  // Tier 1: @343dev/gifsicle (modern fork, binary 1.94+, supports --lossy).
  //         IMPORTANT: this package is ESM-only (`type: "module"`) and
  //         exports the binary path via `export default`. We can't
  //         `require()` it from CJS, so instead we resolve its
  //         package.json and reconstruct the well-known binary layout
  //         (<pkg>/vendor/<platform>/gifsicle_<arch>[.exe]). Doing so
  //         lets us stay CJS in main process without paying for a
  //         dynamic `import()` boot.
  // Tier 2: legacy `gifsicle` (imagemin/gifsicle-bin, binary 1.92.x,
  //         lossy support is binary-version dependent — kept only as a
  //         fallback for installs that still have it).
  //
  // R-63 — The previous implementation used
  // `require.resolve('@343dev/gifsicle/package.json')` to find the
  // package directory. That call throws ERR_PACKAGE_PATH_NOT_EXPORTED
  // because @343dev/gifsicle's `exports` field does NOT publicise
  // `./package.json` to CJS consumers — Node 16+ honours the field
  // strictly. The throw was caught by the outer try/catch and we
  // silently fell through to the "system PATH" branch, leading to a
  // false "gifsicle 不可用" capability toast despite the vendor binary
  // sitting in node_modules. We now do a directory walk-up via
  // `findPackageDir` which doesn't need a working subpath.
  try {
    const pkgDir = findPackageDir('@343dev/gifsicle');
    if (pkgDir) {
      const binaryName = `gifsicle_${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
      const binPath = path.join(pkgDir, 'vendor', process.platform, binaryName);
      cachedGifsicle = resolveBin(binPath, 'gifsicle');
      log(`gifsicle: using @343dev/gifsicle -> ${cachedGifsicle}`);
      return cachedGifsicle;
    }
    log(`gifsicle: @343dev/gifsicle directory not found in node_modules tree`);
  } catch (e) {
    log(`gifsicle: @343dev/gifsicle resolve failed: ${(e as Error).message}`);
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('gifsicle') as string | { default?: string; path?: string } | null;
    const p = typeof mod === 'string'
      ? mod
      : (mod && typeof mod === 'object' ? (mod.default ?? mod.path ?? null) : null);
    if (p) {
      cachedGifsicle = resolveBin(p, 'gifsicle');
      log(`gifsicle: using legacy gifsicle -> ${cachedGifsicle}`);
      return cachedGifsicle;
    }
  } catch (e) {
    log(`gifsicle: legacy gifsicle load failed: ${(e as Error).message}`);
  }
  cachedGifsicle = 'gifsicle';
  return cachedGifsicle;
}

let cachedGifsicleHasLossy: boolean | null = null;
/** Probe whether the resolved gifsicle binary supports `--lossy=N`.
 *  Cached after first call. Used by [gifsicleOptimize] to decide whether
 *  to omit the flag (older builds reject it with "unrecognized option"
 *  and the whole optimize step fails).
 *
 *  We invoke `gifsicle --help` once and grep stdout for "lossy". The
 *  flag has been part of the official gifsicle binary since 1.92 and is
 *  the single biggest contributor to GIF compression ratio — without it
 *  Phase B / C of the compressLoop is much weaker. */
export function gifsicleSupportsLossy(): boolean {
  if (cachedGifsicleHasLossy !== null) return cachedGifsicleHasLossy;
  const bin = getGifsiclePath();
  try {
    const r = spawnSync(bin, ['--help'], { encoding: 'utf8', timeout: 5000 });
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    cachedGifsicleHasLossy = /--lossy/i.test(out);
    log(`gifsicle: supports --lossy = ${cachedGifsicleHasLossy}`);
  } catch (e) {
    log(`gifsicle: --help probe failed: ${(e as Error).message}`);
    cachedGifsicleHasLossy = false;
  }
  return cachedGifsicleHasLossy;
}

export function getCacheDir(): string {
  const dir = path.join(app.getPath('userData'), 'cache');
  return dir;
}

function probeBinary(label: string, bin: string, args: string[]): { ok: boolean; version: string } {
  try {
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 5000 });
    if (r.error) {
      log(`probe ${label}: spawn error ${r.error.message} (path=${bin})`);
      return { ok: false, version: '' };
    }
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    const firstLine = out.split(/\r?\n/).find((s) => s.trim().length > 0) || '';
    if (r.status === 0 || /version/i.test(firstLine)) {
      return { ok: true, version: firstLine.trim() };
    }
    log(`probe ${label}: exit ${r.status} (path=${bin})`);
    return { ok: false, version: firstLine.trim() };
  } catch (e) {
    log(`probe ${label}: throw ${(e as Error).message}`);
    return { ok: false, version: '' };
  }
}

/**
 * R-66 — Async, non-blocking variant of `probeBinary`. Used by
 * `printPathsAsync` so that the diagnostic probe at app startup does
 * NOT freeze the main process event loop while ETIMEDOUT-prone
 * binaries (e.g. macOS arm64 ffprobe on first launch) burn through
 * their 5s timeout — that synchronous wait was what produced the
 * "彩虹 loading 卡 5 秒" symptom in R-66.
 *
 * R-69 — Now returns a `timedOut` flag so callers can distinguish
 * "definitely failed" (spawn ENOENT / non-zero exit) from "still
 * warming up" (Rosetta translation / Defender first-scan / yt-dlp
 * PyInstaller self-extract). Pre-R-69 every probe used a flat 5 s
 * budget which produced false-positive "binary missing" toasts on
 * macOS first launch — measured 6.7 s for ffprobe (Rosetta) and
 * 26.7 s for yt-dlp (PyInstaller). Use `probeBinaryWarmAware` below
 * to pick the right budget per platform / warm-cache state.
 */
export interface AsyncProbeResult {
  ok: boolean;
  version: string;
  timedOut: boolean;
}
function probeBinaryAsync(label: string, bin: string, args: string[], timeoutMs: number = 5000): Promise<AsyncProbeResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (res: AsyncProbeResult): void => {
      if (settled) return;
      settled = true;
      resolve(res);
    };
    try {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const t = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        log(`probe ${label}: timeout (path=${bin}, budget=${timeoutMs}ms)`);
        finish({ ok: false, version: '', timedOut: true });
      }, timeoutMs);
      child.stdout?.on('data', (d) => { stdout += d.toString('utf8'); });
      child.stderr?.on('data', (d) => { stderr += d.toString('utf8'); });
      child.on('error', (e) => {
        clearTimeout(t);
        log(`probe ${label}: spawn error ${e.message} (path=${bin})`);
        finish({ ok: false, version: '', timedOut: false });
      });
      child.on('close', (code) => {
        clearTimeout(t);
        const out = `${stdout}\n${stderr}`;
        const firstLine = out.split(/\r?\n/).find((s) => s.trim().length > 0) || '';
        if (code === 0 || /version/i.test(firstLine)) {
          finish({ ok: true, version: firstLine.trim(), timedOut: false });
          return;
        }
        log(`probe ${label}: exit ${code} (path=${bin})`);
        finish({ ok: false, version: firstLine.trim(), timedOut: false });
      });
    } catch (e) {
      log(`probe ${label}: throw ${(e as Error).message}`);
      finish({ ok: false, version: '', timedOut: false });
    }
  });
}

/**
 * R-69 — High-level probe wrapper: picks platform-aware timeout from
 * the warm cache and, on cold-cache timeout, retries once with the
 * extended cold budget. Used by both `printPathsAsync` and
 * `capabilities.ts` so the policy lives in one place.
 *
 * Cold budget by platform: darwin 30s / win32 15s / linux 8s.
 * Warm budget: 5s everywhere. The warm marker is keyed by
 * `<absolutePath>|<mtimeMs>`; updating the binary invalidates it.
 */
export async function probeBinaryWarmAware(
  label: string,
  bin: string,
  args: string[]
): Promise<AsyncProbeResult> {
  const warm = isWarm(label, bin);
  const timeoutMs = warm ? warmProbeTimeoutMs() : coldProbeTimeoutMs();
  const r = await probeBinaryAsync(label, bin, args, timeoutMs);
  if (r.ok) {
    markWarm(label, bin, r.version);
    return r;
  }
  // If we used the warm budget and it timed out, retry ONCE with the
  // cold budget — the warm marker may be stale (binary updated since).
  // We don't retry when the cold budget itself timed out; that's a
  // genuine failure regardless of platform.
  if (r.timedOut && warm) {
    log(`probe ${label}: warm budget timed out, retrying with cold budget`);
    const r2 = await probeBinaryAsync(label, bin, args, coldProbeTimeoutMs());
    if (r2.ok) markWarm(label, bin, r2.version);
    return r2;
  }
  return r;
}

export function printPaths(): { ffmpeg: { path: string; ok: boolean; version: string }; ffprobe: { path: string; ok: boolean; version: string }; gifsicle: { path: string; ok: boolean; version: string } } {
  const ffmpegPath = getFfmpegPath();
  const ffprobePath = getFfprobePath();
  const gifsiclePath = getGifsiclePath();
  const ffmpeg = probeBinary('ffmpeg', ffmpegPath, ['-version']);
  const ffprobe = probeBinary('ffprobe', ffprobePath, ['-version']);
  const gifsicle = probeBinary('gifsicle', gifsiclePath, ['--version']);
  log(`binaries: ffmpeg=${ffmpegPath} ok=${ffmpeg.ok} ${ffmpeg.version}`);
  log(`binaries: ffprobe=${ffprobePath} ok=${ffprobe.ok} ${ffprobe.version}`);
  log(`binaries: gifsicle=${gifsiclePath} ok=${gifsicle.ok} ${gifsicle.version}`);
  return {
    ffmpeg: { path: ffmpegPath, ...ffmpeg },
    ffprobe: { path: ffprobePath, ...ffprobe },
    gifsicle: { path: gifsiclePath, ...gifsicle }
  };
}

/**
 * R-66 — Async, non-blocking variant of `printPaths`. Use this from
 * the app startup chain so the main process event loop isn't frozen
 * by ETIMEDOUT-prone `--version` probes (the user-reported "彩虹
 * loading 卡 5 秒" symptom). The synchronous `printPaths` is kept
 * for tests that want a deterministic snapshot.
 *
 * R-69 — Routes through `probeBinaryWarmAware` so the timeout budget
 * matches platform reality (macOS first launch needs > 5 s for
 * Rosetta-translated binaries) and successful probes persist a warm
 * marker for faster subsequent boots.
 */
export async function printPathsAsync(): Promise<{ ffmpeg: { path: string; ok: boolean; version: string }; ffprobe: { path: string; ok: boolean; version: string }; gifsicle: { path: string; ok: boolean; version: string } }> {
  const ffmpegPath = getFfmpegPath();
  const ffprobePath = getFfprobePath();
  const gifsiclePath = getGifsiclePath();
  const [ffmpeg, ffprobe, gifsicle] = await Promise.all([
    probeBinaryWarmAware('ffmpeg', ffmpegPath, ['-version']),
    probeBinaryWarmAware('ffprobe', ffprobePath, ['-version']),
    probeBinaryWarmAware('gifsicle', gifsiclePath, ['--version'])
  ]);
  log(`binaries: ffmpeg=${ffmpegPath} ok=${ffmpeg.ok} ${ffmpeg.version}`);
  log(`binaries: ffprobe=${ffprobePath} ok=${ffprobe.ok} ${ffprobe.version}`);
  log(`binaries: gifsicle=${gifsiclePath} ok=${gifsicle.ok} ${gifsicle.version}`);
  return {
    ffmpeg: { path: ffmpegPath, ok: ffmpeg.ok, version: ffmpeg.version },
    ffprobe: { path: ffprobePath, ok: ffprobe.ok, version: ffprobe.version },
    gifsicle: { path: gifsiclePath, ok: gifsicle.ok, version: gifsicle.version }
  };
}
