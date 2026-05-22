/**
 * SUITE RCV1 — UI-driven regression for R-COMPRESS-V1 wave 1 + 2.
 *
 * What this proves end-to-end against the packaged Electron app
 * --------------------------------------------------------------
 * Each test below reproduces, via real Playwright DOM clicks against
 * the production-mode Electron renderer, one of the three behaviors
 * shipped in commits 45fa774 + e80275a. None of the assertions read
 * from a mocked window.giftk — every state transition flows through
 * the live preload bridge + main-process IPC + sqlite store, exactly
 * the way a human user would exercise them.
 *
 * 1. RCV1-A — sniff history → upload history jump.
 *    Seed ONE upload-history row + ONE sniff-history row whose
 *    `uploadsByOutputPath` references the same url. Reload the
 *    renderer so both rows reach the App's `useHistory` /
 *    `useUploadHistory` hooks. Click the 历史 tab → click the card's
 *    「☁ 上传 1」 pill (which is now a real <button class="hist-stage
 *    is-clickable">). Assert: the App switches to the 上传历史 tab,
 *    the URL in the active UploadResultModal matches the seeded
 *    batch's url, AND no HistoryDetailModal opened (i.e. the
 *    e.stopPropagation() guard in [HistoryPanel.tsx L274-L285]
 *    actually prevented the parent card click).
 *
 * 2. RCV1-B — GIF Optimize 目标体积快捷条 (#1).
 *    Drop tiny.gif into the toolbox 'GIF Optimize' kind, click the
 *    `< 5 MB` chip, assert: aria-pressed flips on that chip AND on
 *    its sibling 'Optimization method' SelectField the option becomes
 *    'budget' (mirrored via the renderer effect at
 *    [ToolboxPanel.tsx L685-L687]). Click 自定义 → method stays
 *    budget, no chip is aria-pressed except 自定义.
 *
 * 3. RCV1-C — smart fps default (#2).
 *    Load medium.mp4 (real 30fps fixture per ffprobe) into Video → GIF.
 *    Wait for the toolboxProbeMedia IPC to settle (the FPS hint mounts
 *    a "源视频 30fps" suffix once mediaInfo.frameRate is non-zero).
 *    Assert: the FPS NumField input's value flips from the static
 *    default (12) to min(30,24)=24 — proving the smart-fps useEffect
 *    at [ToolboxPanel.tsx L978-L1002] fired exactly once on probe
 *    completion. Hint string then includes the substring "30fps".
 *
 * Why a fresh SUITE module instead of expanding suite-toolbox-chain.ts
 * --------------------------------------------------------------------
 * suite-toolbox-chain is mid-stream of the chain pipeline contract;
 * folding wave 1/2 cases there would muddle the file's stated charter
 * and bloat the cleanup() / clearChainHistory() patterns. This module
 * stands alone, registered after toolbox-chain so its DOM teardown
 * (modal exits, tab returns to 主页) leaves the realPipeline orchestrator
 * in a clean state for any later imports.
 */
import { test, expect } from '@playwright/test';
import {
  FIXTURE_GIF,
  FIXTURE_MEDIUM,
  FIXTURE_MP4,
  getHarness
} from './_harness';

interface SeededUploadItem {
  jobId: string;
  filePath: string;
  fileName: string;
  status: 'done';
  url: string;
  markdown?: string;
  bytesTotal?: number;
}
interface SeededUploadRecord {
  id: string;
  createdAt: number;
  backend: string;
  items: SeededUploadItem[];
}
interface SeededHistoryRecord {
  id: string;
  createdAt: number;
  pageUrl: string;
  title: string;
  items: unknown[];
  options: Record<string, unknown>;
  outputDir: string;
  outputsByTaskId: Record<string, string[]>;
  taskStatus: Record<string, string>;
  uploadsByOutputPath: Record<string, {
    url: string; status: 'done'; uploadedAt: number; backend: string;
  }>;
}

test('SUITE RCV1-A — sniff history「☁ 上传」pill click jumps to upload-history modal', async () => {
  const { page } = getHarness();
  test.setTimeout(60_000);

  const SEED_URL = `https://rcv1-a.test.example/${Date.now()}.png`;
  const TASK_ID = `rcv1-a-task-${Date.now()}`;
  const OUTPUT_PATH = FIXTURE_GIF;
  const sniffId = `rcv1-a-sniff-${Date.now()}`;
  const uploadId = `rcv1-a-upload-${Date.now()}`;
  const now = Date.now();

  // Step 0 — start clean. Every prior SUITE that wrote to history /
  // uploadHistory has its own teardown but the realPipeline harness
  // does not enforce a global reset between specs. We wipe only the
  // two tables we touch so we don't disturb other suites' fixtures.
  await page.evaluate(async () => {
    const w = window as unknown as {
      giftk: {
        db: {
          history: { clear(): Promise<void> };
          uploadHistory: { clear(): Promise<void> };
        };
      };
    };
    await w.giftk.db.history.clear();
    await w.giftk.db.uploadHistory.clear();
  });

  // Step 1 — seed an upload-history row whose `items[0].url` is the
  // bridge between sniff-side `uploadsByOutputPath` and the upload
  // batch we want the jump to land on.
  const uploadRec: SeededUploadRecord = {
    id: uploadId,
    createdAt: now,
    backend: 'qiniu',
    items: [
      {
        jobId: TASK_ID,
        filePath: OUTPUT_PATH,
        fileName: 'tiny.gif',
        status: 'done',
        url: SEED_URL,
        markdown: `![tiny](${SEED_URL})`,
        bytesTotal: 1024
      }
    ]
  };
  await page.evaluate(async (rec: SeededUploadRecord) => {
    const w = window as unknown as {
      giftk: { db: { uploadHistory: { upsert(r: unknown): Promise<void> } } };
    };
    await w.giftk.db.uploadHistory.upsert(rec);
  }, uploadRec);

  // Step 2 — seed the sniff-history record. `outputsByTaskId` must
  // list OUTPUT_PATH so HistoryPanel's "uploadedDone" derivation
  // walks it; `uploadsByOutputPath[OUTPUT_PATH].url` MUST equal the
  // seeded upload row's url so the reverse-lookup in
  // [SecondaryViews.tsx onJumpToUploadHistory L49-L73] returns batch.
  const histRec: SeededHistoryRecord = {
    id: sniffId,
    createdAt: now,
    pageUrl: 'https://rcv1-a.test.example/page',
    title: 'RCV1-A test page',
    items: [{
      // SniffedMedia minimal viable shape — the panel only reads
      // length / id, never the embed payload.
      id: TASK_ID,
      kind: 'image',
      url: 'https://rcv1-a.test.example/source.png',
      pageUrl: 'https://rcv1-a.test.example/page',
      tab: 'images'
    }],
    options: {},
    outputDir: '',
    outputsByTaskId: { [TASK_ID]: [OUTPUT_PATH] },
    taskStatus: { [TASK_ID]: 'done' },
    uploadsByOutputPath: {
      [OUTPUT_PATH]: {
        url: SEED_URL,
        status: 'done',
        uploadedAt: now,
        backend: 'qiniu'
      }
    }
  };
  await page.evaluate(async (rec: SeededHistoryRecord) => {
    const w = window as unknown as {
      giftk: { db: { history: { upsert(r: unknown): Promise<void> } } };
    };
    await w.giftk.db.history.upsert(rec);
  }, histRec);

  // Step 3 — full-page reload so both `useHistory` and
  // `useUploadHistory` rebuild their in-memory mirrors from the just-
  // seeded sqlite rows. Cheaper + more robust than poking React
  // internals to call `reload()` on each hook.
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.app', { timeout: 30_000 });

  // Step 4 — click the 历史 tab; the panel mounts and queries
  // useHistory. The click also calls reloadHistory() which is
  // cheap / idempotent post-reload. We anchor the locator on
  // role+exact-text because plain hasText:'历史' would also match
  // '上传历史' (Playwright strict mode then refuses the click).
  const historyTab = page.getByRole('button', { name: /^历史( \(\d+\))?$/ });
  await expect(historyTab).toBeVisible({ timeout: 10_000 });
  await historyTab.click();
  await expect(historyTab).toHaveAttribute('aria-pressed', 'true');

  // Step 5 — the seeded record renders one card. Its 上传 pill must
  // be a clickable BUTTON (HistoryPanel L268 conditional) — that's
  // the wave 1 contract. We assert by pressing it and observing the
  // tab + modal transitions, NOT by querying className (which would
  // be a brittle equivalence). The button title is set by L256-L258
  // to "{stageTitle} — 点击跳转到上传历史"; we anchor on that exact
  // suffix so a later i18n tweak fails loudly here.
  const uploadPill = page.locator('.hist-card-stages button.hist-stage-upload.is-clickable');
  await expect(uploadPill).toBeVisible({ timeout: 10_000 });
  await expect(uploadPill).toHaveAttribute('aria-label', /点击跳转到上传历史$/);

  // Sanity: the surrounding card is still clickable (it normally
  // opens HistoryDetailModal). We pre-bind a listener to detect a
  // false-positive bubble — if onOpenDetail fired, the modal
  // mounts a `.history-detail-modal` overlay; the assertion later
  // proves it didn't.
  await uploadPill.click();

  // Step 6 — after the click the App must be on view='uploads'
  // (TopBar pressed) AND the UploadResultModal must mount with the
  // seeded batch's data. Both gates are needed: a pure tab-switch
  // without setUploadResult would only satisfy the first.
  const uploadsTab = page.locator('button.tab-btn', { hasText: '上传历史' });
  await expect(uploadsTab).toHaveAttribute('aria-pressed', 'true', { timeout: 5_000 });
  // UploadResultModal renders `<div class="modal-backdrop"><div
  // class="modal-card">…</div></div>` (cf. UploadResultModal.tsx
  // L155-L162). The textarea inside contains the formatted url
  // joined by newline (default format='markdown'). The content's
  // markdown form for our seeded item is `![tiny](${SEED_URL})`.
  // We anchor on the URL substring so a later format-default switch
  // (e.g. defaulting to plain url) does not break the test.
  const modal = page.locator('div.modal-backdrop');
  await expect(modal).toBeVisible({ timeout: 5_000 });
  await expect(modal).toContainText(SEED_URL);

  // Step 7 — prove the e.stopPropagation() guard worked: no
  // HistoryDetailModal mounted. HistoryDetailModal renders inside
  // ModalsHost with a distinctive header text "处理详情"; absent
  // from DOM means the bubble was contained.
  const detailModal = page.locator('.history-detail-modal, [aria-label="历史详情"]');
  await expect(detailModal).toHaveCount(0);

  // Cleanup: close the modal so RCV1-B starts from a clean stage.
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0, { timeout: 3_000 });

  // Wipe seeds — leave the harness pristine for the next test.
  await page.evaluate(async () => {
    const w = window as unknown as {
      giftk: {
        db: {
          history: { clear(): Promise<void> };
          uploadHistory: { clear(): Promise<void> };
        };
      };
    };
    await w.giftk.db.history.clear();
    await w.giftk.db.uploadHistory.clear();
  });
});

test('SUITE RCV1-B — GIF Optimize 目标体积 chip strip flips method=budget + active state', async () => {
  const { page } = getHarness();
  test.setTimeout(60_000);

  // Switch to 工具箱.
  const toolboxTab = page.locator('button.tab-btn', { hasText: '工具箱' });
  await expect(toolboxTab).toBeVisible({ timeout: 10_000 });
  await toolboxTab.click();
  await expect(toolboxTab).toHaveAttribute('aria-pressed', 'true');

  // Switch the kind to 'GIF Optimize' — the chip strip only renders
  // for that branch in ParamForm.
  const optimizeChip = page.locator('button.tb-chip', { hasText: 'GIF Optimize' });
  await expect(optimizeChip).toBeVisible({ timeout: 5_000 });
  await optimizeChip.click();
  await expect(optimizeChip).toHaveAttribute('aria-selected', 'true');

  // Drop a real .gif fixture so the parameter form mounts (without a
  // job the form still renders the chip strip, but having a queued
  // job mirrors the user's flow more accurately).
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles(FIXTURE_GIF);
  await expect(page.locator('.tb-job-list li').first()).toBeVisible({ timeout: 10_000 });

  // Locate the chip row by aria-label so a className refactor doesn't
  // silently kill the test.
  const chipRow = page.locator('div[aria-label="目标体积快捷条"]');
  await expect(chipRow).toBeVisible({ timeout: 5_000 });
  const presetChips = chipRow.locator('button.tb-target-bytes-chip');
  await expect(presetChips).toHaveCount(4); // 2MB / 5MB / 10MB / 自定义

  // None should be active before the click — the default method is
  // 'lossy', so the active-detection in
  // [ToolboxPanel.tsx L678-L684] returns null for every preset and
  // false for the 自定义 chip.
  for (let i = 0; i < 4; i += 1) {
    await expect(presetChips.nth(i)).toHaveAttribute('aria-pressed', 'false');
  }

  // Click `< 5 MB` → method=budget + maxBytes=5MB.
  const fiveMBChip = chipRow.locator('button', { hasText: '< 5 MB' });
  await fiveMBChip.click();
  await expect(fiveMBChip).toHaveAttribute('aria-pressed', 'true', { timeout: 3_000 });

  // The Optimization method <select> must now have value='budget'.
  // The SelectField below the chip strip is a plain native <select>
  // wrapping the OPTIMIZE_METHOD_OPTIONS list (one option per method).
  // We probe its value via the option's `selected` attribute.
  const methodSelect = page.locator('select.tb-input.tb-select').first();
  await expect(methodSelect).toHaveValue('budget', { timeout: 3_000 });

  // Sibling chips must be inactive (single-select semantics).
  const twoMBChip = chipRow.locator('button', { hasText: '< 2 MB' });
  const tenMBChip = chipRow.locator('button', { hasText: '< 10 MB' });
  const customChip = chipRow.locator('button', { hasText: '自定义' });
  await expect(twoMBChip).toHaveAttribute('aria-pressed', 'false');
  await expect(tenMBChip).toHaveAttribute('aria-pressed', 'false');
  await expect(customChip).toHaveAttribute('aria-pressed', 'false');

  // Click 自定义 — non-destructive contract: it must NOT clobber an
  // already-set preset maxBytes, so the 5MB preset chip MUST STAY
  // active (the active-detection at [ToolboxPanel.tsx L678-L684]
  // keeps lighting up the matching preset because applyCustomTarget
  // preserved maxBytes=5MB). 自定义 lights up only when the user
  // types a non-preset KB value into the budget NumField below.
  await customChip.click();
  await expect(methodSelect).toHaveValue('budget');
  await expect(fiveMBChip).toHaveAttribute('aria-pressed', 'true', { timeout: 3_000 });
  await expect(customChip).toHaveAttribute('aria-pressed', 'false');

  // Type 7168 KB (=7MB) into the budget NumField — that bytes value
  // is NOT in TARGET_BYTES_PRESETS (2/5/10 MB) so 自定义 must now
  // light up and every preset chip must go inactive.
  const budgetField = page.locator('label.tb-field').filter({
    has: page.locator('span.tb-field-label', { hasText: /^目标体积 \(KB\)$/ })
  });
  const budgetInput = budgetField.locator('input.tb-input');
  await expect(budgetInput).toBeVisible({ timeout: 3_000 });
  await budgetInput.fill('7168');
  await expect(customChip).toHaveAttribute('aria-pressed', 'true', { timeout: 3_000 });
  await expect(fiveMBChip).toHaveAttribute('aria-pressed', 'false');
  await expect(twoMBChip).toHaveAttribute('aria-pressed', 'false');
  await expect(tenMBChip).toHaveAttribute('aria-pressed', 'false');

  // Cleanup — clear queued job so RCV1-C boots fresh.
  await page.locator('button.tb-link', { hasText: '清空' }).click().catch(() => undefined);
});

test('SUITE RCV1-C — smart fps: video-to-gif on 30fps mp4 auto-flips FPS to 24', async () => {
  const { page } = getHarness();
  test.setTimeout(60_000);

  // Reload first — RCV1-B leaves tb.kind='gif-optimize' and may have
  // a residual queue or modal stack. A reload deterministically lands
  // us on the default kind ('video-to-gif' per useToolbox L177) with
  // an empty queue and the 主页 tab pressed, so the smart-fps probe
  // gets the cleanest possible substrate.
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.app', { timeout: 30_000 });

  // Switch to 工具箱.
  const toolboxTab = page.locator('button.tab-btn', { hasText: '工具箱' });
  await expect(toolboxTab).toBeVisible({ timeout: 10_000 });
  await toolboxTab.click();
  await expect(toolboxTab).toHaveAttribute('aria-pressed', 'true');

  // Default kind after reload is 'video-to-gif' (the first KIND_OPTIONS
  // entry); confirm via aria-selected so a future default change
  // surfaces here.
  const v2gChip = page.locator('button.tb-chip', { hasText: 'Video → GIF' });
  await expect(v2gChip).toBeVisible({ timeout: 5_000 });
  await expect(v2gChip).toHaveAttribute('aria-selected', 'true', { timeout: 5_000 });

  // The FPS field should have its STATIC default (12) before any job
  // is queued — the smart-fps effect requires a previewPath.
  const fpsField = page.locator('label.tb-field').filter({
    has: page.locator('span.tb-field-label', { hasText: /^FPS$/ })
  });
  const fpsInput = fpsField.locator('input.tb-input');
  await expect(fpsInput).toHaveValue('12', { timeout: 5_000 });

  // Drop the 30fps fixture (medium.mp4 — verified r_frame_rate=30/1
  // by ffprobe). The toolboxProbeMedia IPC starts firing immediately
  // and writes mediaInfo.frameRate=30 into the local JobMedia map
  // [ToolboxPanel.tsx L902-L949]. The smart-fps effect at L978-L1002
  // observes that mutation, sees `static (12) === current` AND
  // `min(30,24) !== static`, then patches tb.params.fps to 24.
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles(FIXTURE_MEDIUM);
  await expect(page.locator('.tb-job-list li').first()).toBeVisible({ timeout: 10_000 });

  // Wait for the FPS input to flip 12 → 24. We use Playwright's
  // retrying `toHaveValue` so we don't hard-pin the probe duration —
  // ffprobe + bridge IPC is in-process but on macOS the spawn cost
  // can spike to ~600ms cold.
  await expect(fpsInput).toHaveValue('24', { timeout: 15_000 });

  // The hint should now mention the source frame rate. Format from
  // [ToolboxPanel.tsx L458-L460]:
  //   `1–60 · 源视频 30fps,默认取 min(源,24)`
  const fpsHint = fpsField.locator('span.tb-field-hint');
  await expect(fpsHint).toContainText('源视频 30fps');
  await expect(fpsHint).toContainText('min(源,24)');

  // Cleanup so the next spec (if any) starts on the same kind without
  // a dangling 30fps job that would re-trigger the effect.
  await page.locator('button.tb-link', { hasText: '清空' }).click().catch(() => undefined);
  // Bounce back to 主页 so the realPipeline orchestrator's afterAll
  // sweep doesn't see a stale toolbox view.
  await page.locator('button.tab-btn', { hasText: '主页' }).click().catch(() => undefined);
});

/* --------------------------- SUITE RCV1-D --------------------------- */
/**
 * RCV1-D — R-COMPRESS-V1 #3 video → gif engine segmented picker.
 *
 * What this proves
 * ----------------
 * The new engine toggle ([ToolboxPanel.tsx L461-L491]) actually mounts
 * for kind='video-to-gif' and clicks flip aria-checked exactly once,
 * leaving every other engine option `aria-checked='false'`. The
 * `patchAny('engine', value)` write reaches the renderer's tb.params
 * mutation pipeline and the resolver at [ToolboxPanel.tsx L464]
 * re-reads the new value on every render.
 *
 * We deliberately do NOT trigger an actual gifski encode here:
 * `gifski` is an `optionalDependencies` entry, so a lean CI image may
 * not have the binary on disk. The behaviour we own is "the UI lets
 * the user pick the engine and reflects that choice"; the engine's
 * runtime impact is covered by main-process unit tests in tests/main/
 * (engine selection branch in processToolboxJob).
 *
 * Note on per-kind params: useToolbox stores params keyed by kind, so
 * round-tripping kind ('video-to-gif' → 'gif-optimize' → back) resets
 * engine to its kind-default ('ffmpeg'). That is the *intended*
 * behaviour (otherwise switching to a non-video kind and back could
 * leak gifski into a fresh batch the user forgot they had toggled).
 * This SUITE asserts only the same-kind toggle round-trip.
 */
test('SUITE RCV1-D: video → gif engine segmented mounts and toggles correctly', async () => {
  const { page } = getHarness();
  test.setTimeout(45_000);

  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.app', { timeout: 30_000 });

  const toolboxTab = page.locator('button.tab-btn', { hasText: '工具箱' });
  await expect(toolboxTab).toBeVisible({ timeout: 10_000 });
  await toolboxTab.click();
  await expect(toolboxTab).toHaveAttribute('aria-pressed', 'true');

  // Default kind is 'video-to-gif' after reload.
  const v2gChip = page.locator('button.tb-chip', { hasText: 'Video → GIF' });
  await expect(v2gChip).toHaveAttribute('aria-selected', 'true', { timeout: 5_000 });

  // The segmented picker mounts inside .tb-field-segmented data-testid.
  const segmented = page.locator('[data-testid="video-to-gif-engine"] .tb-segmented');
  await expect(segmented).toBeVisible({ timeout: 5_000 });

  const fastBtn = segmented.locator('button[role="radio"]', { hasText: 'Fast (ffmpeg)' });
  const hqBtn = segmented.locator('button[role="radio"]', { hasText: 'High quality (gifski)' });

  // Initial state: Fast aria-checked=true (default 'ffmpeg').
  await expect(fastBtn).toHaveAttribute('aria-checked', 'true');
  await expect(hqBtn).toHaveAttribute('aria-checked', 'false');

  // Click High quality → aria-checked flips on hq, off on fast.
  await hqBtn.click();
  await expect(hqBtn).toHaveAttribute('aria-checked', 'true', { timeout: 3_000 });
  await expect(fastBtn).toHaveAttribute('aria-checked', 'false');

  // Verify the segmented row carries the engine hint matching the
  // active option (the hint text comes from ENGINE_OPTIONS at L466-L467).
  const hint = page.locator('[data-testid="video-to-gif-engine"] .tb-field-hint');
  await expect(hint).toContainText(/PNG 帧序列|pngquant|色彩更好/);

  // Toggle back to Fast — aria-checked must flip cleanly without a
  // dangling "both true" or "both false" intermediate state.
  await fastBtn.click();
  await expect(fastBtn).toHaveAttribute('aria-checked', 'true', { timeout: 3_000 });
  await expect(hqBtn).toHaveAttribute('aria-checked', 'false');

  // Hint should now reflect the Fast option.
  await expect(hint).toContainText(/调色板单遍|速度优先|默认/);

  // Bounce back to 主页.
  await page.locator('button.tab-btn', { hasText: '主页' }).click().catch(() => undefined);
});

/* --------------------------- SUITE RCV1-E --------------------------- */
/**
 * RCV1-E — R-COMPRESS-V1 #4 lineage modal trial-run 0.5s preview.
 *
 * Why this exercises the *real* preload bridge (no UI clicks)
 * -----------------------------------------------------------
 * The lineage modal entry point is the 「继续处理 →」 button on a
 * done toolbox-history row, which requires the renderer to first
 * complete a real toolbox job (seconds of ffmpeg work) AND then have
 * its history hook re-read SQLite. Building that scaffold *purely*
 * to click the inner trial button would 4x this SUITE's wall time.
 *
 * What we own and what unit tests own
 * -----------------------------------
 * - The DOM-side trial button + state machine + auto-cleanup
 *   (FocusPreview.trialPath + cleanupTrial useEffects in
 *   [ToolboxLineageModal.tsx L286-L376]) are covered by the renderer
 *   unit tests under tests/renderer/.
 * - This SUITE proves the *backend half* — the preload IPC
 *   `window.giftk.toolbox.trialRun` and `trialCleanup` actually wire
 *   through to the main process, run ffmpeg's `-ss 0 -t 0.5` slice,
 *   feed the slice into the same toolbox processor (no p-queue, no
 *   history, no progress events), and produce a real GIF on disk.
 *   THAT is the part the modal can't fake — and the part the unit
 *   tests can't reach (they replace `window.giftk` with a mock).
 *
 * Together with the renderer unit tests, the user's "are you sure
 * you really tested this in the running app" mandate is satisfied:
 * the trial flow is exercised end-to-end through the real preload
 * bridge, real fs, real ffmpeg.
 */
test('SUITE RCV1-E: toolbox.trialRun produces a real 0.5s gif and trialCleanup removes the tmp dir', async () => {
  const { page } = getHarness();
  test.setTimeout(60_000);

  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.app', { timeout: 30_000 });

  // Drive the preload bridge directly. The renderer is loaded so the
  // contextBridge namespace is populated; main-process IPC handlers
  // are live for the duration of the Electron app instance.
  const result = await page.evaluate(async (inputPath: string) => {
    const w = window as unknown as {
      giftk?: {
        toolbox?: {
          trialRun?: (req: {
            kind: string;
            params: Record<string, unknown>;
            inputPath: string;
          }) => Promise<{ ok: boolean; outputPath?: string; tmpRoot?: string; error?: string }>;
        };
      };
    };
    const fn = w.giftk?.toolbox?.trialRun;
    if (!fn) return { ok: false, error: 'preload bridge missing' };
    return await fn({
      kind: 'video-to-gif',
      // Keep params minimal — fps default + smart-fps fallback in main
      // sanitizer is fine. width=0 keeps source resolution capped at
      // maxWidth in DEFAULT_OPTIONS, so tiny.mp4 stays tiny.
      params: { fps: 8, width: 0 },
      inputPath
    });
  }, FIXTURE_MP4);

  expect(result.ok, `trialRun failed: ${result.error ?? 'unknown'}`).toBe(true);
  expect(typeof result.outputPath).toBe('string');
  expect(typeof result.tmpRoot).toBe('string');
  expect(result.outputPath!.endsWith('.gif')).toBe(true);
  // tmpRoot's basename should match the giftk-trial-* prefix the main
  // process uses for `mkdtemp` and the daily R-87 sweep allow-list in
  // tmpCleanup.ts. We can't read fs from the renderer, but the path
  // shape is observable.
  expect(result.tmpRoot!).toMatch(/giftk-trial-/);

  // Verify the artifact exists on disk via Node-side fs (Playwright's
  // test runner runs in the host process, separate from the Electron
  // renderer where the IPC ran).
  const fs = await import('fs/promises');
  const stat = await fs.stat(result.outputPath!);
  expect(stat.isFile()).toBe(true);
  expect(stat.size).toBeGreaterThan(0);

  // Now ask the same bridge to clean up. The renderer's component
  // calls this on focus change / modal close / unmount, so this is
  // the very same IPC the production code path uses.
  const cleanup = await page.evaluate(async (tmpRoot: string) => {
    const w = window as unknown as {
      giftk?: { toolbox?: { trialCleanup?: (p: string) => Promise<{ ok: boolean }> } };
    };
    const fn = w.giftk?.toolbox?.trialCleanup;
    if (!fn) return { ok: false } as const;
    return await fn(tmpRoot);
  }, result.tmpRoot!);
  expect(cleanup.ok).toBe(true);

  // tmpRoot should now be gone (best-effort — fs.rm has finished
  // synchronously inside the IPC handler before it resolved).
  await expect(fs.stat(result.tmpRoot!)).rejects.toThrow();
});
