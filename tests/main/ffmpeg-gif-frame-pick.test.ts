/**
 * R-GIF-FRAME-PICK regression — animated-GIF frame-range / frame-pick
 * operations (trim, reverse, rotate, crop) MUST rebuild the canvas of
 * every selected frame before writing, otherwise renderers see
 * "transparent black" holes whenever the starting frame is not the
 * GIF's keyframe (frame 0). This regressed in production for the user
 * with an ezgif-optimised input where:
 *   - every non-zero frame was a tiny diff rect with disposal=asis
 *   - each frame carried a local color table
 *   - gifsicle's plain `[input, '#a-b']` selection silently dropped
 *     the cumulative pixel state, leaving frame 0 of the trim output
 *     mostly (R=0,G=0,B=0,A=0) — i.e. transparent black.
 *
 * This suite drives the real toolboxTrim helper against a synthetic
 * disposal=asis fixture and asserts:
 *   1. The output exists and is non-empty.
 *   2. Frame 0 of the trimmed clip has no transparent-alpha samples
 *      (the bug signature).
 * The same path also covers toolboxReverse / toolboxRotate / toolboxCrop
 * since they all funnel through the same gifsicleRebuildFrames helper.
 */
import { describe, expect, it, vi } from 'vitest';
import { promises as fsp, existsSync, mkdtempSync, statSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';

// ffmpeg.ts depends on logger.ts → ipcMain.handle / BrowserWindow which
// only exist inside the Electron host. Stub the surface so the module
// graph loads in node-only test runners.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showMessageBox: vi.fn(() => Promise.resolve({})) }
}));

const { toolboxTrim } = await import('../../src/main/ffmpeg');
// Reuse the production cross-platform binary resolver so the suite
// works on win32 / darwin / linux instead of being silently skipped
// outside Windows. The fixture builder will fall back to the legacy
// vendored path only if the resolver returns empty (e.g. when the
// vendor folder is missing on a CI runner).
const { getGifsiclePath } = await import('../../src/main/binaries');

interface FrameStats {
  blacks: number;
  transp: number;
  bri: number;
  total: number;
}

async function probeFrame(file: string, page: number): Promise<FrameStats> {
  const { data, info } = await sharp(file, { animated: false, page })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  let blacks = 0;
  let transp = 0;
  let bri = 0;
  let total = 0;
  // 5×5 grid of samples, skipping the very edges to avoid
  // legitimate-transparent border pixels in some GIFs.
  for (let yi = 1; yi <= 5; yi++) {
    for (let xi = 1; xi <= 5; xi++) {
      const x = Math.floor((info.width * xi) / 6);
      const y = Math.floor((info.height * yi) / 6);
      const o = (y * info.width + x) * ch;
      const r = data[o];
      const g = data[o + 1];
      const b = data[o + 2];
      const a = ch > 3 ? data[o + 3] : 255;
      bri += (r + g + b) / 3;
      if (r < 20 && g < 20 && b < 20) blacks++;
      if (a < 20) transp++;
      total++;
    }
  }
  return { blacks, transp, bri: bri / total, total };
}

/**
 * Synthesise a "diff-frame" GIF that mimics the ezgif optimisation
 * shape: every frame after #0 is a tiny opaque rect at a non-zero
 * offset, with `disposal=asis` so frame state accumulates. We need
 * gifsicle (already vendored under node_modules/@343dev/gifsicle) to
 * concatenate per-frame inputs because sharp can't emit per-frame
 * disposal flags.
 */
async function buildOptimizedFixture(workDir: string): Promise<string> {
  const W = 200;
  const H = 100;
  const N = 6;
  const frames: string[] = [];
  // Frame 0 — full canvas with a vivid green background.
  const base = Buffer.alloc(W * H * 3);
  for (let p = 0; p < W * H; p++) {
    base[p * 3] = 50;
    base[p * 3 + 1] = 180;
    base[p * 3 + 2] = 70;
  }
  const f0 = path.join(workDir, 'f00.gif');
  await sharp(base, { raw: { width: W, height: H, channels: 3 } })
    .gif()
    .toFile(f0);
  frames.push(f0);
  // Frames 1..N-1 — tiny 30×30 white squares marching across.
  for (let i = 1; i < N; i++) {
    const buf = Buffer.alloc(W * H * 4);
    for (let p = 0; p < W * H; p++) {
      buf[p * 4] = 50;
      buf[p * 4 + 1] = 180;
      buf[p * 4 + 2] = 70;
      buf[p * 4 + 3] = 255;
    }
    const sx = 20 + i * 20;
    for (let yy = 30; yy < 60; yy++) {
      for (let xx = sx; xx < sx + 30 && xx < W; xx++) {
        const o = (yy * W + xx) * 4;
        buf[o] = 240;
        buf[o + 1] = 240;
        buf[o + 2] = 240;
        buf[o + 3] = 255;
      }
    }
    const fn = path.join(workDir, `f${String(i).padStart(2, '0')}.gif`);
    await sharp(buf, { raw: { width: W, height: H, channels: 4 } })
      .gif()
      .toFile(fn);
    frames.push(fn);
  }
  // Concatenate with gifsicle. `--no-loopcount=forever` keeps things
  // simple; `-d 12` sets a uniform 0.12 s delay; `-O3` aggressively
  // diff-encodes which is exactly the pathological case we want.
  const gifsicle = getGifsiclePath();
  const out = path.join(workDir, 'optimized.gif');
  if (!gifsicle || !existsSync(gifsicle)) {
    // The vendor binary isn't present on this runner — surface a clear
    // error so the caller can `it.skipIf(...)` without silently passing.
    throw new Error(
      `platform-specific gifsicle not available at ${gifsicle || '<unresolved>'}`
    );
  }
  const r = spawnSync(
    gifsicle,
    ['-d', '12', '--loopcount=forever', '-O3', ...frames, '-o', out],
    { encoding: 'utf8' }
  );
  if (r.status !== 0) {
    throw new Error(`gifsicle concat failed: ${r.stderr}`);
  }
  return out;
}

describe('R-GIF-FRAME-PICK — toolboxTrim rebuilds frames on optimised inputs', () => {
  // Skip cleanly on runners that do NOT have the vendored gifsicle
  // binary on disk (e.g. fresh CI image without `npm ci`, or a future
  // platform whose `vendor/<platform>/<arch>` layout we haven't shipped
  // yet). We deliberately do NOT skip based on `process.platform`
  // alone — the bug regressed on macOS too, so darwin / linux MUST run
  // the suite as long as the binary is reachable.
  let gifsicleAvailable = false;
  try {
    const p = getGifsiclePath();
    gifsicleAvailable = !!p && existsSync(p);
  } catch {
    gifsicleAvailable = false;
  }
  const tinyFixture = path.resolve(__dirname, '../fixtures/tiny.gif');

  it.skipIf(!gifsicleAvailable)(
    'trims a disposal=asis GIF without producing transparent-black output',
    async () => {
      const workDir = mkdtempSync(path.join(tmpdir(), 'giftk-trim-test-'));
      try {
        const fixture = await buildOptimizedFixture(workDir);
        const out = path.join(workDir, 'trim.gif');
        // Trim away the first 2 frames so the output's frame 0 is the
        // input's frame 2 — exactly the configuration that triggers
        // the transparent-black bug on the legacy code path.
        await toolboxTrim(fixture, out, 0.24, 0.6);
        expect(existsSync(out)).toBe(true);
        expect(statSync(out).size).toBeGreaterThan(0);

        const meta = await sharp(out, { animated: true }).metadata();
        expect(meta.pages ?? 1).toBeGreaterThanOrEqual(1);

        const stats = await probeFrame(out, 0);
        // Original bug: ~17/25 transparent samples, ~17/25 near-black.
        // Fix should bring both to 0.
        expect(stats.transp).toBe(0);
        expect(stats.blacks).toBeLessThan(stats.total / 4);
      } finally {
        await fsp.rm(workDir, { recursive: true, force: true });
      }
    },
    30_000
  );

  it.skipIf(!gifsicleAvailable)(
    'trims tiny.gif (legacy fixture) without breaking the happy path',
    async () => {
      expect(existsSync(tinyFixture)).toBe(true);
      const workDir = mkdtempSync(path.join(tmpdir(), 'giftk-trim-tiny-'));
      try {
        const out = path.join(workDir, 'tiny-trim.gif');
        await toolboxTrim(tinyFixture, out, 0, 0.08);
        expect(existsSync(out)).toBe(true);
        expect(statSync(out).size).toBeGreaterThan(0);
        const stats = await probeFrame(out, 0);
        expect(stats.transp).toBe(0);
      } finally {
        await fsp.rm(workDir, { recursive: true, force: true });
      }
    },
    30_000
  );
});
