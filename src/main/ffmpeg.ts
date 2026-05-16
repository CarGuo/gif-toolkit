import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { promises as fsp } from 'fs';
import sharp from 'sharp';
import { getFfmpegPath, getFfprobePath, getGifsiclePath } from './binaries';

export interface ProbeInfo {
  durationSec: number;
  width: number;
  height: number;
  hasVideo: boolean;
}

interface RunOpts {
  onStderr?: (line: string) => void;
  signal?: AbortSignal;
}

// Local cancellation marker. processor.ts has its own CancelledError class,
// but uses `isAbortError(e)` (which checks `e.name === 'CancelledError'`) so
// any Error with that name is treated as a cancellation. Keep semantics
// consistent with processor without creating a circular import.
function makeCancelledError(): Error {
  const e = new Error('cancelled');
  e.name = 'CancelledError';
  return e;
}

const liveProcs = new Set<ChildProcess>();

export function killAllProcs(): void {
  for (const p of liveProcs) {
    try {
      p.kill('SIGKILL');
    } catch {
      // ignore
    }
  }
  liveProcs.clear();
}

function run(cmd: string, args: string[], opts: RunOpts = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    liveProcs.add(child);
    let settled = false;
    const settleReject = (e: Error) => {
      if (settled) return;
      settled = true;
      liveProcs.delete(child);
      if (onAbort && opts.signal) opts.signal.removeEventListener('abort', onAbort);
      reject(e);
    };
    const settleResolve = () => {
      if (settled) return;
      settled = true;
      liveProcs.delete(child);
      if (onAbort && opts.signal) opts.signal.removeEventListener('abort', onAbort);
      resolve();
    };

    let onAbort: (() => void) | null = null;
    if (opts.signal) {
      if (opts.signal.aborted) {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        settleReject(makeCancelledError());
        return;
      }
      onAbort = () => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        settleReject(makeCancelledError());
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    let errBytes = 0;
    const errChunks: string[] = [];
    const ERR_LIMIT = 64 * 1024;
    child.stdout.on('error', () => undefined);
    child.stderr.on('error', () => undefined);
    child.stderr.on('data', (chunk: Buffer) => {
      const txt = chunk.toString();
      errBytes += txt.length;
      if (errBytes <= ERR_LIMIT) errChunks.push(txt);
      if (opts.onStderr) opts.onStderr(txt);
    });
    child.on('error', (e) => settleReject(e));
    child.on('close', (code, signal) => {
      if (code === 0) {
        settleResolve();
      } else {
        const errAll = errChunks.join('').slice(-1500);
        settleReject(new Error(`${path.basename(cmd)} exited ${code} (${signal ?? 'no signal'}): ${errAll.slice(-500)}`));
      }
    });
  });
}

function runJson<T>(cmd: string, args: string[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    liveProcs.add(child);
    let settled = false;
    const settleReject = (e: Error) => {
      if (settled) return;
      settled = true;
      liveProcs.delete(child);
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(e);
    };
    const settleResolve = (v: T) => {
      if (settled) return;
      settled = true;
      liveProcs.delete(child);
      resolve(v);
    };

    let out = '';
    let err = '';
    const timer = setTimeout(() => settleReject(new Error('ffprobe timeout')), 30000);
    child.stdout.on('error', () => undefined);
    child.stderr.on('error', () => undefined);
    child.stdout.on('data', (b: Buffer) => {
      out += b.toString();
      if (out.length > 5 * 1024 * 1024) {
        settleReject(new Error('ffprobe output too large'));
      }
    });
    child.stderr.on('data', (b: Buffer) => (err += b.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      settleReject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (code === 0) {
        try {
          settleResolve(JSON.parse(out) as T);
        } catch (e) {
          settleReject(e as Error);
        }
      } else {
        settleReject(new Error(`ffprobe failed (${code}): ${err.slice(-300)}`));
      }
    });
  });
}

interface FfprobeStream {
  codec_type: string;
  width?: number;
  height?: number;
  duration?: string;
}
interface FfprobeFormat {
  duration?: string;
}
interface FfprobeOutput {
  streams: FfprobeStream[];
  format: FfprobeFormat;
}

export async function probe(file: string): Promise<ProbeInfo> {
  const ffprobe = getFfprobePath();
  const data = await runJson<FfprobeOutput>(ffprobe, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    file
  ]);
  const v = data.streams.find((s) => s.codec_type === 'video');
  const dur = Number(v?.duration ?? data.format?.duration ?? 0) || 0;
  return {
    durationSec: dur,
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    hasVideo: !!v
  };
}

export async function extractFrameDataUrl(
  file: string,
  atSec: number,
  options: { signal?: AbortSignal; maxBytes?: number } = {}
): Promise<string> {
  const ffmpeg = getFfmpegPath();
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  const signal = options.signal;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const ce = new Error('cancelled');
      ce.name = 'CancelledError';
      reject(ce);
      return;
    }
    const child = spawn(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        String(Math.max(0, atSec)),
        '-i',
        file,
        '-frames:v',
        '1',
        '-vf',
        'scale=480:-2',
        '-q:v',
        '4',
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        'pipe:1'
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    liveProcs.add(child);
    let settled = false;
    const chunks: Buffer[] = [];
    let total = 0;
    let err = '';

    let onAbort: (() => void) | null = null;
    const cleanupAbort = () => {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    };

    const failReject = (e: Error) => {
      if (settled) return;
      settled = true;
      cleanupAbort();
      liveProcs.delete(child);
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(e);
    };
    const succeed = (val: string) => {
      if (settled) return;
      settled = true;
      cleanupAbort();
      liveProcs.delete(child);
      resolve(val);
    };

    if (signal) {
      onAbort = () => {
        const ce = new Error('cancelled');
        ce.name = 'CancelledError';
        failReject(ce);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('error', () => undefined);
    child.stderr.on('error', () => undefined);
    child.stdout.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        failReject(new Error(`frame data exceeded ${maxBytes} bytes`));
        return;
      }
      chunks.push(c);
    });
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.on('error', (e) => failReject(e));
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        failReject(new Error(`extract frame failed: ${err.slice(-200)}`));
        return;
      }
      const buf = Buffer.concat(chunks);
      succeed(`data:image/jpeg;base64,${buf.toString('base64')}`);
    });
  });
}

export interface GifConvertParams {
  input: string;
  output: string;
  startSec: number;
  durationSec: number;
  fps: number;
  width: number;
  speed?: number; // 1.0 = normal; 2.0 = 2x faster; 0.5 = half speed
  cropRect?: { x: number; y: number; w: number; h: number };
  statsMode?: 'diff' | 'full' | 'single';
  /** Optional HTTP headers (e.g. Referer for Bilibili CDN). Used only when
   *  `input` is an http(s) URL — ffmpeg's `-headers` flag is otherwise a
   *  no-op for local files. */
  headers?: Record<string, string>;
}

function buildHttpInputArgs(input: string, headers?: Record<string, string>): string[] {
  if (!headers) return [];
  if (!/^https?:/i.test(input)) return [];
  const lines: string[] = [];
  for (const [k, v] of Object.entries(headers)) {
    if (typeof k !== 'string' || typeof v !== 'string') continue;
    if (!/^[A-Za-z0-9-]+$/.test(k)) continue;
    if (/[\r\n]/.test(v) || v.indexOf('\u0000') !== -1) continue;
    lines.push(`${k}: ${v}`);
  }
  if (lines.length === 0) return [];
  return ['-headers', lines.join('\r\n') + '\r\n'];
}

export async function videoToGifPalette(p: GifConvertParams, onLog?: (s: string) => void, signal?: AbortSignal): Promise<void> {
  const ffmpeg = getFfmpegPath();
  const palette = `${p.output}.palette.png`;
  const statsMode = p.statsMode ?? 'diff';
  try {
    const cropFilter = p.cropRect
      ? `crop=${Math.max(2, Math.round(p.cropRect.w))}:${Math.max(2, Math.round(p.cropRect.h))}:${Math.max(
          0,
          Math.round(p.cropRect.x)
        )}:${Math.max(0, Math.round(p.cropRect.y))}`
      : '';
    const scaleFilter = p.width > 0 ? `scale=${p.width}:-2:flags=lanczos` : '';
    const speed = p.speed && p.speed > 0 && p.speed !== 1 ? p.speed : 1;
    const setptsFilter = speed !== 1 ? `setpts=PTS/${speed}` : '';
    // Compose the base filter chain WITHOUT a trailing comma; consumers add
    // their own separator. Empty parts are filtered out so we never emit an
    // empty filter ("No such filter: ''").
    const baseChain = [setptsFilter, `fps=${p.fps}`, cropFilter, scaleFilter]
      .filter((s) => s.length > 0)
      .join(',');

    // -t at input level cuts SOURCE duration. setpts=PTS/speed compresses output
    // PTS, so output duration = sourceDuration / speed. To make the resulting
    // GIF cover exactly p.durationSec of perceived motion (at speed=N), we read
    // p.durationSec * speed seconds from the source.
    const sourceDuration = String(Math.max(0.05, p.durationSec * speed));
    const httpHeaderArgs = buildHttpInputArgs(p.input, p.headers);

    await run(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        String(p.startSec),
        '-t',
        sourceDuration,
        ...httpHeaderArgs,
        '-i',
        p.input,
        '-an',
        '-sn',
        '-vf',
        `${baseChain},palettegen=stats_mode=${statsMode}`,
        palette
      ],
      { onStderr: (s) => onLog?.(s.trim()), signal }
    );

    await run(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        String(p.startSec),
        '-t',
        sourceDuration,
        ...httpHeaderArgs,
        '-i',
        p.input,
        '-i',
        palette,
        '-an',
        '-sn',
        '-lavfi',
        `${baseChain}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
        p.output
      ],
      { onStderr: (s) => onLog?.(s.trim()), signal }
    );
  } finally {
    await fsp.unlink(palette).catch(() => undefined);
  }
}

export async function gifsicleOptimize(
  input: string,
  output: string,
  lossy: number,
  colors: number,
  signal?: AbortSignal
): Promise<void> {
  const gifsicle = getGifsiclePath();
  const safeLossy = Number.isFinite(lossy) ? Math.max(0, Math.floor(lossy)) : 0;
  const safeColors = Number.isFinite(colors) ? Math.max(2, Math.min(256, Math.floor(colors))) : 256;
  await run(
    gifsicle,
    [
      '-O3',
      `--lossy=${safeLossy}`,
      '--colors',
      String(safeColors),
      input,
      '-o',
      output
    ],
    { signal }
  );
}

export async function imageResizeKeepAspect(input: string, output: string, targetWidth: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw makeCancelledError();
  await sharp(input, { animated: true })
    .resize({ width: targetWidth, withoutEnlargement: true })
    .gif()
    .toFile(output);
  if (signal?.aborted) throw makeCancelledError();
}

export function statSizeMB(p: string): Promise<number> {
  return fsp.stat(p).then((s) => s.size / (1024 * 1024));
}

/**
 * Build a small webp thumbnail (max width 256) suitable for inline previews.
 * - For images / gifs: read first frame via sharp (animated:false)
 * - For videos: pull a frame via ffmpeg at ~1s and let sharp compress it
 */
export async function buildThumbnailDataUrl(
  inputPath: string,
  kind: 'video' | 'gif' | 'image',
  maxWidth = 256
): Promise<{ dataUrl: string; width: number; height: number }> {
  if (kind === 'video') {
    const ffmpeg = getFfmpegPath();
    const jpegBuf = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(
        ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-ss',
          '1',
          '-i',
          inputPath,
          '-frames:v',
          '1',
          '-vf',
          `scale=${maxWidth}:-2:flags=lanczos`,
          '-q:v',
          '4',
          '-f',
          'image2pipe',
          '-vcodec',
          'mjpeg',
          'pipe:1'
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      liveProcs.add(child);
      let settled = false;
      const chunks: Buffer[] = [];
      let total = 0;
      const LIMIT = 8 * 1024 * 1024;
      let err = '';
      child.stdout.on('error', () => undefined);
      child.stderr.on('error', () => undefined);
      child.stdout.on('data', (c: Buffer) => {
        total += c.length;
        if (total > LIMIT) {
          if (settled) return;
          settled = true;
          liveProcs.delete(child);
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
          reject(new Error('thumbnail frame too large'));
          return;
        }
        chunks.push(c);
      });
      child.stderr.on('data', (c: Buffer) => (err += c.toString()));
      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        liveProcs.delete(child);
        reject(e);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        liveProcs.delete(child);
        if (code !== 0) {
          reject(new Error(`thumbnail extract failed: ${err.slice(-200)}`));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });
    const meta = await sharp(jpegBuf).metadata();
    const out = await sharp(jpegBuf)
      .resize({ width: maxWidth, withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer();
    return {
      dataUrl: `data:image/webp;base64,${out.toString('base64')}`,
      width: meta.width ?? 0,
      height: meta.height ?? 0
    };
  }

  // gif / image: take first frame via sharp; do NOT pass animated:true so we get one frame
  const meta = await sharp(inputPath).metadata();
  const buf = await sharp(inputPath)
    .resize({ width: maxWidth, withoutEnlargement: true })
    .webp({ quality: 75 })
    .toBuffer();
  return {
    dataUrl: `data:image/webp;base64,${buf.toString('base64')}`,
    width: meta.width ?? 0,
    height: meta.height ?? 0
  };
}
