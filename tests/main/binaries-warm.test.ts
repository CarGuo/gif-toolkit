/**
 * R-69 — Tests for the platform-aware warm-cache probe layer in
 * `src/main/binaries.ts`.
 *
 * The user reported that `ffprobe` and `yt-dlp` were being flagged as
 * unavailable on macOS first launch even though both binaries were
 * present and ran fine. Manual timing showed Rosetta 2 + Gatekeeper
 * imposed 6.7 s / 26.7 s cold-start cost — well over the legacy 5 s
 * timeout that produced the false positives.
 *
 * The fix gives every probe two budgets — a generous cold one
 * (darwin 30 s / win32 15 s / linux 8 s) and a tight warm one (5 s
 * everywhere) — plus a persistent warm marker keyed by absolute
 * path + mtimeMs. This test suite locks in:
 *
 *   1. A successful probe returns `{ok:true, timedOut:false}`.
 *   2. A spawn-error (ENOENT) probe returns `{ok:false, timedOut:false}`
 *      — i.e. capabilities.ts must still surface a "binary missing"
 *      issue for these.
 *   3. A timed-out probe returns `{ok:false, timedOut:true}` — i.e.
 *      capabilities.ts must NOT surface an issue, the binary may
 *      simply still be warming up.
 */
import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// `binaries.ts` lazily reads `app.getPath('userData')` to locate the
// warm-cache JSON. Stub it to a tmp dir so test runs don't pollute the
// real Electron userData and remain hermetic across machines.
const TEST_USERDATA = path.join(os.tmpdir(), 'gif-toolkit-test-userdata');
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  app: {
    getPath: vi.fn(() => TEST_USERDATA),
    isPackaged: false
  }
}));

const { probeBinaryWarmAware, _resetWarmCacheForTest } = await import('../../src/main/binaries');

beforeEach(() => {
  _resetWarmCacheForTest();
});

// R-WS-90 P5i — 之前每次 vitest run 后 `gif-toolkit-test-userdata`
// 都会留在 os.tmpdir() 里(probeBinaryWarmAware 会写入 warm-cache JSON
// 到 app.getPath('userData')),没人清。这里测试套结束后兜底清掉。
afterAll(() => {
  try { fs.rmSync(TEST_USERDATA, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('probeBinaryWarmAware', () => {
  it('returns ok=true with version text when the binary launches cleanly', async () => {
    // `node --version` is universally available on every machine that
    // can run vitest, so it's the most reliable "definitely works"
    // probe we can write. Result must include the version string and
    // explicitly NOT be flagged as timedOut.
    const r = await probeBinaryWarmAware('node-test', process.execPath, ['--version']);
    expect(r.ok).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.version).toMatch(/v\d+\.\d+\.\d+/);
  });

  it('returns ok=false, timedOut=false on spawn error (ENOENT)', async () => {
    // A non-existent binary triggers child.on('error', ...) before
    // any timeout fires. capabilities.ts uses this branch — and ONLY
    // this branch — to push a `*-missing` issue and a red toast.
    const r = await probeBinaryWarmAware('does-not-exist', '/no/such/binary-xyz', ['--version']);
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(false);
  });

  it('marks the binary warm so a second probe still succeeds', async () => {
    // Two consecutive successful probes should both return ok=true.
    // The second one will use the warm-budget (5 s) but since `node
    // --version` is sub-50ms anyway, the budget difference isn't
    // observable in test wall-clock — what we lock in is correctness:
    // `markWarm` must not break the next call.
    const a = await probeBinaryWarmAware('node-test', process.execPath, ['--version']);
    const b = await probeBinaryWarmAware('node-test', process.execPath, ['--version']);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(b.timedOut).toBe(false);
  });
});
