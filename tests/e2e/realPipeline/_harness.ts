/**
 * Shared harness for the realPipeline e2e suite.
 *
 * Why this module exists
 * ----------------------
 * `realPipeline.spec.ts` previously hosted 2031 lines: 20 SUITE
 * bodies plus a substantial prelude of fixture paths, recorder
 * plumbing, and terminal-status pollers. The prelude is shared
 * verbatim by every SUITE, so co-locating it inside the spec inflated
 * the test file far past the project's 500-line target without any
 * functional reason. This module hosts the prelude in isolation so
 * the spec can shed ~150 lines and the helpers gain a stable import
 * path for future per-SUITE module splits.
 *
 * Lifecycle contract
 * ------------------
 * The Electron `app` and its first window `page` are owned by the
 * spec's `test.beforeAll` hook (Playwright cannot construct workers
 * from this module). The spec calls `bindHarness(app, page,
 * defaultOutDir)` exactly once after handshake, and every helper
 * exposed here reads `harness.page` / `harness.app` at call time.
 * Reset between suites is unnecessary because the pipeline is
 * single-worker (workers: 1, fullyParallel: false in
 * playwright.config.ts) and SUITEs already clean their own page
 * state.
 *
 * Why not just `export let page` and let the spec mutate it?
 * ---------------------------------------------------------
 * Mutating an exported binding works at runtime but breaks tree-
 * shake reasoning and tsserver navigation; the explicit
 * `bindHarness` / `getHarness` pair makes the dependency direction
 * crystal clear ("spec owns the lifecycle, harness is read-only").
 */
import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

export const REPO_ROOT = path.resolve(__dirname, '../../..');
export const MAIN_ENTRY = path.join(REPO_ROOT, 'dist/main/index.js');
export const FIXTURES_DIR = path.join(REPO_ROOT, 'tests/fixtures');
export const FIXTURE_HTML = path.join(FIXTURES_DIR, 'offline-page.html');
export const FIXTURE_MP4 = path.join(FIXTURES_DIR, 'tiny.mp4');
export const FIXTURE_GIF = path.join(FIXTURES_DIR, 'tiny.gif');
export const FIXTURE_MEDIUM = path.join(FIXTURES_DIR, 'medium.mp4');
export const FIXTURE_LONG = path.join(FIXTURES_DIR, 'long.mp4');

export interface RecordedProgress {
  taskId: string;
  status: string;
  percent: number;
  outputs?: string[];
  error?: string;
  errorCode?: string;
  message?: string;
}

export interface RecordedSniffProgress {
  stage: string;
  percent: number;
  message?: string;
  found?: number;
}

export interface HarnessHandle {
  app: ElectronApplication;
  page: Page;
  defaultOutDir: string;
}

let bound: HarnessHandle | null = null;

export function bindHarness(h: HarnessHandle): void {
  bound = h;
}

export function unbindHarness(): void {
  bound = null;
}

/**
 * Per-suite modules call this inside their `test()` body to grab the
 * live Electron handles. Throwing on unbound prevents accidental use
 * outside the spec's lifecycle (e.g. import-time DOM probes).
 */
export function getHarness(): HarnessHandle {
  if (!bound) {
    throw new Error(
      'realPipeline harness not bound — bindHarness(...) must run inside test.beforeAll'
    );
  }
  return bound;
}

function require_(): HarnessHandle {
  return getHarness();
}

/**
 * Re-export the Electron launcher so per-suite modules don't need to
 * pull `@playwright/test` again. The orchestrator spec is the only
 * call site so far, but if SUITEs are split into per-file modules
 * later they can simply `import { launchElectron } from './_harness'`.
 */
export const launchElectron = _electron.launch.bind(_electron);

export function freshOutDir(label: string): string {
  const { defaultOutDir } = require_();
  const dir = path.join(
    defaultOutDir,
    `giftk-e2e-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Translate an OS-absolute path into the renderer-visible
 * `giftk-local://` URL the production preload bridge would emit.
 *
 * Mirrors the encoding rule used by [registerLocalProtocolHandler](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts):
 * percent-encode each path segment individually so spaces and unicode
 * survive the round-trip, and on POSIX preserve the leading slash by
 * NOT filtering empty segments. On win32 the leading drive segment
 * keeps a leading slash for a `giftk-local://localhost/C:/...` shape.
 */
export function pathToGiftkLocal(absPath: string): string {
  const norm = path.resolve(absPath);
  const parts = norm.split(path.sep).map((seg) => encodeURIComponent(seg));
  const joined = process.platform === 'win32'
    ? '/' + parts.filter(Boolean).join('/')
    : parts.join('/');
  return `giftk-local://localhost${joined}`;
}

/**
 * Install a buffered recorder for the three IPC channels SUITE
 * assertions read: progress events, log lines, sniff progress.
 *
 * Why a window-side buffer (and not a Playwright `page.on` listener)?
 *   - The preload bridge emits via Electron's `ipcRenderer.on`; only
 *     the renderer can subscribe. Playwright's `page.on` covers the
 *     Chromium devtools protocol, not Electron IPC.
 *   - Buffering inside `window.__e2e` lets multiple async assertions
 *     in the same SUITE re-read the same window of events without
 *     racing against incoming IPC.
 */
export async function installRecorder(): Promise<void> {
  const { page } = require_();
  await page.evaluate(() => {
    const w = window as unknown as {
      __e2e?: {
        progress: unknown[];
        logs: string[];
        sniff: unknown[];
        offProgress?: () => void;
        offLog?: () => void;
        offSniff?: () => void;
      };
      giftk: {
        onProgress(cb: (p: unknown) => void): () => void;
        onLog(cb: (line: string) => void): () => void;
        onSniffProgress(cb: (p: unknown) => void): () => void;
      };
    };
    if (w.__e2e?.offProgress) w.__e2e.offProgress();
    if (w.__e2e?.offLog) w.__e2e.offLog();
    if (w.__e2e?.offSniff) w.__e2e.offSniff();
    const buf = { progress: [] as unknown[], logs: [] as string[], sniff: [] as unknown[] };
    const offProgress = w.giftk.onProgress((p) => { buf.progress.push(p); });
    const offLog = w.giftk.onLog((line) => { buf.logs.push(line); });
    const offSniff = w.giftk.onSniffProgress((p) => { buf.sniff.push(p); });
    w.__e2e = { ...buf, offProgress, offLog, offSniff };
  });
}

export async function tearDownRecorder(): Promise<void> {
  const { page } = require_();
  await page.evaluate(() => {
    const w = window as unknown as {
      __e2e?: { offProgress?: () => void; offLog?: () => void; offSniff?: () => void };
    };
    if (w.__e2e?.offProgress) w.__e2e.offProgress();
    if (w.__e2e?.offLog) w.__e2e.offLog();
    if (w.__e2e?.offSniff) w.__e2e.offSniff();
    w.__e2e = undefined;
  });
}

export async function snapshotRecorder(): Promise<{
  progress: RecordedProgress[];
  logs: string[];
  sniff: RecordedSniffProgress[];
}> {
  const { page } = require_();
  return page.evaluate(() => {
    const w = window as unknown as {
      __e2e?: { progress: unknown[]; logs: string[]; sniff: unknown[] };
    };
    const e = w.__e2e;
    if (!e) return { progress: [], logs: [], sniff: [] };
    return {
      progress: JSON.parse(JSON.stringify(e.progress)) as RecordedProgress[],
      logs: e.logs.slice(),
      sniff: JSON.parse(JSON.stringify(e.sniff)) as RecordedSniffProgress[]
    };
  });
}

export async function waitForTerminal(taskId: string, timeoutMs: number): Promise<RecordedProgress> {
  const { page } = require_();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snap = await snapshotRecorder();
    const last = [...snap.progress].reverse().find(
      (p) => p.taskId === taskId && (p.status === 'done' || p.status === 'failed' || p.status === 'cancelled' || p.status === 'skipped')
    );
    if (last) return last;
    await page.waitForTimeout(300);
  }
  throw new Error(`timeout waiting for terminal status of ${taskId} after ${timeoutMs}ms`);
}

/**
 * SUITE E variant: the renderer assigns the taskId itself (sha256 of
 * the sniffed media URL), so the test can't predict it up-front.
 * Returns the first terminal progress event seen on ANY taskId. Pair
 * with `seenIds` to wait for a SECOND terminal on the same id after a
 * 强制允许 retry.
 */
export async function waitForAnyTerminal(
  timeoutMs: number,
  opts?: { acceptStatuses?: string[]; ignoreEventBefore?: number }
): Promise<RecordedProgress> {
  const { page } = require_();
  const accept = new Set(opts?.acceptStatuses ?? ['done', 'failed', 'cancelled', 'skipped']);
  const skipBefore = opts?.ignoreEventBefore ?? 0;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snap = await snapshotRecorder();
    for (let i = skipBefore; i < snap.progress.length; i++) {
      const p = snap.progress[i];
      if (accept.has(p.status)) return p;
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`timeout waiting for any terminal status after ${timeoutMs}ms`);
}

/**
 * Reads the most recent http(s) URL from the user's persisted sniff
 * history (sqlite). Used by SUITE F/G/H to replay a real prior run
 * rather than baking a brittle URL into the suite. Returns null when
 * the bridge is missing or the table is empty so the SUITE can
 * test.skip cleanly.
 */
export async function readSampleUrlFromHistory(): Promise<string | null> {
  const { page } = require_();
  return page.evaluate(async () => {
    const w = window as unknown as {
      giftk: { sniffHistory?: { readAll(): Promise<Array<{ url?: string; sniffedAt?: number }>> } };
    };
    if (!w.giftk?.sniffHistory?.readAll) return null;
    const rows = await w.giftk.sniffHistory.readAll();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const sorted = rows
      .filter((r) => typeof r.url === 'string' && r.url.startsWith('http'))
      .sort((a, b) => (b.sniffedAt ?? 0) - (a.sniffedAt ?? 0));
    return sorted[0]?.url ?? null;
  });
}

/**
 * Locate Google Chrome on macOS / Linux. SUITE G's system-chrome
 * sniff path requires the real binary on PATH (it spawns a separate
 * process with a debug port). Returns null on Windows or when no
 * known location resolves so SUITE G can test.skip rather than fail.
 */
export function findChromeBinary(): string | null {
  if (process.platform === 'darwin') {
    const cands = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ];
    for (const c of cands) if (existsSync(c)) return c;
    return null;
  }
  if (process.platform === 'linux') {
    for (const c of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
      if (existsSync(c)) return c;
    }
    return null;
  }
  return null;
}

/**
 * Locate yt-dlp via `which` / `command -v`. SUITE H requires the
 * binary; returns null on absence so the SUITE can test.skip.
 */
export function findYtDlpBinary(): string | null {
  try {
    const out = execSync('which yt-dlp 2>/dev/null || command -v yt-dlp', { encoding: 'utf8' }).trim();
    return out && existsSync(out) ? out : null;
  } catch {
    return null;
  }
}
