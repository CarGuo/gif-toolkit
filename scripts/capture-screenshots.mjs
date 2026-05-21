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

    console.log('▶ capturing 4 tabs');

    await clickTab(page, '主页');
    await takeShot(page, '01-home');

    await clickTab(page, '工具箱');
    await takeShot(page, '02-toolbox');

    await clickTab(page, '历史');
    await takeShot(page, '03-history');

    await clickTab(page, '上传历史');
    await takeShot(page, '04-uploads');

    console.log(`\n✓ 4 screenshots written to docs/images/screenshots/`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
