/**
 * SUITE SNIFF-CHROME-DETECT — `sniff:system-chrome:detect` /
 * `sniff:system-chrome` URL gate / `sniff:system-chrome:finalize`
 * idle reply / `sniff:cancel` no-op contract
 * (R-SNIFF-CHROME-DETECT-V1).
 *
 * Why this SUITE exists
 * ---------------------
 * The "真 Chrome 嗅探" backend has a four-step preflight surface that
 * the renderer relies on *before* it ever spawns Chrome. We never
 * exercise the real Chrome spawn here (that needs an installed browser
 * on the runner) but we DO lock the pure-IPC envelope so a renderer
 * refactor can't silently break the entry-point.
 *
 *   - [sniff:system-chrome:detect](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L943-L945)
 *     MUST return an Array of `{id,label,exePath}`. Empty on CI runners
 *     without Chrome — that's the *expected* preflight signal the
 *     renderer uses to grey out the entry.
 *   - [sniff:system-chrome](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L946-L955)
 *     MUST reject non-http(s) URLs at [assertHttpUrl](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L102-L113)
 *     before doing anything observable (no Chrome spawn, no log
 *     session opened). We fire `file:`, `javascript:` and bare junk.
 *   - [sniff:system-chrome:finalize](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L1023-L1044)
 *     MUST return `false` when nothing is in flight (no throw) —
 *     the「✓ 完成嗅探」button calls this defensively on a
 *     just-pressed state.
 *   - [sniff:cancel](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L836-L840)
 *     MUST resolve (no throw) on `{}`, on `{sessionId:'unknown'}`,
 *     and when called twice in a row — workspace tab close uses this
 *     and we don't want a stray rejection killing the Promise chain.
 */
import { test, expect } from '@playwright/test';
import { getHarness } from './_harness';

interface BrowserCandidateWire {
  id: string;
  label: string;
  exePath: string;
}

test.describe('SUITE SNIFF-CHROME-DETECT — sniff:system-chrome:* schema + URL gate', () => {
  test('SUITE SCD-A — detect returns Array<{id,label,exePath}>; entries are well-formed when present', async () => {
    test.setTimeout(15_000);
    const { page } = getHarness();
    const r = (await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: { detectSystemBrowsers(): Promise<BrowserCandidateWire[]> };
      };
      return w.giftk.detectSystemBrowsers();
    })) as BrowserCandidateWire[];
    expect(Array.isArray(r)).toBe(true);
    // Empty array is the *expected* answer on a vanilla CI runner that
    // has no Chrome / Edge / Brave installed — the renderer uses it to
    // grey out the menu item, so we DO NOT assert non-empty. We only
    // lock the per-entry shape for the host that does have a browser.
    for (const c of r) {
      expect(typeof c.id).toBe('string');
      expect(c.id.length).toBeGreaterThan(0);
      expect(['chrome', 'edge', 'brave', 'chromium']).toContain(c.id);
      expect(typeof c.label).toBe('string');
      expect(c.label.length).toBeGreaterThan(0);
      expect(typeof c.exePath).toBe('string');
      expect(c.exePath.length).toBeGreaterThan(0);
    }
  });

  test('SUITE SCD-B — sniff:system-chrome rejects non-http(s) URLs at the main-side gate (file:, javascript:, garbage)', async () => {
    test.setTimeout(15_000);
    const { page } = getHarness();
    // The preload bridge only runs ensureString on the URL — the
    // protocol gate lives in main's assertHttpUrl, which throws before
    // any Chrome launch / log session is opened. Each rejection is
    // observable as a Promise rejection on the renderer side.
    const r = await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: {
          sniffWithSystemChrome(url: string): Promise<unknown>;
        };
      };
      const probe = async (url: string): Promise<string> => {
        try {
          await w.giftk.sniffWithSystemChrome(url);
          return 'resolved';
        } catch (e) {
          return (e as Error).message || 'threw';
        }
      };
      const fileUrl = await probe('file:///etc/passwd');
      const javascriptUrl = await probe('javascript:alert(1)');
      const garbage = await probe('not a url at all');
      const ftpUrl = await probe('ftp://example.com/');
      return { fileUrl, javascriptUrl, garbage, ftpUrl };
    });
    expect(r.fileUrl).not.toBe('resolved');
    expect(r.javascriptUrl).not.toBe('resolved');
    expect(r.garbage).not.toBe('resolved');
    expect(r.ftpUrl).not.toBe('resolved');
    // assertHttpUrl says either "only http(s) URLs are allowed" or
    // "invalid URL"; the renderer's error toast branches on this.
    const protocolMsg = /(only http\(s\)|invalid url)/i;
    expect(r.fileUrl).toMatch(protocolMsg);
    expect(r.javascriptUrl).toMatch(protocolMsg);
    expect(r.garbage).toMatch(protocolMsg);
    expect(r.ftpUrl).toMatch(protocolMsg);
  });

  test('SUITE SCD-C — finalize returns false when no system-chrome sniff is in flight (no throw)', async () => {
    test.setTimeout(15_000);
    const { page } = getHarness();
    const r = await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: {
          finalizeSystemChromeSniff(opts?: { sessionId?: string }): Promise<boolean>;
        };
      };
      // No-arg form: legacy fallback, finalises every in-flight ctrl
      // and returns true iff at least one was aborted. With nothing
      // in flight, the bare-fallback path returns false.
      const noArg = await w.giftk.finalizeSystemChromeSniff();
      // sessionId-keyed form: directly checks finalizeCtrls map; an
      // unknown id MUST resolve to false (renderer relies on this to
      // tell the user "no live sniff to close").
      const empty = await w.giftk.finalizeSystemChromeSniff({});
      const unknown = await w.giftk.finalizeSystemChromeSniff({
        sessionId: 'unknown-' + Date.now(),
      });
      return { noArg, empty, unknown };
    });
    expect(r.noArg).toBe(false);
    expect(r.empty).toBe(false);
    expect(r.unknown).toBe(false);
  });

  test('SUITE SCD-D — cancelSniff is a no-op on empty / unknown / repeated calls', async () => {
    test.setTimeout(15_000);
    const { page } = getHarness();
    // Workspace tab close fires this defensively on every tab; a
    // missing sessionId or stray duplicate MUST NOT reject — the
    // close handler doesn't try/catch.
    const r = await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: {
          cancelSniff(opts?: { sessionId?: string }): Promise<void>;
        };
      };
      const probe = async (
        opts?: { sessionId?: string }
      ): Promise<string> => {
        try {
          await w.giftk.cancelSniff(opts);
          return 'resolved';
        } catch (e) {
          return (e as Error).message || 'threw';
        }
      };
      const noArg = await probe(undefined);
      const empty = await probe({});
      const unknownA = await probe({ sessionId: 'unknown-a-' + Date.now() });
      // Hit the same unknown twice in a row to lock idempotence.
      const unknownB = await probe({ sessionId: 'unknown-b' });
      const unknownBAgain = await probe({ sessionId: 'unknown-b' });
      return { noArg, empty, unknownA, unknownB, unknownBAgain };
    });
    expect(r.noArg).toBe('resolved');
    expect(r.empty).toBe('resolved');
    expect(r.unknownA).toBe('resolved');
    expect(r.unknownB).toBe('resolved');
    expect(r.unknownBAgain).toBe('resolved');
  });
});
