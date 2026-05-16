import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { promises as fsp } from 'fs';
import sharp from 'sharp';
import { getFfmpegPath, getFfprobePath, getGifsiclePath, gifsicleSupportsLossy } from './binaries';

export interface ProbeInfo {
  durationSec: number;
  width: number;
  height: number;
  hasVideo: boolean;
  /** Frame rate parsed from `r_frame_rate` (e.g. "30000/1001" → 29.97).
   *  Falls back to `avg_frame_rate`. 0 when unknown. */
  frameRate: number;
  /** Best-effort frame count. Prefers `nb_frames` (animated GIF / mkv with
   *  index), falls back to `durationSec * frameRate`. 0 when unknown. */
  nbFrames: number;
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
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_frames?: string;
}
interface FfprobeFormat {
  duration?: string;
}
interface FfprobeOutput {
  streams: FfprobeStream[];
  format: FfprobeFormat;
}

/** Parse an ffprobe rational string like "30000/1001" into a Number.
 *  Returns 0 for null/empty/malformed/zero-denominator inputs. Exported
 *  for unit testing (see tests/main/ffmpeg-pure.test.ts). */
export function parseRational(s: string | undefined): number {
  if (!s) return 0;
  const [a, b] = s.split('/').map((n) => Number(n));
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return 0;
  return a / b;
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
  // Prefer r_frame_rate (real / container) over avg_frame_rate (which is
  // often a noisy estimate for VFR sources). Fall back to avg if r is 0/0.
  const fps = parseRational(v?.r_frame_rate) || parseRational(v?.avg_frame_rate);
  const nbFromTag = Number(v?.nb_frames ?? 0);
  const nbFrames = Number.isFinite(nbFromTag) && nbFromTag > 0
    ? nbFromTag
    : (dur > 0 && fps > 0 ? Math.round(dur * fps) : 0);
  return {
    durationSec: dur,
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    hasVideo: !!v,
    frameRate: fps,
    nbFrames
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
  const statsMode = p.statsMode ?? 'diff';
  const cropFilter = p.cropRect
    ? `crop=${Math.max(2, Math.round(p.cropRect.w))}:${Math.max(2, Math.round(p.cropRect.h))}:${Math.max(
        0,
        Math.round(p.cropRect.x)
      )}:${Math.max(0, Math.round(p.cropRect.y))}`
    : '';
  const scaleFilter = p.width > 0 ? `scale=${p.width}:-2:flags=lanczos` : '';
  const speed = p.speed && p.speed > 0 && p.speed !== 1 ? p.speed : 1;
  const setptsFilter = speed !== 1 ? `setpts=PTS/${speed}` : '';
  // Common chain (after the input timeline). fps -> crop -> scale puts the
  // expensive lanczos resize on top of an already-decimated frame stream so
  // we never resize frames we throw away. setpts must run BEFORE fps so the
  // 'speed multiplier' applies to the source PTS first; fps then samples
  // the speeded-up timeline at p.fps Hz exactly.
  const baseChain = [setptsFilter, `fps=${p.fps}`, cropFilter, scaleFilter]
    .filter((s) => s.length > 0)
    .join(',');

  // -t at input level cuts SOURCE duration. setpts=PTS/speed compresses output
  // PTS, so output duration = sourceDuration / speed. To make the resulting
  // GIF cover exactly p.durationSec of perceived motion (at speed=N), we read
  // p.durationSec * speed seconds from the source.
  const sourceDuration = String(Math.max(0.05, p.durationSec * speed));
  const httpHeaderArgs = buildHttpInputArgs(p.input, p.headers);

  // O6 (R-24): single-pass split → palettegen → paletteuse. The previous
  // implementation invoked ffmpeg twice (once to write a PNG palette, once
  // to encode the GIF), forcing the source to be demuxed + decoded + scaled
  // twice. With a 'split' filter we feed one decoded stream into two filter
  // branches, cutting the heavy lifting in half. Empirically -25% wall time
  // on a 20s 1080p clip on an M2 Air.
  //
  // O7: feed palettegen a half-rate sample (`fps=p.fps/2`) so the palette
  // generator has half as many frames to histogram. stats_mode=diff already
  // restricts work to motion regions, but halving the sample rate further
  // is essentially free for typical content because palette-relevant colour
  // distributions vary slowly over time. We keep the 'paletteuse' branch
  // at the full target fps so output smoothness is unchanged.
  const paletteFps = Math.max(2, Math.round(p.fps / 2));
  const filterComplex =
    `[0:v]${baseChain},split[full][low];` +
    `[low]fps=${paletteFps},palettegen=stats_mode=${statsMode}[pal];` +
    `[full][pal]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;

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
      '-filter_complex',
      filterComplex,
      p.output
    ],
    { onStderr: (s) => onLog?.(s.trim()), signal }
  );
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
  const args = ['-O3'];
  // Skip --lossy if the resolved binary doesn't understand it (some older
  // imagemin/gifsicle-bin builds < 1.92 reject it with
  // "gifsicle: unrecognized option '--lossy=N'" and the entire optimize
  // step fails — degrading silently to no-lossy is far better than
  // taking the whole compress phase down with us).
  if (safeLossy > 0 && gifsicleSupportsLossy()) {
    args.push(`--lossy=${safeLossy}`);
  }
  args.push('--colors', String(safeColors), input, '-o', output);
  await run(gifsicle, args, { signal });
}

/** Resize an animated GIF (or any image) keeping aspect ratio.
 *
 *  Two-tier strategy:
 *    1. sharp({ animated: true, limitInputPixels: false }) — fast, but
 *       sharp tiles every frame into a single virtual canvas of height
 *       (H * frames). Even with `limitInputPixels: false`, very large /
 *       long animated gifs occasionally still throw "Input image exceeds
 *       pixel limit" on libvips' internal guards.
 *    2. ffmpeg fallback — `ffmpeg -i in.gif -vf "scale=W:-2" out.gif`.
 *       Native GIF demuxer, frame-by-frame, no virtual canvas, no
 *       pixel-limit guard. Slower but always works.
 *
 *  We always try sharp first (faster + better quality on small gifs)
 *  and silently fall back to ffmpeg on ANY sharp error. The caller
 *  doesn't need to know which engine produced the output. */
export async function imageResizeKeepAspect(input: string, output: string, targetWidth: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw makeCancelledError();
  try {
    await sharp(input, { animated: true, limitInputPixels: false })
      .resize({ width: targetWidth, withoutEnlargement: true })
      .gif()
      .toFile(output);
    if (signal?.aborted) throw makeCancelledError();
    return;
  } catch (sharpErr) {
    if (signal?.aborted) throw makeCancelledError();
    // Re-throw cancellation untouched.
    if ((sharpErr as Error)?.name === 'CancelledError') throw sharpErr;
    // Fall through to ffmpeg.
  }

  if (signal?.aborted) throw makeCancelledError();
  // Even width is a hard requirement for many encoders/filters; -2 in
  // height keeps aspect ratio while snapping to an even number.
  const safeW = Math.max(2, Math.floor(targetWidth / 2) * 2);
  await run(
    getFfmpegPath(),
    [
      '-y',
      '-loglevel', 'error',
      '-i', input,
      '-vf', `scale=${safeW}:-2:flags=lanczos`,
      '-loop', '0',
      output
    ],
    { signal }
  );
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

  // gif / image: take first frame via sharp; do NOT pass animated:true so we get one frame.
  // limitInputPixels: false avoids "Input image exceeds pixel limit" on huge gifs/images
  // (sharp's default ~268MP guard trips on large source dimensions even when we only
  // want the first frame for a 256-wide thumbnail).
  const meta = await sharp(inputPath, { limitInputPixels: false }).metadata();
  const buf = await sharp(inputPath, { limitInputPixels: false })
    .resize({ width: maxWidth, withoutEnlargement: true })
    .webp({ quality: 75 })
    .toBuffer();
  return {
    dataUrl: `data:image/webp;base64,${buf.toString('base64')}`,
    width: meta.width ?? 0,
    height: meta.height ?? 0
  };
}
