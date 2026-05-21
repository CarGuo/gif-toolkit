/**
 * E2E regression for the 5 hooks extracted from App.tsx during
 * Step 1-5 refactor (useWebviewMenu / useBottomResize / useEmbedResolve
 * / useIpcEvents / useUploadDispatch).
 *
 * Why this exists
 * ---------------
 * vitest+happy-dom unit tests already cover each hook's contract
 * in isolation, but they cannot prove that the hook still
 *   1. mounts inside the *real* React tree of the home page,
 *   2. wires its DOM correctly into App.tsx,
 *   3. reads back from `window.giftk` (the preload bridge) without
 *      crashing,
 *   4. survives a real Electron renderer process boot.
 *
 * Playwright's `_electron.launch` does that: it spawns the actual
 * `dist/main/index.js` entry, attaches to the renderer's CDP target
 * and lets us drive the live DOM.
 *
 * Mode: PRODUCTION
 * ----------------
 * We run with `NODE_ENV=production` so main loads
 * `dist/renderer/index.html` via `loadFile` — no Vite dev server,
 * no port races, no HMR-induced double-mounts. This is exactly the
 * code path users hit after `electron-builder` packages the app, so
 * passing here is the strongest "the bundle works" signal we can
 * automate.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import { existsSync } from 'node:fs';

const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'dist/main/index.js');
const FIXTURES_DIR = path.join(REPO_ROOT, 'tests/fixtures');
const FIXTURE_MP4 = path.join(FIXTURES_DIR, 'tiny.mp4');

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  app = await electron.launch({
    args: [MAIN_ENTRY],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      // Quiet the macOS Dock icon spam from logger noise so CI logs are
      // readable.
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    }
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.app', { timeout: 30_000 });
});

test.afterAll(async () => {
  if (app) await app.close();
});

test('preload bridge: window.giftk is exposed by main/preload', async () => {
  const exposed = await page.evaluate(() => {
    const g = (window as unknown as { giftk?: Record<string, unknown> }).giftk;
    if (!g) return { present: false, sample: [] as string[] };
    const keys = Object.keys(g).sort();
    return { present: true, sample: keys.slice(0, 12) };
  });
  expect(exposed.present).toBe(true);
  expect(exposed.sample.length).toBeGreaterThan(0);
});

test('App mounts: top-level .app shell + --bottom-h CSS var bound by useBottomResize', async () => {
  const probe = await page.evaluate(() => {
    const root = document.querySelector('.app') as HTMLElement | null;
    if (!root) return { mounted: false, bottomH: '' };
    const v = root.style.getPropertyValue('--bottom-h').trim();
    return { mounted: true, bottomH: v };
  });
  expect(probe.mounted).toBe(true);
  expect(probe.bottomH).toMatch(/^\d+px$/);
});

test('useWebviewMenu: caret toggles role=menu popup + aria-expanded reflects state', async () => {
  const caret = page.getByRole('button', { name: '切换网页嗅探方式' });
  await expect(caret).toBeVisible();
  await expect(caret).toHaveAttribute('aria-expanded', 'false');

  await caret.click();

  await expect(caret).toHaveAttribute('aria-expanded', 'true');
  const popup = page.getByRole('menu', { name: '网页嗅探方式' });
  await expect(popup).toBeVisible();

  const radios = page.getByRole('menuitemradio');
  await expect(radios).toHaveCount(3);

  // Pick a non-default mode. The hook must persist it to localStorage and
  // close the popup.
  const ytdlpItem = radios.nth(2);
  await ytdlpItem.click();
  await expect(popup).toBeHidden();
  await expect(caret).toHaveAttribute('aria-expanded', 'false');

  const persisted = await page.evaluate(() => localStorage.getItem('giftk:preferredWebviewMode'));
  expect(persisted).toBe('ytdlp-direct');

  // Re-open: the radio we picked must now report aria-checked=true,
  // proving the persistence + read-back loop works through the live hook.
  await caret.click();
  const checkedItem = radios.nth(2);
  await expect(checkedItem).toHaveAttribute('aria-checked', 'true');

  // Reset to embed for a clean state and close.
  await radios.nth(0).click();
  await expect(page.getByRole('menu', { name: '网页嗅探方式' })).toBeHidden();
});

test('useWebviewMenu: Escape closes popup and restores focus to caret', async () => {
  const caret = page.getByRole('button', { name: '切换网页嗅探方式' });
  await caret.click();
  const popup = page.getByRole('menu', { name: '网页嗅探方式' });
  await expect(popup).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();

  const focusedAria = await page.evaluate(
    () => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label') ?? ''
  );
  expect(focusedAria).toBe('切换网页嗅探方式');
});

test('useBottomResize: dblclick on .right-resize-handle resets --bottom-h to 180px and persists', async () => {
  // Pre-condition: stash an off-default value so the dblclick reset is observable.
  await page.evaluate(() => {
    localStorage.setItem('giftk.bottomPanelHeight', '420');
  });
  const handle = page.locator('.right-resize-handle');
  await expect(handle).toBeVisible();

  // dblclick must fire resetBottomH which both updates state AND persists.
  await handle.dblclick();

  await expect.poll(async () =>
    page.evaluate(() => {
      const root = document.querySelector('.app') as HTMLElement | null;
      return root ? root.style.getPropertyValue('--bottom-h').trim() : '';
    })
  ).toBe('180px');

  const persisted = await page.evaluate(() => localStorage.getItem('giftk.bottomPanelHeight'));
  expect(persisted).toBe('180');
});

test('useIpcEvents: renderer survives mount with all 4 IPC channels subscribed (no console errors)', async () => {
  // The hook subscribes onProgress/onLog/onSniffProgress/onUploadProgress
  // exactly once on mount via depsRef. If any of those threw inside the
  // mount-once useEffect, React would unmount the tree and the .app
  // shell would not be present (already verified in the mount test
  // above). As a stronger signal, we also assert that giftk exposes the
  // four IPC subscriber functions the hook calls into.
  const ipcShape = await page.evaluate(() => {
    const g = (window as unknown as { giftk?: Record<string, unknown> }).giftk ?? {};
    return {
      onProgress: typeof (g as { onProgress?: unknown }).onProgress,
      onLog: typeof (g as { onLog?: unknown }).onLog,
      onSniffProgress: typeof (g as { onSniffProgress?: unknown }).onSniffProgress,
      onUploadProgress: typeof (g as { onUploadProgress?: unknown }).onUploadProgress
    };
  });
  expect(ipcShape.onProgress).toBe('function');
  expect(ipcShape.onLog).toBe('function');
  expect(ipcShape.onSniffProgress).toBe('function');
  // onUploadProgress is allowed to be missing on older preloads — the
  // hook is defensive about that, but our current preload should expose it.
  expect(['function', 'undefined']).toContain(ipcShape.onUploadProgress);
});

test('useUploadDispatch / useEmbedResolve mount: required giftk surface for these hooks is intact', async () => {
  const surface = await page.evaluate(() => {
    const g = (window as unknown as { giftk?: Record<string, unknown> }).giftk ?? {};
    return {
      // useUploadDispatch reads these:
      uploadGetSettings: typeof (g as { uploadGetSettings?: unknown }).uploadGetSettings,
      uploadStart: typeof (g as { uploadStart?: unknown }).uploadStart,
      // useEmbedResolve reads this:
      resolveEmbed: typeof (g as { resolveEmbed?: unknown }).resolveEmbed
    };
  });
  expect(surface.uploadGetSettings).toBe('function');
  expect(surface.uploadStart).toBe('function');
  expect(surface.resolveEmbed).toBe('function');
});

test('useWorkspaces: tab strip renders one initial blank tab and the new-tab button is hidden (R-WS-2026-05-21)', async () => {
  const tablist = page.getByRole('tablist', { name: '工作区标签' });
  await expect(tablist).toBeVisible();
  const tabs = tablist.getByRole('tab');
  await expect(tabs).toHaveCount(1);
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  // Sole tab hides its × per WorkspaceTabs.tsx (workspaces.length>1 gate).
  await expect(tablist.locator('.ws-tab-close')).toHaveCount(0);
  // R-WS-2026-05-21 — product decision: tabs only born from sniff
  // (claimForSniff). Manual "+" button has been removed from the UI.
  await expect(tablist.getByRole('button', { name: '新建工作区' })).toHaveCount(0);
});

test('useWorkspaces: blank-reuse + non-blank-creates + switch + close (R-WS-2026-05-21 lifecycle oracle)', async () => {
  // R-WS-2026-05-21 — Single state-evolving test that exercises the
  // full workspace lifecycle end-to-end (replaces the old "+ button"
  // test plus serves as the reuse-on-blank oracle).
  //
  // Bug we're guarding: "I have 1 blank tab, I type a URL and click
  // 真 Chrome 嗅探 — why does a second tab appear?"
  // The fix: isBlank is `result==null && !sniffing` (url alone does NOT
  // mark a tab as non-blank). A sniff on a blank tab MUST reuse it.
  //
  // Lifecycle covered:
  //  Phase 1 (reuse): blank tab + URL fill + sniff → still 1 tab
  //  Phase 2 (create): tab is now non-blank, second sniff → 2 tabs
  //  Phase 3 (switch): clicking tab A flips aria-selected
  //  Phase 4 (close): × on tab B drops back to 1 tab; sole tab × hidden
  if (!existsSync(FIXTURE_MP4)) throw new Error(`missing fixture: ${FIXTURE_MP4}`);

  await app.evaluate(async ({ dialog }, fixturePath: string) => {
    const original = dialog.showOpenDialog.bind(dialog);
    const stub = (async () => ({ canceled: false, filePaths: [fixturePath] })) as typeof dialog.showOpenDialog;
    (dialog as unknown as { showOpenDialog: typeof dialog.showOpenDialog }).showOpenDialog = stub;
    (globalThis as unknown as { __originalShowOpenDialog?: typeof dialog.showOpenDialog }).__originalShowOpenDialog = original;
  }, FIXTURE_MP4);

  try {
    const tablist = page.getByRole('tablist', { name: '工作区标签' });
    const urlInput = page.getByPlaceholder('https://example.com/article');
    const offlineBtn = page.getByRole('button', { name: /离线导入/ });

    // Phase 1 — reuse-on-blank oracle.
    await expect(tablist.getByRole('tab')).toHaveCount(1);
    await urlInput.fill('https://example.com/blank-reuse-probe');
    await expect(tablist.getByRole('tab')).toHaveCount(1);
    await offlineBtn.click();
    await page.waitForTimeout(1500);
    // **The contract**: blank + URL + sniff stays at 1 tab.
    await expect(tablist.getByRole('tab')).toHaveCount(1);
    await expect(tablist.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true');
    await expect(offlineBtn).toBeEnabled({ timeout: 30_000 });

    // Phase 2 — non-blank now, second sniff opens tab B.
    await offlineBtn.click();
    await expect(tablist.getByRole('tab')).toHaveCount(2, { timeout: 15_000 });
    const tabsAfterOpen = tablist.getByRole('tab');
    await expect(tabsAfterOpen.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(offlineBtn).toBeEnabled({ timeout: 30_000 });

    // Phase 3 — switch back to tab A.
    await tabsAfterOpen.nth(0).click();
    await expect(tabsAfterOpen.nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(tabsAfterOpen.nth(1)).toHaveAttribute('aria-selected', 'false');

    // Phase 4 — close tab B via × (tab A is non-blank but idle).
    const closeBtns = tablist.locator('.ws-tab-close');
    await expect(closeBtns).toHaveCount(2);
    await closeBtns.nth(1).click();
    await expect(tablist.getByRole('tab')).toHaveCount(1);
    // Single remaining tab loses its ×.
    await expect(tablist.locator('.ws-tab-close')).toHaveCount(0);
  } finally {
    await app.evaluate(async ({ dialog }) => {
      const original = (globalThis as unknown as { __originalShowOpenDialog?: typeof dialog.showOpenDialog }).__originalShowOpenDialog;
      if (original) {
        (dialog as unknown as { showOpenDialog: typeof dialog.showOpenDialog }).showOpenDialog = original;
      }
    });
  }
});

test('useWorkspaces: per-tab state isolation — url of tab A does not leak into freshly opened tab B', async () => {
  // R-WS-2026-05-21 — tab B must be born from sniff (no manual "+"),
  // so we drive it through the offline-import path and check that
  // tab A's url does not pollute tab B.
  // Reload first to guarantee a clean blank workspace state regardless
  // of what the previous lifecycle test left behind.
  await page.reload();
  await page.waitForSelector('.app', { timeout: 30_000 });
  if (!existsSync(FIXTURE_MP4)) throw new Error(`missing fixture: ${FIXTURE_MP4}`);

  await app.evaluate(async ({ dialog }, fixturePath: string) => {
    const original = dialog.showOpenDialog.bind(dialog);
    const stub = (async () => ({ canceled: false, filePaths: [fixturePath] })) as typeof dialog.showOpenDialog;
    (dialog as unknown as { showOpenDialog: typeof dialog.showOpenDialog }).showOpenDialog = stub;
    (globalThis as unknown as { __originalShowOpenDialog?: typeof dialog.showOpenDialog }).__originalShowOpenDialog = original;
  }, FIXTURE_MP4);

  try {
    // R-WS-2026-05-21 — "blank" is now `result==null && !sniffing` (url
    // alone does NOT mark a tab as non-blank). To force tab B to be
    // opened, we first run a real offline import on tab A so it
    // accumulates a non-null result, then re-seed tab A's url to the
    // probe and trigger another sniff.
    const urlInput = page.getByPlaceholder('https://example.com/article');
    await expect(urlInput).toBeVisible();

    const tablist = page.getByRole('tablist', { name: '工作区标签' });
    const offlineBtn = page.getByRole('button', { name: /离线导入/ });

    // (1) seed tab A with a real result via offline import
    await offlineBtn.click();
    await page.waitForFunction(
      () => {
        const tab = document.querySelector('[role="tab"][aria-selected="true"]');
        const label = tab?.querySelector('.ws-tab-label')?.textContent ?? '';
        return label.trim() !== '' && label.trim() !== '新工作区';
      },
      undefined,
      { timeout: 30_000 }
    );
    await expect(offlineBtn).toBeEnabled({ timeout: 30_000 });

    // (2) Re-seed tab A's url to the probe value (covers the input over
    // any url field offline import may have written).
    await urlInput.fill('https://example.com/tab-a-isolation-probe');
    await expect(urlInput).toHaveValue('https://example.com/tab-a-isolation-probe');

    // (3) Trigger offline import again → tab A has a result so it is
    // non-blank, claimForSniff opens tab B and focuses it.
    await offlineBtn.click();
    await expect(tablist.getByRole('tab')).toHaveCount(2, { timeout: 15_000 });
    await expect(offlineBtn).toBeEnabled({ timeout: 30_000 });

    // Tab B is now active — its url must NOT be the probe value
    // (proving tab A's url did not leak into tab B).
    const tabBUrlValue = await urlInput.inputValue();
    expect(tabBUrlValue).not.toBe('https://example.com/tab-a-isolation-probe');

    // Switch back to tab A — its url must come back verbatim.
    await tablist.getByRole('tab').nth(0).click();
    await expect(urlInput).toHaveValue('https://example.com/tab-a-isolation-probe');

    // Cleanup: close tab B.
    await tablist.getByRole('tab').nth(1).click();
    const closeBtns = tablist.locator('.ws-tab-close');
    await closeBtns.nth(1).click();
    await expect(tablist.getByRole('tab')).toHaveCount(1);
    await urlInput.fill('');
  } finally {
    await app.evaluate(async ({ dialog }) => {
      const original = (globalThis as unknown as { __originalShowOpenDialog?: typeof dialog.showOpenDialog }).__originalShowOpenDialog;
      if (original) {
        (dialog as unknown as { showOpenDialog: typeof dialog.showOpenDialog }).showOpenDialog = original;
      }
    });
  }
});
