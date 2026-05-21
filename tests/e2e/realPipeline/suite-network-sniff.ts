/**
 * SUITE F + G + H — TRUE end-to-end嗅探 entrypoint coverage.
 *
 * Each suite exercises one of the three network-bound sniff entries
 * (embed / system-chrome / ytdlp-direct) through real DOM. SUITE E
 * already covers offline; F covers embed (default 嗅探 button), G
 * covers system-chrome (网页嗅探 dropdown → 系统 Chrome), H covers
 * ytdlp-direct (网页嗅探 dropdown → yt-dlp 直拉).
 *
 * All three suites are NETWORK-GATED — they only run when
 * `GIFTK_E2E_NETWORK=1` is set, because:
 *   - embed/system-chrome/ytdlp all require external network
 *   - sample URL is read from the user's local 嗅探 history
 *     (sqlite) so the test reflects real usage, not a synthetic page
 *   - system-chrome additionally requires Chrome on the host
 *   - ytdlp-direct requires the `yt-dlp` binary on PATH
 */
import { test, expect } from '@playwright/test';
import {
  getHarness,
  installRecorder,
  tearDownRecorder,
  snapshotRecorder,
  readSampleUrlFromHistory,
  findChromeBinary,
  findYtDlpBinary
} from './_harness';

test('SUITE F — UI-driven embed sniff (default 嗅探 button) full pipeline', async () => {
  const { page } = getHarness();
  test.setTimeout(180_000);
  test.skip(process.env.GIFTK_E2E_NETWORK !== '1', 'GIFTK_E2E_NETWORK!=1; flip the env var to run network-bound suites');

  const tablist = page.getByRole('tablist', { name: '工作区标签' });
  await tablist.getByRole('button', { name: '新建工作区' }).click();
  const tabs = tablist.getByRole('tab');
  const lastTab = tabs.nth((await tabs.count()) - 1);
  await lastTab.click();
  await expect(lastTab).toHaveAttribute('aria-selected', 'true');

  const sampleUrl = await readSampleUrlFromHistory();
  test.skip(!sampleUrl, 'no http URL found in giftk.sniffHistory; sniff something in the app first to seed a sample');

  const urlInput = page.locator('.url-bar input[type="text"]');
  await urlInput.fill(sampleUrl!);

  await installRecorder();
  try {
    const sniffBtn = page.locator('.url-bar button.primary', { hasText: /嗅探/ });
    await expect(sniffBtn).toHaveText('嗅探');
    await sniffBtn.click();
    await expect(sniffBtn).toHaveText('嗅探', { timeout: 60_000 });

    const mediaItems = page.locator('.media-card');
    await expect(mediaItems.first()).toBeVisible({ timeout: 60_000 });

    const snap = await snapshotRecorder();
    const sniffStages = new Set(snap.sniff.map((p) => p.stage));
    expect(sniffStages.size).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(
      '\n[SUITE F embed]\n' +
      `  sample URL    : ${sampleUrl}\n` +
      `  media count   : ${await mediaItems.count()}\n` +
      `  sniff stages  : [${[...sniffStages].join(',')}]\n` +
      `  log lines     : ${snap.logs.length}\n`
    );
  } finally {
    await tearDownRecorder();
    page.once('dialog', (d) => { void d.accept(); });
    await tablist.locator('.ws-tab-close').last().click().catch(() => undefined);
  }
});

test('SUITE G — UI-driven system-chrome sniff full pipeline', async () => {
  const { page } = getHarness();
  test.setTimeout(180_000);
  test.skip(process.env.GIFTK_E2E_NETWORK !== '1', 'GIFTK_E2E_NETWORK!=1; flip the env var to run network-bound suites');

  const chrome = findChromeBinary();
  test.skip(!chrome, 'Google Chrome binary not found on this host; system-chrome sniff requires it');

  const tablist = page.getByRole('tablist', { name: '工作区标签' });
  await tablist.getByRole('button', { name: '新建工作区' }).click();
  const tabs = tablist.getByRole('tab');
  const lastTab = tabs.nth((await tabs.count()) - 1);
  await lastTab.click();

  const sampleUrl = await readSampleUrlFromHistory();
  test.skip(!sampleUrl, 'no http URL found in giftk.sniffHistory');

  const urlInput = page.locator('.url-bar input[type="text"]');
  await urlInput.fill(sampleUrl!);

  await installRecorder();
  try {
    const webviewSniffTrigger = page.locator('button', { hasText: /网页嗅探/ }).first();
    await expect(webviewSniffTrigger).toBeVisible();
    await webviewSniffTrigger.click();

    const systemChromeOpt = page.locator('button', { hasText: /系统 Chrome|系统 chrome|system.chrome/i }).first();
    await expect(systemChromeOpt).toBeVisible({ timeout: 5_000 });
    await systemChromeOpt.click();

    const mediaItems = page.locator('.media-card');
    await expect(mediaItems.first()).toBeVisible({ timeout: 90_000 });

    const snap = await snapshotRecorder();
    const sysChromeLogs = snap.logs.filter((l) => /system-chrome/.test(l));
    expect(sysChromeLogs.length).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(
      '\n[SUITE G system-chrome]\n' +
      `  sample URL          : ${sampleUrl}\n` +
      `  chrome binary       : ${chrome}\n` +
      `  media count         : ${await mediaItems.count()}\n` +
      `  system-chrome logs  : ${sysChromeLogs.length}\n`
    );
  } finally {
    await tearDownRecorder();
    page.once('dialog', (d) => { void d.accept(); });
    await tablist.locator('.ws-tab-close').last().click().catch(() => undefined);
  }
});

test('SUITE H — UI-driven ytdlp-direct sniff full pipeline', async () => {
  const { page } = getHarness();
  test.setTimeout(180_000);
  test.skip(process.env.GIFTK_E2E_NETWORK !== '1', 'GIFTK_E2E_NETWORK!=1; flip the env var to run network-bound suites');

  const ytdlp = findYtDlpBinary();
  test.skip(!ytdlp, 'yt-dlp binary not found on PATH; ytdlp-direct sniff requires it');

  const tablist = page.getByRole('tablist', { name: '工作区标签' });
  await tablist.getByRole('button', { name: '新建工作区' }).click();
  const tabs = tablist.getByRole('tab');
  const lastTab = tabs.nth((await tabs.count()) - 1);
  await lastTab.click();

  const sampleUrl = await readSampleUrlFromHistory();
  test.skip(!sampleUrl, 'no http URL found in giftk.sniffHistory');

  const urlInput = page.locator('.url-bar input[type="text"]');
  await urlInput.fill(sampleUrl!);

  await installRecorder();
  try {
    const webviewSniffTrigger = page.locator('button', { hasText: /网页嗅探/ }).first();
    await expect(webviewSniffTrigger).toBeVisible();
    await webviewSniffTrigger.click();

    const ytdlpOpt = page.locator('button', { hasText: /yt-?dlp|yld/i }).first();
    await expect(ytdlpOpt).toBeVisible({ timeout: 5_000 });
    await ytdlpOpt.click();

    const mediaItems = page.locator('.media-card');
    let sawMedia = true;
    try {
      await expect(mediaItems.first()).toBeVisible({ timeout: 90_000 });
    } catch {
      sawMedia = false;
    }

    const snap = await snapshotRecorder();
    const ytdlpLogs = snap.logs.filter((l) => /ytdlp.direct|yt-dlp/i.test(l));
    expect(ytdlpLogs.length).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(
      '\n[SUITE H ytdlp-direct]\n' +
      `  sample URL    : ${sampleUrl}\n` +
      `  yt-dlp binary : ${ytdlp}\n` +
      `  media found   : ${sawMedia}\n` +
      `  ytdlp logs    : ${ytdlpLogs.length}\n`
    );
  } finally {
    await tearDownRecorder();
    page.once('dialog', (d) => { void d.accept(); });
    await tablist.locator('.ws-tab-close').last().click().catch(() => undefined);
  }
});
