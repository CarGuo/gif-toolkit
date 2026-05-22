/**
 * SUITE HIST-DETAIL-UPLOAD-ENTRY-UI — header「📤 上传历史」入口回归。
 *
 * 触发原因
 * --------
 * 用户报告「嗅探历史的详情页里,为什么没有这个历史的上传历史入口?」。
 * 排查后发现入口确实存在,但藏在右下角 ProgressDock 内嵌的 UploadsSection
 * 工具栏里,而且 UploadsSection 在 flat.length===0(没产物的 sniff 记录)
 * 时整段 return null,导致用户一打开 detail modal 根本看不到入口。
 *
 * 修法(R-WS-90 P5i)
 * -------------------
 * 把同一个跳转 hook 提到标题栏「打开目录」按钮旁边,作为 detail modal
 * 的常驻入口:
 *   - 本记录至少有一条 status==='done' && url 非空的 upload 记录
 *     → 按钮 enabled,点击后调用 onJumpToUploadHistory(rec)
 *       (实现见 ModalsHost.tsx#L191-L206:url ∩ url 反查 batchId)。
 *   - 反之 → 按钮 disabled,title 提示「本记录尚未上传任何产物」。
 *     用户至少能确认入口存在,而不是怀疑功能丢了。
 *
 * 这套 e2e 把两种状态都压上回归。任何回退(比如未来有人把按钮移回
 * UploadsSection 内部、或者把 onJumpToUploadHistory 的 hasAnyDoneUpload
 * 守卫顺手撤掉)都会被这两个 SUITE 在真实 Electron app 里抓到。
 *
 * 实现策略
 * --------
 *   1. 清空 history + uploadHistory 两张表(避免被前面 SUITE 的残留行
 *      污染)。
 *   2. seed 一行 sniff history(根据子 SUITE 不同,uploadsByOutputPath
 *      要么为空、要么含一条 done 记录,后者还配套 seed 一行 uploadHistory
 *      以保证反查能命中)。
 *   3. page.reload() 让 useHistory / useUploadHistory 从 sqlite 重新拉。
 *   4. 切到「历史」tab → 点卡片打开 HistoryDetailModal。
 *   5. 断言标题栏 [data-testid="hist-detail-jump-uploads"] 按钮:
 *        - HD-UP-A: disabled === true,title 含「尚未上传」。
 *        - HD-UP-B: disabled === false,点击后 view 切到 uploads tab
 *          且 UploadResultModal 渲染出种子 url。
 *   6. 清表收尾。
 */
import { test, expect } from '@playwright/test';
import {
  FIXTURE_GIF,
  getHarness
} from './_harness';

// ---------------------------------------------------------------------------
// Seed shapes — 与 suite-r-compress-v1-ui.ts 保持一致, 直接走 db.* IPC,
// 不通过 React 状态绕弯。
// ---------------------------------------------------------------------------

interface SeededSniffMedia {
  id: string;
  kind: 'image' | 'video' | 'gif';
  url: string;
  pageUrl: string;
  tab: 'images' | 'videos' | 'gifs';
}

interface SeededHistoryRecord {
  id: string;
  createdAt: number;
  pageUrl: string;
  title: string;
  items: SeededSniffMedia[];
  options: Record<string, unknown>;
  outputDir: string;
  outputsByTaskId: Record<string, string[]>;
  taskStatus: Record<string, string>;
  uploadsByOutputPath: Record<string, {
    url: string;
    status: 'done';
    uploadedAt: number;
    backend: string;
  }>;
}

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

async function clearAllHistory(): Promise<void> {
  const { page } = getHarness();
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
}

async function seedHistory(rec: SeededHistoryRecord): Promise<void> {
  const { page } = getHarness();
  await page.evaluate(async (r: SeededHistoryRecord) => {
    const w = window as unknown as {
      giftk: { db: { history: { upsert(r: unknown): Promise<void> } } };
    };
    await w.giftk.db.history.upsert(r);
  }, rec);
}

async function seedUploadBatch(rec: SeededUploadRecord): Promise<void> {
  const { page } = getHarness();
  await page.evaluate(async (r: SeededUploadRecord) => {
    const w = window as unknown as {
      giftk: { db: { uploadHistory: { upsert(r: unknown): Promise<void> } } };
    };
    await w.giftk.db.uploadHistory.upsert(r);
  }, rec);
}

async function reloadAndSwitchToHistory(): Promise<void> {
  const { page } = getHarness();
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.app', { timeout: 30_000 });
  // Anchor on role + exact ^历史( (\d+))?$ to avoid matching 上传历史 in
  // strict mode.
  const historyTab = page.getByRole('button', { name: /^历史( \(\d+\))?$/ });
  await expect(historyTab).toBeVisible({ timeout: 10_000 });
  await historyTab.click();
  await expect(historyTab).toHaveAttribute('aria-pressed', 'true');
}

async function openDetailModal(): Promise<void> {
  const { page } = getHarness();
  // The seeded card is the only one rendered in HistoryPanel after we
  // cleared both tables — single click opens HistoryDetailModal.
  // We anchor on the seeded title so a stray pre-existing card cannot
  // hijack the click.
  const card = page.locator('.hist-card').first();
  await expect(card).toBeVisible({ timeout: 10_000 });
  // Click the card body (NOT the upload pill / open-dir button) so
  // the bubble reaches HistoryPanel's onOpenDetail handler.
  await card.click({ position: { x: 8, y: 8 } });
  await expect(page.locator('.hist-detail-modal')).toBeVisible({ timeout: 5_000 });
}

async function closeDetailModalAndCleanup(): Promise<void> {
  const { page } = getHarness();
  await page.keyboard.press('Escape');
  await expect(page.locator('.hist-detail-modal')).toHaveCount(0, { timeout: 5_000 });
  await clearAllHistory();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('SUITE HIST-DETAIL-UPLOAD-ENTRY-UI — sniff history detail header surfaces 上传历史 entry', () => {
  test('HD-UP-A — header「📤 上传历史」按钮在无 done 上传时存在但 disabled', async () => {
    const { page } = getHarness();
    test.setTimeout(60_000);

    await clearAllHistory();

    const sniffId = `hd-up-a-${Date.now()}`;
    const taskId = `${sniffId}-task`;
    const now = Date.now();

    await seedHistory({
      id: sniffId,
      createdAt: now,
      pageUrl: 'https://hd-up-a.test.example/page',
      title: 'HD-UP-A — 无上传',
      items: [{
        id: taskId,
        kind: 'image',
        url: 'https://hd-up-a.test.example/source.png',
        pageUrl: 'https://hd-up-a.test.example/page',
        tab: 'images'
      }],
      options: {},
      outputDir: '',
      outputsByTaskId: {},
      taskStatus: {},
      uploadsByOutputPath: {}
    });

    await reloadAndSwitchToHistory();
    await openDetailModal();

    const btn = page.locator('[data-testid="hist-detail-jump-uploads"]');
    await expect(btn).toBeVisible({ timeout: 5_000 });
    await expect(btn).toBeDisabled();
    await expect(btn).toHaveAttribute('title', /尚未上传/);

    await closeDetailModalAndCleanup();
  });

  test('HD-UP-B — header「📤 上传历史」按钮在有 done 上传时 enabled,点击跳到 uploads tab 并定位 batch', async () => {
    const { page } = getHarness();
    test.setTimeout(60_000);

    await clearAllHistory();

    const SEED_URL = `https://hd-up-b.test.example/${Date.now()}.gif`;
    const sniffId = `hd-up-b-${Date.now()}`;
    const taskId = `${sniffId}-task`;
    const uploadId = `hd-up-b-up-${Date.now()}`;
    const now = Date.now();

    // 1) 上传历史:批次必须含 url 才能被反查命中。
    await seedUploadBatch({
      id: uploadId,
      createdAt: now,
      backend: 'qiniu',
      items: [{
        jobId: taskId,
        filePath: FIXTURE_GIF,
        fileName: 'tiny.gif',
        status: 'done',
        url: SEED_URL,
        markdown: `![tiny](${SEED_URL})`,
        bytesTotal: 1024
      }]
    });

    // 2) 嗅探历史:uploadsByOutputPath[*].url 必须等于上传批次的 url,
    //    这样 ModalsHost.onJumpToUploadHistory 的 url ∩ url 反查才能命中。
    await seedHistory({
      id: sniffId,
      createdAt: now,
      pageUrl: 'https://hd-up-b.test.example/page',
      title: 'HD-UP-B — 已上传',
      items: [{
        id: taskId,
        kind: 'image',
        url: 'https://hd-up-b.test.example/source.png',
        pageUrl: 'https://hd-up-b.test.example/page',
        tab: 'images'
      }],
      options: {},
      outputDir: '',
      outputsByTaskId: { [taskId]: [FIXTURE_GIF] },
      taskStatus: { [taskId]: 'done' },
      uploadsByOutputPath: {
        [FIXTURE_GIF]: {
          url: SEED_URL,
          status: 'done',
          uploadedAt: now,
          backend: 'qiniu'
        }
      }
    });

    await reloadAndSwitchToHistory();
    await openDetailModal();

    const btn = page.locator('[data-testid="hist-detail-jump-uploads"]');
    await expect(btn).toBeVisible({ timeout: 5_000 });
    await expect(btn).toBeEnabled();
    await expect(btn).toHaveAttribute('title', /跳转到「上传历史」tab/);

    // 点击后应:
    //   a) 关闭 detail modal
    //   b) 切到 uploads tab
    //   c) UploadResultModal 渲染出种子 url
    await btn.click();
    await expect(page.locator('.hist-detail-modal')).toHaveCount(0, { timeout: 5_000 });
    const uploadsTab = page.locator('button.tab-btn', { hasText: '上传历史' });
    await expect(uploadsTab).toHaveAttribute('aria-pressed', 'true', { timeout: 5_000 });
    const resultModal = page.locator('div.modal-backdrop');
    await expect(resultModal).toBeVisible({ timeout: 5_000 });
    await expect(resultModal).toContainText(SEED_URL);

    // Close the upload-result modal and clean up.
    await page.keyboard.press('Escape');
    await expect(resultModal).toHaveCount(0, { timeout: 5_000 });
    await clearAllHistory();
  });
});
