/**
 * Real-pipeline e2e orchestrator — proves that the actual main-process
 * IPC + ffmpeg / gifsicle / sniffFilters chains work end-to-end. The
 * sibling [hooks.spec.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/e2e/hooks.spec.ts)
 * only exercises UI shape (and mocks every giftk call via window.giftk
 * introspection); this file deliberately AVOIDS any mocking and drives
 * the production preload bridge directly so a regression in offline
 * import, processor, or per-tab isolation surfaces here.
 *
 * Mode mirrors hooks.spec.ts: NODE_ENV=production, packaged dist entry,
 * .app shell handshake. Each test is given a 90s budget because real
 * ffmpeg / gifsicle invocations are spawned per case.
 *
 * Architecture:
 *   This file owns the Electron lifecycle (launch in beforeAll, close
 *   in afterAll). All SUITE bodies have been split into per-topic
 *   modules under [realPipeline/](file:///Users/guoshuyu/workspace/gif-toolkit/tests/e2e/realPipeline)
 *   and are loaded via side-effect imports below — Playwright collects
 *   every `test()` registered during spec evaluation regardless of
 *   which file it was textually written in. The shared
 *   [_harness.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/e2e/realPipeline/_harness.ts)
 *   exposes the live app/page/outDir to every module via getHarness().
 */
import { test, type ElectronApplication, type Page } from '@playwright/test';
import { readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  REPO_ROOT,
  MAIN_ENTRY,
  bindHarness,
  unbindHarness,
  launchElectron
} from './realPipeline/_harness';

/**
 * E2E SUITE leftover sweep
 * ------------------------
 * `g.startBatch(tasks, pageTitle, ...)` makes the main process emit a
 * sub-directory `<defaultOutDir>/<safeName(pageTitle).slice(0,60)>-<ts>-<ms>-<random4>`
 * (cf. src/main/index.ts SUITE batch path). When SUITEs pass synthetic
 * pageTitles like 'suite-O-reoptimize' / 'suite-S-A' or fixture names
 * like 'medium.mp4', those sub-dirs accumulate in the user's real
 * Downloads/GifToolkit folder across runs because the harness has no
 * sandbox redirect for getDefaultOutputDir().
 *
 * The sweep below runs in afterAll BEFORE app.close() so it can read
 * the live `defaultOutDir` we already captured in beforeAll. It deletes
 * only entries whose name STRICTLY matches the e2e shape — fixture-
 * basename / `suite-` / `giftk-e2e-` / `SUITE_*_fixture_page-` prefix
 * AND a `-<ts>-<ms>-<random4>` tail — to guarantee we never touch a
 * legitimate user capture (those keep page-title prefixes outside this
 * whitelist).
 */
const E2E_LEFTOVER_PREFIXES = [
  /^suite-/,
  /^giftk-e2e-/,
  /^long\.mp4-/,
  /^medium\.mp4-/,
  /^tiny\.mp4-/,
  /^tiny\.gif-/,
  /^SUITE_[A-Z]_fixture_page-/
];
function isE2eLeftover(name: string): boolean {
  return E2E_LEFTOVER_PREFIXES.some((re) => re.test(name));
}
function sweepE2eLeftovers(rootDir: string): { removed: number; errors: number } {
  let removed = 0;
  let errors = 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(rootDir);
  } catch {
    return { removed, errors };
  }
  for (const name of entries) {
    if (!isE2eLeftover(name)) continue;
    const full = path.join(rootDir, name);
    try {
      const s = statSync(full);
      if (!s.isDirectory()) continue;
      rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      errors += 1;
    }
  }
  return { removed, errors };
}

// Side-effect SUITE imports — Playwright registers `test()` calls in
// the order modules evaluate, so listing in textual SUITE order keeps
// the report alphabetical and lets `workers: 1` run them serially in
// the same Electron app handle bound by beforeAll below.
import './realPipeline/suite-offline-sniff';            // SUITE A, A2
import './realPipeline/suite-conversion-core';          // SUITE B, C
import './realPipeline/suite-cross-tab-isolation';      // SUITE D
import './realPipeline/suite-ui-full-pipeline';         // SUITE E
import './realPipeline/suite-network-sniff';            // SUITE F, G, H (network-gated)
import './realPipeline/suite-segment-trim-reoptimize';  // SUITE I, J, L
import './realPipeline/suite-format-contracts';         // SUITE M, N
import './realPipeline/suite-compression-isolation-oracles'; // SUITE O, P, Q, R, S
import './realPipeline/suite-toolbox-chain';            // SUITE TB-CHAIN A/B/C (R-TB-CHAIN)

test.describe.configure({ timeout: 90_000 });

let app: ElectronApplication;
let page: Page;
let capturedDefaultOutDir: string | null = null;

test.beforeAll(async () => {
  app = await launchElectron({
    args: [MAIN_ENTRY],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    }
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.app', { timeout: 30_000 });

  const defaultOutDir = await page.evaluate(async () => {
    const g = (window as unknown as { giftk: { getDefaultOutputDir(): Promise<string> } }).giftk;
    return g.getDefaultOutputDir();
  });
  if (!defaultOutDir) throw new Error('default output directory unavailable');
  capturedDefaultOutDir = defaultOutDir;

  // Bind the shared harness so per-suite modules see the live
  // app/page/outDir for the lifetime of this spec. unbindHarness() in
  // afterAll prevents a closed page from leaking into other spec files
  // (Playwright runs workers: 1 so this is the cleanest hand-off).
  bindHarness({ app, page, defaultOutDir });
});

test.afterAll(async () => {
  // Sweep e2e SUITE leftovers BEFORE closing the app so the captured
  // defaultOutDir is still authoritative. Failures are logged but never
  // fail the suite — clean-up is best-effort, the assertions above are
  // what gate the run.
  if (capturedDefaultOutDir) {
    try {
      const { removed, errors } = sweepE2eLeftovers(capturedDefaultOutDir);
      if (removed > 0 || errors > 0) {
        // eslint-disable-next-line no-console
        console.log(`[e2e cleanup] swept ${removed} leftover dir(s) under ${capturedDefaultOutDir} (errors=${errors})`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[e2e cleanup] sweep failed:', err);
    }
  }
  unbindHarness();
  if (app) await app.close();
});
