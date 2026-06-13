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

  it('default (no opts) for color-reduction emits -O3 and --dither=floyd-steinberg', async () => {
    await gifsicleMethod('/in.gif', '/out.gif', 'color-reduction', {
      colors: 128
    });
    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0]!.args;
    expect(args).toContain('-O3');
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

  it("dither='none' (with color-reduction) omits any --dither flag", async () => {
    await gifsicleMethod('/in.gif', '/out.gif', 'color-reduction', {
      colors: 64,
      dither: 'none'
    });
    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0]!.args;
    // No --dither=* anywhere, and no bare --dither / --no-dither either.
    expect(args.some((a) => a.startsWith('--dither'))).toBe(false);
    expect(args).not.toContain('--no-dither');
  });

  it("dither='ordered' (with color-reduction) emits --dither=ordered", async () => {
    await gifsicleMethod('/in.gif', '/out.gif', 'color-reduction', {
      colors: 64,
      dither: 'ordered'
    });
    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0]!.args;
    expect(args).toContain('--dither=ordered');
    expect(args).not.toContain('--dither=floyd-steinberg');
  });

  it('color-reduction at 256 colors omits the dither arg entirely (palette unchanged)', async () => {
    // R-81 — dither flags only matter when the palette is actually being
    // reduced; verify the picker still respects that invariant when the
    // caller explicitly opts into floyd-steinberg dither.
    await gifsicleMethod('/in.gif', '/out.gif', 'color-reduction', {
      colors: 256,
      dither: 'floyd-steinberg'
    });
    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0]!.args;
    expect(args.some((a) => a.startsWith('--dither'))).toBe(false);
  });
});
