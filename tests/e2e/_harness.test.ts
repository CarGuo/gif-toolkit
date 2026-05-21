/**
 * Unit tests for [tests/e2e/realPipeline/_harness.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/e2e/realPipeline/_harness.ts)
 * — the shared lifecycle / path / binary-locator module that powers
 * the per-suite real-pipeline e2e files.
 *
 * Why these tests matter
 * ----------------------
 * The 25 SUITE Playwright e2e run only exercises the **happy path**
 * of every harness API: bound state, posix `pathToGiftkLocal`, and
 * the absent-binary skip branches in SUITE F/G/H. The following
 * branches are NEVER hit by a real-app run on a single host and
 * would silently regress without unit coverage:
 *
 *   1. `getHarness()` throw branch when the orchestrator forgot to
 *      bind (or unbound mid-spec).
 *   2. `pathToGiftkLocal` win32 branch (forward-slash separator,
 *      drive letter handling).
 *   3. `pathToGiftkLocal` percent-encoding for spaces / unicode.
 *   4. `findChromeBinary` darwin / linux / unsupported platform
 *      decision tree.
 *   5. `findYtDlpBinary` exception swallow path.
 *
 * The recorder/`waitForTerminal`/`launchElectron` helpers are
 * intrinsically Playwright-bound (they call `page.evaluate`) and
 * are covered by the e2e SUITEs themselves; they intentionally are
 * NOT replicated here.
 *
 * Mocking strategy
 * ----------------
 * `_harness.ts` does `import { existsSync, mkdirSync } from 'node:fs'`
 * and `import { execSync } from 'node:child_process'` at the top of
 * the file. Those are bound as module-local `const`s at import time,
 * so a `vi.spyOn(fs, 'existsSync')` on the namespace object would NOT
 * reach the captured binding — we MUST `vi.mock(...)` the source
 * modules before the SUT loads. We use shared mock instances kept in
 * outer-scope variables so each `it` block can re-program them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';

const existsSyncMock = vi.fn<(p: string) => boolean>();
const execSyncMock = vi.fn<(...args: unknown[]) => Buffer | string>();

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: (p: string) => existsSyncMock(p),
    // mkdirSync is only used by freshOutDir which is not exercised
    // here; keep the real impl as a fall-through so accidental calls
    // don't silently corrupt the repo.
    mkdirSync: actual.mkdirSync
  };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execSync: (...args: unknown[]) => execSyncMock(...args)
  };
});

// SUT must be imported AFTER the vi.mock calls above so the captured
// bindings inside _harness.ts resolve to the mocked exports.
import {
  bindHarness,
  unbindHarness,
  getHarness,
  pathToGiftkLocal,
  findChromeBinary,
  findYtDlpBinary,
  type HarnessHandle
} from './realPipeline/_harness';

function fakeHandle(defaultOutDir = '/tmp/giftk-fake-out'): HarnessHandle {
  return {
    app: {} as HarnessHandle['app'],
    page: {} as HarnessHandle['page'],
    defaultOutDir
  };
}

describe('_harness lifecycle (bindHarness / unbindHarness / getHarness)', () => {
  beforeEach(() => {
    unbindHarness();
  });

  afterEach(() => {
    unbindHarness();
  });

  it('getHarness throws a descriptive error when no bind has happened yet', () => {
    expect(() => getHarness()).toThrow(/harness not bound/i);
    expect(() => getHarness()).toThrow(/bindHarness/);
  });

  it('getHarness returns the bound handle by reference (no clone) so per-suite modules see live state', () => {
    const h = fakeHandle();
    bindHarness(h);
    expect(getHarness()).toBe(h);
    expect(getHarness().defaultOutDir).toBe('/tmp/giftk-fake-out');
  });

  it('bindHarness called twice replaces the previous handle (last-write-wins)', () => {
    const a = fakeHandle('/tmp/a');
    const b = fakeHandle('/tmp/b');
    bindHarness(a);
    bindHarness(b);
    expect(getHarness()).toBe(b);
    expect(getHarness()).not.toBe(a);
  });

  it('unbindHarness causes subsequent getHarness to throw again (clean teardown)', () => {
    bindHarness(fakeHandle());
    expect(() => getHarness()).not.toThrow();
    unbindHarness();
    expect(() => getHarness()).toThrow(/harness not bound/i);
  });

  it('unbindHarness is idempotent (calling twice does not throw)', () => {
    bindHarness(fakeHandle());
    unbindHarness();
    expect(() => unbindHarness()).not.toThrow();
    expect(() => getHarness()).toThrow(/harness not bound/i);
  });
});

describe('pathToGiftkLocal — renderer-visible URL encoding', () => {
  const realPlatform = process.platform;
  const setPlatform = (p: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  };
  afterEach(() => setPlatform(realPlatform));

  it('posix: percent-encodes path segments individually and preserves leading slash', () => {
    setPlatform('darwin');
    const url = pathToGiftkLocal('/Users/alice/Movies/My Cat.gif');
    expect(url).toBe('giftk-local://localhost/Users/alice/Movies/My%20Cat.gif');
  });

  it('posix: encodes unicode segments without losing the leading slash', () => {
    setPlatform('darwin');
    const url = pathToGiftkLocal('/tmp/中文 目录/动图.gif');
    expect(url.startsWith('giftk-local://localhost/tmp/')).toBe(true);
    expect(/[\u4e00-\u9fff]/.test(url)).toBe(false);
    expect(url).toContain('%E4%B8%AD%E6%96%87');
  });

  it('posix: a trailing slash on input does not produce a double-slash on output', () => {
    setPlatform('darwin');
    const url = pathToGiftkLocal('/tmp/dir');
    expect(url).toBe('giftk-local://localhost/tmp/dir');
    expect(url).not.toContain('//tmp');
  });

  it('win32 branch: emits forward slashes and keeps a leading "/" before drive segment', () => {
    if (realPlatform === 'win32') return; // skip on real Windows host
    setPlatform('win32');
    const winAbs = path.win32.resolve('C:/Users/Bob/Videos/clip.mp4');
    const url = pathToGiftkLocal(winAbs.replace(/\\/g, '/'));
    expect(url.startsWith('giftk-local://localhost/')).toBe(true);
    expect(url.includes('\\')).toBe(false);
  });
});

describe('findChromeBinary — multi-platform discovery', () => {
  const realPlatform = process.platform;
  const setPlatform = (p: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  };

  beforeEach(() => {
    existsSyncMock.mockReset();
  });

  afterEach(() => {
    setPlatform(realPlatform);
  });

  it('darwin: returns the system bundle path when /Applications/Google Chrome.app exists', () => {
    setPlatform('darwin');
    const sysPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    existsSyncMock.mockImplementation((p) => p === sysPath);
    expect(findChromeBinary()).toBe(sysPath);
  });

  it('darwin: falls back to ~/Applications when only the user bundle exists', () => {
    setPlatform('darwin');
    const userPath = path.join(
      os.homedir(),
      'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    );
    existsSyncMock.mockImplementation((p) => p === userPath);
    expect(findChromeBinary()).toBe(userPath);
  });

  it('darwin: returns null when neither bundle exists', () => {
    setPlatform('darwin');
    existsSyncMock.mockReturnValue(false);
    expect(findChromeBinary()).toBeNull();
  });

  it('linux: probes the three canonical paths in order and returns the first match', () => {
    setPlatform('linux');
    const found = '/usr/bin/chromium';
    existsSyncMock.mockImplementation((p) => p === found);
    expect(findChromeBinary()).toBe(found);
  });

  it('linux: returns null when none of /usr/bin/{google-chrome,chromium,chromium-browser} exist', () => {
    setPlatform('linux');
    existsSyncMock.mockReturnValue(false);
    expect(findChromeBinary()).toBeNull();
  });

  it('win32 (and any other unsupported platform): returns null without probing the FS', () => {
    setPlatform('win32');
    existsSyncMock.mockReturnValue(true);
    expect(findChromeBinary()).toBeNull();
    // Short-circuit BEFORE any fs lookup so unsupported platforms pay no I/O.
    expect(existsSyncMock).not.toHaveBeenCalled();
  });
});

describe('findYtDlpBinary — exception-swallow contract', () => {
  beforeEach(() => {
    existsSyncMock.mockReset();
    execSyncMock.mockReset();
  });

  it('returns the trimmed path when `which yt-dlp` succeeds AND the result exists on disk', () => {
    execSyncMock.mockReturnValue('/usr/local/bin/yt-dlp\n');
    existsSyncMock.mockReturnValue(true);
    expect(findYtDlpBinary()).toBe('/usr/local/bin/yt-dlp');
  });

  it('returns null when `which` succeeds but the resolved path does not exist (stale shim)', () => {
    execSyncMock.mockReturnValue('/usr/local/bin/yt-dlp\n');
    existsSyncMock.mockReturnValue(false);
    expect(findYtDlpBinary()).toBeNull();
  });

  it('returns null when `which` produces empty output (binary missing on PATH)', () => {
    execSyncMock.mockReturnValue('\n');
    expect(findYtDlpBinary()).toBeNull();
  });

  it('swallows execSync throws so a CI without yt-dlp simply test.skip()s', () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('command not found');
    });
    expect(() => findYtDlpBinary()).not.toThrow();
    expect(findYtDlpBinary()).toBeNull();
  });
});
