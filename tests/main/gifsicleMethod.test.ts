/**
 * Unit tests for `gifsicleMethod` argv composition (P0-5 / R-81).
 *
 * The method picker used to hard-code `-O3 --dither=floyd-steinberg`; the
 * fixes under audit forward the renderer's `optimizeLevel` / `dither`
 * choices into the gifsicle argv. We exercise that wiring by:
 *
 *   1. Mocking `child_process.spawn` so no real gifsicle process is
 *      launched. The mock returns a synthetic ChildProcess-like object
 *      that fires `close` with exit-code 0 on next tick, mirroring the
 *      happy path of the real binary.
 *   2. Mocking `./binaries` so `getGifsiclePath()` returns a deterministic
 *      string and `gifsicleSupportsLossy()` returns true (we want the
 *      `--lossy=N` arg to be appended so the picker code path is
 *      identical to a packaged build).
 *   3. Capturing every call to spawn and asserting on the args array.
 *
 * We do NOT touch the underlying source — only the test file is new.
 */
import { EventEmitter } from 'events';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Capture every spawn invocation so individual tests can inspect args.
const spawnCalls: Array<{ cmd: string; args: string[] }> = [];

function makeFakeChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void } {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => undefined;
  // Resolve on next tick so the await in run() actually awaits.
  setImmediate(() => child.emit('close', 0, null));
  return child;
}

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn((cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args: args.slice() });
      return makeFakeChild() as unknown as ReturnType<typeof actual.spawn>;
    })
  };
});

// `./binaries` reaches into electron / app paths under load. Stub it
// entirely so the test stays node-only.
vi.mock('../../src/main/binaries', () => ({
  getGifsiclePath: () => '/fake/gifsicle',
  gifsicleSupportsLossy: () => true,
  getFfmpegPath: () => '/fake/ffmpeg',
  getFfprobePath: () => '/fake/ffprobe',
  getGifskiPath: () => null
}));

// Stub electron — ffmpeg.ts imports it transitively via logger.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
}));

const { gifsicleMethod } = await import('../../src/main/ffmpeg');

describe('gifsicleMethod — optimizeLevel / dither argv plumbing (P0-5, R-81)', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
  });

  it("(C-03) default 'color-reduction' is hard-coded no-dither: emits --no-dither, no --dither=*", async () => {
    // C-03 fix — 'color-reduction' is the explicit "no dither" partner of
    // 'color-dither'. Pre-fix, default opts (dither='floyd-steinberg')
    // silently injected --dither=floyd-steinberg here too, collapsing
    // both pickers into the same argv. New invariant: color-reduction
    // ALWAYS gets --no-dither and never --dither=*.
    await gifsicleMethod('/in.gif', '/out.gif', 'color-reduction', {
      colors: 128
    });
    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0]!.args;
    expect(args).toContain('-O3');
    expect(args).toContain('--no-dither');
    expect(args.some((a) => a.startsWith('--dither='))).toBe(false);
  });

  it("(C-03) 'color-reduction' is no-dither even when opts.dither='ordered' (picker contract beats opts)", async () => {
    // The picker is the contract — 'color-reduction' means "no dither".
    // If the caller wanted dither, they should pick 'color-dither'.
    await gifsicleMethod('/in.gif', '/out.gif', 'color-reduction', {
      colors: 64,
      dither: 'ordered'
    });
    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0]!.args;
    expect(args).toContain('--no-dither');
    expect(args.some((a) => a.startsWith('--dither='))).toBe(false);
  });

  it("(C-03) 'color-dither' still honours --dither=ordered when requested", async () => {
    // The A/B partner remains the dither-on branch. This pins the
    // post-C-03 invariant that the two pickers are now distinguishable.
    await gifsicleMethod('/in.gif', '/out.gif', 'color-dither', {
      colors: 64,
      dither: 'ordered'
    });
    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0]!.args;
    expect(args).toContain('--dither=ordered');
  });

  it("(C-03) 'color-dither' defaults to floyd-steinberg when dither opt is unset/'none'", async () => {
    // 'color-dither' is the explicit "I want dithering" picker; calling
    // it with dither='none' is contradictory, so the picker treats that
    // as "use the sensible default" — floyd-steinberg.
    await gifsicleMethod('/in.gif', '/out.gif', 'color-dither', {
      colors: 64,
      dither: 'none'
    });
    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0]!.args;
    expect(args).toContain('--dither=floyd-steinberg');
  });

  it('optimizeLevel=1 emits -O1 (not -O3)', async () => {
    await gifsicleMethod('/in.gif', '/out.gif', 'lossy', {
      lossy: 80,
      optimizeLevel: 1
    });
    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0]!.args;
    expect(args).toContain('-O1');
    expect(args).not.toContain('-O3');
  });

  it("(C-03) 'color-reduction' at 256 colors still emits --no-dither (picker contract is unconditional)", async () => {
    // Pre-C-03 the dither arg was suppressed when colors>=256 because
    // a 256-colour palette has nothing to quantise — true, but the
    // picker should still be self-consistent: 'color-reduction' means
    // no dither, period. We emit --no-dither which is a no-op at 256
    // colours but keeps the argv readable and consistent across runs.
    await gifsicleMethod('/in.gif', '/out.gif', 'color-reduction', {
      colors: 256,
      dither: 'floyd-steinberg'
    });
    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0]!.args;
    expect(args).toContain('--no-dither');
    expect(args.some((a) => a.startsWith('--dither='))).toBe(false);
  });
});
