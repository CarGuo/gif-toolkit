/**
 * Unit tests for `gifskiReencode` argv composition (R-GIFSKI-PRIMARY).
 *
 * Mirrors the gifsicleMethod.test.ts strategy: mock `child_process.spawn`
 * so no real binary executes, mock `./binaries` so the gifski path is
 * deterministic, then assert on the captured argv arrays.
 *
 * What we lock:
 *   1. When `getGifskiPath()` returns null → gifskiReencode throws and
 *      DOES NOT spawn anything (R-COMPRESS-V1.5 + R-GIFSKI-PRIMARY rule 2
 *      — never silently fall back to a different engine here, the caller
 *      is responsible for the fallback decision).
 *   2. When gifski is available → spawns ffmpeg first (PNG extract),
 *      then spawns gifski with --fps/--quality/--quiet/-o + PNG list.
 *   3. quality is clamped to [1, 100].
 */
import { EventEmitter } from 'events';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { promises as fsp } from 'fs';
import path from 'path';
import { tmpdir as osTmpdir } from 'os';

const spawnCalls: Array<{ cmd: string; args: string[] }> = [];

function makeFakeChild(
  framesDir: string | null,
  cmd: string
): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void } {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => undefined;
  // For the ffmpeg call we synthesise a few PNG files so gifskiReencode
  // sees a non-empty frames dir; for the gifski call we just exit 0.
  setImmediate(async () => {
    if (cmd.includes('ffmpeg') && framesDir) {
      try {
        await fsp.mkdir(framesDir, { recursive: true });
        // 3 fake frames are enough for the readdir+sort path coverage.
        await fsp.writeFile(path.join(framesDir, 'frame-000001.png'), 'p');
        await fsp.writeFile(path.join(framesDir, 'frame-000002.png'), 'p');
        await fsp.writeFile(path.join(framesDir, 'frame-000003.png'), 'p');
      } catch { /* ignore: gifskiReencode's mkdir will retry */ }
    }
    child.emit('close', 0, null);
  });
  return child;
}

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn((cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args: args.slice() });
      // The first ffmpeg arg list ends with the PNG pattern; the
      // containing dir is what we need to populate.
      const framePattern = args[args.length - 1];
      const framesDir = framePattern && framePattern.includes(osTmpdir())
        ? path.dirname(framePattern)
        : null;
      return makeFakeChild(framesDir, cmd) as unknown as ReturnType<typeof actual.spawn>;
    })
  };
});

// `./binaries` reaches into electron / app paths; stub it deterministically.
// Two distinct mock instances are needed (gifski present / absent), but
// vi.mock is module-graph-cached, so we toggle via a mutable export.
let _gifskiPath: string | null = '/fake/gifski';
vi.mock('../../src/main/binaries', () => ({
  getGifsiclePath: () => '/fake/gifsicle',
  gifsicleSupportsLossy: () => true,
  getFfmpegPath: () => '/fake/ffmpeg',
  getFfprobePath: () => '/fake/ffprobe',
  getGifskiPath: () => _gifskiPath
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
}));

const { gifskiReencode } = await import('../../src/main/ffmpeg');

describe('gifskiReencode — R-GIFSKI-PRIMARY argv plumbing', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    _gifskiPath = '/fake/gifski';
  });

  it('throws (no spawn) when gifski binary is not available', async () => {
    _gifskiPath = null;
    await expect(
      gifskiReencode({ inputGif: '/in.gif', outputGif: '/out.gif', fps: 10, quality: 80 })
    ).rejects.toThrow(/gifski binary not available/);
    expect(spawnCalls.length).toBe(0);
  });

  it('spawns ffmpeg(extract) then gifski(encode) with the right argv shape', async () => {
    await gifskiReencode({
      inputGif: '/in.gif',
      outputGif: '/out.gif',
      fps: 10,
      quality: 80
    });
    // Exactly 2 spawns: ffmpeg PNG-extract + gifski encode.
    expect(spawnCalls).toHaveLength(2);

    const ff = spawnCalls[0]!;
    expect(ff.cmd).toBe('/fake/ffmpeg');
    // -i input.gif + -vsync 0 + -f image2 + PNG glob pattern
    expect(ff.args).toContain('-i');
    expect(ff.args).toContain('/in.gif');
    expect(ff.args).toContain('-vsync');
    expect(ff.args).toContain('0');
    expect(ff.args).toContain('-f');
    expect(ff.args).toContain('image2');
    const framePat = ff.args[ff.args.length - 1];
    expect(framePat.endsWith('frame-%06d.png')).toBe(true);

    const gs = spawnCalls[1]!;
    expect(gs.cmd).toBe('/fake/gifski');
    expect(gs.args).toContain('--fps');
    expect(gs.args).toContain('10');
    expect(gs.args).toContain('--quality');
    expect(gs.args).toContain('80');
    expect(gs.args).toContain('--quiet');
    expect(gs.args).toContain('-o');
    expect(gs.args).toContain('/out.gif');
    // PNG list comes last (we wrote 3 frames into the tmp dir).
    const pngArgs = gs.args.filter((a) => a.endsWith('.png'));
    expect(pngArgs).toHaveLength(3);
  });

  it('clamps quality to [1, 100]', async () => {
    await gifskiReencode({ inputGif: '/a.gif', outputGif: '/b.gif', fps: 5, quality: 500 });
    expect(spawnCalls[1]!.args[spawnCalls[1]!.args.indexOf('--quality') + 1]).toBe('100');

    spawnCalls.length = 0;
    await gifskiReencode({ inputGif: '/a.gif', outputGif: '/b.gif', fps: 5, quality: -10 });
    expect(spawnCalls[1]!.args[spawnCalls[1]!.args.indexOf('--quality') + 1]).toBe('1');
  });

  it('defaults quality to 80 when omitted', async () => {
    await gifskiReencode({ inputGif: '/a.gif', outputGif: '/b.gif', fps: 5 });
    expect(spawnCalls[1]!.args[spawnCalls[1]!.args.indexOf('--quality') + 1]).toBe('80');
  });
});
