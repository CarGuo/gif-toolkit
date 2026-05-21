/**
 * SUITE D — workspace cross-tab task isolation oracle.
 *
 * R-WS-2026-05-21: 工作区 tab 现在仅由"嗅探"自动产生 (claimForSniff)，
 * UI 已移除"+"按钮。SUITE D 通过真实链路验证 tab 间任务隔离：
 *   1. tab A 初始 blank → 离线导入一次让它变非 blank
 *   2. 再调一次离线导入 → claimForSniff 看 active 非 blank 自动开 tab B
 *   3. 在 tab B 跑 startBatch，验证 tab A 看不到 task 行
 *
 * Like SUITE E, this drives the production preload bridge via real DOM
 * events but keeps a `dialog.showOpenDialog` stub installed via
 * `app.evaluate(...)` so the OS file picker doesn't block. Production
 * source stays untouched.
 */
import { test, expect } from '@playwright/test';
import { existsSync, rmSync } from 'node:fs';
import {
  FIXTURE_MP4,
  getHarness,
  freshOutDir,
  pathToGiftkLocal,
  installRecorder,
  tearDownRecorder,
  waitForTerminal
} from './_harness';

test('SUITE D — workspace cross-tab task isolation', async () => {
  const { app, page } = getHarness();
  // R-WS-2026-05-21 — 工作区 tab 现在仅由"嗅探"自动产生 (claimForSniff)，
  // UI 已移除"+"按钮。SUITE D 改造为通过真实链路开第二个 tab：
  //   1. tab A 初始 blank → 离线导入一次让它变非 blank
  //   2. 再调一次离线导入 → claimForSniff 看 active 非 blank 自动开 tab B
  //   3. 在 tab B 跑 startBatch，验证 tab A 看不到 task 行
  test.setTimeout(120_000);
  expect(existsSync(FIXTURE_MP4)).toBe(true);
  const outDir = freshOutDir('D');

  // dialog stub for offline-import button (mirrors SUITE E pattern)
  await app.evaluate(async ({ dialog }, fixturePath: string) => {
    const original = dialog.showOpenDialog.bind(dialog);
    const stub = (async () => ({ canceled: false, filePaths: [fixturePath] })) as typeof dialog.showOpenDialog;
    (dialog as unknown as { showOpenDialog: typeof dialog.showOpenDialog }).showOpenDialog = stub;
    (globalThis as unknown as { __originalShowOpenDialog?: typeof dialog.showOpenDialog }).__originalShowOpenDialog = original;
  }, FIXTURE_MP4);

  try {
    const tablist = page.getByRole('tablist', { name: '工作区标签' });
    const tabs = tablist.getByRole('tab');

    // (1) 让 tab A 变非 blank：点离线导入按钮
    const offlineBtn = page.getByRole('button', { name: /离线导入/ });
    await expect(offlineBtn).toBeEnabled({ timeout: 15_000 });
    await offlineBtn.click();
    // wait for tab A to host a sniff result (label != "新工作区")
    await page.waitForFunction(
      () => {
        const tab = document.querySelector('[role="tab"][aria-selected="true"]');
        const label = tab?.querySelector('.ws-tab-label')?.textContent ?? '';
        return label.trim() !== '' && label.trim() !== '新工作区';
      },
      undefined,
      { timeout: 30_000 }
    );
    // wait for sniffing to finish (offlineBtn re-enabled)
    await expect(offlineBtn).toBeEnabled({ timeout: 30_000 });

    // (2) 再点离线导入 → claimForSniff 自动开 tab B
    await offlineBtn.click();
    await expect(tabs).toHaveCount(2, { timeout: 15_000 });
    const tabBIndex = 1;
    await tabs.nth(tabBIndex).click();
    await expect(tabs.nth(tabBIndex)).toHaveAttribute('aria-selected', 'true');
    // ensure tab B's sniff settled too
    await expect(offlineBtn).toBeEnabled({ timeout: 30_000 });

    await installRecorder();

    // (3) 在 tab B 直接 startBatch (合法真实 IPC，模拟 UI 点击 ▶ 开始批处理)
    const localUrl = pathToGiftkLocal(FIXTURE_MP4);
    await page.evaluate(async (args: { url: string; outDir: string }) => {
      const g = (window as unknown as {
        giftk: { startBatch(tasks: unknown[]): Promise<unknown> };
      }).giftk;
      const media = {
        id: 'realtest-d',
        url: args.url,
        kind: 'video',
        source: 'video-tag',
        pageUrl: args.url,
        width: 240,
        height: 180,
        durationSec: 1
      };
      const options = {
        outDir: args.outDir,
        fps: 8,
        maxWidth: 120,
        maxBytes: 512000,
        softMaxBytes: 256000,
        minSize: 64,
        speed: 1,
        maxSegmentSec: 60,
        lossyCeiling: 80,
        colorsFloor: 64,
        optimizeLevel: 1,
        dither: 'floyd-steinberg',
        forceAllowSmallSide: true
      };
      return g.startBatch([{ id: 'realtest-d', media, options }]);
    }, { url: localUrl, outDir });

    const sawProgress = await page.waitForFunction(
      () => {
        const w = window as unknown as { __e2e?: { progress: Array<{ taskId: string; status: string }> } };
        const arr = w.__e2e?.progress ?? [];
        return arr.some(
          (p) => p.taskId === 'realtest-d' && (p.status === 'processing' || p.status === 'done' || p.status === 'converting' || p.status === 'compressing' || p.status === 'downloading' || p.status === 'probing' || p.status === 'segmenting')
        );
      },
      undefined,
      { timeout: 30_000 }
    );
    expect(sawProgress).toBeTruthy();

    // (4) 切回 tab A 验证 task 行 = 0（隔离 oracle）
    await tabs.nth(0).click();
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');

    const tabATaskRowCount = await page.locator('.tasks .task').count();
    expect(tabATaskRowCount).toBe(0);

    // (5) 切回 tab B 等任务收敛
    await tabs.nth(tabBIndex).click();
    await expect(tabs.nth(tabBIndex)).toHaveAttribute('aria-selected', 'true');
    await waitForTerminal('realtest-d', 60_000);
  } finally {
    await tearDownRecorder();
    try { rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
    // restore dialog stub
    await app.evaluate(async ({ dialog }) => {
      const original = (globalThis as unknown as { __originalShowOpenDialog?: typeof dialog.showOpenDialog }).__originalShowOpenDialog;
      if (original) {
        (dialog as unknown as { showOpenDialog: typeof dialog.showOpenDialog }).showOpenDialog = original;
      }
    });
    // close extra tabs to keep test isolation hygiene
    const tablist = page.getByRole('tablist', { name: '工作区标签' });
    const tabs = tablist.getByRole('tab');
    const count = await tabs.count();
    if (count > 1) {
      const closeBtns = tablist.locator('.ws-tab-close');
      const closeCount = await closeBtns.count();
      if (closeCount > 0) {
        page.once('dialog', (d) => { void d.accept(); });
        await closeBtns.last().click().catch(() => undefined);
      }
    }
    // R-WS-2026-05-21 — final tab carries SUITE D's sniff result; reload
    // the renderer to guarantee SUITE E starts from a fresh single
    // blank workspace. localStorage / SQLite state survives reload, only
    // the in-memory React tree is reset.
    await page.reload();
    await page.waitForSelector('.app', { timeout: 30_000 });
  }
});
