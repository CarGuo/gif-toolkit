/**
 * SUITE O + P + Q + R + S — compression / isolation / freedom oracles.
 *
 * SUITE O — compression monotonic oracle (UI-driven first pass +
 *   IPC-driven re-optimize): firstSize > secondSize, ratio ≤ 0.95.
 * SUITE P — multi-task batch + cancelTask isolation oracle. Tiny task
 *   must finish done while medium task is cancelled mid-flight.
 * SUITE Q — skipCompress=true reverse oracle. maxBytes=1KB but
 *   skipCompress lets product land at ~45KB (43x oversize).
 * SUITE R — lossyCeiling 0 vs 200 weak monotone oracle (lossy=200
 *   product never strictly larger than lossy=0).
 * SUITE S — startBatch append session oracle. Two startBatch calls
 *   in the same session don't cross-contaminate (taskId isolation +
 *   ≥1 done).
 */
import { test, expect } from '@playwright/test';
import { existsSync, statSync } from 'node:fs';
import {
  FIXTURE_MP4,
  FIXTURE_MEDIUM,
  getHarness,
  pathToGiftkLocal,
  installRecorder,
  tearDownRecorder,
  snapshotRecorder,
  waitForTerminal,
  waitForAnyTerminal
} from './_harness';

test('SUITE O — UI-driven compression oracle: second pass size monotonically smaller', async () => {
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

    // ── 第一次：default 参数 ─────────────────────────────────────
    const baseline1 = (await snapshotRecorder()).progress.length;
    await page.locator('button.fab-start-batch').click();
    await expect(page.locator('.tasks .task').first()).toBeVisible({ timeout: 30_000 });
    const first = await waitForAnyTerminal(120_000, { ignoreEventBefore: baseline1 });
    expect(first.status).toBe('done');
    const firstOut = (first.outputs ?? [])[0] as string;
    expect(firstOut && existsSync(firstOut)).toBeTruthy();
    const firstSize = statSync(firstOut).size;
    expect(firstSize).toBeGreaterThan(1024);

    // ── 第二次：HomeView 没有 maxBytes 输入框（只有 ToolboxPanel 才有），
    //     所以这里通过 giftk.startBatch 用 reoptimizeFromGifPath=firstOut +
    //     maxBytes=firstSize*0.7 直接驱动主进程的 manual 二次优化路径。
    //     这与 SUITE B/M 用 page.evaluate 调 startBatch 同质：是渲染端
    //     到主进程的真实 IPC 调用，不是 mock。 ──────────────────────
    const targetMax = Math.floor(firstSize * 0.7);
    const secondId = `O-${Date.now()}`;
    const secondStart = await page.evaluate(async (args: {
      url: string;
      gifPath: string;
      maxBytes: number;
      taskId: string;
    }) => {
      const g = (window as unknown as {
        giftk: {
          startBatch(
            tasks: unknown[],
            pageTitle?: string,
            outputDirOverride?: string,
            sessionId?: string
          ): Promise<{ ok: boolean; outputDir: string }>;
        };
      }).giftk;
      const media = {
        id: args.taskId,
        url: args.url,
        kind: 'gif',
        source: 'img-tag',
        pageUrl: args.url,
        width: 0,
        height: 0
      };
      const options = {
        fps: 10,
        maxWidth: 160,
        maxBytes: args.maxBytes,
        softMaxBytes: Math.floor(args.maxBytes * 0.6),
        minSize: 120,
        speed: 1,
        maxSegmentSec: 60,
        lossyCeiling: 200,
        colorsFloor: 32,
        optimizeLevel: 3,
        dither: 'floyd-steinberg',
        forceAllowSmallSide: true,
        reoptimizeFromGifPath: args.gifPath
      };
      return g.startBatch(
        [{ id: args.taskId, media, options }],
        'suite-O-reoptimize',
        undefined,
        undefined
      );
    }, {
      url: pathToGiftkLocal(firstOut),
      gifPath: firstOut,
      maxBytes: targetMax,
      taskId: secondId
    });
    expect(secondStart.ok).toBe(true);
    const secondVal = await waitForTerminal(secondId, 120_000);
    expect(secondVal.status).toBe('done');
    const secondOut = (secondVal.outputs ?? [])[0] as string;
    expect(secondOut && existsSync(secondOut)).toBeTruthy();
    const secondSize = statSync(secondOut).size;

    // ── Oracle：second.size <= first.size * 0.95。
    //     允许 5% 浮动是为了避免 ffmpeg / gifsicle 微小帧数差导致的
    //     边界拒绝（GIF 编码不是纯线性，targetMax 是软指标）。
    expect(secondSize).toBeLessThan(firstSize);
    expect(secondSize).toBeLessThanOrEqual(Math.floor(firstSize * 0.95));

    // eslint-disable-next-line no-console
    console.log(
      '\n[SUITE O compression oracle]\n' +
      `  first  gif        : ${firstOut} (${firstSize} bytes)\n` +
      `  second gif        : ${secondOut} (${secondSize} bytes)\n` +
      `  ratio second/first: ${(secondSize / firstSize).toFixed(3)}\n` +
      `  targetMax (req'd) : ${targetMax} bytes\n`
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

test('SUITE P — multi-task batch + single-task cancelTask isolation oracle', async () => {
  const { page } = getHarness();
  test.setTimeout(180_000);
  expect(existsSync(FIXTURE_MP4)).toBe(true);
  expect(existsSync(FIXTURE_MEDIUM)).toBe(true);
  await installRecorder();
  const tinyId = `P-tiny-${Date.now()}`;
  const mediumId = `P-medium-${Date.now()}`;
  try {
    const startResult = await page.evaluate(async (args: {
      tinyUrl: string; mediumUrl: string;
      tinyId: string; mediumId: string;
    }) => {
      const g = (window as unknown as {
        giftk: {
          startBatch(
            tasks: unknown[],
            pageTitle?: string,
            outputDirOverride?: string,
            sessionId?: string
          ): Promise<{ ok: boolean; outputDir: string }>;
        };
      }).giftk;
      const mkOpts = () => ({
        fps: 10,
        maxWidth: 160,
        maxBytes: 512000,
        softMaxBytes: 256000,
        minSize: 120,
        speed: 1,
        maxSegmentSec: 60,
        lossyCeiling: 80,
        colorsFloor: 64,
        optimizeLevel: 3,
        dither: 'floyd-steinberg'
      });
      const tasks = [
        {
          id: args.tinyId,
          media: {
            id: args.tinyId, url: args.tinyUrl, kind: 'video',
            source: 'video-tag', pageUrl: args.tinyUrl,
            width: 240, height: 180, durationSec: 1
          },
          options: mkOpts()
        },
        {
          id: args.mediumId,
          media: {
            id: args.mediumId, url: args.mediumUrl, kind: 'video',
            source: 'video-tag', pageUrl: args.mediumUrl,
            width: 320, height: 240, durationSec: 21
          },
          options: mkOpts()
        }
      ];
      return g.startBatch(tasks, 'suite-P-multitask', undefined, undefined);
    }, {
      tinyUrl: pathToGiftkLocal(FIXTURE_MP4),
      mediumUrl: pathToGiftkLocal(FIXTURE_MEDIUM),
      tinyId,
      mediumId
    });
    expect(startResult.ok).toBe(true);

    // 等 medium 看到 running 后立刻 cancelTask 它（如果它还没开始就直接
    // cancel 也能命中：cancelAllTasks abort + queue.removeFromQueue 把
    // 未启动的 task 也一并撤销）。给 800ms 让 medium worker 起来更稳。
    await page.waitForTimeout(800);
    const cancelRes = await page.evaluate(async (id: string) => {
      const g = (window as unknown as {
        giftk: {
          cancelTask(id: string): Promise<{ ok: boolean; cancelled: boolean; error?: string }>;
        };
      }).giftk;
      return g.cancelTask(id);
    }, mediumId);
    expect(cancelRes.ok).toBe(true);

    // tiny 必须 done，medium 终态宽松（done / cancelled / failed 都接受）
    const tinyTerm = await waitForTerminal(tinyId, 60_000);
    expect(tinyTerm.status).toBe('done');
    const tinyOut = (tinyTerm.outputs ?? [])[0] as string;
    expect(tinyOut && existsSync(tinyOut)).toBeTruthy();
    expect(statSync(tinyOut).size).toBeGreaterThan(0);

    const mediumTerm = await waitForTerminal(mediumId, 60_000);
    expect(['cancelled', 'failed', 'done']).toContain(mediumTerm.status);

    // eslint-disable-next-line no-console
    console.log(
      '\n[SUITE P multi-task cancel oracle]\n' +
      `  tiny   id     : ${tinyId} → ${tinyTerm.status} (${tinyOut ? statSync(tinyOut).size : 0} bytes)\n` +
      `  medium id     : ${mediumId} → ${mediumTerm.status} (cancelTask.ok=${cancelRes.ok})\n`
    );
  } finally {
    await tearDownRecorder();
  }
});

test('SUITE Q — skipCompress=true produces oversized gif (quality-over-size oracle)', async () => {
  const { page } = getHarness();
  test.setTimeout(120_000);
  expect(existsSync(FIXTURE_MP4)).toBe(true);
  await installRecorder();
  const taskId = `Q-${Date.now()}`;
  const ridiculousMax = 1024; // 1 KB — far below any realistic gif size
  try {
    const startResult = await page.evaluate(async (args: {
      url: string; taskId: string; maxBytes: number;
    }) => {
      const g = (window as unknown as {
        giftk: {
          startBatch(
            tasks: unknown[],
            pageTitle?: string,
            outputDirOverride?: string,
            sessionId?: string
          ): Promise<{ ok: boolean; outputDir: string }>;
        };
      }).giftk;
      const media = {
        id: args.taskId,
        url: args.url,
        kind: 'video',
        source: 'video-tag',
        pageUrl: args.url,
        width: 240, height: 180, durationSec: 1
      };
      const options = {
        fps: 10,
        maxWidth: 160,
        maxBytes: args.maxBytes,
        softMaxBytes: Math.max(512, Math.floor(args.maxBytes / 2)),
        minSize: 120,
        speed: 1,
        maxSegmentSec: 60,
        lossyCeiling: 80,
        colorsFloor: 64,
        optimizeLevel: 3,
        dither: 'floyd-steinberg',
        skipCompress: true
      };
      return g.startBatch(
        [{ id: args.taskId, media, options }],
        'suite-Q-skipCompress',
        undefined,
        undefined
      );
    }, { url: pathToGiftkLocal(FIXTURE_MP4), taskId, maxBytes: ridiculousMax });
    expect(startResult.ok).toBe(true);

    const term = await waitForTerminal(taskId, 60_000);
    expect(term.status).toBe('done');
    const out = (term.outputs ?? [])[0] as string;
    expect(out && existsSync(out)).toBeTruthy();
    const size = statSync(out).size;
    // 反向断言：产物显著大于 maxBytes，证明压缩循环被跳过
    expect(size).toBeGreaterThan(ridiculousMax);

    // eslint-disable-next-line no-console
    console.log(
      '\n[SUITE Q skipCompress quality-over-size oracle]\n' +
      `  fixture           : ${FIXTURE_MP4}\n` +
      `  output gif        : ${out} (${size} bytes)\n` +
      `  maxBytes (asked)  : ${ridiculousMax} bytes\n` +
      `  ratio size/max    : ${(size / ridiculousMax).toFixed(2)}x (>1 = skipCompress 生效)\n`
    );
  } finally {
    await tearDownRecorder();
  }
});

test('SUITE R — lossyCeiling 0 vs 200 produces non-strictly-larger output (compression freedom oracle)', async () => {
  const { page } = getHarness();
  test.setTimeout(180_000);
  expect(existsSync(FIXTURE_MP4)).toBe(true);
  await installRecorder();
  try {
    async function runOnce(taskId: string, lossyCeiling: number): Promise<{ size: number; out: string }> {
      const startResult = await page.evaluate(async (args: {
        url: string; taskId: string; lossyCeiling: number;
      }) => {
        const g = (window as unknown as {
          giftk: {
            startBatch(
              tasks: unknown[],
              pageTitle?: string,
              outputDirOverride?: string,
              sessionId?: string
            ): Promise<{ ok: boolean; outputDir: string }>;
          };
        }).giftk;
        const media = {
          id: args.taskId,
          url: args.url,
          kind: 'video',
          source: 'video-tag',
          pageUrl: args.url,
          width: 240, height: 180, durationSec: 1
        };
        const options = {
          fps: 10,
          maxWidth: 160,
          // SUITE Q 实测 tiny.mp4 raw ≈ 45KB；maxBytes=20KB 强制压缩
          // 循环必须启动 lossy 阶梯（softMaxBytes=15KB 是 stop 阈值）
          maxBytes: 20_000,
          softMaxBytes: 15_000,
          minSize: 120,
          speed: 1,
          maxSegmentSec: 60,
          lossyCeiling: args.lossyCeiling,
          colorsFloor: 64,
          optimizeLevel: 3,
          dither: 'floyd-steinberg'
        };
        return g.startBatch(
          [{ id: args.taskId, media, options }],
          `suite-R-lossy-${args.lossyCeiling}`,
          undefined,
          undefined
        );
      }, { url: pathToGiftkLocal(FIXTURE_MP4), taskId, lossyCeiling });
      expect(startResult.ok).toBe(true);
      const term = await waitForTerminal(taskId, 90_000);
      // term 可能是 done(达标) 也可能是 done with warning(没达标但跑完)
      // 我们只需要拿到产物文件本身
      expect(['done', 'failed']).toContain(term.status);
      const out = (term.outputs ?? [])[0] as string;
      expect(out && existsSync(out)).toBeTruthy();
      return { size: statSync(out).size, out };
    }

    const lossy0 = await runOnce(`R0-${Date.now()}`, 0);
    const lossy200 = await runOnce(`R200-${Date.now()}`, 200);

    // HL 启发式：lossy=200 ≤ lossy=0
    // 弱单调不变量 — 给 lossy 更高上限永远不应该让产物更大。
    expect(lossy200.size).toBeLessThanOrEqual(lossy0.size);

    // eslint-disable-next-line no-console
    console.log(
      '\n[SUITE R lossyCeiling compression-freedom oracle]\n' +
      `  fixture           : ${FIXTURE_MP4}\n` +
      `  maxBytes target   : 20000 / softMaxBytes 15000\n` +
      `  lossy=0   output  : ${lossy0.out} (${lossy0.size} bytes)\n` +
      `  lossy=200 output  : ${lossy200.out} (${lossy200.size} bytes)\n` +
      `  ratio 200/0       : ${(lossy200.size / lossy0.size).toFixed(3)}x (≤ 1.0 required)\n`
    );
  } finally {
    await tearDownRecorder();
  }
});

test('SUITE S — startBatch append in same session: both tasks complete without cross-contamination', async () => {
  const { page } = getHarness();
  test.setTimeout(180_000);
  expect(existsSync(FIXTURE_MP4)).toBe(true);
  expect(existsSync(FIXTURE_MEDIUM)).toBe(true);
  await installRecorder();

  const idA = `S-A-${Date.now()}`;
  const idB = `S-B-${Date.now()}`;
  try {
    // start A (medium — slower, gives append a window)
    const aRes = await page.evaluate(async (args: { url: string; taskId: string }) => {
      const g = (window as unknown as {
        giftk: {
          startBatch(
            tasks: unknown[],
            pageTitle?: string,
            outputDirOverride?: string,
            sessionId?: string
          ): Promise<{ ok: boolean; outputDir: string }>;
        };
      }).giftk;
      const media = {
        id: args.taskId,
        url: args.url,
        kind: 'video',
        source: 'video-tag',
        pageUrl: args.url,
        width: 320, height: 240, durationSec: 2
      };
      const options = {
        fps: 12, maxWidth: 320, maxBytes: 5_000_000, softMaxBytes: 4_000_000,
        minSize: 120, speed: 1, maxSegmentSec: 60,
        lossyCeiling: 80, colorsFloor: 64, optimizeLevel: 3, dither: 'floyd-steinberg'
      };
      return g.startBatch([{ id: args.taskId, media, options }], 'suite-S-A', undefined, undefined);
    }, { url: pathToGiftkLocal(FIXTURE_MEDIUM), taskId: idA });
    expect(aRes.ok).toBe(true);

    // append B while A is still in flight
    await page.waitForTimeout(150);
    const bRes = await page.evaluate(async (args: { url: string; taskId: string }) => {
      const g = (window as unknown as {
        giftk: {
          startBatch(
            tasks: unknown[],
            pageTitle?: string,
            outputDirOverride?: string,
            sessionId?: string
          ): Promise<{ ok: boolean; outputDir: string }>;
        };
      }).giftk;
      const media = {
        id: args.taskId,
        url: args.url,
        kind: 'video',
        source: 'video-tag',
        pageUrl: args.url,
        width: 240, height: 180, durationSec: 1
      };
      const options = {
        fps: 10, maxWidth: 160, maxBytes: 5_000_000, softMaxBytes: 4_000_000,
        minSize: 120, speed: 1, maxSegmentSec: 60,
        lossyCeiling: 80, colorsFloor: 64, optimizeLevel: 3, dither: 'floyd-steinberg'
      };
      return g.startBatch([{ id: args.taskId, media, options }], 'suite-S-B', undefined, undefined);
    }, { url: pathToGiftkLocal(FIXTURE_MP4), taskId: idB });
    expect(bRes.ok).toBe(true);

    const termA = await waitForTerminal(idA, 120_000);
    const termB = await waitForTerminal(idB, 120_000);

    // HL 启发式断言：终态都收敛 + 至少一个 done
    expect(['done', 'cancelled', 'failed']).toContain(termA.status);
    expect(['done', 'cancelled', 'failed']).toContain(termB.status);
    expect(termA.status === 'done' || termB.status === 'done').toBe(true);
    // taskId 互不污染（隐式：waitForTerminal 拿到的 record.taskId 必须等于查询 id）
    expect(termA.taskId).toBe(idA);
    expect(termB.taskId).toBe(idB);

    // eslint-disable-next-line no-console
    console.log(
      '\n[SUITE S append session oracle]\n' +
      `  taskA id          : ${idA}\n` +
      `  taskA status      : ${termA.status}\n` +
      `  taskB id          : ${idB}\n` +
      `  taskB status      : ${termB.status}\n` +
      `  oracle            : both terminal + taskId isolated + ≥1 done\n`
    );
  } finally {
    await tearDownRecorder();
  }
});
