import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const MAIN_ENTRY = path.join(projectRoot, 'dist/main/index.js');
const outDir = path.join(projectRoot, 'docs/images/screenshots');
const FIXTURE_GIF = path.join(projectRoot, 'tests/fixtures/tiny.gif');

const VIEWPORT = { width: 1440, height: 900 };

async function takeShot(page, name) {
  await page.waitForTimeout(400);
  await page.screenshot({
    path: path.join(outDir, `${name}.png`),
    fullPage: false,
  });
  console.log(`  ✓ docs/images/screenshots/${name}.png`);
}

async function clickTab(page, label) {
  await page.locator('.tab-btn', { hasText: label }).first().click();
  await page.waitForTimeout(500);
}

async function captureLineageModal(page) {
  // The seed already ran before 02-toolbox, so the history row is
  // visible underneath; just open the modal and shoot.
  const continueBtn = page.locator('button.tb-history-continue').first();
  await continueBtn.waitFor({ state: 'visible', timeout: 10_000 });
  await continueBtn.click();

  const modal = page.locator('div.modal.tb-lineage-modal[role="dialog"]');
  await modal.waitFor({ state: 'visible', timeout: 5_000 });
  await page.waitForTimeout(800);
  await takeShot(page, '05-toolbox-lineage-modal');
}

/**
 * R-COMPRESS-V1 #4 — Capture the lineage modal with the new
 * 「试跑 0.5s」 button visible in the footer. Assumes the lineage
 * modal is currently open from `captureLineageModal`.
 */
async function captureLineageTrialPreview(page) {
  const modal = page.locator('div.modal.tb-lineage-modal[role="dialog"]');
  await modal.waitFor({ state: 'visible', timeout: 5_000 });
  const trialBtn = modal.locator('button', { hasText: /试跑 0\.5s|试跑中…/ });
  await trialBtn.waitFor({ state: 'visible', timeout: 5_000 });
  await trialBtn.scrollIntoViewIfNeeded().catch(() => undefined);
  // Hover so the title tooltip on the button is visually highlighted.
  await trialBtn.hover().catch(() => undefined);
  await page.waitForTimeout(400);
  await takeShot(page, '08-lineage-trial-preview');

  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(300);
}

/**
 * R-COMPRESS-V1 #1 — Switch the toolbox 'kind' chip to GIF Optimize
 * so the new 目标体积快捷条 (target-bytes chip strip) becomes
 * visible, then capture.
 */
async function captureTargetBytesChipRow(page) {
  await clickTab(page, '工具箱');
  const optimizeChip = page.locator('button.tb-chip', { hasText: 'GIF Optimize' });
  await optimizeChip.waitFor({ state: 'visible', timeout: 5_000 });
  await optimizeChip.click();
  const chipRow = page.locator('div[aria-label="目标体积快捷条"]');
  await chipRow.waitFor({ state: 'visible', timeout: 5_000 });
  await chipRow.scrollIntoViewIfNeeded().catch(() => undefined);
  await page.waitForTimeout(400);
  await takeShot(page, '06-toolbox-target-bytes-chip');
}

/**
 * R-COMPRESS-V1 #3 — Switch back to Video → GIF kind so the new
 * fast↔gifski engine segmented control is visible. Hover the
 * 'High quality (gifski)' option so the hint is clearly highlighted.
 */
async function captureEngineToggle(page) {
  await clickTab(page, '工具箱');
  const v2gChip = page.locator('button.tb-chip', { hasText: 'Video → GIF' });
  await v2gChip.waitFor({ state: 'visible', timeout: 5_000 });
  await v2gChip.click();
  const segmented = page.locator('[data-testid="video-to-gif-engine"]');
  await segmented.waitFor({ state: 'visible', timeout: 5_000 });
  await segmented.scrollIntoViewIfNeeded().catch(() => undefined);
  await segmented.locator('button', { hasText: /High quality/ }).hover().catch(() => undefined);
  await page.waitForTimeout(400);
  await takeShot(page, '07-toolbox-engine-toggle');
}

/**
 * R-COMPRESS-V1 #5 — Seed a single done-with-.gif HistoryRecord so
 * HistoryPanel renders a 推荐预设 chip strip on the card. Assumes the
 * 历史 tab is reachable.
 */
async function seedHistoryRecordWithDoneGif(page) {
  await page.evaluate(async (output) => {
    const w = /** @type {{ giftk: { db: { history: { upsert(rec: unknown): Promise<void>; clear(): Promise<void> } } } }} */ (window);
    // Wipe any leftover sniff history (e.g. RCV1-F seed from a prior
    // realPipeline run) so the spotlight only shows our deterministic
    // demo card.
    await w.giftk.db.history.clear();
    const sniffId = `screenshot-history-seed-${Date.now()}`;
    const taskId = `${sniffId}-task`;
    await w.giftk.db.history.upsert({
      id: sniffId,
      createdAt: Date.now(),
      pageUrl: 'https://gif-toolkit.test.example/preset-demo',
      title: '推荐预设演示页',
      items: [{
        id: taskId,
        kind: 'image',
        url: 'https://gif-toolkit.test.example/source.gif',
        pageUrl: 'https://gif-toolkit.test.example/preset-demo',
        tab: 'images'
      }],
      options: {},
      outputDir: '',
      outputsByTaskId: { [taskId]: [output] },
      taskStatus: { [taskId]: 'done' },
      uploadsByOutputPath: {}
    });
  }, FIXTURE_GIF);
}

/**
 * R-COMPRESS-V1 #5 — Open 历史 tab, wait for the seeded card with
 * its 推荐预设 chip strip, then capture.
 */
async function captureHistoryPresetStrip(page) {
  // 历史 is a substring of 上传历史 — match the exact tab name.
  const historyTab = page.getByRole('button', { name: /^历史( \(\d+\))?$/ });
  await historyTab.waitFor({ state: 'visible', timeout: 10_000 });
  await historyTab.click();
  const presetGroup = page.locator('[role="group"][aria-label="推荐预设"]').first();
  await presetGroup.waitFor({ state: 'visible', timeout: 5_000 });
  await presetGroup.scrollIntoViewIfNeeded().catch(() => undefined);
  await page.waitForTimeout(400);
  await takeShot(page, '09-history-preset-strip');
}

async function seedToolboxHistoryRow(page) {
  const seedId = `screenshot-seed-${Date.now()}`;
  const finishedAt = Date.now();
  await page.evaluate(
    async (args) => {
      await window.giftk.db.toolboxHistory.upsert({
        id: args.id,
        kind: 'video-to-gif',
        inputPath: '/synthetic/source.mp4',
        displayName: 'demo-input.mp4',
        outputs: [args.output],
        params: { fps: 12, maxWidth: 320 },
        status: 'done',
        finishedAt: args.finishedAt,
      });
    },
    { id: seedId, output: FIXTURE_GIF, finishedAt }
  );
  // Bounce tabs so ToolboxPanel re-reads db.toolboxHistory on mount.
  await clickTab(page, '主页');
  await page.waitForFunction(
    async (id) => {
      const rows = await window.giftk.db.toolboxHistory.readAll();
      return rows.some((r) => r.id === id);
    },
    seedId,
    { timeout: 10_000 }
  );
}

async function main() {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(
      `dist/main/index.js missing — run \`npm run build\` first (or use \`npm run docs:screenshots\` which does it).`
    );
  }
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const app = await electron.launch({
    args: [MAIN_ENTRY],
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('.app', { timeout: 30_000 });
    await page.setViewportSize(VIEWPORT);
    await page.waitForTimeout(800);

    console.log('▶ capturing 4 tabs + 5 R-COMPRESS-V1 spotlights');

    // R-TB-CHAIN-V2.6 — seed one toolbox-history row up-front so
    // 02-toolbox showcases the new 4-col history grid + thumbnail and
    // 05-toolbox-lineage-modal can immediately open the modal off the
    // same row.
    await seedToolboxHistoryRow(page);
    // R-COMPRESS-V1 #5 — also seed a sniff-history record with a done
    // .gif output so 03-history (and the dedicated 09 spotlight) show
    // the new 推荐预设 chip strip.
    await seedHistoryRecordWithDoneGif(page);

    await clickTab(page, '主页');
    await takeShot(page, '01-home');

    await clickTab(page, '工具箱');
    await takeShot(page, '02-toolbox');

    await clickTab(page, '历史');
    await takeShot(page, '03-history');

    await clickTab(page, '上传历史');
    await takeShot(page, '04-uploads');

    // Re-enter the toolbox tab so the history row is mounted, then
    // open the lineage modal and capture the V2.6 弹窗化 + 自动播放
    // 预览 + 4-列历史行 UI in one shot.
    await clickTab(page, '工具箱');
    await captureLineageModal(page);
    // R-COMPRESS-V1 #4 — re-shoot the still-open modal with the
    // 试跑 0.5s footer button highlighted, then close it.
    await captureLineageTrialPreview(page);

    // R-COMPRESS-V1 #1 + #3 — back to the main toolbox panel and
    // walk through the two new ParamForm spotlights.
    await captureTargetBytesChipRow(page);
    await captureEngineToggle(page);

    // R-COMPRESS-V1 #5 — open 历史 tab and capture the dedicated
    // chip-strip closeup.
    await captureHistoryPresetStrip(page);

    console.log(`\n✓ 9 screenshots written to docs/images/screenshots/`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
