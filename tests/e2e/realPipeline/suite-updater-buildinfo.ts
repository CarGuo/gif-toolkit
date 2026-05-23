/**
 * SUITE UPDATER-BUILDINFO — `updater:*` / `app:buildInfo` /
 * `app:defaultDir` / `app:registerOutputDir` schema + path-gate lock
 * (R-UPDATER-BUILDINFO-V1).
 *
 * Why this SUITE exists
 * ---------------------
 * These are the smallest, lowest-traffic IPC channels — and exactly
 * the kind that drift unnoticed until a release fingerprint lands in
 * a CI script that consumes the wrong field name.
 *
 *   - [updater:checkForUpdates](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L1478-L1481)
 *     MUST return a well-formed [UpdateCheckResult](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types/update.ts#L21-L42) every time —
 *     even on network failure (`error: string` set, `hasUpdate: false`),
 *     so the renderer never has to try/catch.
 *   - [app:buildInfo](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L1466-L1468)
 *     MUST round-trip the [BuildInfo](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/buildInfo.ts#L29-L50) shape with all 7 fields
 *     present (in dev builds the values are "dev" sentinels but the
 *     keys must still exist).
 *   - [app:defaultDir](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L1443-L1447)
 *     MUST return a non-empty string (the dev-time default download
 *     directory) and add it to the allow-list as a side effect.
 *   - [app:registerOutputDir](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L1535-L1569)
 *     MUST return `{ok:true}` for the default dir and `{ok:false}` for
 *     anything outside the allow-list — never throw, because hydration
 *     iterates this against every persisted history record.
 */
import { test, expect } from '@playwright/test';
import { getHarness } from './_harness';

interface UpdateCheckResultWire {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  htmlUrl: string | null;
  publishedAt: string | null;
  releaseName: string | null;
  body: string | null;
  error: string | null;
  cached: boolean;
  fetchedAt: number;
}

interface BuildInfoWire {
  version: string;
  commit: string;
  builtAt: string;
  runNumber: string;
  nodeVersion: string;
  electronVersion: string;
  buildPlatform: string;
}

interface RegisterOutputDirWire { ok: boolean; }

test.describe('SUITE UPDATER-BUILDINFO — updater:* / app:buildInfo / app:defaultDir / app:registerOutputDir', () => {
  test('SUITE UPD-A — updater:checkForUpdates returns a well-formed UpdateCheckResult (no throw, even on failure)', async () => {
    // Network fetch with a built-in 6h cache; allow up to 30s for a
    // cold call on a slow CI runner.
    test.setTimeout(45_000);
    const { page } = getHarness();
    const r = (await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: { updater: { checkForUpdates(force?: boolean): Promise<UpdateCheckResultWire> } };
      };
      // force=false so we hit the cache if a prior call (LIFE-* or App
      // mount) already populated it; either branch satisfies the
      // schema-lock contract.
      return w.giftk.updater.checkForUpdates(false);
    })) as UpdateCheckResultWire;
    // 10 contractual fields — every one must be present and the
    // discriminated-union variant must be self-consistent.
    expect(typeof r.current).toBe('string');
    expect(r.current.length).toBeGreaterThan(0);
    expect(r.latest === null || typeof r.latest === 'string').toBe(true);
    expect(typeof r.hasUpdate).toBe('boolean');
    expect(r.htmlUrl === null || typeof r.htmlUrl === 'string').toBe(true);
    expect(r.publishedAt === null || typeof r.publishedAt === 'string').toBe(true);
    expect(r.releaseName === null || typeof r.releaseName === 'string').toBe(true);
    expect(r.body === null || typeof r.body === 'string').toBe(true);
    expect(r.error === null || typeof r.error === 'string').toBe(true);
    expect(typeof r.cached).toBe('boolean');
    expect(typeof r.fetchedAt).toBe('number');
    expect(Number.isFinite(r.fetchedAt)).toBe(true);
    // Self-consistency: if hasUpdate is true we MUST have a `latest`.
    if (r.hasUpdate) expect(typeof r.latest).toBe('string');
    // And: error→hasUpdate=false (the renderer relies on this).
    if (r.error !== null) expect(r.hasUpdate).toBe(false);
  });

  test('SUITE UPD-B — app:buildInfo returns the full 7-field BuildInfo shape', async () => {
    test.setTimeout(10_000);
    const { page } = getHarness();
    const r = (await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: { getBuildInfo(): Promise<BuildInfoWire> };
      };
      return w.giftk.getBuildInfo();
    })) as BuildInfoWire;
    // Every key must be a non-empty string. Values may be the "dev"
    // sentinels (BUILD_INFO_DEFAULTS) — that's fine, we only lock the
    // schema not the content.
    const keys: Array<keyof BuildInfoWire> = [
      'version', 'commit', 'builtAt', 'runNumber',
      'nodeVersion', 'electronVersion', 'buildPlatform'
    ];
    for (const k of keys) {
      expect(typeof r[k], `field ${k} type`).toBe('string');
      expect(r[k].length, `field ${k} non-empty`).toBeGreaterThan(0);
    }
  });

  test('SUITE UPD-C — app:defaultDir returns a non-empty string', async () => {
    test.setTimeout(10_000);
    const { page } = getHarness();
    const r = (await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: { getDefaultOutputDir(): Promise<string> };
      };
      return w.giftk.getDefaultOutputDir();
    })) as string;
    expect(typeof r).toBe('string');
    expect(r.length).toBeGreaterThan(0);
  });

  test('SUITE UPD-D — app:registerOutputDir gates path against the allow-list', async () => {
    test.setTimeout(15_000);
    const { page } = getHarness();
    // The preload bridge enforces ensureString(p) before the IPC call;
    // empty / non-string inputs throw synchronously at the bridge.
    // Real-but-out-of-tree paths reach the main handler which returns
    // {ok:false} (never throws). We lock both layers here.
    const r = await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: {
          getDefaultOutputDir(): Promise<string>;
          registerOutputDir(p: string): Promise<RegisterOutputDirWire>;
        };
      };
      // Default dir is added to the allow-list as a side effect of
      // app:defaultDir, so registering it again MUST return ok:true.
      const def = await w.giftk.getDefaultOutputDir();
      const okDefault = await w.giftk.registerOutputDir(def);
      // A real path that is NOT inside any allow-list root — the
      // handler returns ok:false, NEVER throws.
      const okOutside = await w.giftk.registerOutputDir('/etc');
      // Oversize path (>4096 chars) — main handler short-circuits to
      // ok:false. Bridge has no length cap; only main does.
      const okOversize = await w.giftk.registerOutputDir('/' + 'a'.repeat(5000));
      // Bridge ensureString only checks type — empty string passes
      // through to main, which short-circuits to {ok:false}. `null`
      // however IS rejected at the bridge.
      const okEmpty = await w.giftk.registerOutputDir('');
      let nullKind: string;
      try {
        await (w.giftk.registerOutputDir as unknown as (
          v: unknown
        ) => Promise<RegisterOutputDirWire>)(null);
        nullKind = 'resolved';
      } catch {
        nullKind = 'threw';
      }
      return { okDefault, okOutside, okOversize, okEmpty, nullKind };
    });
    expect(r.okDefault.ok).toBe(true);
    expect(r.okOutside.ok).toBe(false);
    expect(r.okOversize.ok).toBe(false);
    expect(r.okEmpty.ok).toBe(false);
    expect(r.nullKind).toBe('threw');
  });
});
