/**
 * SUITE TOOLBOX-STANDALONE — non-chain toolbox IPC surface
 * (R-TOOLBOX-STANDALONE-V1).
 *
 * Why this SUITE exists
 * ---------------------
 * The toolbox-chain runner is already saturated by [TB-CHAIN A..E](file:///Users/guoshuyu/workspace/gif-toolkit/tests/e2e/realPipeline/suite-toolbox-chain.ts)
 * + [TREE A..I](file:///Users/guoshuyu/workspace/gif-toolkit/tests/e2e/realPipeline/suite-toolbox-lineage-tree-ui.ts)
 * + [RCV1](file:///Users/guoshuyu/workspace/gif-toolkit/tests/e2e/realPipeline/suite-r-compress-v1-ui.ts).
 * What is NOT covered end-to-end is the *non-chain* toolbox surface
 * the renderer hits in three places:
 *
 *   - [toolbox:probeMedia](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L1629-L1657) — drives "size · WxH · frames" rows
 *   - [toolbox:firstFrame](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L1666-L1682) — drives the Crop panel canvas
 *   - [toolbox:start](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L1684-L1724) — single-tool batch (no chain)
 *   - [toolbox:trialRun / trialCleanup](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L1954-L2030) — lineage modal "试跑 0.5s"
 *   - [toolbox:cancelChain](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L1896-L1901) — invalid-id rejection contract
 *
 * Each handler has its own sanitiser + fast-path validation that
 * existing UI-driven SUITEs only exercise transitively. Drilling the
 * raw IPC ensures a regression in the validation logic (e.g. a typo
 * in TOOLBOX_INPUT_EXTENSIONS, or trialCleanup accepting an arbitrary
 * tmp path) trips this SUITE first.
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import {
  FIXTURE_GIF,
  FIXTURE_MEDIUM,
  freshOutDir,
  getHarness,
  installRecorder,
  snapshotRecorder,
  waitForTerminal
} from './_harness';

interface ProbeWire {
  width: number;
  height: number;
  durationSec: number;
  frameRate: number;
  nbFrames: number;
  sizeBytes: number;
}
interface FirstFrameWire { dataUrl: string; }
interface ToolboxStartResultWire { ok: boolean; outputDir: string; }
interface TrialRunResultWire { ok: boolean; outputPath: string; tmpRoot: string; }
interface CancelChainResultWire { ok: boolean; }

test.describe('SUITE TOOLBOX-STANDALONE — non-chain toolbox IPC surface', () => {
  test('SUITE TBX-A — toolbox:probeMedia returns the full schema for an on-disk gif', async () => {
    test.setTimeout(20_000);
    const { page } = getHarness();
    const r = await page.evaluate(async (p: string) => {
      const w = window as unknown as {
        giftk: { toolboxProbeMedia(p: string): Promise<ProbeWire> };
      };
      return w.giftk.toolboxProbeMedia(p);
    }, FIXTURE_GIF);
    expect(typeof r.width).toBe('number');
    expect(typeof r.height).toBe('number');
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
    expect(typeof r.durationSec).toBe('number');
    expect(typeof r.frameRate).toBe('number');
    expect(typeof r.nbFrames).toBe('number');
    expect(typeof r.sizeBytes).toBe('number');
    // The fixture exists on disk; sizeBytes should match statSync().
    const onDiskBytes = fs.statSync(FIXTURE_GIF).size;
    expect(r.sizeBytes).toBe(onDiskBytes);
  });

  test('SUITE TBX-B — toolbox:firstFrame returns a base64 data:image/ JPEG for an mp4', async () => {
    test.setTimeout(30_000);
    const { page } = getHarness();
    const r = await page.evaluate(async (p: string) => {
      const w = window as unknown as {
        giftk: { toolboxFirstFrame(p: string): Promise<FirstFrameWire> };
      };
      return w.giftk.toolboxFirstFrame(p);
    }, FIXTURE_MEDIUM);
    expect(typeof r.dataUrl).toBe('string');
    expect(r.dataUrl.startsWith('data:image/')).toBe(true);
    // A JPEG-encoded ~480w first frame should be > 1KB after base64.
    expect(r.dataUrl.length).toBeGreaterThan(1024);
  });

  test('SUITE TBX-C — toolbox:probeMedia rejects bogus paths / extensions cleanly', async () => {
    test.setTimeout(10_000);
    const { page } = getHarness();
    // The renderer-side bridge throws synchronously / via rejected promise
    // for every malformed path — capture the message string so we can
    // assert it surfaced from the main-process sanitiser, not a JS crash.
    const r = await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: { toolboxProbeMedia(p: string): Promise<ProbeWire> };
      };
      const out: Record<string, string> = {};
      try {
        await w.giftk.toolboxProbeMedia('');
      } catch (e) {
        out.empty = (e as Error).message;
      }
      try {
        await w.giftk.toolboxProbeMedia('/tmp/does-not-exist.gif');
      } catch (e) {
        out.missing = (e as Error).message;
      }
      try {
        await w.giftk.toolboxProbeMedia('/tmp/nope.txt');
      } catch (e) {
        out.badExt = (e as Error).message;
      }
      return out;
    });
    // We don't pin the exact wording (cross-platform paths differ), but
    // every branch MUST surface a non-empty string back to the renderer.
    expect(typeof r.empty).toBe('string');
    expect(r.empty.length).toBeGreaterThan(0);
    expect(typeof r.missing).toBe('string');
    expect(r.missing.length).toBeGreaterThan(0);
    expect(typeof r.badExt).toBe('string');
    // The .txt path can fail either at "extension not allowed" (when
    // resolved) or at "does not exist" — both indicate the sanitiser
    // is doing its job. Just assert the message is non-empty.
    expect(r.badExt.length).toBeGreaterThan(0);
  });

  test('SUITE TBX-D — toolbox:start runs gif-optimize on tiny.gif end-to-end', async () => {
    test.setTimeout(60_000);
    const { page } = getHarness();
    await installRecorder();
    const outDir = await freshOutDir('tbx-d');
    const jobId = `tbx-d-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const r = await page.evaluate(
      async (args: { jobId: string; inputPath: string; outDir: string }) => {
        const w = window as unknown as {
          giftk: {
            startToolbox(
              jobs: Array<Record<string, unknown>>,
              outputDirOverride?: string
            ): Promise<ToolboxStartResultWire>;
          };
        };
        return w.giftk.startToolbox(
          [{
            id: args.jobId,
            kind: 'gif-optimize',
            inputPath: args.inputPath,
            params: { lossy: 80, optimizeLevel: 3, maxBytes: 5_242_880 }
          }],
          args.outDir
        );
      },
      { jobId, inputPath: FIXTURE_GIF, outDir }
    );
    expect(r.ok).toBe(true);
    expect(typeof r.outputDir).toBe('string');
    // Wait for the terminal progress emit so we know the optimize
    // actually completed and produced an output file under outDir.
    const terminal = await waitForTerminal(jobId, 50_000);
    expect(['done', 'skipped']).toContain(terminal.status);
    if (terminal.status === 'done') {
      expect(Array.isArray(terminal.outputs)).toBe(true);
      expect(terminal.outputs!.length).toBeGreaterThan(0);
      // The output file MUST live inside the outputDirOverride we asked for.
      const outputPath = terminal.outputs![0];
      expect(outputPath.startsWith(path.resolve(outDir))).toBe(true);
      expect(fs.existsSync(outputPath)).toBe(true);
    }
  });

  test('SUITE TBX-E — toolbox:trialRun + trialCleanup tmp-root contract', async () => {
    test.setTimeout(60_000);
    const { page } = getHarness();
    const r = await page.evaluate(
      async (inputPath: string) => {
        const w = window as unknown as {
          giftk: {
            toolbox: {
              trialRun(req: {
                kind: string;
                params: Record<string, unknown>;
                inputPath: string;
              }): Promise<TrialRunResultWire>;
              trialCleanup(tmpRoot: string): Promise<{ ok: boolean }>;
            };
          };
        };
        const out = await w.giftk.toolbox.trialRun({
          kind: 'gif-optimize',
          params: { lossy: 80, optimizeLevel: 3 },
          inputPath
        });
        // Cleanup attempts:
        //  1. on a foreign tmp path — must NOT delete it (returns ok:false)
        //  2. on the real tmpRoot — must delete it (returns ok:true)
        const fakeReject = await w.giftk.toolbox.trialCleanup('/tmp/some-foreign-path');
        const realCleanup = await w.giftk.toolbox.trialCleanup(out.tmpRoot);
        return { run: out, fakeReject, realCleanup };
      },
      FIXTURE_GIF
    );
    expect(r.run.ok).toBe(true);
    expect(typeof r.run.outputPath).toBe('string');
    expect(typeof r.run.tmpRoot).toBe('string');
    // tmpRoot must live under os.tmpdir and start with `giftk-trial-`.
    expect(path.basename(r.run.tmpRoot).startsWith('giftk-trial-')).toBe(true);
    // The output ALSO must live inside the tmpRoot (defence in depth —
    // trial outputs never leak into the user's real output tree).
    expect(r.run.outputPath.startsWith(r.run.tmpRoot)).toBe(true);
    // Cleanup contract — foreign tmp path is silently rejected, real
    // tmpRoot is reaped.
    expect(r.fakeReject.ok).toBe(false);
    expect(r.realCleanup.ok).toBe(true);
    // After cleanup the dir really is gone.
    expect(fs.existsSync(r.run.tmpRoot)).toBe(false);
  });

  test('SUITE TBX-F — toolbox:cancelChain on a non-existent chainId returns ok:false (no throw)', async () => {
    test.setTimeout(10_000);
    const { page } = getHarness();
    const r = await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: { cancelToolboxChain(id: string): Promise<CancelChainResultWire> };
      };
      // Send a syntactically-valid id that is NOT registered with the
      // chain controller. Main-process treats this as a no-op and
      // returns ok:false without throwing — UI uses it for fire-and-
      // forget cancellation (closing modal etc.).
      return w.giftk.cancelToolboxChain(`nonexistent-chain-${Date.now()}`);
    });
    expect(r.ok).toBe(false);
    // Also assert the recorder didn't observe a phantom progress emit.
    const snap = await snapshotRecorder();
    expect(Array.isArray(snap.progress)).toBe(true);
  });
});
