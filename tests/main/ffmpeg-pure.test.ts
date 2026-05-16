/**
 * Tests for the few exported pure functions in src/main/ffmpeg.ts.
 *
 * The rest of ffmpeg.ts spawns child processes (ffmpeg/ffprobe) and is
 * covered by integration runs against real binaries; we don't replay that
 * here. parseRational is the parser ffprobe r_frame_rate / avg_frame_rate
 * results flow through, so a misparse here means wrong frame counts and a
 * wrong a-priori GIF size estimate everywhere downstream.
 */
import { describe, expect, it, vi } from 'vitest';

// ffmpeg.ts indirectly imports logger.ts → ipcMain.handle, which would
// throw outside Electron. Stub the electron surface to a noop so the module
// graph loads in node-only test environment.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
}));

const { parseRational } = await import('../../src/main/ffmpeg');

describe('parseRational', () => {
  it('returns 0 for null/undefined/empty', () => {
    expect(parseRational(undefined)).toBe(0);
    expect(parseRational('')).toBe(0);
  });

  it('parses canonical NTSC rationals', () => {
    expect(parseRational('30000/1001')).toBeCloseTo(29.97, 2);
    expect(parseRational('24000/1001')).toBeCloseTo(23.976, 2);
  });

  it('parses simple integers expressed as a/b', () => {
    expect(parseRational('30/1')).toBe(30);
    expect(parseRational('60/1')).toBe(60);
    expect(parseRational('25/1')).toBe(25);
  });

  it('returns 0 when denominator is zero (avoid Infinity poisoning)', () => {
    expect(parseRational('30/0')).toBe(0);
    expect(parseRational('0/0')).toBe(0);
  });

  it('returns 0 for malformed strings', () => {
    expect(parseRational('abc')).toBe(0);
    expect(parseRational('30')).toBe(0); // missing /b
    expect(parseRational('30/abc')).toBe(0);
  });
});
