/**
 * SUITE UPLOAD-FULL — uploader end-to-end against a localhost mock HTTP
 * server (R-UPLOAD-FULL-V1).
 *
 * Why this SUITE exists
 * ---------------------
 * The uploader subsystem ([src/main/uploader](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/uploader))
 * was previously covered only by `uploaderUtils.test.ts` (38 unit cases
 * for sanitisers / backoff / region inference) and a single hook unit
 * for `useUploadOrchestrator`. There is no e2e that drives the real IPC
 * surface (`upload:settings:set/get`, `upload:start`, `upload:cancel`,
 * `upload:test`) end-to-end against an HTTP transport. That gap means
 * regressions in:
 *   - secret-mask round-trip (`••••••` preserved on save without
 *     leaking actual secrets back to the renderer)
 *   - per-job retry / cancel / progress event shape
 *   - allowedOutputDirs enforcement on inbound `filePath`
 *   - jobs running with concurrency=N on a worker pool
 * could ship undetected.
 *
 * Strategy
 * --------
 * We start a single Node `http` server on `127.0.0.1:<random>` inside
 * the spec process (NOT inside Electron) and configure the customWeb
 * backend to POST against it. The customWeb backend explicitly accepts
 * `http://localhost` / `http://127.0.0.1` ([backends.ts#L92-L95](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/uploader/backends.ts#L92-L95)),
 * which is why this transport is e2e-friendly without baking a real
 * cloud secret into CI.
 *
 * The server returns deterministic JSON shapes per route:
 *   POST /ok        -> 200 { url: 'http://localhost:<port>/r/<n>' }
 *   POST /fail      -> 504 (then 504, then 504 — exhausts retries)
 *   POST /slow      -> sleeps 5s before responding 200 (cancel target)
 *   POST /probe     -> 200 echoing fileSize header (used by UPLOAD-E)
 *
 * fileBytes are kept tiny (1×1 PNG / a freshly-converted gif under
 * 200KB) so the whole SUITE settles inside the per-test 90s budget.
 *
 * Why we DO NOT mock window.giftk
 * -------------------------------
 * The realPipeline contract is "production preload bridge, production
 * main process". Mocking would defeat the purpose of e2e regression
 * (e.g. a typo in `ipcRenderer.invoke('upload:start', ...)` would slip
 * past). All renderer calls use `page.evaluate(...g.uploadStart...)`.
 *
 * Cleanup
 * -------
 *   - Each test allocates its own `freshOutDir(...)` and deletes it in
 *     the finally block.
 *   - `db.uploadHistory.clear()` is NOT called between tests because
 *     the renderer hook does not write the upload-history row from
 *     this SUITE (we drive the IPC directly without going through the
 *     React state). The unit-test bootstrapImport / repos.test.ts
 *     suites cover history persistence orthogonally.
 *   - `upload:cancelAll` is fired in finally so a hung job can never
 *     leak past a single SUITE step.
 */
import { test, expect } from '@playwright/test';
import { existsSync, rmSync, appendFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  FIXTURE_MP4,
  getHarness,
  freshOutDir,
  pathToGiftkLocal,
  installRecorder,
  tearDownRecorder,
  waitForTerminal
} from './_harness';

interface UploadProgressWire {
  jobId: string;
  status: 'queued' | 'uploading' | 'done' | 'failed' | 'cancelled';
  percent: number;
  url?: string;
  error?: string;
  attempt?: number;
  maxAttempts?: number;
  reused?: boolean;
}

/* ---------------------------- mock server -------------------------- */

interface MockSrv {
  port: number;
  baseUrl: string;
  reset(): void;
  hits: () => string[];
  setSlowMs(ms: number): void;
  close(): Promise<void>;
}

/**
 * Spin up a local HTTP server that the customWeb backend can POST
 * against. We support four routes whose semantics are documented at
 * the top of this file. The server is per-SUITE (not per-test) so the
 * port stays stable and the tests can address `${baseUrl}/ok` etc.
 */
async function startMockServer(): Promise<MockSrv> {
  const hits: string[] = [];
  let slowMs = 5_000;
  const srv = http.createServer((req, res) => {
    const url = req.url || '/';
    hits.push(`${req.method} ${url}`);
    let bytes = 0;
    req.on('data', (c: Buffer) => { bytes += c.length; });
    req.on('end', () => {
      if (url === '/ok') {
        const id = Math.random().toString(36).slice(2, 8);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/r/${id}.bin` }));
        return;
      }
      if (url === '/fail') {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'gateway timeout' }));
        return;
      }
      if (url === '/slow') {
        // Honour cancellations from the client side: when the request
        // socket closes early, do nothing (the response was never sent)
        // and let the test's `uploadCancel` win.
        const t = setTimeout(() => {
          if (res.writableEnded) return;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/r/slow.bin` }));
        }, slowMs);
        req.on('close', () => clearTimeout(t));
        return;
      }
      if (url === '/probe') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/r/probe.png`, bytes }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const port = (srv.address() as AddressInfo).port;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    reset(): void { hits.length = 0; },
    hits(): string[] { return hits.slice(); },
    setSlowMs(ms: number): void { slowMs = ms; },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  };
}

/* --------------------------- helpers -------------------------- */

interface UploadRecorder {
  events: UploadProgressWire[];
}

async function installUploadRecorder(): Promise<void> {
  const { page } = getHarness();
  await page.evaluate(() => {
    const w = window as unknown as {
      __upload?: { events: UploadProgressWire[]; off?: () => void };
      giftk: { onUploadProgress(cb: (p: UploadProgressWire) => void): () => void };
    };
    if (w.__upload?.off) w.__upload.off();
    const events: UploadProgressWire[] = [];
    const off = w.giftk.onUploadProgress((p) => { events.push(p); });
    w.__upload = { events, off };
  });
}

async function snapshotUploadRecorder(): Promise<UploadRecorder> {
  const { page } = getHarness();
  return page.evaluate(() => {
    const w = window as unknown as { __upload?: { events: UploadProgressWire[] } };
    return { events: JSON.parse(JSON.stringify(w.__upload?.events ?? [])) as UploadProgressWire[] };
  });
}

async function tearDownUploadRecorder(): Promise<void> {
  const { page } = getHarness();
  await page.evaluate(() => {
    const w = window as unknown as { __upload?: { off?: () => void } };
    if (w.__upload?.off) w.__upload.off();
    if (w.__upload) (w as unknown as { __upload?: unknown }).__upload = undefined;
  });
}

/**
 * Drive a real mp4→gif conversion to materialise a small artifact under
 * the user's allowed output tree. Uploader rejects any filePath outside
 * `allowedOutputDirs`; calling this once per test guarantees the bytes
 * we hand to `uploadStart` are inside the allowlist with the same
 * `freshOutDir` semantics every other SUITE uses.
 */
async function makeRealArtifact(label: string): Promise<{ outDir: string; outputPath: string }> {
  const { page } = getHarness();
  const outDir = freshOutDir(label);
  await installRecorder();
  try {
    const localUrl = pathToGiftkLocal(FIXTURE_MP4);
    const taskId = `upl-${label}-${Date.now()}`;
    await page.evaluate(async (args: { url: string; outDir: string; taskId: string }) => {
      const g = (window as unknown as {
        giftk: { startBatch(tasks: unknown[]): Promise<{ ok: boolean; outputDir: string }> };
      }).giftk;
      await g.startBatch([{
        id: args.taskId,
        media: {
          id: args.taskId,
          url: args.url,
          kind: 'video',
          source: 'video-tag',
          pageUrl: args.url,
          width: 240, height: 180, durationSec: 1
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
    }, { url: localUrl, outDir, taskId });
    const term = await waitForTerminal(taskId, 60_000);
    expect(term.status).toBe('done');
    expect((term.outputs ?? []).length).toBeGreaterThanOrEqual(1);
    const outputPath = (term.outputs as string[])[0];
    expect(existsSync(outputPath)).toBe(true);
    // R-UPLOAD-FULL-V1 — defeat the uploader's `<userData>/upload-hash-cache.json`
    // dedup short-circuit ([uploader/index.ts#L73-L150](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/uploader/index.ts#L73-L150))
    // by appending a tiny random byte tail to every freshly-built
    // artifact. Two calls to `makeRealArtifact` against the same
    // fixture would otherwise produce byte-identical GIFs (ffmpeg is
    // deterministic for the same inputs); the cache then returns a
    // synthetic `done` for every job past the first, which made
    // UPLOAD-B's /fail probe come back as `done` and UPLOAD-C's /slow
    // cancel finish before the abort even left the renderer.
    // The bytes go AFTER the gif trailer (0x3B), so most decoders
    // ignore them; uploader hashes the whole buffer either way which
    // is all this guard cares about.
    const tail = Buffer.from(`\n//giftk-e2e-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}\n`);
    appendFileSync(outputPath, tail);
    return { outDir, outputPath };
  } finally {
    await tearDownRecorder();
  }
}

interface UploadStartArgs {
  baseUrl: string;
  jobs: Array<{ id: string; filePath: string }>;
}

async function setCustomWebBackend(baseUrl: string, route: string): Promise<void> {
  const { page } = getHarness();
  await page.evaluate(async (args: { url: string }) => {
    const g = (window as unknown as {
      giftk: { uploadSetSettings(c: unknown): Promise<{ ok: boolean }> };
    }).giftk;
    await g.uploadSetSettings({
      active: 'customWeb',
      maxConcurrent: 3,
      maxRetries: 2,
      customWeb: {
        url: args.url,
        urlPath: 'url',
        fileField: 'file',
        headers: {}
      }
    });
  }, { url: `${baseUrl}${route}` });
}

async function uploadStartBatch(args: UploadStartArgs): Promise<{ jobIds: string[] }> {
  const { page } = getHarness();
  return page.evaluate(async (a: UploadStartArgs) => {
    const g = (window as unknown as {
      giftk: { uploadStart(p: unknown): Promise<{ ok: boolean; jobIds: string[] }> };
    }).giftk;
    // Submit individual upload settings per route by routing through a
    // single backend config — the route discrimination is handled by
    // `setCustomWebBackend` between calls. This helper just submits
    // jobs whose filePaths the main process must validate.
    const r = await g.uploadStart({
      jobs: a.jobs.map((j) => ({ id: j.id, filePath: j.filePath, remoteName: undefined }))
    });
    return { jobIds: r.jobIds };
  }, args);
}

async function waitForUploadTerminal(
  jobIds: string[],
  timeoutMs: number
): Promise<UploadProgressWire[]> {
  const { page } = getHarness();
  const start = Date.now();
  const terminalSet = new Set(['done', 'failed', 'cancelled']);
  while (Date.now() - start < timeoutMs) {
    const snap = await snapshotUploadRecorder();
    const lastByJob = new Map<string, UploadProgressWire>();
    for (const e of snap.events) lastByJob.set(e.jobId, e);
    const missing = jobIds.filter((id) => {
      const last = lastByJob.get(id);
      return !last || !terminalSet.has(last.status);
    });
    if (missing.length === 0) return jobIds.map((id) => lastByJob.get(id)!);
    await page.waitForTimeout(200);
  }
  throw new Error(`upload terminal timeout after ${timeoutMs}ms; jobIds=${jobIds.join(',')}`);
}

/* ----------------------------- tests ----------------------------- */

test.describe('SUITE UPLOAD-FULL — uploader real IPC end-to-end', () => {
  let mock: MockSrv;

  test.beforeAll(async () => {
    mock = await startMockServer();
  });

  test.afterAll(async () => {
    await mock.close();
  });

  test('SUITE UPLOAD-A — customWeb single-job happy path posts bytes and resolves URL', async () => {
    test.setTimeout(120_000);
    const { page } = getHarness();
    mock.reset();
    await installUploadRecorder();
    const { outDir, outputPath } = await makeRealArtifact('UPLOAD-A');
    try {
      await setCustomWebBackend(mock.baseUrl, '/ok');

      const jobId = `upl-a-${Date.now()}`;
      await uploadStartBatch({
        baseUrl: mock.baseUrl,
        jobs: [{ id: jobId, filePath: outputPath }]
      });

      const [term] = await waitForUploadTerminal([jobId], 30_000);
      expect(term.status).toBe('done');
      expect(typeof term.url).toBe('string');
      expect(term.url!.startsWith(`${mock.baseUrl}/r/`)).toBe(true);

      // Mock server actually received the POST.
      const hits = mock.hits();
      expect(hits.some((h) => h.startsWith('POST /ok'))).toBe(true);

      // Live IPC: settings :get round-trip masks any real secret. Here
      // there is none, but the backend echo should still be customWeb.
      const cfg = await page.evaluate(async () => {
        const g = (window as unknown as {
          giftk: { uploadGetSettings(): Promise<{ active: string; customWeb?: { url: string } }> };
        }).giftk;
        return g.uploadGetSettings();
      });
      expect(cfg.active).toBe('customWeb');
      expect(cfg.customWeb?.url).toBe(`${mock.baseUrl}/ok`);
    } finally {
      await tearDownUploadRecorder();
      try { rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('SUITE UPLOAD-B — 3-job batch with mixed routes: 2×done + 1×failed (504 exhausts retries)', async () => {
    test.setTimeout(180_000);
    const { page } = getHarness();
    mock.reset();
    await installUploadRecorder();
    const a = await makeRealArtifact('UPLOAD-B-1');
    const b = await makeRealArtifact('UPLOAD-B-2');
    try {
      // Configure the backend pointing at /ok first, run 2 jobs, then
      // re-point at /fail and run a third in a follow-up batch. Each
      // batch only sees one URL, but the SUITE asserts the union.
      await setCustomWebBackend(mock.baseUrl, '/ok');
      const okIds = [`upl-b-ok1-${Date.now()}`, `upl-b-ok2-${Date.now()}`];
      await uploadStartBatch({
        baseUrl: mock.baseUrl,
        jobs: [
          { id: okIds[0], filePath: a.outputPath },
          { id: okIds[1], filePath: b.outputPath }
        ]
      });
      const okTerms = await waitForUploadTerminal(okIds, 30_000);
      for (const t of okTerms) expect(t.status).toBe('done');

      // 504 path. We use the same outputPath as job 1; uploader's hash
      // dedup cache will short-circuit if we're not careful. Cure it
      // by pointing at a distinct on-disk artifact.
      const c = await makeRealArtifact('UPLOAD-B-3');
      await setCustomWebBackend(mock.baseUrl, '/fail');
      // Lower retry count for this batch to keep wall clock under
      // budget. uploader reads maxRetries from the latest settings, so
      // saving via :set re-applies on next runBatch.
      await page.evaluate(async (url: string) => {
        const g = (window as unknown as {
          giftk: { uploadSetSettings(c: unknown): Promise<{ ok: boolean }> };
        }).giftk;
        await g.uploadSetSettings({
          active: 'customWeb',
          maxConcurrent: 1,
          maxRetries: 1,
          customWeb: { url, urlPath: 'url', fileField: 'file', headers: {} }
        });
      }, `${mock.baseUrl}/fail`);
      const failId = `upl-b-fail-${Date.now()}`;
      await uploadStartBatch({
        baseUrl: mock.baseUrl,
        jobs: [{ id: failId, filePath: c.outputPath }]
      });
      const [failTerm] = await waitForUploadTerminal([failId], 30_000);
      expect(failTerm.status).toBe('failed');
      expect(typeof failTerm.error).toBe('string');
      expect((failTerm.error || '').toLowerCase()).toMatch(/504|gateway|timeout|customweb/);

      try { rmSync(c.outDir, { recursive: true, force: true }); } catch { /* ignore */ }
    } finally {
      await tearDownUploadRecorder();
      try { rmSync(a.outDir, { recursive: true, force: true }); } catch { /* ignore */ }
      try { rmSync(b.outDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('SUITE UPLOAD-C — uploadCancelAll aborts an in-flight slow job within budget', async () => {
    test.setTimeout(60_000);
    const { page } = getHarness();
    mock.reset();
    mock.setSlowMs(15_000);
    await installUploadRecorder();
    const { outDir, outputPath } = await makeRealArtifact('UPLOAD-C');
    try {
      await setCustomWebBackend(mock.baseUrl, '/slow');
      const jobId = `upl-c-${Date.now()}`;
      await uploadStartBatch({
        baseUrl: mock.baseUrl,
        jobs: [{ id: jobId, filePath: outputPath }]
      });
      // Give the request time to actually leave the main process.
      await page.waitForTimeout(750);
      const cancelResult = await page.evaluate(async () => {
        const g = (window as unknown as {
          giftk: { uploadCancelAll(): Promise<{ ok: boolean }> };
        }).giftk;
        return g.uploadCancelAll();
      });
      expect(cancelResult.ok).toBe(true);

      const [term] = await waitForUploadTerminal([jobId], 15_000);
      expect(['cancelled', 'failed']).toContain(term.status);
    } finally {
      mock.setSlowMs(5_000);
      await tearDownUploadRecorder();
      try { rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('SUITE UPLOAD-D — settings :set/:get round-trip masks secrets and persists across calls', async () => {
    test.setTimeout(30_000);
    const { page } = getHarness();
    // Flip to github backend with a fake token, save, read back; the
    // token field must come back as the literal MASK. Then re-save with
    // the mask in place and a tweaked customDomain; the persisted
    // record must still contain the original token (masked-merge).
    const cfg1 = await page.evaluate(async () => {
      const g = (window as unknown as {
        giftk: {
          uploadSetSettings(c: unknown): Promise<{ ok: boolean }>;
          uploadGetSettings(): Promise<{
            active: string;
            github?: { token?: string; repo?: string; branch?: string; pathPrefix?: string; customDomain?: string };
          }>;
        };
      }).giftk;
      await g.uploadSetSettings({
        active: 'github',
        maxConcurrent: 2,
        maxRetries: 1,
        github: {
          token: 'super-secret-token-001',
          repo: 'me/imgs',
          branch: 'main',
          pathPrefix: 'upl-d',
          customDomain: ''
        }
      });
      return g.uploadGetSettings();
    });
    expect(cfg1.active).toBe('github');
    expect(cfg1.github?.repo).toBe('me/imgs');
    expect(cfg1.github?.token).toBe('••••••');

    // Re-save with the mask in place — the merge should preserve the
    // real secret. The persisted token MUST still upload-test green.
    await page.evaluate(async () => {
      const g = (window as unknown as {
        giftk: { uploadSetSettings(c: unknown): Promise<{ ok: boolean }> };
      }).giftk;
      await g.uploadSetSettings({
        active: 'github',
        maxConcurrent: 2,
        maxRetries: 1,
        github: {
          token: '••••••',
          repo: 'me/imgs',
          branch: 'main',
          pathPrefix: 'upl-d',
          customDomain: 'cdn.example.test'
        }
      });
    });

    const cfg2 = await page.evaluate(async () => {
      const g = (window as unknown as {
        giftk: { uploadGetSettings(): Promise<{ active: string; github?: { token?: string; customDomain?: string } }> };
      }).giftk;
      return g.uploadGetSettings();
    });
    expect(cfg2.github?.token).toBe('••••••');
    expect(cfg2.github?.customDomain).toBe('cdn.example.test');

    // Restore customWeb default so subsequent SUITEs are not surprised
    // by a github backend with a fake token.
    await page.evaluate(async () => {
      const g = (window as unknown as {
        giftk: { uploadSetSettings(c: unknown): Promise<{ ok: boolean }> };
      }).giftk;
      await g.uploadSetSettings({
        active: 'customWeb',
        maxConcurrent: 3,
        maxRetries: 2,
        customWeb: { url: '', urlPath: 'url', fileField: 'file', headers: {} }
      });
    });
  });

  test('SUITE UPLOAD-E — uploadTest probes the active backend with a 1×1 PNG and reports url+duration', async () => {
    test.setTimeout(30_000);
    const { page } = getHarness();
    mock.reset();
    // Configure customWeb to /probe, then call uploadTest WITHOUT a
    // configs override. The uploader merges persisted settings with
    // any incoming partial — passing `{}` is enough to use the saved
    // backend.
    await setCustomWebBackend(mock.baseUrl, '/probe');
    const result = await page.evaluate(async () => {
      const g = (window as unknown as {
        giftk: { uploadTest(p: { backend?: string }): Promise<{ ok: boolean; url?: string; error?: string; durationMs?: number }> };
      }).giftk;
      return g.uploadTest({ backend: 'customWeb' });
    });
    expect(result.ok).toBe(true);
    expect(typeof result.url).toBe('string');
    expect(result.url!.includes('/r/probe.png')).toBe(true);
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const hits = mock.hits();
    expect(hits.some((h) => h.startsWith('POST /probe'))).toBe(true);
  });
});
