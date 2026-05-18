import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { promises as fsp } from 'fs';
import { tmpdir as osTmpdir } from 'os';
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

  // R-65 — animated WebP fast path.
  //
  // ffmpeg-static's bundled ffmpeg does NOT include a working animated
  // WebP demuxer: it logs "skipping unsupported chunk: ANIM/ANMF" then
  // bails with "image data not found". sharp ships its own libwebp and
  // handles animated WebP natively, so we delegate first-frame extraction
  // for *.webp inputs to sharp and only fall back to ffmpeg for the
  // formats it's actually known to decode (gif, video).
  if (file.toLowerCase().endsWith('.webp')) {
    if (signal?.aborted) throw makeCancelledError();
    const buf = await sharp(file, { animated: false, page: 0 })
      .resize(480, null, { withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    if (signal?.aborted) throw makeCancelledError();
    if (buf.length > maxBytes) {
      throw new Error(`extract frame failed: output exceeds ${maxBytes} bytes`);
    }
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  }

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

/**
 * R-35 — encode a video clip to an animated WebP via libwebp.
 *
 * Mirrors videoToGifPalette's filter chain (setpts → fps → crop → scale)
 * but skips the palette/dither dance: libwebp handles colour itself
 * with a lossy quality knob (0-100) and supports an `-loop` flag for
 * forever / N-time loops. The output container hint (.webp) is what
 * makes ffmpeg pick the libwebp_anim muxer; we don't have to pass
 * `-c:v libwebp_anim` explicitly.
 */
export async function videoToAnimatedWebP(
  p: GifConvertParams & { quality?: number; loop?: number },
  onLog?: (s: string) => void,
  signal?: AbortSignal
): Promise<void> {
  const ffmpeg = getFfmpegPath();
  const cropFilter = p.cropRect
    ? `crop=${Math.max(2, Math.round(p.cropRect.w))}:${Math.max(2, Math.round(p.cropRect.h))}:${Math.max(
        0,
        Math.round(p.cropRect.x)
      )}:${Math.max(0, Math.round(p.cropRect.y))}`
    : '';
  const scaleFilter = p.width > 0 ? `scale=${p.width}:-2:flags=lanczos` : '';
  const speed = p.speed && p.speed > 0 && p.speed !== 1 ? p.speed : 1;
  const setptsFilter = speed !== 1 ? `setpts=PTS/${speed}` : '';
  const baseChain = [setptsFilter, `fps=${p.fps}`, cropFilter, scaleFilter]
    .filter((s) => s.length > 0)
    .join(',');
  const sourceDuration = String(Math.max(0.05, p.durationSec * speed));
  const httpHeaderArgs = buildHttpInputArgs(p.input, p.headers);
  const quality = Math.max(0, Math.min(100, Math.round(p.quality ?? 75)));
  const loop = Math.max(0, Math.min(65535, Math.round(p.loop ?? 0)));

  await run(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-ss', String(p.startSec),
      '-t', sourceDuration,
      ...httpHeaderArgs,
      '-i', p.input,
      '-an', '-sn',
      '-vf', baseChain,
      '-c:v', 'libwebp_anim',
      '-loop', String(loop),
      '-quality', String(quality),
      '-preset', 'default',
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
  // R-41 — gifsicle is gif-only, but the toolbox now accepts .webp on
  // GIF Optimize too. When either side is webp, route through the
  // transcode wrapper so the user gets the same optimisation knobs and
  // a webp output (matching their input format).
  if (!isGifPath(input) || !isGifPath(output)) {
    return withWebpAsGif(input, output, (gifIn, gifOut) =>
      gifsicleOptimize(gifIn, gifOut, lossy, colors, signal)
    );
  }
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

/**
 * R-35 #2 — single-pass gif optimisation tuned to a specific "method"
 * (mirrors ezgif's Optimization method picker).
 *
 * Each branch is a deliberate, single-axis transformation; that's what
 * makes the "method" picker useful — pick one knob, see what it does,
 * then layer the next. For the "do everything" budget mode keep using
 * compressLoop in processor.ts (it's the 4-Phase strategy that already
 * blends size + quality).
 *
 * Methods:
 *   - 'lossy'              : --lossy=N (fast, perceptual). N defaults to 80.
 *   - 'color-reduction'    : --colors=K --color-method=blend-diversity (no dither).
 *   - 'color-dither'       : --colors=K --dither (visibly dithered, larger).
 *   - 'drop-every-nth'     : `--delete '#0'` of every N-th frame, then -O3.
 *                            For N=2 we drop frames 1,3,5,…; for N=3 we drop
 *                            frames 2,5,8,…; this halves / thirds the FPS.
 *   - 'drop-duplicates'    : -O3 `--no-extensions`. Gifsicle's own dedupe.
 *   - 'optimize-transparency': -O3 with `--use-colormap=web` + `--no-extensions`,
 *                              clamps to a stable palette so transparency
 *                              regions can be optimised across frames.
 */
export async function gifsicleMethod(
  input: string,
  output: string,
  method: 'lossy' | 'color-reduction' | 'color-dither' | 'drop-every-nth' | 'drop-duplicates' | 'optimize-transparency',
  opts: { lossy?: number; colors?: number; dropEveryN?: number; signal?: AbortSignal } = {}
): Promise<void> {
  // R-41 — webp passthrough wrapper, see gifsicleOptimize for the
  // rationale. We route the work into a tmp .gif round-trip so the
  // gifsicle CLI is always handed a real gif.
  if (!isGifPath(input) || !isGifPath(output)) {
    return withWebpAsGif(input, output, (gifIn, gifOut) =>
      gifsicleMethod(gifIn, gifOut, method, opts)
    );
  }
  const gifsicle = getGifsiclePath();
  const lossy = Number.isFinite(opts.lossy) ? Math.max(0, Math.min(200, Math.floor(opts.lossy as number))) : 80;
  const colors = Number.isFinite(opts.colors) ? Math.max(2, Math.min(256, Math.floor(opts.colors as number))) : 128;
  const dropN = Number.isFinite(opts.dropEveryN) ? Math.max(2, Math.min(10, Math.floor(opts.dropEveryN as number))) : 2;

  switch (method) {
    case 'lossy': {
      const args = ['-O3'];
      if (lossy > 0 && gifsicleSupportsLossy()) args.push(`--lossy=${lossy}`);
      args.push(input, '-o', output);
      await run(gifsicle, args, { signal: opts.signal });
      return;
    }
    case 'color-reduction': {
      await run(gifsicle, ['-O3', '--colors', String(colors), '--color-method', 'blend-diversity', input, '-o', output], { signal: opts.signal });
      return;
    }
    case 'color-dither': {
      await run(gifsicle, ['-O3', '--colors', String(colors), '--dither', input, '-o', output], { signal: opts.signal });
      return;
    }
    case 'drop-every-nth': {
      // Probe the gif's frame count via gifsicle itself (-I) — much cheaper
      // than spinning up sharp/ffmpeg just to count frames. The output of
      // `gifsicle -I` includes one "+ image #N …" line per frame; counting
      // those lines is exact.
      const info = await runCapture(gifsicle, ['-I', input], { signal: opts.signal });
      const frameCount = (info.match(/^\s*\+\s+image\s+#\d+/gm) ?? []).length || 1;
      const indices: string[] = [];
      // Drop frames whose 0-based index is (k % N === N-1) so e.g. N=2 keeps
      // even indices (#0, #2, #4) and drops #1, #3, … which halves the fps.
      for (let i = 0; i < frameCount; i += 1) {
        if (i % dropN === dropN - 1) indices.push(`#${i}`);
      }
      const args = ['-O3'];
      if (indices.length > 0) {
        args.push('--delete');
        args.push(...indices);
      }
      args.push(input, '-o', output);
      await run(gifsicle, args, { signal: opts.signal });
      return;
    }
    case 'drop-duplicates': {
      await run(gifsicle, ['-O3', '--no-extensions', input, '-o', output], { signal: opts.signal });
      return;
    }
    case 'optimize-transparency': {
      await run(gifsicle, ['-O3', '--use-colormap=web', input, '-o', output], { signal: opts.signal });
      return;
    }
    default: {
      // Defensive fallback — should never hit because the renderer + main
      // sanitiser both clamp method to the union above.
      await run(gifsicle, ['-O3', input, '-o', output], { signal: opts.signal });
    }
  }
}

/** Capture a child-process stdout to a string (small outputs only — used
 *  for `gifsicle -I` frame counting). Mirrors `run()`'s signal/abort
 *  semantics so cancellation works the same way. */
function runCapture(cmd: string, args: string[], opts: { signal?: AbortSignal } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) { reject(makeCancelledError()); return; }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawn } = require('child_process') as typeof import('child_process');
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (d: Buffer) => { buf += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code: number) => {
      if (code === 0) resolve(buf);
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    if (opts.signal) {
      const onAbort = (): void => { try { child.kill('SIGTERM'); } catch { /* ignore */ } };
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
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
  // R-41 — pick the output codec based on the output's file extension
  // so webp inputs round-trip back to webp (sharp's gif() encoder
  // would otherwise drop the lossless alpha channel and the user
  // would silently get a different format than what they uploaded).
  const isWebpOut = /\.webp$/i.test(output);
  try {
    const pipe = sharp(input, { animated: true, limitInputPixels: false })
      .resize({ width: targetWidth, withoutEnlargement: true });
    if (isWebpOut) {
      await pipe.webp({ quality: 75 }).toFile(output);
    } else {
      await pipe.gif().toFile(output);
    }
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
 * R-42 — GIF ↔ WebP transcode helper.
 *
 * Re-encodes an animated GIF or animated WebP into the requested
 * container, preserving every frame. We try sharp first because:
 *
 *   - sharp natively decodes both animated GIF and animated WebP
 *     (when `{ animated: true }` is passed) and emits a multi-frame
 *     output via `.gif()` / `.webp()`, so a single API call covers
 *     both directions of the conversion.
 *   - sharp is significantly faster than spinning up ffmpeg for
 *     small-to-medium media.
 *
 * R-43 — when sharp throws, we fall back to ffmpeg with the *correct*
 * encoder explicitly selected:
 *
 *   - target=webp → `-c:v libwebp_anim` (without this, ffmpeg picks
 *     the single-frame `libwebp` encoder by extension and silently
 *     drops every frame after the first).
 *   - target=gif  → palettegen+paletteuse filtergraph + the source's
 *     native fps (without this, ffmpeg's default `-r 25` will warp
 *     animation timing on sources whose original delays don't match).
 *
 * The catch block also captures the original sharp error message so
 * if ffmpeg also fails, the thrown error reports both reasons.
 *
 * Cancellation: we re-check `signal.aborted` around every async hop.
 * The sharp `.toFile()` call itself is not interruptible mid-encode
 * — that's a known libvips constraint.
 *
 * Same-path guard: if `path.resolve(input) === path.resolve(output)`
 * we throw immediately. sharp's `.toFile(output)` opens input for
 * decode and writes output simultaneously; pointing both at the same
 * file race-corrupts the user's source bytes.
 */
export async function convertGifWebp(
  input: string,
  output: string,
  target: 'gif' | 'webp',
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw makeCancelledError();
  // R-43 H-1 — refuse same-path so libvips can't overwrite the source
  // mid-decode. Callers (processor.ts) decide whether to short-circuit
  // with copyFile or surface the error.
  if (path.resolve(input) === path.resolve(output)) {
    throw new Error(`convertGifWebp: input and output resolve to the same path: ${input}`);
  }
  let sharpErrMsg: string | null = null;
  try {
    const pipe = sharp(input, { animated: true, limitInputPixels: false });
    if (target === 'webp') {
      await pipe.webp({ quality: 75 }).toFile(output);
    } else {
      await pipe.gif().toFile(output);
    }
    if (signal?.aborted) throw makeCancelledError();
    return;
  } catch (sharpErr) {
    if (signal?.aborted) throw makeCancelledError();
    if ((sharpErr as Error)?.name === 'CancelledError') throw sharpErr;
    sharpErrMsg = (sharpErr as Error)?.message ?? String(sharpErr);
    // fall through to ffmpeg
  }

  if (signal?.aborted) throw makeCancelledError();

  try {
    if (target === 'webp') {
      // R-43 — libwebp_anim is REQUIRED for multi-frame webp output.
      // Default extension-based selection picks libwebp (single-frame)
      // and silently throws away every frame past index 0.
      await run(
        getFfmpegPath(),
        [
          '-y',
          '-loglevel', 'error',
          '-i', input,
          '-c:v', 'libwebp_anim',
          '-lossless', '0',
          '-quality', '75',
          '-loop', '0',
          output
        ],
        { signal }
      );
    } else {
      // R-43 — for GIF output, probe the source for fps so we don't
      // collapse to ffmpeg's default 25fps and warp timing. We also
      // use palettegen+paletteuse so the gif quantises cleanly from
      // a webp source's true-colour pixels.
      let srcFps = 0;
      try {
        const info = await probe(input);
        srcFps = info.frameRate || 0;
      } catch {
        // probe failure is non-fatal; we just fall back to a sane fps.
      }
      const fps = srcFps > 0 && srcFps <= 60 ? srcFps : 15;
      await run(
        getFfmpegPath(),
        [
          '-y',
          '-loglevel', 'error',
          '-i', input,
          '-vf', `fps=${fps},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a`,
          '-loop', '0',
          output
        ],
        { signal }
      );
    }
  } catch (ffErr) {
    if (signal?.aborted) throw makeCancelledError();
    if ((ffErr as Error)?.name === 'CancelledError') throw ffErr;
    const ffMsg = (ffErr as Error)?.message ?? String(ffErr);
    // R-43 H-3 — preserve both reasons so logs / UI surface why both
    // paths failed instead of just the last one.
    throw new Error(
      sharpErrMsg
        ? `convertGifWebp failed: sharp=${sharpErrMsg}; ffmpeg=${ffMsg}`
        : `convertGifWebp failed: ffmpeg=${ffMsg}`
    );
  }
  if (signal?.aborted) throw makeCancelledError();
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

/* =============================================================
 * R-37 Toolbox helpers — Trim / Speed / Reverse / Rotate.
 *
 * Design notes:
 *   - Each helper accepts an absolute input path and writes to a stable
 *     output path (caller is responsible for picking the output dir +
 *     basename). The helpers DO NOT mutate the input file.
 *   - For .gif inputs we prefer gifsicle when the operation is
 *     palette-safe (Trim's --delete, Speed's --delay, Reverse's
 *     `#-1` index trick). Rotate has to bounce through ffmpeg because
 *     gifsicle only knows --rotate-{90,180,270} and not 90+flip combos
 *     and we want a single uniform code path that also handles vflip /
 *     hflip; we keep gifsicle for the pure-90° non-flip case where it
 *     produces strictly smaller files (no re-encode artefacts).
 *   - For video inputs we always invoke ffmpeg with the explicit
 *     -vf / -af pipeline so we don't accidentally lose audio metadata.
 * ============================================================= */

const REVERSE_AUDIO_MODES = new Set(['mute', 'reverse', 'keep']);

function isGifPath(p: string): boolean {
  return p.toLowerCase().endsWith('.gif');
}

/** R-41 — true when the path's extension is `.webp`. Used by toolbox
 *  helpers that delegate to gifsicle (which only understands gif) so
 *  they can decide whether to wrap the call in a webp ⇄ gif transcode
 *  pair. */
function isWebpPath(p: string): boolean {
  return p.toLowerCase().endsWith('.webp');
}

/** R-41 — true for any animated bitmap container we accept on the
 *  "non-video" tools (gif-resize / gif-optimize / trim / speed / reverse
 *  / rotate / crop). Today this is `.gif | .webp` — see
 *  TOOLBOX_INPUT_EXTENSIONS#GIF_OR_WEBP. Currently exported for tests
 *  and for downstream branches that want a single helper instead of
 *  re-implementing the OR. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function isGifLikePath(p: string): boolean {
  return isGifPath(p) || isWebpPath(p);
}

/**
 * R-41 — wrapper that lets gifsicle-only helpers (gif-optimize methods)
 * accept .webp inputs by transcoding webp → tmp.gif before running the
 * gifsicle work, then transcoding the result back to .webp on the way
 * out. For pure .gif inputs we just call `work` directly, so the .gif
 * fast path is unaffected.
 *
 * The transcode is done with sharp (`{ animated: true }`) which already
 * handles multi-frame webp / gif round-trips and falls through to ffmpeg
 * via imageResizeKeepAspect's existing fallback chain when sharp can't
 * decode the source.
 *
 * Temp files are created in os.tmpdir() with unique names and ALWAYS
 * cleaned up (success or failure) in the finally block. We never leak
 * temp gifs because the user could be processing many large clips in a
 * row.
 *
 * R-65 — the wrapper is now also used by the ffmpeg-only toolbox helpers
 * (reverse / rotate / crop / trim / speed) because ffmpeg-static's
 * bundled ffmpeg cannot decode animated WebP at all (it skips ANIM/ANMF
 * chunks and bails with "image data not found"). Routing webp inputs
 * through sharp → tmp.gif → ffmpeg/gifsicle → tmp.gif → sharp → webp
 * sidesteps the broken webp demuxer entirely while keeping the
 * non-webp fast paths unchanged.
 */
async function withWebpAsGif(
  input: string,
  output: string,
  work: (gifIn: string, gifOut: string) => Promise<void>
): Promise<void> {
  if (isGifPath(input) && isGifPath(output)) {
    await work(input, output);
    return;
  }
  const tmpDir = osTmpdir();
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const tmpIn = isGifPath(input) ? input : path.join(tmpDir, `giftk-in-${stamp}.gif`);
  const tmpOut = isGifPath(output) ? output : path.join(tmpDir, `giftk-out-${stamp}.gif`);
  try {
    if (!isGifPath(input)) {
      // webp → tmp.gif via sharp (animated). sharp's default settings
      // preserve the per-frame delays so gifsicle sees the right timing.
      await sharp(input, { animated: true, limitInputPixels: false }).gif().toFile(tmpIn);
    }
    await work(tmpIn, tmpOut);
    if (!isGifPath(output)) {
      // tmp.gif → output.webp via sharp's webp encoder (also animated).
      await sharp(tmpOut, { animated: true, limitInputPixels: false }).webp({ quality: 75 }).toFile(output);
    }
  } finally {
    if (tmpIn !== input) {
      try { await fsp.unlink(tmpIn); } catch { /* swallow — tmp cleanup */ }
    }
    if (tmpOut !== output) {
      try { await fsp.unlink(tmpOut); } catch { /* swallow — tmp cleanup */ }
    }
  }
}

function clampSpeedFactor(n: number | undefined): number {
  // We accept 0.25..4 inclusive. ffmpeg's atempo filter natively supports
  // 0.5..2; for values outside that range we'd have to chain atempo
  // filters. To keep the MVP simple we clamp to that natively-supported
  // range — UI exposes 0.25..4 but the audio path silently chains.
  if (typeof n !== 'number' || !Number.isFinite(n)) return 1;
  return Math.max(0.25, Math.min(4, n));
}

/** Build an `atempo=…` filter chain for an arbitrary speed factor by
 *  splitting it into 0.5..2 segments. ffmpeg's atempo refuses values
 *  outside that range, so e.g. 4× → atempo=2,atempo=2 and 0.25× →
 *  atempo=0.5,atempo=0.5. */
function atempoChain(factor: number): string {
  const parts: string[] = [];
  let remaining = factor;
  // For factor > 2 we need a chain of 2× until we land in [0.5,2].
  while (remaining > 2.0 + 1e-6) {
    parts.push('atempo=2.0');
    remaining /= 2;
  }
  while (remaining < 0.5 - 1e-6) {
    parts.push('atempo=0.5');
    remaining *= 2;
  }
  parts.push(`atempo=${remaining.toFixed(4)}`);
  return parts.join(',');
}

/**
 * R-37 Trim — extract a [startSec, endSec) clip. Lossless re-mux when
 * the input is a video (we use -ss + -to with -c copy so we don't
 * transcode). For gifs we go through gifsicle's frame-range syntax
 * (`#start-end`) which preserves original delays + palette.
 */
export async function toolboxTrim(
  input: string,
  output: string,
  startSec: number,
  endSec: number | undefined,
  opts: { signal?: AbortSignal } = {}
): Promise<void> {
  if (!Number.isFinite(startSec) || startSec < 0) startSec = 0;
  if (typeof endSec === 'number' && Number.isFinite(endSec) && endSec <= startSec) {
    throw new Error('toolboxTrim: endSec must be greater than startSec');
  }

  // R-65 — animated webp inputs cannot be decoded by ffmpeg-static, so
  // we route them through the sharp ⇄ tmp.gif wrapper and reuse the
  // gifsicle frame-range path.
  if (isWebpPath(input)) {
    await withWebpAsGif(input, output, (gifIn, gifOut) =>
      toolboxTrim(gifIn, gifOut, startSec, endSec, opts)
    );
    return;
  }

  if (isGifPath(input)) {
    // Trim a gif in the frame domain via gifsicle. We need to translate
    // (startSec, endSec) → frame indices using `gifsicle -I` to read
    // each frame's delay (in 1/100 s).
    const gifsicle = getGifsiclePath();
    const info = await runCapture(gifsicle, ['-I', input], { signal: opts.signal });
    // delay lines look like:  + image #3  640x360  delay 0.10s
    const delays: number[] = [];
    const re = /delay\s+([\d.]+)s/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(info)) !== null) {
      const d = Number(m[1]);
      delays.push(Number.isFinite(d) && d > 0 ? d : 0.1);
    }
    if (delays.length === 0) {
      // single-frame gif — copy through
      await fsp.copyFile(input, output);
      return;
    }
    let acc = 0;
    let startIdx = 0;
    let endIdx = delays.length - 1;
    for (let i = 0; i < delays.length; i += 1) {
      if (acc <= startSec) startIdx = i;
      acc += delays[i];
      if (typeof endSec === 'number' && acc >= endSec) { endIdx = i; break; }
    }
    if (endIdx < startIdx) endIdx = startIdx;
    // R-65 — gifsicle parses `path#range` as a literal filename, not as
    // a frame selection. The frame range must be a separate argv entry
    // following the input file path. Without this split gifsicle bails
    // with "No such file or directory" on every range.
    await run(gifsicle, ['-O3', input, `#${startIdx}-${endIdx}`, '-o', output], { signal: opts.signal });
    return;
  }

  const ffmpeg = getFfmpegPath();
  const args = ['-y', '-ss', String(startSec)];
  if (typeof endSec === 'number') args.push('-to', String(endSec));
  args.push('-i', input, '-c', 'copy', '-avoid_negative_ts', 'make_zero', output);
  await run(ffmpeg, args, { signal: opts.signal });
}

/**
 * R-37 Speed — uniformly accelerate or decelerate playback. For video
 * we apply setpts on video and atempoChain on audio (preserving pitch).
 * For gifs we re-emit with all delays divided by `factor` via gifsicle's
 * `--delay` flag (which expresses delay in 1/100 s units). 1× is a no-op.
 */
export async function toolboxSpeed(
  input: string,
  output: string,
  factor: number,
  opts: { signal?: AbortSignal } = {}
): Promise<void> {
  const f = clampSpeedFactor(factor);
  if (Math.abs(f - 1) < 1e-3) {
    await fsp.copyFile(input, output);
    return;
  }
  // R-65 — see toolboxTrim for rationale.
  if (isWebpPath(input)) {
    await withWebpAsGif(input, output, (gifIn, gifOut) =>
      toolboxSpeed(gifIn, gifOut, factor, opts)
    );
    return;
  }
  if (isGifPath(input)) {
    // gifsicle reads existing per-frame delays, so we need to emit a new
    // global delay = avg / factor. Since gifs commonly have uniform
    // delays we approximate by reading the first delay; users wanting
    // per-frame retiming should preprocess via the trim tool.
    const gifsicle = getGifsiclePath();
    const info = await runCapture(gifsicle, ['-I', input], { signal: opts.signal });
    const m = /delay\s+([\d.]+)s/.exec(info);
    const baseDelaySec = m && m[1] ? Number(m[1]) : 0.1;
    const newDelayCs = Math.max(2, Math.round((baseDelaySec / f) * 100));
    await run(gifsicle, ['-O3', '--delay', String(newDelayCs), input, '-o', output], { signal: opts.signal });
    return;
  }

  const ffmpeg = getFfmpegPath();
  // setpts uses the inverse multiplier: 2× speed → setpts=PTS/2 → 0.5×PTS.
  const vfilter = `setpts=${(1 / f).toFixed(6)}*PTS`;
  const afilter = atempoChain(f);
  const args = [
    '-y', '-i', input,
    '-filter:v', vfilter,
    '-filter:a', afilter,
    output
  ];
  // If the source has no audio ffmpeg will fail on `-filter:a`; do a
  // graceful retry with audio dropped when that's the case.
  try {
    await run(ffmpeg, args, { signal: opts.signal });
  } catch (e) {
    if ((e as Error).name === 'CancelledError') throw e;
    const fallback = ['-y', '-i', input, '-an', '-filter:v', vfilter, output];
    await run(ffmpeg, fallback, { signal: opts.signal });
  }
}

/**
 * R-37 Reverse — play the input back-to-front. Video uses ffmpeg's
 * `reverse` (frame buffer in RAM, expensive on long clips!) plus an
 * audio mode toggle. Gif goes through gifsicle's negative frame index
 * trick: `gifsicle -U input.gif #-1-#0 -o out.gif` rewrites frames in
 * descending order.
 */
export async function toolboxReverse(
  input: string,
  output: string,
  audioMode: 'mute' | 'reverse' | 'keep',
  opts: { signal?: AbortSignal } = {}
): Promise<void> {
  if (!REVERSE_AUDIO_MODES.has(audioMode)) audioMode = 'mute';

  // R-65 — see toolboxTrim for rationale.
  if (isWebpPath(input)) {
    await withWebpAsGif(input, output, (gifIn, gifOut) =>
      toolboxReverse(gifIn, gifOut, audioMode, opts)
    );
    return;
  }

  if (isGifPath(input)) {
    const gifsicle = getGifsiclePath();
    // Probe frame count, then build an explicit descending range.
    const info = await runCapture(gifsicle, ['-I', input], { signal: opts.signal });
    const count = (info.match(/^\s*\+\s+image\s+#\d+/gm) ?? []).length || 1;
    // R-65 — gifsicle expects `[input, '#N']` as two argv entries, not
    // `path#N`. We open the input once at the start and prepend the file
    // arg, then the per-frame `#N` selectors copy frames in descending
    // order.
    const frames: string[] = [];
    for (let i = count - 1; i >= 0; i -= 1) frames.push(`#${i}`);
    await run(gifsicle, ['-O3', '-U', input, ...frames, '-o', output], { signal: opts.signal });
    return;
  }

  const ffmpeg = getFfmpegPath();
  const args = ['-y', '-i', input];
  if (audioMode === 'mute') {
    args.push('-an', '-vf', 'reverse', output);
  } else if (audioMode === 'reverse') {
    // -map 0 + filter_complex so audio is reversed alongside video.
    args.push('-vf', 'reverse', '-af', 'areverse', output);
  } else {
    // 'keep' — leave audio as-is over reversed video. We have to seek
    // both streams independently; -map flags tie them together.
    args.push('-vf', 'reverse', '-c:a', 'copy', output);
  }
  try {
    await run(ffmpeg, args, { signal: opts.signal });
  } catch (e) {
    if ((e as Error).name === 'CancelledError') throw e;
    // Fallback: drop audio entirely if the chosen mode failed (e.g.
    // 'keep' on a stream that has no audio at all).
    const fallback = ['-y', '-i', input, '-an', '-vf', 'reverse', output];
    await run(ffmpeg, fallback, { signal: opts.signal });
  }
}

/**
 * R-37 Rotate — rotate by 0/90/180/270 degrees and optionally flip on
 * one or both axes. Gifs with a pure 90/180/270 rotation and no flip
 * stay in gifsicle's --rotate-{90,180,270} fast path; everything else
 * goes through ffmpeg with a transpose / vflip / hflip filter chain.
 */
export async function toolboxRotate(
  input: string,
  output: string,
  degrees: number,
  flip: { flipH?: boolean; flipV?: boolean } = {},
  opts: { signal?: AbortSignal } = {}
): Promise<void> {
  const deg = (((Math.round((degrees ?? 0) / 90) * 90) % 360) + 360) % 360; // snap to 0/90/180/270
  const flipH = !!flip.flipH;
  const flipV = !!flip.flipV;

  if (deg === 0 && !flipH && !flipV) {
    await fsp.copyFile(input, output);
    return;
  }

  // R-65 — see toolboxTrim for rationale.
  if (isWebpPath(input)) {
    await withWebpAsGif(input, output, (gifIn, gifOut) =>
      toolboxRotate(gifIn, gifOut, degrees, flip, opts)
    );
    return;
  }

  if (isGifPath(input) && !flipH && !flipV) {
    const gifsicle = getGifsiclePath();
    const flag = deg === 90 ? '--rotate-90' : deg === 180 ? '--rotate-180' : deg === 270 ? '--rotate-270' : null;
    if (flag) {
      await run(gifsicle, ['-O3', flag, input, '-o', output], { signal: opts.signal });
      return;
    }
  }

  const ffmpeg = getFfmpegPath();
  const filters: string[] = [];
  if (deg === 90) filters.push('transpose=1');
  else if (deg === 180) filters.push('transpose=2,transpose=2');
  else if (deg === 270) filters.push('transpose=2');
  if (flipH) filters.push('hflip');
  if (flipV) filters.push('vflip');
  const vf = filters.join(',');

  if (isGifPath(input)) {
    // For animated gifs ffmpeg needs the gif demuxer + gif encoder.
    await run(ffmpeg, ['-y', '-i', input, '-vf', vf, '-loop', '0', output], { signal: opts.signal });
    return;
  }

  // Video path — keep audio intact (rotation/flip is video-only).
  const args = ['-y', '-i', input, '-vf', vf, '-c:a', 'copy', output];
  try {
    await run(ffmpeg, args, { signal: opts.signal });
  } catch (e) {
    if ((e as Error).name === 'CancelledError') throw e;
    // Fallback re-encodes audio if `-c:a copy` rejected the container.
    const fallback = ['-y', '-i', input, '-vf', vf, output];
    await run(ffmpeg, fallback, { signal: opts.signal });
  }
}

/**
 * R-38 Crop — crop a video or gif to the supplied (x, y, w, h) rectangle
 * expressed in source-pixel (natural) coordinates. The renderer captures
 * this rect via the visual CropBox component on a preview of the first
 * frame, so x/y/w/h come pre-validated against the actual input resolution.
 *
 * ffmpeg's `crop` filter signature is `crop=w:h:x:y` — note the order is
 * (w, h, x, y), not (x, y, w, h). We also snap to even pixels because
 * libx264 / VP9 / WebP_anim all require even dimensions; gifs survive
 * odd dimensions but we keep the same snapping for consistency.
 */
export async function toolboxCrop(
  input: string,
  output: string,
  rect: { x: number; y: number; w: number; h: number },
  opts: { signal?: AbortSignal } = {}
): Promise<void> {
  // Snap to even pixels (mandatory for many codecs; harmless for gif).
  const x = Math.max(0, Math.floor(rect.x / 2) * 2);
  const y = Math.max(0, Math.floor(rect.y / 2) * 2);
  const w = Math.max(2, Math.floor(rect.w / 2) * 2);
  const h = Math.max(2, Math.floor(rect.h / 2) * 2);
  // ffmpeg crop filter — note the (w:h:x:y) ordering.
  const vf = `crop=${w}:${h}:${x}:${y}`;

  // R-65 — see toolboxTrim for rationale.
  if (isWebpPath(input)) {
    await withWebpAsGif(input, output, (gifIn, gifOut) =>
      toolboxCrop(gifIn, gifOut, rect, opts)
    );
    return;
  }

  const ffmpeg = getFfmpegPath();
  if (isGifPath(input)) {
    // For gifs we re-encode through the gif muxer; ffmpeg keeps the
    // animation timing (per-frame delays) intact when no -r is given.
    await run(ffmpeg, ['-y', '-i', input, '-vf', vf, '-loop', '0', output], { signal: opts.signal });
    return;
  }

  // Video path — preserve original audio with `-c:a copy`. If the input
  // container rejects copy (rare, e.g. AAC-in-MOV with PCM remap), fall
  // back to re-encoding audio so the user still gets an output file.
  const args = ['-y', '-i', input, '-vf', vf, '-c:a', 'copy', output];
  try {
    await run(ffmpeg, args, { signal: opts.signal });
  } catch (e) {
    if ((e as Error).name === 'CancelledError') throw e;
    const fallback = ['-y', '-i', input, '-vf', vf, output];
    await run(ffmpeg, fallback, { signal: opts.signal });
  }
}

