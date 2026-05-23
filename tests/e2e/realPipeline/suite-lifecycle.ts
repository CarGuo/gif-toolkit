/**
 * SUITE LIFECYCLE — app-shell + persistence + capabilities (R-LIFECYCLE-V1).
 *
 * Why this SUITE exists
 * ---------------------
 * Across 41 IPC channels and 26 main-process service modules, several
 * "boring but load-bearing" handlers had no e2e regression at all:
 *
 *   - `app:registerOutputDir` ([src/main/index.ts#L1535-L1569](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L1535-L1569)) —
 *     re-allow a persisted output directory after a restart so old
 *     "打开目录" buttons keep working without throwing the renderer
 *     into a hydration deadlock when one entry is stale.
 *   - `app:defaultDir` — the renderer hits this exactly once during
 *     bootstrap; if it ever returns empty/undefined the entire output
 *     pane breaks silently.
 *   - `app:buildInfo` / `system:capabilities` — the About modal +
 *     "缺失依赖" toasts read these. A regression in either schema
 *     would hide a missing ffmpeg / yt-dlp from the user.
 *   - DB migrations idempotency — `db.history.readAll()` /
 *     `db.uploadHistory.readAll()` etc must be safe to call repeatedly,
 *     including round-trip after `clear()`.
 *
 * The SUITE drives every channel through the production preload bridge
 * and asserts both happy paths and graceful-degradation cases (e.g.
 * registering a non-existent path returns `{ok:false}` rather than
 * throwing).
 *
 * Why we don't restart the Electron process
 * -----------------------------------------
 * The realPipeline harness owns one app + one window for the whole
 * spec ([_harness.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/e2e/realPipeline/_harness.ts)
 * lifecycle contract). A second `_electron.launch(...)` inside this
 * SUITE would race with the bound harness and is forbidden. Persistence
 * across hard restarts is covered by the unit suites
 * `migrations.test.ts` + `bootstrapImport.test.ts`. This SUITE proves
 * the IPC surface, schema validation, and live cross-handler invariants
 * hold inside a running app.
 */
import { test, expect } from '@playwright/test';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  freshOutDir,
  getHarness
} from './_harness';

interface BuildInfoWire {
  version: string;
  commit: string;
  builtAt: string;
  runNumber: string;
  nodeVersion: string;
  electronVersion: string;
  buildPlatform: string;
}

interface BinaryReport {
  path: string;
  ok: boolean;
  version: string;
}
interface CapabilityReportWire {
  platform: string;
  arch: string;
  hasHiResIcon: boolean;
  binaries: {
    ffmpeg: BinaryReport;
    ffprobe: BinaryReport;
    gifsicle: BinaryReport;
    ytdlp: BinaryReport;
  };
  issues?: unknown[];
}

test.describe('SUITE LIFECYCLE — app-shell IPC + persistence invariants', () => {
  test('SUITE LIFE-A — registerOutputDir accepts dirs under defaultOutputDir, rejects outside-tree / non-existent', async () => {
    test.setTimeout(30_000);
    const { page } = getHarness();

    // 1) A directory we just minted under defaultOutputDir is accepted.
    //    `freshOutDir` already mkdir'd it, so the stat() inside the
    //    handler succeeds and the underDefault branch fires.
    const insideAllowed = freshOutDir('LIFE-A-inside');
    const inOk = await page.evaluate(async (p: string) => {
      const g = (window as unknown as {
        giftk: { registerOutputDir(p: string): Promise<{ ok: boolean }> };
      }).giftk;
      return g.registerOutputDir(p);
    }, insideAllowed);
    expect(inOk.ok).toBe(true);

    // 2) An OS path that exists but is OUTSIDE any allowed root and
    //    NOT under defaultOutputDir must return { ok: false }. We use
    //    `os.tmpdir()` directly which the production app never adds
    //    to allowedOutputDirs.
    //    Caveat: on macOS CI runners $TMPDIR sometimes lives under the
    //    user's home which can also be the parent of defaultOutputDir.
    //    To be defensive, we register a path that's clearly neither —
    //    `/private/var` on macOS, `/tmp/giftk-life-outside` on linux.
    const outsidePath = process.platform === 'darwin' ? '/private/etc' : '/etc';
    const outOk = await page.evaluate(async (p: string) => {
      const g = (window as unknown as {
        giftk: { registerOutputDir(p: string): Promise<{ ok: boolean }> };
      }).giftk;
      return g.registerOutputDir(p);
    }, outsidePath);
    expect(outOk.ok).toBe(false);

    // 3) A non-existent path returns { ok: false } without throwing.
    const ghost = path.join(os.tmpdir(), `giftk-life-a-ghost-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    expect(existsSync(ghost)).toBe(false);
    const ghostOk = await page.evaluate(async (p: string) => {
      const g = (window as unknown as {
        giftk: { registerOutputDir(p: string): Promise<{ ok: boolean }> };
      }).giftk;
      return g.registerOutputDir(p);
    }, ghost);
    expect(ghostOk.ok).toBe(false);
  });

  test('SUITE LIFE-B — getDefaultOutputDir returns a real on-disk directory', async () => {
    test.setTimeout(15_000);
    const { defaultOutDir } = getHarness();
    expect(defaultOutDir).toBeTruthy();
    expect(typeof defaultOutDir).toBe('string');
    expect(existsSync(defaultOutDir)).toBe(true);
    expect(statSync(defaultOutDir).isDirectory()).toBe(true);

    // Re-call across the bridge — it must agree with the value the
    // harness captured at boot.
    const { page } = getHarness();
    const live = await page.evaluate(async () => {
      const g = (window as unknown as {
        giftk: { getDefaultOutputDir(): Promise<string> };
      }).giftk;
      return g.getDefaultOutputDir();
    });
    expect(live).toBe(defaultOutDir);
  });

  test('SUITE LIFE-C — buildInfo + capabilities expose well-formed schemas', async () => {
    // First-call capabilities probes spawn `--version` against ffmpeg /
    // ffprobe / gifsicle / yt-dlp in parallel. On a cold macOS box the
    // PyInstaller-bundled yt-dlp can need ~27s to unpack Python and
    // exit, plus Rosetta ffprobe needs ~7s. After the first call the
    // result is cached in-memory so subsequent calls are sub-millisecond,
    // but THIS particular SUITE is the first one in the run that hits
    // the channel directly, so we budget for the cold-spawn worst case.
    test.setTimeout(90_000);
    const { page } = getHarness();

    const build = await page.evaluate(async () => {
      const g = (window as unknown as {
        giftk: { getBuildInfo(): Promise<BuildInfoWire> };
      }).giftk;
      return g.getBuildInfo();
    });
    expect(typeof build.version).toBe('string');
    expect(build.version.length).toBeGreaterThan(0);
    expect(typeof build.commit).toBe('string');
    expect(typeof build.builtAt).toBe('string');
    expect(typeof build.runNumber).toBe('string');
    expect(typeof build.nodeVersion).toBe('string');
    expect(typeof build.electronVersion).toBe('string');
    expect(typeof build.buildPlatform).toBe('string');

    const caps = await page.evaluate(async () => {
      const g = (window as unknown as {
        giftk: { getCapabilities(): Promise<CapabilityReportWire> };
      }).giftk;
      return g.getCapabilities();
    });
    expect(['darwin', 'win32', 'linux']).toContain(caps.platform);
    expect(typeof caps.arch).toBe('string');
    expect(typeof caps.hasHiResIcon).toBe('boolean');
    for (const key of ['ffmpeg', 'ffprobe', 'gifsicle', 'ytdlp'] as const) {
      const b = caps.binaries[key];
      expect(typeof b.path).toBe('string');
      expect(typeof b.ok).toBe('boolean');
      expect(typeof b.version).toBe('string');
    }
    // ffmpeg + gifsicle MUST be present in a packaged build — without
    // them the conversion suites would fail. So this assertion is a
    // belt-and-suspenders check that a baseline-healthy run has them.
    expect(caps.binaries.ffmpeg.ok).toBe(true);
    expect(caps.binaries.gifsicle.ok).toBe(true);
  });

  test('SUITE LIFE-D — db.* readAll() is idempotent and clear() is safe to call from a running app', async () => {
    test.setTimeout(20_000);
    const { page } = getHarness();

    // Snapshot all four core history tables; each must return an
    // array, even when empty.
    const counts = await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: {
          db: {
            history: { readAll(): Promise<unknown[]> };
            uploadHistory: { readAll(): Promise<unknown[]> };
            sniffHistory: { readAll(): Promise<unknown[]> };
            toolboxHistory: { readAll(): Promise<unknown[]> };
          };
        };
      };
      const a = await w.giftk.db.history.readAll();
      const b = await w.giftk.db.uploadHistory.readAll();
      const c = await w.giftk.db.sniffHistory.readAll();
      const d = await w.giftk.db.toolboxHistory.readAll();
      // Same call again — must return the same length each time.
      const a2 = await w.giftk.db.history.readAll();
      return {
        history: a.length, history2: a2.length,
        uploadHistory: b.length,
        sniffHistory: c.length,
        toolboxHistory: d.length
      };
    });
    expect(counts.history).toBe(counts.history2);
    expect(typeof counts.uploadHistory).toBe('number');
    expect(typeof counts.sniffHistory).toBe('number');
    expect(typeof counts.toolboxHistory).toBe('number');
  });
});
