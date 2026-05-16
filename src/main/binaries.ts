import path from 'path';
import { spawnSync } from 'child_process';
import { app } from 'electron';
import { log } from './logger';

function resolveBin(staticPath: string | null | undefined, fallbackName: string): string {
  if (!staticPath) return fallbackName;
  if (app && app.isPackaged) {
    return staticPath.replace(/app\.asar([\\/]|$)/, 'app.asar.unpacked$1');
  }
  return staticPath;
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
  try {
    const pkgJson = require.resolve('@343dev/gifsicle/package.json');
    const pkgDir = path.dirname(pkgJson);
    const binaryName = `gifsicle_${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
    const binPath = path.join(pkgDir, 'vendor', process.platform, binaryName);
    cachedGifsicle = resolveBin(binPath, 'gifsicle');
    log(`gifsicle: using @343dev/gifsicle -> ${cachedGifsicle}`);
    return cachedGifsicle;
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
