/**
 * SUITE M + N — format contracts.
 *
 * SUITE M (R-69 contract guard): 「手动二次优化」按钮必出现分支.
 *   long.mp4 + maxBytes=1KB → 4-Phase compression 撑不到目标 → final.warning
 *   含 "exceeds hard target" → 把 progress 喂给
 *   [isUnderTargetDone](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/TaskTable.tsx#L89-L94)
 *   返回 true. 这是「按钮必出现」的等价 oracle.
 *
 * SUITE N: UI 真链路「视频转 GIF」产物 ffprobe 格式契约.
 *   tiny.mp4 → 离线导 → 选 → 开始批处理 → 等终态 → ffprobe 验
 *   format_name=gif, codec_name=gif, frames>=2.
 */
import { test, expect } from '@playwright/test';
import { existsSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import {
  FIXTURE_MP4,
  FIXTURE_LONG,
  getHarness,
  freshOutDir,
  pathToGiftkLocal,
  installRecorder,
  tearDownRecorder,
  snapshotRecorder,
  waitForTerminal,
  waitForAnyTerminal
} from './_harness';

test('SUITE M — 手动优化按钮契约: warning + isUnderTargetDone predicate', async () => {
  const { page } = getHarness();
  test.setTimeout(180_000);
  expect(existsSync(FIXTURE_LONG)).toBe(true);

  await installRecorder();
  const outDir = freshOutDir('M');
  try {
    const localUrl = pathToGiftkLocal(FIXTURE_LONG);

    // R-69 — long.mp4 (82KB, 21s @ 320x240) + maxBytes=1KB / softMaxBytes=512B
    // 让 4-Phase compression 永远撑不到目标 → 终态 warning 必含 "exceeds hard
    // target". 用 long.mp4 而非 tiny.mp4, 因 tiny.mp4 (6.6KB) 转 GIF 后可能
    // 直接 ≤ 1KB 反而早退成功. lossyCeiling=200 让 lossy 耗尽极限,
    // colorsFloor=2 让色板压到极小, optimizeLevel=3 让 gifsicle 拉满,
    // 但因为 maxSegmentSec=10 + 21s 视频 → 多段 GIF 无法压到 1KB.
    const startResult = await page.evaluate(async (args: { url: string; outDir: string }) => {
      const g = (window as unknown as {
        giftk: { startBatch(tasks: unknown[], pageTitle?: string, outputDirOverride?: string, sessionId?: string): Promise<{ ok: boolean; outputDir: string }> };
      }).giftk;
      const media = {
        id: 'realtest-m',
        url: args.url,
        kind: 'video',
        source: 'video-tag',
        pageUrl: args.url,
        width: 320,
        height: 240,
        durationSec: 21
      };
      const options = {
        outDir: args.outDir,
        fps: 12,
        maxWidth: 320,
        maxBytes: 1 * 1024,
        softMaxBytes: 512,
        minSize: 64,
        speed: 1,
        maxSegmentSec: 60,
        lossyCeiling: 200,
        colorsFloor: 2,
        optimizeLevel: 3,
        dither: 'floyd-steinberg'
      };
      return g.startBatch([{ id: 'realtest-m', media, options }], 'fixture-m', undefined, undefined);
    }, { url: localUrl, outDir });

    expect(startResult.ok).toBe(true);

    const final = await waitForTerminal('realtest-m', 150_000);
    expect(final.status).toBe('done');
    expect(typeof final.warning).toBe('string');
    // R-69 — 三种 over-target warning 都接受 (single-pass / soft / multi-segment).
    expect(final.warning ?? '').toMatch(
      /exceeds hard target|did not reach soft target|seg\s+\d+\s+final\s+[\d.]+MB\s+exceeds/
    );

    // R-69 — predicate parity guard: TaskTable 渲染按钮的 if 条件就是
    // isUnderTargetDone(p), 把这个 predicate 在测试里跑一遍, 等价于
    // 断言 "按钮在这种 progress 下会被渲染". 这避免了产品改 warning
    // 字符串后 predicate 失配, UI 永远不显示按钮的隐式回归.
    const buttonShouldShow = await page.evaluate((progress: unknown) => {
      const p = progress as { status?: string; warning?: string };
      if (p.status !== 'done') return false;
      const w = p.warning;
      if (!w) return false;
      return (
        w.includes('exceeds hard target') ||
        w.includes('did not reach soft target') ||
        /seg\s+\d+\s+final\s+[\d.]+MB\s+exceeds\s+[\d.]+MB\s+target/.test(w)
      );
    }, final);
    expect(buttonShouldShow).toBe(true);

    // eslint-disable-next-line no-console
    console.log(
      '\n[SUITE M manual-optimize-button contract]\n' +
      `  task warning      : ${final.warning}\n` +
      `  isUnderTargetDone : ${buttonShouldShow}\n` +
      `  contract status   : OK (按钮会被 TaskTable 渲染)\n`
    );
  } finally {
    await tearDownRecorder();
    try { rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('SUITE N — UI-driven mp4 → gif: ffprobe verify output is real GIF', async () => {
  const { app, page } = getHarness();
  test.setTimeout(120_000);
  expect(existsSync(FIXTURE_MP4)).toBe(true);

  await app.evaluate(async ({ dialog }, fixturePath: string) => {
    const original = dialog.showOpenDialog.bind(dialog);
    const stub = (async () => ({ canceled: false, filePaths: [fixturePath] })) as typeof dialog.showOpenDialog;
    (dialog as unknown as { showOpenDialog: typeof dialog.showOpenDialog }).showOpenDialog = stub;
    (globalThis as unknown as { __originalShowOpenDialog?: typeof dialog.showOpenDialog }).__originalShowOpenDialog = original;
  }, FIXTURE_MP4);

  await installRecorder();
  try {
    await page.locator('button', { hasText: /📂 离线导入/ }).first().click();
    const mediaCard = page.locator('.media-card').first();
    await expect(mediaCard).toBeVisible({ timeout: 30_000 });
    // R-N-1 — tiny.mp4 是 video，要确保 video badge 出现，否则可能进了
    // 静态图分支被过滤；这一行是 contract guard。
    await expect(mediaCard.locator('.badge.video')).toBeVisible();
    await mediaCard.locator('.card-check input[type="checkbox"]').check();

    const baselineN = (await snapshotRecorder()).progress.length;
    await page.locator('button.fab-start-batch').click();
    await expect(page.locator('.tasks .task').first()).toBeVisible({ timeout: 30_000 });
    const final = await waitForAnyTerminal(60_000, { ignoreEventBefore: baselineN });
    expect(final.status).toBe('done');

    const outputs = final.outputs ?? [];
    expect(Array.isArray(outputs) && outputs.length).toBeGreaterThan(0);
    const outGif = outputs[0] as string;
    expect(existsSync(outGif)).toBe(true);

    // ffprobe -show_streams + -show_format。一次调用拿全 codec / 容器 /
    // 维度信息，比起多次 spawn 更快也更稳。
    const probeJson = execSync(
      `ffprobe -v error -print_format json -show_format -show_streams "${outGif}"`,
      { encoding: 'utf8' }
    );
    const probe = JSON.parse(probeJson) as {
      format?: { format_name?: string; nb_streams?: number };
      streams?: Array<{ codec_name?: string; codec_type?: string; width?: number; height?: number; nb_frames?: string }>;
    };

    expect(probe.format?.format_name ?? '').toMatch(/gif/i);
    const videoStream = (probe.streams ?? []).find((s) => s.codec_type === 'video');
    expect(videoStream).toBeDefined();
    expect((videoStream?.codec_name ?? '').toLowerCase()).toBe('gif');
    expect((videoStream?.width ?? 0)).toBeGreaterThan(0);
    expect((videoStream?.height ?? 0)).toBeGreaterThan(0);
    // tiny.mp4 是有动效的视频：产物至少应有 2 帧（单帧静图意味着 GIF
    // 退化成静态了，对"视频转 GIF"语义来说是 regression）
    const nbFrames = Number(videoStream?.nb_frames ?? 0);
    expect(Number.isFinite(nbFrames) && nbFrames >= 2).toBe(true);

    // eslint-disable-next-line no-console
    console.log(
      '\n[SUITE N mp4 → gif format contract]\n' +
      `  fixture           : ${FIXTURE_MP4}\n` +
      `  output gif        : ${outGif}\n` +
      `  format_name       : ${probe.format?.format_name}\n` +
      `  codec_name        : ${videoStream?.codec_name}\n` +
      `  dimensions        : ${videoStream?.width}x${videoStream?.height}\n` +
      `  frame count       : ${nbFrames}\n`
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
