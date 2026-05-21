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
import {
  REPO_ROOT,
  MAIN_ENTRY,
  bindHarness,
  unbindHarness,
  launchElectron
} from './realPipeline/_harness';

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

test.describe.configure({ timeout: 90_000 });

let app: ElectronApplication;
let page: Page;

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

  // Bind the shared harness so per-suite modules see the live
  // app/page/outDir for the lifetime of this spec. unbindHarness() in
  // afterAll prevents a closed page from leaking into other spec files
  // (Playwright runs workers: 1 so this is the cleanest hand-off).
  bindHarness({ app, page, defaultOutDir });
});

test.afterAll(async () => {
  unbindHarness();
  if (app) await app.close();
});
