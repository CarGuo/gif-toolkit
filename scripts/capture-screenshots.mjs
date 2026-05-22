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

  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(300);
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

    console.log('▶ capturing 4 tabs + 1 lineage modal');

    // R-TB-CHAIN-V2.6 — seed one toolbox-history row up-front so
    // 02-toolbox showcases the new 4-col history grid + thumbnail and
    // 05-toolbox-lineage-modal can immediately open the modal off the
    // same row.
    await seedToolboxHistoryRow(page);

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

    console.log(`\n✓ 5 screenshots written to docs/images/screenshots/`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
