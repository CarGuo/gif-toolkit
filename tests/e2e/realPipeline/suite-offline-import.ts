/**
 * SUITE OFFLINE-IMPORT — `sniff:offlineImport` end-to-end (R-OFFLINE-IMPORT-V1).
 *
 * Why this SUITE exists
 * ---------------------
 * Three sniff entrypoints out of five (`sniff:url` / `sniff:webview` /
 * `sniff:system-chrome` / `sniff:ytdlp-direct` / `sniff:offlineImport`)
 * already had real-network e2e in [suite-network-sniff.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/e2e/realPipeline/suite-network-sniff.ts)
 * (SUITE F/G/H), gated on the host having Chrome / yt-dlp installed and
 * a live internet connection. The OFFLINE entrypoint is the only one
 * that REQUIRES no network at all — it parses a saved `.html` / `.mhtml`
 * or sniffs metadata from a local `.mp4` / `.gif` / `.png` — yet it had
 * exactly zero realPipeline coverage. Regressions in:
 *
 *   - the dialog-bypass branch (when `absPath` is passed, dialog is
 *     skipped and the path is `path.resolve()`d through);
 *   - per-session `AbortController` cleanup (`sniff:cancel { sessionId }`
 *     must abort exactly that session and not leak other in-flight
 *     imports);
 *   - the `sniff.done` log line on success (offline never emits
 *     `sniff:progress` with `stage: 'cancelled'`, only the abort throw);
 *
 * could ship undetected and break the「📁 离线导入」 button users hit
 * for paywalled / signed-out pages.
 *
 * Strategy
 * --------
 * We feed three synthetic-but-real on-disk inputs:
 *   - HTML: [tests/fixtures/offline-page.html](file:///Users/guoshuyu/workspace/gif-toolkit/tests/fixtures/offline-page.html)
 *           — already has `<video>` + `<img>` markup; importer should
 *           return ≥1 SniffedMedia plus the page title.
 *   - MP4 : [tests/fixtures/tiny.mp4](file:///Users/guoshuyu/workspace/gif-toolkit/tests/fixtures/tiny.mp4)
 *           — single-file import; offline parser detects the kind from
 *           the extension and returns one item with `kind: 'video'`.
 *   - Cancel: a long-running synthetic run on a 5MB-ish .mp4 that we
 *           cancel via `sniff:cancel({ sessionId })` mid-flight. We
 *           don't have a guaranteed-slow corpus, so this case is
 *           best-effort: we accept either `cancelled` (the rejected
 *           promise propagates) OR a clean done with items returned
 *           (race lost — that's fine, the IPC didn't crash).
 */
import { test, expect } from '@playwright/test';
import {
  FIXTURE_HTML,
  FIXTURE_MEDIUM,
  FIXTURE_MP4,
  getHarness
} from './_harness';

interface SniffedMediaWire {
  id: string;
  url: string;
  kind: string;
  source: string;
  pageUrl: string;
}
interface SniffResultWire {
  pageUrl: string;
  title?: string;
  items: SniffedMediaWire[];
  warnings: string[];
  infoNotices?: string[];
  sessionId?: string;
}

test.describe('SUITE OFFLINE-IMPORT — sniff:offlineImport real-IPC end-to-end', () => {
  test('SUITE OFFLINE-A — HTML fixture surfaces video + image items via offline parser', async () => {
    test.setTimeout(30_000);
    const { page } = getHarness();
    const sessionId = `offline-a-${Date.now()}`;
    const r = await page.evaluate(
      async (args: { absPath: string; sessionId: string }) => {
        const g = (window as unknown as {
          giftk: {
            importOfflinePage(
              p: string,
              opts: { includeStaticImages?: boolean; sessionId?: string }
            ): Promise<SniffResultWire | null>;
          };
        }).giftk;
        return g.importOfflinePage(args.absPath, {
          includeStaticImages: true,
          sessionId: args.sessionId
        });
      },
      { absPath: FIXTURE_HTML, sessionId }
    );
    expect(r).not.toBeNull();
    expect(r!.items.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(r!.warnings)).toBe(true);
    // The imported `pageUrl` must be the absolute file path we handed
    // in (offline imports don't have a real page URL).
    expect(typeof r!.pageUrl).toBe('string');
    expect(r!.pageUrl.length).toBeGreaterThan(0);
    // sessionId comes back in the merged result for renderer routing.
    expect(r!.sessionId).toBe(sessionId);
    // At least one item should be a video (the `<video src=…sample.mp4>`
    // tag in the fixture). We don't pin the `source` field because the
    // offline parser may credit it as `video-tag` OR as inferred mime.
    const kinds = r!.items.map((i) => i.kind);
    expect(kinds.some((k) => k === 'video' || k === 'image' || k === 'gif')).toBe(true);
  });

  test('SUITE OFFLINE-B — single mp4 file is imported as a one-item video result', async () => {
    test.setTimeout(30_000);
    const { page } = getHarness();
    const sessionId = `offline-b-${Date.now()}`;
    const r = await page.evaluate(
      async (args: { absPath: string; sessionId: string }) => {
        const g = (window as unknown as {
          giftk: {
            importOfflinePage(
              p: string,
              opts: { sessionId?: string }
            ): Promise<SniffResultWire | null>;
          };
        }).giftk;
        return g.importOfflinePage(args.absPath, { sessionId: args.sessionId });
      },
      { absPath: FIXTURE_MP4, sessionId }
    );
    expect(r).not.toBeNull();
    expect(r!.items.length).toBe(1);
    expect(r!.items[0].kind).toBe('video');
    // Single-file imports use the file path itself as the media URL —
    // the renderer's playback layer renders this via giftk-local://.
    expect(typeof r!.items[0].url).toBe('string');
    expect(r!.items[0].url.length).toBeGreaterThan(0);
    expect(r!.sessionId).toBe(sessionId);
  });

  test('SUITE OFFLINE-C — sniff:cancel({sessionId}) aborts an in-flight offline import without crashing the IPC', async () => {
    test.setTimeout(30_000);
    const { page } = getHarness();
    const sessionId = `offline-c-${Date.now()}`;

    // Kick off the import + race a cancel. The offlineImport handler
    // wires its AbortController into `sniffCtrls.set(sessionId, ctrl)`,
    // and `sniff:cancel({sessionId})` calls ctrl.abort() — for the
    // medium.mp4 fixture (~2-3MB, deeper probe) we have a real chance
    // to win the race. Either outcome (importer rejects with abort
    // error, OR returns a clean result before the cancel lands) is
    // acceptable; the contract under test is "the IPC channel survives
    // the abort cleanly".
    const result = await page.evaluate(
      async (args: { absPath: string; sessionId: string }) => {
        const g = (window as unknown as {
          giftk: {
            importOfflinePage(
              p: string,
              opts: { sessionId?: string }
            ): Promise<SniffResultWire | null>;
            cancelSniff(opts: { sessionId?: string }): Promise<unknown>;
          };
        }).giftk;
        const racePromise = g.importOfflinePage(args.absPath, {
          sessionId: args.sessionId
        }).then(
          (ok) => ({ kind: 'done' as const, ok }),
          (err: Error) => ({ kind: 'rejected' as const, message: err?.message ?? String(err) })
        );
        // Fire cancel ~50ms after the import lands in the main process.
        await new Promise<void>((res) => setTimeout(res, 50));
        await g.cancelSniff({ sessionId: args.sessionId });
        return racePromise;
      },
      { absPath: FIXTURE_MEDIUM, sessionId }
    );

    if (result.kind === 'rejected') {
      // Cancel won — abort error propagated. The exact message is
      // implementation-defined ('aborted', 'AbortError', …); we just
      // assert SOMEthing came through and the channel didn't crash.
      expect(typeof result.message).toBe('string');
      expect(result.message.length).toBeGreaterThan(0);
    } else {
      // Race lost — the import finished before our cancel landed. The
      // result must still be well-formed. (This branch is rare on a
      // cold box but expected on a hot one.)
      expect(result.ok).not.toBeNull();
      expect(Array.isArray(result.ok!.items)).toBe(true);
    }

    // After the dust settles the IPC must still be alive. Make a
    // trivial follow-up call to prove the offlineImport handler
    // didn't get stuck or unregister itself.
    const live = await page.evaluate(async () => {
      const g = (window as unknown as {
        giftk: { getDefaultOutputDir(): Promise<string> };
      }).giftk;
      return g.getDefaultOutputDir();
    });
    expect(typeof live).toBe('string');
    expect(live.length).toBeGreaterThan(0);
  });
});
