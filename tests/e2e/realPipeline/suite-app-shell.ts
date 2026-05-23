/**
 * SUITE APP-SHELL — `app:*` IPC validation + fallback contracts
 * (R-APP-SHELL-V1).
 *
 * Why this SUITE exists
 * ---------------------
 * `app:openExternal`, `app:openDir`, `app:revealItem`,
 * `app:clipboardWriteText`, `app:logBuffer` are the bridge between
 * renderer code and Electron's `shell.*` / `clipboard.*` APIs. Each
 * one is a security boundary:
 *
 *   - [openExternal](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L1397-L1412) — http(s) only, length-bounded
 *   - [openDir](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L1375-L1386) — must pass assertOutputDir whitelist
 *   - [revealItem](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L1425-L1441) — parent must be in allowedOutputDirs
 *   - [clipboardWriteText](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L1501-L1515) — non-empty string only
 *   - [app:logBuffer](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/logger.ts#L28-L28) — returns string[] snapshot
 *
 * Existing UI-driven SUITEs touch the happy paths transitively, but
 * none lock the negative paths (forged URL schemes, paths outside the
 * output whitelist, empty clipboard payloads). A regression in any
 * of those validators is a real security risk.
 *
 * NOTE: We deliberately do NOT call `app:openExternal` with a real
 * https URL — that would actually launch the user's browser during a
 * test run. We only exercise the *rejection* path, which is exactly
 * the path that needs the most protection.
 */
import { test, expect } from '@playwright/test';
import { getHarness } from './_harness';

interface ClipboardOk { ok: true; length: number; }
interface ClipboardFail { ok: false; reason: string; }
type ClipboardResult = ClipboardOk | ClipboardFail;

test.describe('SUITE APP-SHELL — app:* IPC validation + fallback contracts', () => {
  test('SUITE SHELL-A — app:openExternal rejects non-http(s) schemes / empty / oversize URLs', async () => {
    test.setTimeout(15_000);
    const { page } = getHarness();
    const r = await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: { updater: { openExternal(url: string): Promise<void> } };
      };
      const out: Record<string, string> = {};
      const tries: Array<[string, string]> = [
        ['empty', ''],
        ['file', 'file:///etc/passwd'],
        ['javascript', 'javascript:alert(1)'],
        ['custom', 'giftk-local://evil'],
        ['malformed', 'this is not a url at all']
      ];
      for (const [label, url] of tries) {
        try {
          await w.giftk.updater.openExternal(url);
          out[label] = '<accepted!>';
        } catch (e) {
          out[label] = (e as Error).message;
        }
      }
      // Build a 3000-char URL (over the 2048 limit) and assert it
      // rejects too. Build entirely in-eval to avoid any host-language
      // string-length truncation surprises.
      const oversize = 'https://example.com/' + 'a'.repeat(3000);
      try {
        await w.giftk.updater.openExternal(oversize);
        out.oversize = '<accepted!>';
      } catch (e) {
        out.oversize = (e as Error).message;
      }
      return out;
    });
    // Every entry MUST surface a non-empty rejection — none accepted.
    for (const [k, v] of Object.entries(r)) {
      expect(v.length, `case ${k} message`).toBeGreaterThan(0);
      expect(v.includes('<accepted!>'), `case ${k} should be rejected`).toBe(false);
    }
  });

  test('SUITE SHELL-B — app:openDir rejects paths outside the allowed output tree', async () => {
    test.setTimeout(15_000);
    const { page } = getHarness();
    const r = await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: { openOutputDir(p: string): Promise<void> };
      };
      const out: Record<string, string> = {};
      const tries: Array<[string, string]> = [
        ['root', '/'],
        ['etc', '/etc'],
        ['home', '/Users'],
        // '/tmp' is a real existing dir but NOT in the allow-list.
        ['tmp', '/tmp']
      ];
      for (const [label, p] of tries) {
        try {
          await w.giftk.openOutputDir(p);
          out[label] = '<accepted!>';
        } catch (e) {
          out[label] = (e as Error).message;
        }
      }
      return out;
    });
    for (const [k, v] of Object.entries(r)) {
      expect(v.length, `case ${k} message`).toBeGreaterThan(0);
      expect(v.includes('<accepted!>'), `case ${k} should be rejected`).toBe(false);
    }
  });

  test('SUITE SHELL-C — app:revealItem rejects paths outside allowedOutputDirs', async () => {
    test.setTimeout(15_000);
    const { page } = getHarness();
    const r = await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: { revealItem(p: string): Promise<{ ok: boolean }> };
      };
      const out: Record<string, string> = {};
      const tries: Array<[string, string]> = [
        ['empty', ''],
        ['nullByte', '/tmp/foo\u0000bar'],
        ['outsideTree', '/etc/hosts']
      ];
      for (const [label, p] of tries) {
        try {
          await w.giftk.revealItem(p);
          out[label] = '<accepted!>';
        } catch (e) {
          out[label] = (e as Error).message;
        }
      }
      return out;
    });
    for (const [k, v] of Object.entries(r)) {
      expect(v.length, `case ${k} message`).toBeGreaterThan(0);
      expect(v.includes('<accepted!>'), `case ${k} should be rejected`).toBe(false);
    }
  });

  test('SUITE SHELL-D — app:clipboardWriteText round-trip + empty / non-string fallbacks', async () => {
    test.setTimeout(15_000);
    const { page } = getHarness();
    const r = await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: { clipboardWriteText(text: string): Promise<ClipboardResult> };
      };
      // Use a stable marker so a flaky concurrent test can't poison the
      // result — we don't read it back, only verify the contract.
      const okPayload = 'giftk-shell-d-' + Math.random().toString(36).slice(2);
      const okRes = await w.giftk.clipboardWriteText(okPayload);
      const emptyRes = await w.giftk.clipboardWriteText('');
      // payload-not-string is reachable only through the bare ipcRenderer.
      // The preload bridge has no runtime type-guard, so casting `null as
      // unknown as string` will hit the ok:false / payload-not-string
      // branch in the main process.
      const nonString = await (w.giftk.clipboardWriteText as unknown as (
        v: unknown
      ) => Promise<ClipboardResult>)(null);
      return { okRes, emptyRes, nonString, okPayloadLength: okPayload.length };
    });
    expect(r.okRes.ok).toBe(true);
    if (r.okRes.ok) expect(r.okRes.length).toBe(r.okPayloadLength);
    expect(r.emptyRes.ok).toBe(false);
    if (!r.emptyRes.ok) expect(typeof r.emptyRes.reason).toBe('string');
    expect(r.nonString.ok).toBe(false);
    if (!r.nonString.ok) expect(r.nonString.reason).toBe('payload-not-string');
  });

  test('SUITE SHELL-E — app:logBuffer returns a string[] snapshot bounded by MAX=500', async () => {
    test.setTimeout(15_000);
    const { page } = getHarness();
    const r = await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: { getLogBuffer(): Promise<string[]> };
      };
      return w.giftk.getLogBuffer();
    });
    expect(Array.isArray(r)).toBe(true);
    // The log buffer is bounded; at any point in time it MUST be
    // <= MAX=500 entries (see logger.ts). We only assert the upper
    // bound — the buffer may legitimately be empty on a fresh launch.
    expect(r.length).toBeLessThanOrEqual(500);
    for (const line of r) {
      expect(typeof line).toBe('string');
    }
  });
});
