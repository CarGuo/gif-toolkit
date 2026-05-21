/**
 * SUITE I + J + L — segment picker, manual re-optimize, trim oracle.
 *
 * SUITE I (default ON, R-68): UI-driven segment picker. Long video
 *   (21s) → BatchSegmentModal → 默认勾 [0] (前 20s) → 开始处理 →
 *   ffprobe oracle: 产物时长 < 20.5s (proves segment-pick took effect).
 *
 * SUITE J (default ON): manual re-optimize OR compression log oracle.
 *   medium.mp4 → 离线导 → 跑 → 验首跑日志含 lossy/gifsicle/optimize.
 *   若首产物未达标自动出二次优化按钮 → 点 → 比 secondSize ≤ firstSize * 1.1.
 *
 * SUITE L (skip without GIFTK_E2E_DEEP=1): PreviewModal trim drag.
 *   medium.mp4 (3s) → MediaCard click → PreviewModal → drag 右 handle →
 *   单独处理 → ffprobe oracle: 产物时长 < 1.5s. KNOWN LIMITATION:
 *   PreviewModal 内嵌的 <video> 在 Playwright/Electron 沙箱加载
 *   giftk-local:// 失败 → onLoadedMetadata 不触发 → Timeline 不渲染.
 *   同质 trim 场景由 SUITE I 的 segment-picker 在 default 模式下覆盖.
 */
import { test, expect } from '@playwright/test';
import { existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import {
  FIXTURE_LONG,
  FIXTURE_MEDIUM,
  type RecordedProgress,
  getHarness,
  installRecorder,
  tearDownRecorder,
  snapshotRecorder,
  waitForAnyTerminal
} from './_harness';

test('SUITE I — UI-driven segment picker: long video → modal → first segment only', async () => {
  const { app, page } = getHarness();
  test.setTimeout(120_000);
  expect(existsSync(FIXTURE_LONG)).toBe(true);

  await app.evaluate(async ({ dialog }, fixturePath: string) => {
    const original = dialog.showOpenDialog.bind(dialog);
    const stub = (async () => ({ canceled: false, filePaths: [fixturePath] })) as typeof dialog.showOpenDialog;
    (dialog as unknown as { showOpenDialog: typeof dialog.showOpenDialog }).showOpenDialog = stub;
    (globalThis as unknown as { __originalShowOpenDialog?: typeof dialog.showOpenDialog }).__originalShowOpenDialog = original;
  }, FIXTURE_LONG);

  await installRecorder();
  try {
    await page.locator('button', { hasText: /📂 离线导入/ }).first().click();
    const mediaCard = page.locator('.media-card').first();
    await expect(mediaCard).toBeVisible({ timeout: 30_000 });
    await mediaCard.locator('.card-check input[type="checkbox"]').check();

    await page.locator('button.fab-start-batch').click();

    const modal = page.locator('[aria-label="batch-segment-modal"]');
    await expect(modal).toBeVisible({ timeout: 15_000 });

    const confirmBtn = modal.locator('button', { hasText: /开始处理/ });
    await expect(confirmBtn).toBeVisible();
    const confirmText = (await confirmBtn.textContent()) ?? '';
    expect(confirmText).toMatch(/\(\s*1\s*段\s*\)/);
    await confirmBtn.click();

    await expect(modal).not.toBeVisible({ timeout: 5_000 });

    const taskRow = page.locator('.tasks .task').first();
    await expect(taskRow).toBeVisible({ timeout: 30_000 });
    const baselineI = (await snapshotRecorder()).progress.length;
    await waitForAnyTerminal(60_000, { ignoreEventBefore: baselineI });

    const snap = await snapshotRecorder();
    const doneEntry = snap.progress.slice(baselineI).find((p) => p.status === 'done');
    expect(doneEntry, 'expected at least one progress=done entry').toBeDefined();
    const outputs = doneEntry?.outputs ?? [];
    expect(Array.isArray(outputs) && outputs.length).toBeGreaterThan(0);

    const outGif = outputs[0] as string;
    expect(existsSync(outGif)).toBe(true);
    const probeOut = execSync(
      `ffprobe -v error -show_entries format=duration -of default=nokey=1:noprint_wrappers=1 "${outGif}"`,
      { encoding: 'utf8' }
    ).trim();
    const gifDuration = Number(probeOut);
    expect(Number.isFinite(gifDuration)).toBe(true);
    expect(gifDuration).toBeGreaterThan(0);
    expect(gifDuration).toBeLessThan(20.5);
    // eslint-disable-next-line no-console
    console.log(
      '\n[SUITE I segment-picker]\n' +
      `  fixture original  : 21.0s\n` +
      `  output gif        : ${outGif}\n` +
      `  output duration   : ${gifDuration.toFixed(2)}s\n` +
      `  outputs count     : ${outputs.length}\n`
    );
  } finally {
    await tearDownRecorder();
    await app.evaluate(async ({ dialog }) => {
      const original = (globalThis as unknown as { __originalShowOpenDialog?: typeof dialog.showOpenDialog }).__originalShowOpenDialog;
      if (original) {
        (dialog as unknown as { showOpenDialog: typeof dialog.showOpenDialog }).showOpenDialog = original;
      }
    });
  }
});

test('SUITE J — UI-driven manual re-optimize OR compression log oracle', async () => {
  const { app, page } = getHarness();
  test.setTimeout(180_000);
  expect(existsSync(FIXTURE_MEDIUM)).toBe(true);

  await app.evaluate(async ({ dialog }, fixturePath: string) => {
    const original = dialog.showOpenDialog.bind(dialog);
    const stub = (async () => ({ canceled: false, filePaths: [fixturePath] })) as typeof dialog.showOpenDialog;
    (dialog as unknown as { showOpenDialog: typeof dialog.showOpenDialog }).showOpenDialog = stub;
    (globalThis as unknown as { __originalShowOpenDialog?: typeof dialog.showOpenDialog }).__originalShowOpenDialog = original;
  }, FIXTURE_MEDIUM);

  await installRecorder();
  try {
    await page.locator('button', { hasText: /📂 离线导入/ }).first().click();
    const mediaCard = page.locator('.media-card').first();
    await expect(mediaCard).toBeVisible({ timeout: 30_000 });
    await mediaCard.locator('.card-check input[type="checkbox"]').check();
    await page.locator('button.fab-start-batch').click();

    const taskRow = page.locator('.tasks .task').first();
    await expect(taskRow).toBeVisible({ timeout: 30_000 });
    const baselineJ = (await snapshotRecorder()).progress.length;
    await waitForAnyTerminal(90_000, { ignoreEventBefore: baselineJ });

    const firstSnap = await snapshotRecorder();
    const firstDone = firstSnap.progress.slice(baselineJ).find((p) => p.status === 'done');
    expect(firstDone, 'first run must produce a done').toBeDefined();
    const firstOutputs = (firstDone?.outputs ?? []) as string[];
    expect(firstOutputs.length).toBeGreaterThan(0);
    const firstGif = firstOutputs[0];
    const firstSize = statSync(firstGif).size;

    const compressionEvents = firstSnap.progress
      .slice(baselineJ)
      .filter((p) => {
        const substep = (p as RecordedProgress & { substep?: string }).substep ?? '';
        const message = (p as RecordedProgress & { message?: string }).message ?? '';
        return /compress|lossy|gifsicle|optim/i.test(substep) || /compress|lossy|gifsicle|optim/i.test(message);
      });
    const allMessagesSample = firstSnap.progress
      .slice(baselineJ)
      .map((p) => (p as RecordedProgress & { substep?: string; message?: string }))
      .map((p) => `[${p.status}/${p.substep ?? ''}] ${p.message ?? ''}`)
      .join(' || ');
    expect(
      compressionEvents.length,
      `expected ≥1 compression-related progress event (substep/message含 compress|lossy|gifsicle|optim). All events: ${allMessagesSample}`
    ).toBeGreaterThan(0);

    const optimizeBtn = page.locator(
      'button[title*="二次优化"], button[title*="手动二次优化"]'
    ).first();
    const optimizeVisible = await optimizeBtn.isVisible().catch(() => false);

    let secondGif: string | null = null;
    let secondSize: number | null = null;

    if (optimizeVisible) {
      await optimizeBtn.click();
      const optModalTitle = page.locator('h3', { hasText: /手动二次优化/ });
      await expect(optModalTitle).toBeVisible({ timeout: 5_000 });
      const optModalRoot = page.locator('div', { has: optModalTitle }).first();
      const submitBtn = optModalRoot
        .locator('button')
        .filter({ hasText: /(再次|重新|确认|重跑|开始|提交|应用|执行)/ })
        .first();
      const submitVisible = await submitBtn.isVisible().catch(() => false);
      if (submitVisible) {
        const baselineSecond = (await snapshotRecorder()).progress.length;
        await submitBtn.click();
        await waitForAnyTerminal(90_000, { ignoreEventBefore: baselineSecond });
        const secondSnap = await snapshotRecorder();
        const dones = secondSnap.progress.slice(baselineSecond).filter((p) => p.status === 'done');
        if (dones.length >= 1) {
          const last = dones[dones.length - 1];
          const lastOutputs = (last.outputs ?? []) as string[];
          if (lastOutputs.length > 0) {
            secondGif = lastOutputs[0];
            secondSize = statSync(secondGif).size;
          }
        }
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      '\n[SUITE J re-optimize / compression oracle]\n' +
      `  first gif         : ${firstGif} (${firstSize} bytes)\n` +
      `  compression evts  : ${compressionEvents.length} (substep含 compress/lossy/gifsicle)\n` +
      `  re-optimize btn   : ${optimizeVisible ? 'visible — clicked' : 'hidden — first产物已达标'}\n` +
      `  second gif        : ${secondGif ?? '(none)'}` +
      (secondSize !== null ? ` (${secondSize} bytes)` : '') + '\n'
    );

    if (secondGif !== null && secondSize !== null) {
      expect(secondGif).not.toBe(firstGif);
      expect(secondSize).toBeLessThanOrEqual(firstSize * 1.1);
    }
  } finally {
    await tearDownRecorder();
    await app.evaluate(async ({ dialog }) => {
      const original = (globalThis as unknown as { __originalShowOpenDialog?: typeof dialog.showOpenDialog }).__originalShowOpenDialog;
      if (original) {
        (dialog as unknown as { showOpenDialog: typeof dialog.showOpenDialog }).showOpenDialog = original;
      }
    });
  }
});

test('SUITE L — UI-driven trim adjust: PreviewModal timeline drag → 单独处理 → ffprobe verify', async () => {
  const { app, page } = getHarness();
  test.setTimeout(180_000);
  expect(existsSync(FIXTURE_MEDIUM)).toBe(true);

  // KNOWN LIMITATION — 见上面注释. PreviewModal video tag 在 Playwright
  // Electron 沙箱里加载 giftk-local:// 失败 → onLoadedMetadata 不触发 →
  // Timeline 不渲染. 用 GIFTK_E2E_DEEP=1 强制运行,但需要在真实 Electron
  // 环境(非 Playwright 包装)才能看到 timeline-handle. 同等的 trim 场景
  // 由 SUITE I (BatchSegmentModal segment-pick) 覆盖, default ON.
  test.skip(
    process.env.GIFTK_E2E_DEEP !== '1',
    'PreviewModal video tag 在 Playwright/Electron 测试环境下无法加载 giftk-local:// → ' +
    'Timeline 不渲染. 设 GIFTK_E2E_DEEP=1 在本地真实环境强跑. ' +
    '同质 trim 场景已由 SUITE I segment-picker 覆盖.'
  );

  await app.evaluate(async ({ dialog }, fixturePath: string) => {
    const original = dialog.showOpenDialog.bind(dialog);
    const stub = (async () => ({ canceled: false, filePaths: [fixturePath] })) as typeof dialog.showOpenDialog;
    (dialog as unknown as { showOpenDialog: typeof dialog.showOpenDialog }).showOpenDialog = stub;
    (globalThis as unknown as { __originalShowOpenDialog?: typeof dialog.showOpenDialog }).__originalShowOpenDialog = original;
  }, FIXTURE_MEDIUM);

  await installRecorder();
  try {
    // 1) 离线导入 medium.mp4 (3s, 320x240)
    await page.locator('button', { hasText: /📂 离线导入/ }).first().click();
    const mediaCard = page.locator('.media-card').first();
    await expect(mediaCard).toBeVisible({ timeout: 30_000 });

    // 2) 点 MediaCard 打开 PreviewModal — 不点 checkbox / process button.
    //    卡片本身的 onClick 在 .media-card 容器层.
    await mediaCard.click();
    // 等 modal-mask 出现, 证明 PreviewModal 真打开了.
    const modalMask = page.locator('.modal-mask').first();
    await expect(modalMask).toBeVisible({ timeout: 10_000 });
    const modal = page.locator('.modal-mask .modal[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 5_000 });
    // 等 video metadata 加载 (medium.mp4 离线导入是 giftk-local:// 协议,
    //    Electron 已注册成 secure scheme, 但仍需要等 onLoadedMetadata).
    //    Timeline 只在 isVideo && duration > 0 时渲染.
    const timelineTrack = page.locator('.modal .timeline .timeline-track').first();
    await expect(timelineTrack).toBeVisible({ timeout: 30_000 });

    // 3) 真鼠标拖右 handle 到 ~1/3 位置 (end ≈ 1s 给 3s 视频).
    const trackBox = await timelineTrack.boundingBox();
    if (!trackBox) throw new Error('timeline-track has no bounding box');
    const rightHandle = page.locator('.timeline-handle.right').first();
    const rightBox = await rightHandle.boundingBox();
    if (!rightBox) throw new Error('right timeline-handle has no bounding box');
    const startX = rightBox.x + rightBox.width / 2;
    const startY = rightBox.y + rightBox.height / 2;
    const targetX = trackBox.x + trackBox.width * 0.33; // ~1s of 3s

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // 中间步进, 让 pointermove 触发 (单步直接落点有时不会派发 move).
    for (let step = 1; step <= 8; step++) {
      const x = startX + (targetX - startX) * (step / 8);
      await page.mouse.move(x, startY);
    }
    await page.mouse.up();

    await page.waitForTimeout(200);
    const infoText = await page.locator('.timeline').first().textContent();
    if (infoText) {
      // eslint-disable-next-line no-console
      console.log('[SUITE L] timeline info after drag:', infoText.replace(/\s+/g, ' ').trim());
    }

    // 4) 点 "▶ 单独处理本项" — modal footer 的 primary button.
    const baselineL = (await snapshotRecorder()).progress.length;
    const processOneBtn = modal.locator('button.primary', { hasText: /单独处理本项/ }).first();
    await expect(processOneBtn).toBeEnabled({ timeout: 5_000 });
    await processOneBtn.click();

    // 5) 等 done.
    const term = await waitForAnyTerminal(90_000, { ignoreEventBefore: baselineL });
    expect(term.status).toBe('done');
    const outputs = term.outputs ?? [];
    expect(outputs.length).toBeGreaterThan(0);
    const outGif = outputs[0] as string;
    expect(existsSync(outGif)).toBe(true);

    // 6) ffprobe oracle: 产物时长 < 1.5s (trim 把 3s 截到 ~1s).
    const probeOut = execSync(
      `ffprobe -v error -show_entries format=duration -of default=nokey=1:noprint_wrappers=1 "${outGif}"`,
      { encoding: 'utf8' }
    ).trim();
    const gifDuration = Number(probeOut);
    expect(Number.isFinite(gifDuration)).toBe(true);
    expect(gifDuration).toBeGreaterThan(0);
    expect(gifDuration).toBeLessThan(1.5);

    // eslint-disable-next-line no-console
    console.log(
      '\n[SUITE L trim-adjust]\n' +
      `  fixture original  : 3.00s\n` +
      `  output gif        : ${outGif}\n` +
      `  output duration   : ${gifDuration.toFixed(2)}s\n` +
      `  trim oracle       : OK (< 1.5s)\n`
    );
  } finally {
    await tearDownRecorder();
    await app.evaluate(async ({ dialog }) => {
      const original = (globalThis as unknown as { __originalShowOpenDialog?: typeof dialog.showOpenDialog }).__originalShowOpenDialog;
      if (original) {
        (dialog as unknown as { showOpenDialog: typeof dialog.showOpenDialog }).showOpenDialog = original;
      }
    });
    await page.keyboard.press('Escape').catch(() => undefined);
  }
});
