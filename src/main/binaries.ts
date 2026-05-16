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
  try {
    // gifsicle@4.x is CommonJS and exports a binary path string.
    // gifsicle@5.x is ESM and would crash require() — pin to 4.x in package.json.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('gifsicle') as string | { default?: string } | null;
    const p = typeof mod === 'string' ? mod : (mod && typeof mod === 'object' ? mod.default ?? null : null);
    cachedGifsicle = resolveBin(p, 'gifsicle');
  } catch (e) {
    log(`gifsicle load failed: ${(e as Error).message}`);
    cachedGifsicle = 'gifsicle';
  }
  return cachedGifsicle!;
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
