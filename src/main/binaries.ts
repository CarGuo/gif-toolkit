import path from 'path';
import { app } from 'electron';

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
  } catch {
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
  } catch {
    cachedFfprobe = 'ffprobe';
  }
  return cachedFfprobe!;
}

export function getGifsiclePath(): string {
  if (cachedGifsicle) return cachedGifsicle;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const gifsicle = require('gifsicle') as string | null;
    cachedGifsicle = resolveBin(gifsicle, 'gifsicle');
  } catch {
    cachedGifsicle = 'gifsicle';
  }
  return cachedGifsicle!;
}

export function getCacheDir(): string {
  const dir = path.join(app.getPath('userData'), 'cache');
  return dir;
}
