/**
 * R-COVERAGE-REAL-SCENARIO — SMOKE layer entry point.
 *
 * Why this spec exists
 * --------------------
 * The realPipeline.spec.ts file builds 122 contract-style tests
 * around isolated IPC channels: schema locks, error-string regexes,
 * abort idempotence, etc. None of them drives a single user flow
 * end-to-end across all three pipeline stages
 *   sniff (offline import) → process (real ffmpeg/gifsicle) → upload
 * in one continuous run. The user observed (correctly) that the
 * earlier "coverage sprints" optimised the contract surface without
 * exercising one fully wired user journey, so this SMOKE layer
 * exists to cover exactly that journey end-to-end.
 *
 * Why a separate spec (not a SUITE under realPipeline.spec.ts)
 * -----------------------------------------------------------
 *   - We need the Electron main process to launch with
 *     `GIFTK_E2E_MOCK_UPLOAD=1` so `dispatchUpload` short-circuits
 *     into the mock-OSS backend (commit ❶). Threading that env into
 *     the realPipeline launch would also re-route SUITE UPLOAD-FULL
 *     (which deliberately drives the real customWeb backend against
 *     a localhost http server) and break it. A separate spec means
 *     a separate Electron handle with its own env, and zero risk of
 *     cross-suite drift.
 *
 *   - The smoke layer is SLOW per case (real ffmpeg ~5-10s + real
 *     fs round-trips). Putting it under its own spec lets package.json
 *     expose `test:e2e:fast` (= the 122-case contract layer) and
 *     `test:e2e:smoke` (= this spec) as separate runs (commit ❸).
 *
 *   - Playwright's `testDir: './tests/e2e'` (configured in
 *     [playwright.config.ts](file:///Users/guoshuyu/workspace/gif-toolkit/playwright.config.ts))
 *     means files under `tests/e2e-smoke/` are NOT picked up by the
 *     default `npm run test:e2e` runner. So this spec is invisible
 *     until commit ❸ wires up `playwright.smoke.config.ts`.
 *
 * What we test (SMOKE-S1-FULL)
 * ----------------------------
 *   S1-FULL-A — offlineImport(tiny.mp4) → startBatch(real ffmpeg) →
 *               uploadStart(mock-oss) → assert mock-oss URL on
 *               terminal upload progress.
 *
 *   S1-FULL-B — same chain + db.uploadHistory.upsert(...) +
 *               db.uploadHistory.readAll() round-trip → asserts
 *               the row reaches SQLite and round-trips back with
 *               the mock-oss URL preserved (this models what the
 *               useUploadOrchestrator hook does after a real
 *               upload and is what feeds UploadHistoryPanel).
 */
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'dist/main/index.js');
const FIXTURES_DIR = path.join(REPO_ROOT, 'tests/fixtures');
const FIXTURE_MP4 = path.join(FIXTURES_DIR, 'tiny.mp4');

const MOCK_URL_RX = /^mock-oss:\/\/[a-f0-9]{8}\.[a-z0-9]+$/;

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
  sessionId?: string;
}
interface ProgressWire {
  taskId: string;
  status: string;
  percent: number;
  outputs?: string[];
  error?: string;
  message?: string;
}
interface UploadProgressWire {
  jobId: string;
  status: 'queued' | 'uploading' | 'done' | 'failed' | 'cancelled';
  percent: number;
  url?: string;
  error?: string;
}
interface UploadHistoryItemWire {
  jobId: string;
  filePath: string;
  fileName: string;
  status: string;
  url?: string;
  markdown?: string;
}
interface UploadHistoryRowWire {
  id: string;
  createdAt: number;
  backend: string;
  items: UploadHistoryItemWire[];
}

let app: ElectronApplication;
let page: Page;
let defaultOutDir: string;

test.describe.configure({ timeout: 120_000 });

test.beforeAll(async () => {
  app = await _electron.launch({
    args: [MAIN_ENTRY],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      // R-COVERAGE-REAL-SCENARIO — opt mock-oss backend in for THIS
      // Electron handle only. backends.ts/dispatchUpload will route
      // every upload to mockOss.uploadMockOss as long as the app is
      // un-packaged (which is always true under playwright).
      GIFTK_E2E_MOCK_UPLOAD: '1'
    }
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.app', { timeout: 30_000 });

  defaultOutDir = await page.evaluate(async () => {
    const g = (window as unknown as { giftk: { getDefaultOutputDir(): Promise<string> } }).giftk;
    return g.getDefaultOutputDir();
  });
  if (!defaultOutDir) throw new Error('default output directory unavailable');
});

test.afterAll(async () => {
  if (app) await app.close();
});

function freshOutDir(label: string): string {
  const dir = path.join(defaultOutDir, `giftk-smoke-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function installRecorders(): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __smoke?: {
        progress: ProgressWire[];
        upload: UploadProgressWire[];
        offProgress?: () => void;
        offUpload?: () => void;
      };
      giftk: {
        onProgress(cb: (p: ProgressWire) => void): () => void;
        onUploadProgress(cb: (p: UploadProgressWire) => void): () => void;
      };
    };
    if (w.__smoke?.offProgress) w.__smoke.offProgress();
    if (w.__smoke?.offUpload) w.__smoke.offUpload();
    const buf = { progress: [] as ProgressWire[], upload: [] as UploadProgressWire[] };
    const offProgress = w.giftk.onProgress((p) => { buf.progress.push(p); });
    const offUpload = w.giftk.onUploadProgress((p) => { buf.upload.push(p); });
    w.__smoke = { ...buf, offProgress, offUpload };
  });
}

async function tearDownRecorders(): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __smoke?: { offProgress?: () => void; offUpload?: () => void };
    };
    if (w.__smoke?.offProgress) w.__smoke.offProgress();
    if (w.__smoke?.offUpload) w.__smoke.offUpload();
    w.__smoke = undefined;
  });
}

async function snapshotRecorders(): Promise<{ progress: ProgressWire[]; upload: UploadProgressWire[] }> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __smoke?: { progress: ProgressWire[]; upload: UploadProgressWire[] };
    };
    const e = w.__smoke;
    if (!e) return { progress: [], upload: [] };
    return {
      progress: JSON.parse(JSON.stringify(e.progress)) as ProgressWire[],
      upload: JSON.parse(JSON.stringify(e.upload)) as UploadProgressWire[]
    };
  });
}

async function waitForProcessTerminal(taskId: string, timeoutMs: number): Promise<ProgressWire> {
  const start = Date.now();
  const terminalSet = new Set(['done', 'failed', 'cancelled', 'skipped']);
  while (Date.now() - start < timeoutMs) {
    const snap = await snapshotRecorders();
    const last = [...snap.progress].reverse().find((p) => p.taskId === taskId && terminalSet.has(p.status));
    if (last) return last;
    await page.waitForTimeout(200);
  }
  throw new Error(`smoke: process terminal timeout for ${taskId} after ${timeoutMs}ms`);
}

async function waitForUploadTerminal(jobId: string, timeoutMs: number): Promise<UploadProgressWire> {
  const start = Date.now();
  const terminalSet = new Set(['done', 'failed', 'cancelled']);
  while (Date.now() - start < timeoutMs) {
    const snap = await snapshotRecorders();
    const last = [...snap.upload].reverse().find((p) => p.jobId === jobId && terminalSet.has(p.status));
    if (last) return last;
    await page.waitForTimeout(150);
  }
  throw new Error(`smoke: upload terminal timeout for ${jobId} after ${timeoutMs}ms`);
}

test.describe('SUITE SMOKE-S1-FULL — offline-import → process → mock-oss upload', () => {
  test('SMOKE-S1-FULL-A — full pipeline: offlineImport(mp4) → startBatch → uploadStart → mock-oss URL', async () => {
    test.setTimeout(120_000);
    await installRecorders();
    const outDir = freshOutDir('S1A');
    try {
      // STAGE 1 — offline import. The OFFLINE-B contract case in
      // suite-offline-import.ts already locks the shape of this call;
      // here we use it as the entry point of a real user journey
      // (rather than re-asserting its schema).
      const sniff = await page.evaluate(
        async (absPath: string): Promise<SniffResultWire | null> => {
          const g = (window as unknown as {
            giftk: {
              importOfflinePage(p: string, opts: { sessionId?: string }): Promise<SniffResultWire | null>;
            };
          }).giftk;
          return g.importOfflinePage(absPath, { sessionId: `smoke-s1a-${Date.now()}` });
        },
        FIXTURE_MP4
      );
      expect(sniff).not.toBeNull();
      expect(sniff!.items.length).toBeGreaterThanOrEqual(1);
      const videoItem = sniff!.items.find((i) => i.kind === 'video');
      expect(videoItem).toBeTruthy();

      // STAGE 2 — startBatch. Use the sniffed media verbatim so the
      // chain spans both stages without manual coupling.
      const taskId = `smoke-s1a-${Date.now()}`;
      await page.evaluate(
        async (args: { item: SniffedMediaWire; outDir: string; taskId: string }) => {
          const g = (window as unknown as {
            giftk: { startBatch(tasks: unknown[]): Promise<{ ok: boolean; outputDir: string }> };
          }).giftk;
          await g.startBatch([{
            id: args.taskId,
            media: {
              id: args.taskId,
              url: args.item.url,
              kind: args.item.kind,
              source: args.item.source,
              pageUrl: args.item.pageUrl,
              width: 240,
              height: 180,
              durationSec: 1
            },
            options: {
              outDir: args.outDir,
              fps: 8, maxWidth: 120,
              maxBytes: 256_000, softMaxBytes: 128_000,
              minSize: 96, speed: 1, maxSegmentSec: 60,
              lossyCeiling: 80, colorsFloor: 64, optimizeLevel: 3,
              dither: 'floyd-steinberg'
            }
          }]);
        },
        { item: videoItem!, outDir, taskId }
      );
      const procTerm = await waitForProcessTerminal(taskId, 90_000);
      expect(procTerm.status).toBe('done');
      const outputs = procTerm.outputs ?? [];
      expect(outputs.length).toBeGreaterThanOrEqual(1);
      const outputPath = outputs[0];
      expect(existsSync(outputPath)).toBe(true);

      // STAGE 3 — uploadStart against the mock-oss backend. Configure
      // customWeb as the active backend (any backend works — the mock
      // short-circuit pre-empts the switch in dispatchUpload). We do
      // need to point customWeb at SOMETHING parseable to satisfy the
      // sanitiser even though the request is never made.
      await page.evaluate(async () => {
        const g = (window as unknown as {
          giftk: { uploadSetSettings(c: unknown): Promise<{ ok: boolean }> };
        }).giftk;
        await g.uploadSetSettings({
          active: 'customWeb',
          maxConcurrent: 1,
          maxRetries: 0,
          customWeb: {
            url: 'http://localhost:0/never-actually-called',
            urlPath: 'url',
            fileField: 'file',
            headers: {}
          }
        });
      });

      const jobId = `smoke-s1a-job-${Date.now()}`;
      await page.evaluate(
        async (args: { jobId: string; filePath: string }) => {
          const g = (window as unknown as {
            giftk: { uploadStart(p: unknown): Promise<{ ok: boolean; jobIds: string[] }> };
          }).giftk;
          await g.uploadStart({ jobs: [{ id: args.jobId, filePath: args.filePath }] });
        },
        { jobId, filePath: outputPath }
      );

      const upTerm = await waitForUploadTerminal(jobId, 30_000);
      expect(upTerm.status).toBe('done');
      expect(typeof upTerm.url).toBe('string');
      // The crown-jewel assertion: every byte travelled through the
      // mock-oss backend, and the resulting URL is the deterministic
      // sha8 form. If this regex ever drifts, mockOss.ts shape is
      // either broken or the dispatcher short-circuit was bypassed.
      expect(upTerm.url!).toMatch(MOCK_URL_RX);
    } finally {
      await tearDownRecorders();
      try { rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('SMOKE-S1-FULL-B — same chain + db.uploadHistory upsert/readAll round-trips the mock-oss URL', async () => {
    test.setTimeout(120_000);
    await installRecorders();
    const outDir = freshOutDir('S1B');
    try {
      // Stages 1+2 — re-use the exact pattern from S1-FULL-A but with
      // an outDir tagged `S1B` so the two cases never share artifacts
      // (uploader sha256-dedup would otherwise short-circuit the
      // second upload before mock-oss even runs).
      const sniff = await page.evaluate(
        async (absPath: string): Promise<SniffResultWire | null> => {
          const g = (window as unknown as {
            giftk: {
              importOfflinePage(p: string, opts: { sessionId?: string }): Promise<SniffResultWire | null>;
            };
          }).giftk;
          return g.importOfflinePage(absPath, { sessionId: `smoke-s1b-${Date.now()}` });
        },
        FIXTURE_MP4
      );
      expect(sniff).not.toBeNull();
      const videoItem = sniff!.items.find((i) => i.kind === 'video');
      expect(videoItem).toBeTruthy();

      const taskId = `smoke-s1b-${Date.now()}`;
      await page.evaluate(
        async (args: { item: SniffedMediaWire; outDir: string; taskId: string }) => {
          const g = (window as unknown as {
            giftk: { startBatch(tasks: unknown[]): Promise<{ ok: boolean; outputDir: string }> };
          }).giftk;
          await g.startBatch([{
            id: args.taskId,
            media: {
              id: args.taskId,
              url: args.item.url,
              kind: args.item.kind,
              source: args.item.source,
              pageUrl: args.item.pageUrl,
              width: 240, height: 180, durationSec: 1
            },
            options: {
              outDir: args.outDir,
              fps: 8, maxWidth: 100,
              maxBytes: 200_000, softMaxBytes: 100_000,
              minSize: 80, speed: 1, maxSegmentSec: 60,
              lossyCeiling: 80, colorsFloor: 64, optimizeLevel: 3,
              dither: 'floyd-steinberg'
            }
          }]);
        },
        { item: videoItem!, outDir, taskId }
      );
      const procTerm = await waitForProcessTerminal(taskId, 90_000);
      expect(procTerm.status).toBe('done');
      const outputPath = (procTerm.outputs ?? [])[0];
      expect(existsSync(outputPath)).toBe(true);

      // Stage 3 — upload (mock-oss).
      await page.evaluate(async () => {
        const g = (window as unknown as {
          giftk: { uploadSetSettings(c: unknown): Promise<{ ok: boolean }> };
        }).giftk;
        await g.uploadSetSettings({
          active: 'customWeb',
          maxConcurrent: 1,
          maxRetries: 0,
          customWeb: {
            url: 'http://localhost:0/never-actually-called',
            urlPath: 'url',
            fileField: 'file',
            headers: {}
          }
        });
      });
      const jobId = `smoke-s1b-job-${Date.now()}`;
      await page.evaluate(
        async (args: { jobId: string; filePath: string }) => {
          const g = (window as unknown as {
            giftk: { uploadStart(p: unknown): Promise<{ ok: boolean; jobIds: string[] }> };
          }).giftk;
          await g.uploadStart({ jobs: [{ id: args.jobId, filePath: args.filePath }] });
        },
        { jobId, filePath: outputPath }
      );
      const upTerm = await waitForUploadTerminal(jobId, 30_000);
      expect(upTerm.status).toBe('done');
      expect(upTerm.url!).toMatch(MOCK_URL_RX);

      // Stage 4 — Persist the row through the same db IPC the
      // useUploadOrchestrator hook uses. This proves the upload
      // history → SQLite → readAll path is also wired in mock mode,
      // which is what feeds UploadHistoryPanel after a real upload.
      const recordId = `smoke-s1b-rec-${Date.now()}`;
      const fileName = path.basename(outputPath);
      await page.evaluate(
        async (args: { rec: UploadHistoryRowWire }) => {
          const g = (window as unknown as {
            giftk: { db: { uploadHistory: { upsert(r: unknown): Promise<void> } } };
          }).giftk;
          await g.db.uploadHistory.upsert(args.rec);
        },
        {
          rec: {
            id: recordId,
            createdAt: Date.now(),
            backend: 'customWeb',
            items: [{
              jobId,
              filePath: outputPath,
              fileName,
              status: 'done',
              url: upTerm.url!,
              markdown: `![${fileName}](${upTerm.url!})`
            }]
          }
        }
      );

      const rows = await page.evaluate(async () => {
        const g = (window as unknown as {
          giftk: { db: { uploadHistory: { readAll(): Promise<UploadHistoryRowWire[]> } } };
        }).giftk;
        return g.db.uploadHistory.readAll();
      });
      const found = rows.find((r) => r.id === recordId);
      expect(found).toBeTruthy();
      expect(found!.items.length).toBe(1);
      expect(found!.items[0].url).toMatch(MOCK_URL_RX);
      expect(found!.items[0].url).toBe(upTerm.url!);
      expect(found!.items[0].status).toBe('done');

      // Cleanup the row we wrote so the user's local SQLite is
      // unchanged after the smoke run. Failures are swallowed —
      // it's a per-row best-effort tidy, not the assertion.
      await page.evaluate(async (id: string) => {
        const g = (window as unknown as {
          giftk: { db: { uploadHistory: { remove(id: string): Promise<void> } } };
        }).giftk;
        try { await g.db.uploadHistory.remove(id); } catch { /* ignore */ }
      }, recordId);
    } finally {
      await tearDownRecorders();
      try { rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
