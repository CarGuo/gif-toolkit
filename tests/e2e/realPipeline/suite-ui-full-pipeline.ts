/**
 * SUITE E — TRUE end-to-end UI walk: 离线导入 (real DOM click) →
 * MediaGrid select → 开始批处理 (real DOM click) → wait for terminal →
 * optional 强制允许 retry → assert artifact on disk → optional gated
 * upload. Unlike A-D, this suite never calls `window.giftk.*` directly;
 * every state transition is driven by the same DOM events a human would
 * emit. We bypass ONLY the OS-level file picker (which Playwright cannot
 * interact with on Electron) by stubbing `dialog.showOpenDialog` from
 * inside the main process — production source is untouched.
 */
import { test, expect } from '@playwright/test';
import { existsSync, statSync } from 'node:fs';
import {
  FIXTURE_MEDIUM,
  getHarness,
  installRecorder,
  tearDownRecorder,
  snapshotRecorder,
  waitForAnyTerminal
} from './_harness';

test('SUITE E — UI-driven full pipeline: 离线导入 → select → 开始批处理 → terminal → artifact', async () => {
  const { app, page } = getHarness();
  test.setTimeout(180_000);
  if (!existsSync(FIXTURE_MEDIUM)) throw new Error(`missing medium fixture: ${FIXTURE_MEDIUM}`);

  await app.evaluate(async ({ dialog }, fixturePath: string) => {
    const original = dialog.showOpenDialog.bind(dialog);
    const stub = (async () => ({ canceled: false, filePaths: [fixturePath] })) as typeof dialog.showOpenDialog;
    (dialog as unknown as { showOpenDialog: typeof dialog.showOpenDialog }).showOpenDialog = stub;
    (globalThis as unknown as { __originalShowOpenDialog?: typeof dialog.showOpenDialog }).__originalShowOpenDialog = original;
  }, FIXTURE_MEDIUM);

  const tablist = page.getByRole('tablist', { name: '工作区标签' });
  const tabs = tablist.getByRole('tab');
  await tabs.nth(0).click();
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');

  const startedAt = Date.now();
  const intermediateStatuses = new Set<string>();
  let hitForceAllow = false;

  const offlineBtn = page.locator('button', { hasText: /📂 离线导入/ });
  await expect(offlineBtn).toBeVisible({ timeout: 10_000 });
  await expect(offlineBtn).toBeEnabled();

  await installRecorder();
  await offlineBtn.click();

  const mediaItems = page.locator('.media-card');
  await expect(mediaItems.first()).toBeVisible({ timeout: 30_000 });
  const firstItem = mediaItems.first();
  await expect(firstItem.locator('.badge.video')).toBeVisible();

  const checkbox = firstItem.locator('.card-check input[type="checkbox"]');
  const alreadyChecked = await firstItem.evaluate((el) => el.classList.contains('checked'));
  if (!alreadyChecked) await checkbox.click();
  await expect(firstItem).toHaveClass(/(^|\s)checked(\s|$)/);

  let baselineEvents = (await snapshotRecorder()).progress.length;
  try {
    const startBatchBtn = page.locator('button.fab-start-batch');
    await expect(startBatchBtn).toBeVisible();
    await expect(startBatchBtn).toBeEnabled({ timeout: 10_000 });
    await startBatchBtn.click();

    await expect(page.locator('.tasks .task').first()).toBeVisible({ timeout: 30_000 });

    let final = await waitForAnyTerminal(120_000, { ignoreEventBefore: baselineEvents });
    const firstStatus = final.status;
    const firstTaskId = final.taskId;

    if (final.status === 'failed') {
      const forceBtn = page.locator('.force-allow-btn').first();
      const visible = await forceBtn.isVisible().catch(() => false);
      if (!visible) {
        throw new Error(
          `task ${firstTaskId} failed but no 强制允许 button was rendered; ` +
          `errorCode=${final.errorCode ?? '?'} error=${final.error ?? '?'}.`
        );
      }
      hitForceAllow = true;
      await tearDownRecorder();
      await installRecorder();
      baselineEvents = 0;
      await forceBtn.click();
      final = await waitForAnyTerminal(60_000, {
        acceptStatuses: ['done', 'failed', 'cancelled', 'skipped'],
        ignoreEventBefore: baselineEvents
      });
    }

    expect(final.status).toBe('done');
    expect(Array.isArray(final.outputs)).toBe(true);
    expect((final.outputs ?? []).length).toBeGreaterThanOrEqual(1);
    const outputPath = (final.outputs as string[])[0];
    expect(existsSync(outputPath)).toBe(true);
    const sz = statSync(outputPath).size;
    expect(sz).toBeGreaterThan(1024);

    const snap = await snapshotRecorder();
    for (const p of snap.progress) {
      if (p.taskId === final.taskId && p.status !== 'done' && p.status !== 'failed') {
        intermediateStatuses.add(p.status);
      }
    }
    const taskProgress = snap.progress.filter((p) => p.taskId === final.taskId);
    const maxPercent = taskProgress.reduce(
      (m, p) => Math.max(m, typeof p.percent === 'number' ? p.percent : 0),
      0
    );
    const elapsedMs = Date.now() - startedAt;
    // eslint-disable-next-line no-console
    console.log(
      '\n[SUITE E artifact]\n' +
      `  output gif         : ${outputPath}\n` +
      `  output size bytes  : ${sz}\n` +
      `  total elapsed (ms) : ${elapsedMs}\n` +
      `  first terminal     : ${firstStatus}${hitForceAllow ? ' → 强制允许 → done' : ''}\n` +
      `  progress events    : ${taskProgress.length} (max percent ${maxPercent})\n` +
      `  intermediate states: [${[...intermediateStatuses].join(',')}]\n`
    );

    if (process.env.GIFTK_E2E_REAL_UPLOAD === '1') {
      const uploadAllBtn = page.locator('button', { hasText: /⚡ 上传所有产物/ });
      await expect(uploadAllBtn).toBeEnabled({ timeout: 10_000 });
      await page.evaluate(() => {
        const w = window as unknown as {
          __e2eUpload?: { events: unknown[]; off?: () => void };
          giftk: { onUploadProgress?: (cb: (p: unknown) => void) => () => void };
        };
        if (w.__e2eUpload?.off) w.__e2eUpload.off();
        const buf: unknown[] = [];
        const off = w.giftk.onUploadProgress?.((p) => { buf.push(p); });
        w.__e2eUpload = { events: buf, off };
      });
      await uploadAllBtn.click();
      const sawDone = await page.waitForFunction(
        () => {
          const w = window as unknown as {
            __e2eUpload?: { events: Array<{ status?: string }> };
          };
          return (w.__e2eUpload?.events ?? []).some((e) => e.status === 'done');
        },
        undefined,
        { timeout: 30_000 }
      );
      expect(sawDone).toBeTruthy();
    } else {
      test.info().annotations.push({
        type: 'skipped-upload',
        description:
          'GIFTK_E2E_REAL_UPLOAD!=1 — upload leg is gated; flip the env var ' +
          'and configure a backend in 「📤 上传设置」 to exercise it.'
      });
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
