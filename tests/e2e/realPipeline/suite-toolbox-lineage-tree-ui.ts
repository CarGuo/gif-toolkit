/**
 * SUITE TB-LINEAGE-TREE-UI — branching lineage tree (R-LINEAGE-TREE-V1).
 *
 * Why this SUITE exists
 * ---------------------
 * R-LINEAGE-TREE-V1 promoted the toolbox lineage state from a *linear*
 * breadcrumb (`nodes[]` + `focusIndex`) to a real *tree*
 * (`tree: LineageTreeNode[]` keyed by `parentNodeId`). The new model
 * lets the user fork off any earlier step without losing the previously
 * tried branch — that affects (a) the React `ToolboxLineageTreeView`
 * (SVG canvas with one `<g data-testid="tb-lineage-tree-node-...">`
 * per node), (b) the persistence shape in the SQLite
 * `chain_lineage_nodes` table, and (c) the `hydrateFromChain` rehydrate
 * path that rebuilds the whole tree on app restart.
 *
 * Each of those three layers has its own unit/integration coverage,
 * but only an end-to-end UI run can prove they actually compose
 * correctly: the renderer must keep `tree`, `focusNodeId` and the
 * SQLite rows in lockstep through real ffmpeg / gifsicle invocations,
 * a real Electron preload bridge, and the modal mount/unmount cycle.
 *
 * The six cases below pin those compositional contracts down:
 *
 *   • TREE-A — linear two-step run produces 3 nodes (root + 2). The
 *     TreeView only renders when `tree.length > 1`, so we also
 *     assert it stays hidden after the first reset and surfaces
 *     immediately after step 1 settles.
 *
 *   • TREE-B — fork from a non-tail node creates a sibling branch.
 *     We click the middle Resize node to move focus, then run a
 *     third step (Reverse) and assert (via SQLite) that the new
 *     row's `parentNodeId` points to the Resize node, NOT the
 *     previous tail (Optimize).
 *
 *   • TREE-C — same fork mechanic but rooted at the synthetic root
 *     node. Branching from `nodeId='root'` is the most common user
 *     gesture ("undo to original") and the synthetic root has
 *     special handling (it's the only `parentNodeId === null` node
 *     and is intentionally NOT persisted). We assert the new step's
 *     `parentNodeId` is exactly `'root'`.
 *
 *   • TREE-D-ABORT — cancel a long-running step mid-flight via the
 *     modal's "取消" button. The contract: the in-memory node flips
 *     to `status='aborted'`, the SQLite row mirrors it, and the
 *     TreeView's `data-status` attribute reads `aborted`.
 *
 *   • TREE-E-PERSIST — `hydrateFromChain` rehydrates an entire tree
 *     (not just the focused path). We don't restart the Electron app
 *     (too expensive for an e2e loop); instead we exit + re-enter
 *     the modal so the hook remounts with empty state, then trigger
 *     hydrate via a hidden `<button data-testid="tb-lineage-hydrate"
 *     data-chain-id="...">` (the modal exposes this purely so e2e can
 *     drive it deterministically — there is no UI affordance for it).
 *     The rehydrated tree must contain every previously-seen node and
 *     focus must land on the deepest done leaf.
 *
 *   • TREE-F-WARN-INTEGRATION — the TreeView renders the
 *     R-SIZE-REGRESSION-V1 ⚠️ tspan inline on the regressing node's
 *     size line. The size-regression suite already proves the IPC +
 *     LineageProgressRow halves; this case proves the third surface
 *     (the tree node) wires up correctly, replaying the same
 *     "highly-optimized gif → 5px-border crop" reproducer.
 *
 * The SUITE intentionally drives everything through the React tree
 * (`tb-lineage-tree-*` data-testids, real chip clicks, real "继续 →"
 * button) and the public preload bridge
 * (`window.giftk.db.chainLineageNodes.*`). It NEVER reaches into the
 * lineage hook directly — the hook is not attached to `window` on
 * purpose, so the SUITE consumes the same affordances a real user does.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { existsSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  FIXTURE_GIF,
  FIXTURE_MEDIUM,
  getHarness,
  installRecorder,
  tearDownRecorder,
  snapshotRecorder
} from './_harness';

interface LineageTerminalEmit {
  taskId: string;
  status: string;
  outputs?: string[];
  stepIndex?: number;
  totalSteps?: number;
  error?: string;
  message?: string;
}

interface ChainLineageNodeRowLite {
  nodeId: string;
  chainId: string;
  parentNodeId: string | null;
  kind: string | null;
  inputPath: string;
  outputPath: string | null;
  sizeBefore: number | null;
  sizeAfter: number | null;
  sizeRegressionRatio: number | null;
  status: 'pending' | 'done' | 'failed' | 'aborted';
  createdAt: number;
  doneAt: number | null;
}

// =====================================================================
// Shared helpers — copied verbatim from suite-size-regression-ui.ts so
// this SUITE has zero coupling to its sibling. If a third lineage SUITE
// ever appears, lift these into a shared `_lineageHelpers.ts` module.
// =====================================================================

/**
 * Wipe every persistence surface the lineage flow touches: toolbox
 * history (drives the "继续" entry on the panel), chain history
 * (R-TB-CHAIN), and the new chain_lineage_nodes table. Forgetting the
 * third one would let stale rows from a prior case leak into
 * `listChainIds()` and confuse TREE-E-PERSIST's "latest chainId"
 * heuristic.
 */
async function clearAllHistory(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as {
      giftk: {
        db: {
          toolboxHistory: { clear(): Promise<void> };
          toolboxChainHistory: { clear(): Promise<void> };
          chainLineageNodes: { clear(): Promise<void> };
        };
      };
    };
    await w.giftk.db.toolboxHistory.clear();
    await w.giftk.db.toolboxChainHistory.clear();
    await w.giftk.db.chainLineageNodes.clear();
  });
}

async function seedHistoryRow(
  page: Page,
  output: string,
  kind: string,
  inputDisplayName: string
): Promise<string> {
  const id = `tblin-tree-seed-${kind}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await page.evaluate(
    async (args: { id: string; output: string; kind: string; displayName: string; finishedAt: number }) => {
      const w = window as unknown as {
        giftk: { db: { toolboxHistory: { upsert(entry: unknown): Promise<void> } } };
      };
      await w.giftk.db.toolboxHistory.upsert({
        id: args.id,
        kind: args.kind,
        inputPath: `/synthetic/${args.displayName}`,
        displayName: args.displayName,
        outputs: [args.output],
        params: {},
        status: 'done',
        finishedAt: args.finishedAt
      });
    },
    { id, output, kind, displayName: inputDisplayName, finishedAt: Date.now() }
  );
  await page.locator('button.tab-btn', { hasText: '主页' }).click().catch(() => undefined);
  await expect.poll(
    async () => {
      const rows = (await page.evaluate(async () => {
        const w = window as unknown as {
          giftk: { db: { toolboxHistory: { readAll(): Promise<unknown[]> } } };
        };
        return await w.giftk.db.toolboxHistory.readAll();
      })) as Array<{ id: string }>;
      return rows.some((r) => r.id === id);
    },
    { timeout: 10_000, intervals: [50, 100, 200] }
  ).toBe(true);
  await page.locator('button.tab-btn', { hasText: '工具箱' }).click();
  return id;
}

async function ensureToolboxTab(page: Page): Promise<void> {
  const tab = page.locator('button.tab-btn', { hasText: '工具箱' });
  await expect(tab).toBeVisible({ timeout: 10_000 });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-pressed', 'true');
}

async function enterLineage(page: Page): Promise<Locator> {
  const continueBtn = page.locator('button.tb-history-continue').first();
  await expect(continueBtn).toBeVisible({ timeout: 10_000 });
  await continueBtn.click();
  const modal = page.locator('div.modal.tb-lineage-modal[role="dialog"]');
  await expect(modal).toBeVisible({ timeout: 5_000 });
  return modal;
}

async function selectChip(modal: Locator, label: string | RegExp): Promise<void> {
  const chip = modal.locator('.tb-lineage-chips button[role="tab"]', {
    hasText: typeof label === 'string' ? new RegExp(`^${label}$`) : label
  });
  await expect(chip).toBeVisible({ timeout: 5_000 });
  await chip.click();
  await expect(chip).toHaveAttribute('aria-selected', 'true');
}

async function exitLineage(page: Page, modal: Locator): Promise<void> {
  await page.locator('button', { hasText: '退出链路' }).click();
  await expect(modal).toHaveCount(0, { timeout: 5_000 });
}

function rmDirOf(filePath: string | null): void {
  if (!filePath) return;
  try {
    rmSync(path.dirname(filePath), { recursive: true, force: true });
  } catch { /* best-effort */ }
}

/**
 * Mirror of suite-size-regression-ui.ts#buildHighlyOptimizedGif —
 * builds a multi-frame, gifsicle-O3-packed gif from medium.mp4 so
 * a downstream crop is guaranteed to inflate past the 1.05 ratio
 * gate. Used only by TREE-F-WARN-INTEGRATION.
 */
async function buildHighlyOptimizedGif(page: Page): Promise<string> {
  const result = await page.evaluate(async (inputPath: string) => {
    const w = window as unknown as {
      giftk: {
        startToolbox(jobs: unknown[]): Promise<unknown>;
        onProgress(cb: (p: { taskId: string; status: string; outputs?: string[] }) => void): () => void;
      };
    };
    const jobId = `tree-pre-v2g-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    return await new Promise<string>((resolve, reject) => {
      let off: (() => void) | null = null;
      const timer = setTimeout(() => {
        if (off) off();
        reject(new Error('video-to-gif did not finish within 60s'));
      }, 60_000);
      off = w.giftk.onProgress((p) => {
        if (p.taskId !== jobId) return;
        if (p.status === 'done' && p.outputs && p.outputs.length > 0) {
          clearTimeout(timer);
          if (off) off();
          resolve(p.outputs[0]);
        } else if (p.status === 'failed') {
          clearTimeout(timer);
          if (off) off();
          reject(new Error('video-to-gif failed'));
        }
      });
      w.giftk.startToolbox([{
        id: jobId,
        kind: 'video-to-gif',
        inputPath,
        params: { fps: 12, engine: 'ffmpeg' }
      }]).catch(reject);
    });
  }, FIXTURE_MEDIUM);
  return result;
}

/**
 * Click 「继续 →」 and poll the IPC recorder for the chain's terminal
 * `done` emit. Returns the full progress payload so callers can
 * cross-check sizeRegression / outputs.
 *
 * Identical in shape to the size-regression suite's helper — lineage
 * always emits a single-step task id of the form `<ipcChainId>-s1`.
 */
async function runStepAndWaitDone(
  modal: Locator,
  page: Page,
  timeoutMs = 90_000
): Promise<LineageTerminalEmit> {
  const baseline = (await snapshotRecorder()).progress.length;
  const continueStepBtn = modal.locator('button.btn.primary', { hasText: /^继续 →/ });
  await expect(continueStepBtn).toBeEnabled({ timeout: 10_000 });
  await continueStepBtn.click();

  let boundChainId: string | null = null;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snap = await snapshotRecorder();
    const candidates = snap.progress.slice(baseline);
    if (!boundChainId) {
      for (const p of candidates) {
        const tid = (p as { taskId?: unknown }).taskId;
        if (typeof tid !== 'string') continue;
        const m = /^(tblineage-[a-z0-9-]+)-s1$/i.exec(tid);
        if (m) { boundChainId = m[1]; break; }
      }
    }
    if (boundChainId) {
      const expected = `${boundChainId}-s1`;
      const last = [...candidates].reverse().find((p) => {
        const cp = p as unknown as LineageTerminalEmit;
        if (cp.taskId !== expected) return false;
        if (cp.totalSteps !== 1 || cp.stepIndex !== 1) return false;
        return cp.status === 'done' || cp.status === 'failed' || cp.status === 'cancelled';
      });
      if (last) return last as unknown as LineageTerminalEmit;
    }
    await page.waitForTimeout(250);
  }
  const tail = (await snapshotRecorder()).progress.slice(-5);
  throw new Error(
    `lineage tree chain did not finish within ${timeoutMs}ms; tail emits: ${JSON.stringify(tail)}`
  );
}

// =====================================================================
// SUITE-local helpers
// =====================================================================

/**
 * Read the most recent chainId from sqlite. Used by TREE-E-PERSIST
 * to capture the current chain BEFORE exit, then drive a hydrate
 * after re-enter. The lineage hook is intentionally NOT attached to
 * `window`, so this is the most direct way to discover the id.
 */
async function readLatestChainId(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const w = window as unknown as {
      giftk: { db: { chainLineageNodes: { listChainIds(): Promise<string[]> } } };
    };
    const ids = await w.giftk.db.chainLineageNodes.listChainIds();
    if (!Array.isArray(ids) || ids.length === 0) return null;
    return ids[ids.length - 1];
  });
}

async function listChainRows(page: Page, chainId: string): Promise<ChainLineageNodeRowLite[]> {
  return page.evaluate(async (cid: string) => {
    const w = window as unknown as {
      giftk: { db: { chainLineageNodes: { listByChain(c: string): Promise<unknown[]> } } };
    };
    const rows = (await w.giftk.db.chainLineageNodes.listByChain(cid)) as ChainLineageNodeRowLite[];
    return rows;
  }, chainId) as Promise<ChainLineageNodeRowLite[]>;
}

/**
 * R-TB-LOG-V1 — read a single session log snapshot via the preload
 * `db:sessionLogs:read` channel. Returns null when the session id is
 * not on disk. Used by TREE-G-LOG to assert that every chain run
 * leaves a recoverable audit trail keyed by the tree-wide chainId.
 */
interface SessionLogEntryLite {
  seq: number;
  level: string;
  stage: string;
  substep?: string;
  message: string;
  data?: Record<string, unknown>;
}
interface SessionLogSnapshotLite {
  sessionId: string;
  origin?: string;
  outcome?: string;
  entries: SessionLogEntryLite[];
}
async function readSessionLog(page: Page, sessionId: string): Promise<SessionLogSnapshotLite | null> {
  return page.evaluate(async (sid: string) => {
    const w = window as unknown as {
      giftk: { db: { sessionLogs: { read(s: string): Promise<unknown> } } };
    };
    const snap = await w.giftk.db.sessionLogs.read(sid);
    return (snap ?? null) as SessionLogSnapshotLite | null;
  }, sessionId);
}

/**
 * Locate every rendered tree node group regardless of nodeId. Used to
 * count nodes / iterate by index when the test doesn't know specific
 * ids ahead of time (most of these cases derive ids from the DOM).
 */
function treeNodes(modal: Locator): Locator {
  return modal.locator('[data-testid^="tb-lineage-tree-node-"]');
}

function treeNode(modal: Locator, nodeId: string): Locator {
  return modal.locator(`[data-testid="tb-lineage-tree-node-${nodeId}"]`);
}

/**
 * Extract the nodeId portion of a `tb-lineage-tree-node-{nodeId}`
 * data-testid. Returns null when the attribute is missing or shaped
 * unexpectedly. Defensive on purpose — the SUITE keeps running in CI
 * even if a future TreeView refactor changes the prefix, and the
 * resulting `null` will fail the assertion with a clear message.
 */
async function readNodeIdFrom(loc: Locator): Promise<string | null> {
  const tid = await loc.getAttribute('data-testid');
  if (!tid) return null;
  const m = /^tb-lineage-tree-node-(.+)$/.exec(tid);
  return m ? m[1] : null;
}

/**
 * Trigger the hidden hydrate button. Modal exposes
 * `<button data-testid="tb-lineage-hydrate" data-chain-id=""
 *  aria-hidden="true">` purely so e2e can drive `hydrateFromChain`
 * deterministically (there is no end-user UI for it). We MUST set
 * data-chain-id BEFORE click — the modal reads it via `useEffect` on
 * the data attribute mutation.
 */
async function triggerHydrate(page: Page, chainId: string): Promise<void> {
  await page.evaluate((cid: string) => {
    const btn = document.querySelector('[data-testid="tb-lineage-hydrate"]') as HTMLElement | null;
    if (!btn) throw new Error('tb-lineage-hydrate button not found in DOM');
    btn.setAttribute('data-chain-id', cid);
    btn.click();
  }, chainId);
}

// =====================================================================
// SUITE TB-LINEAGE-TREE-UI — branching lineage tree (R-LINEAGE-TREE-V1)
// =====================================================================

test.describe('SUITE TB-LINEAGE-TREE-UI — branching lineage tree (R-LINEAGE-TREE-V1)', () => {
  test.describe.configure({ timeout: 180_000 });

  /**
   * TREE-A — linear two-step chain ⇒ 3 nodes (root + Resize + Optimize).
   * TreeView is hidden on a fresh reset (tree.length === 1) and only
   * appears after step 1 commits. The final focus must land on the
   * tail Optimize node with `data-status=done` `data-focus=1`, and the
   * synthetic root must be visible but NOT focused.
   */
  test('TREE-A linear two-step run produces 3 nodes', async () => {
    const { page } = getHarness();
    await clearAllHistory(page);
    await ensureToolboxTab(page);
    await seedHistoryRow(page, FIXTURE_GIF, 'gif-resize', 'tiny.gif');
    await installRecorder();
    const cleanups: (string | null)[] = [];
    try {
      const modal = await enterLineage(page);

      // Pre-condition: TreeView is hidden on root-only chains. Asserts
      // the `tree.length > 1` gate in the modal, which prevents a
      // useless one-node SVG from cluttering a brand-new lineage.
      const treeView = modal.locator('[data-testid="tb-lineage-tree-view"]');
      await expect(treeView).toHaveCount(0);

      // Step 1 — GIF Resize.
      await selectChip(modal, /^GIF Resize$/);
      const widthInput = modal.locator('label', { hasText: /^宽度$|^Width$|width/i }).first().locator('input').first();
      // Many GIF Resize forms ship with a default width already
      // populated; we don't override unless we have to. The chain
      // either way produces a real node — the test cares about node
      // count + status, not pixel dimensions.
      void widthInput;
      const step1 = await runStepAndWaitDone(modal, page);
      expect(step1.status).toBe('done');
      cleanups.push((step1.outputs ?? [])[0] ?? null);

      // TreeView surfaces now that tree.length === 2.
      await expect(treeView).toBeVisible({ timeout: 10_000 });
      await expect(treeNodes(modal)).toHaveCount(2, { timeout: 10_000 });

      // Step 2 — GIF Optimize.
      await selectChip(modal, /^GIF Optimize$/);
      const step2 = await runStepAndWaitDone(modal, page);
      expect(step2.status).toBe('done');
      cleanups.push((step2.outputs ?? [])[0] ?? null);

      await expect(treeNodes(modal)).toHaveCount(3, { timeout: 10_000 });

      // Root node is rendered (every lineage has a `nodeId='root'`),
      // is in `data-status=done`, and is NOT focused — focus follows
      // the tail.
      const rootNode = treeNode(modal, 'root');
      await expect(rootNode).toHaveAttribute('data-status', 'done');
      await expect(rootNode).toHaveAttribute('data-focus', '0');

      // Tail is focused. We pick the last node in DOM order — TreeView
      // renders nodes in createdAt-asc, and the tail is always the
      // most-recently-inserted node.
      const all = treeNodes(modal);
      const tail = all.last();
      await expect(tail).toHaveAttribute('data-status', 'done');
      await expect(tail).toHaveAttribute('data-focus', '1');

      await exitLineage(page, modal);
    } finally {
      await tearDownRecorder();
      for (const out of cleanups) rmDirOf(out);
      await clearAllHistory(page).catch(() => undefined);
    }
  });

  /**
   * TREE-B — fork from a non-tail node creates a sibling branch.
   *
   * 1. Build a 3-node linear chain (root → Resize → Optimize) just
   *    like TREE-A.
   * 2. Click the middle Resize node so focus moves there.
   * 3. Run a third step (Reverse) from that focus.
   * 4. Inspect SQLite — the new Reverse row's parentNodeId MUST be
   *    the Resize node's id (NOT root, NOT Optimize). This is the
   *    single most important contract of R-LINEAGE-TREE-V1: forking
   *    off an internal node creates a *sibling*, not a child of the
   *    previous tail.
   *
   * SQLite is the source of truth here because the in-memory tree is
   * also derived from `parentNodeId` — checking the persisted column
   * proves the renderer wrote the right relation, not just rendered
   * the right edges.
   */
  test('TREE-B fork from middle node yields 4 nodes with sibling branch', async () => {
    const { page } = getHarness();
    await clearAllHistory(page);
    await ensureToolboxTab(page);
    await seedHistoryRow(page, FIXTURE_GIF, 'gif-resize', 'tiny.gif');
    await installRecorder();
    const cleanups: (string | null)[] = [];
    try {
      const modal = await enterLineage(page);

      // Linear 3-node setup (same as TREE-A).
      await selectChip(modal, /^GIF Resize$/);
      const step1 = await runStepAndWaitDone(modal, page);
      expect(step1.status).toBe('done');
      cleanups.push((step1.outputs ?? [])[0] ?? null);

      await selectChip(modal, /^GIF Optimize$/);
      const step2 = await runStepAndWaitDone(modal, page);
      expect(step2.status).toBe('done');
      cleanups.push((step2.outputs ?? [])[0] ?? null);

      await expect(treeNodes(modal)).toHaveCount(3, { timeout: 10_000 });

      // Pick the Resize node. We exclude root (nodeId='root') and the
      // tail (last in DOM order) to land on the unique middle node.
      const all = treeNodes(modal);
      const total = await all.count();
      let resizeNode: Locator | null = null;
      let resizeNodeId: string | null = null;
      for (let i = 0; i < total; i++) {
        const n = all.nth(i);
        const nid = await readNodeIdFrom(n);
        if (!nid || nid === 'root') continue;
        // Skip the tail (focus=1 currently).
        const focus = await n.getAttribute('data-focus');
        if (focus === '1') continue;
        const status = await n.getAttribute('data-status');
        if (status !== 'done') continue;
        resizeNode = n;
        resizeNodeId = nid;
        break;
      }
      if (!resizeNode || !resizeNodeId) {
        throw new Error('TREE-B: failed to locate the middle Resize node in the rendered tree');
      }

      // Click → focus moves to Resize. We click the inner <rect> /
      // group; Playwright forwards the click to the SVG <g> which has
      // the onClick handler. data-focus=1 is the visible signal.
      await resizeNode.click();
      await expect(resizeNode).toHaveAttribute('data-focus', '1', { timeout: 5_000 });

      // Run Reverse from the new focus. This produces the fork.
      await selectChip(modal, /^Reverse$/);
      const step3 = await runStepAndWaitDone(modal, page);
      expect(step3.status).toBe('done');
      cleanups.push((step3.outputs ?? [])[0] ?? null);

      await expect(treeNodes(modal)).toHaveCount(4, { timeout: 10_000 });

      // Source-of-truth check: SQLite. Synthetic root is intentionally
      // NOT persisted, so we expect exactly 3 rows (Resize, Optimize,
      // Reverse). Reverse's parentNodeId MUST equal Resize's nodeId.
      const cid = await readLatestChainId(page);
      expect(cid).toBeTruthy();
      const rows = await listChainRows(page, cid as string);
      expect(rows.length).toBe(3);

      const resizeRow = rows.find((r) => r.kind === 'gif-resize');
      const optimizeRow = rows.find((r) => r.kind === 'gif-optimize');
      const reverseRow = rows.find((r) => r.kind === 'reverse');
      expect(resizeRow).toBeDefined();
      expect(optimizeRow).toBeDefined();
      expect(reverseRow).toBeDefined();

      // The forked Reverse step shares its parent with Optimize (both
      // children of Resize), proving the sibling-branch shape.
      expect(reverseRow!.parentNodeId).toBe(resizeRow!.nodeId);
      expect(optimizeRow!.parentNodeId).toBe(resizeRow!.nodeId);
      // And the Resize node itself is rooted at the synthetic root.
      expect(resizeRow!.parentNodeId).toBe('root');

      await exitLineage(page, modal);
    } finally {
      await tearDownRecorder();
      for (const out of cleanups) rmDirOf(out);
      await clearAllHistory(page).catch(() => undefined);
    }
  });

  /**
   * TREE-C — branch from the synthetic root.
   *
   * Edge case in two ways:
   *   1. Root is the only node with `parentNodeId === null`, AND
   *   2. Root is intentionally NOT persisted (see useToolboxLineage
   *      header). When a user forks from root, the new step's
   *      `parentNodeId` is the literal string `'root'`, not null.
   *
   * If the renderer ever conflated those (e.g. wrote `null` because
   * "root has no parent"), the SQLite tree would be ambiguous — every
   * fork from root would look like a separate chain root. This case
   * pins the `'root'` string contract down.
   */
  test('TREE-C branch from root keeps prior step and creates a sibling', async () => {
    const { page } = getHarness();
    await clearAllHistory(page);
    await ensureToolboxTab(page);
    await seedHistoryRow(page, FIXTURE_GIF, 'gif-resize', 'tiny.gif');
    await installRecorder();
    const cleanups: (string | null)[] = [];
    try {
      const modal = await enterLineage(page);

      // Step 1 — GIF Resize. 2 nodes total.
      await selectChip(modal, /^GIF Resize$/);
      const step1 = await runStepAndWaitDone(modal, page);
      expect(step1.status).toBe('done');
      cleanups.push((step1.outputs ?? [])[0] ?? null);

      await expect(treeNodes(modal)).toHaveCount(2, { timeout: 10_000 });

      // Click root → focus moves to root.
      const rootNode = treeNode(modal, 'root');
      await rootNode.click();
      await expect(rootNode).toHaveAttribute('data-focus', '1', { timeout: 5_000 });

      // From root, run GIF Optimize. New step is a sibling of the
      // previous Resize, NOT its child.
      await selectChip(modal, /^GIF Optimize$/);
      const step2 = await runStepAndWaitDone(modal, page);
      expect(step2.status).toBe('done');
      cleanups.push((step2.outputs ?? [])[0] ?? null);

      // 3 total: root + Resize + Optimize (sibling).
      await expect(treeNodes(modal)).toHaveCount(3, { timeout: 10_000 });

      const cid = await readLatestChainId(page);
      expect(cid).toBeTruthy();
      const rows = await listChainRows(page, cid as string);
      // Root never persists, so 2 rows on disk.
      expect(rows.length).toBe(2);
      const resizeRow = rows.find((r) => r.kind === 'gif-resize');
      const optimizeRow = rows.find((r) => r.kind === 'gif-optimize');
      expect(resizeRow).toBeDefined();
      expect(optimizeRow).toBeDefined();
      // Both are direct children of the literal 'root' string, NOT null.
      expect(resizeRow!.parentNodeId).toBe('root');
      expect(optimizeRow!.parentNodeId).toBe('root');

      await exitLineage(page, modal);
    } finally {
      await tearDownRecorder();
      for (const out of cleanups) rmDirOf(out);
      await clearAllHistory(page).catch(() => undefined);
    }
  });

  /**
   * TREE-D-ABORT — cancel mid-flight ⇒ status='aborted' on disk and DOM.
   *
   * We deliberately use video-to-gif on medium.mp4 to get a step that
   * runs for several seconds (palette generation + frame extract +
   * gifsicle pack) so the test has a comfortable window to click the
   * "取消" button before it auto-completes.
   *
   * The hook's `cancel()` path inserts a synthetic `aborted` terminal
   * row both in memory and via persistRow, so we get to assert both
   * sides converge.
   */
  test('TREE-D-ABORT cancel mid-flight marks node aborted on disk and in tree', async () => {
    const { page } = getHarness();
    await clearAllHistory(page);
    await ensureToolboxTab(page);
    await seedHistoryRow(page, FIXTURE_MEDIUM, 'video-to-gif', path.basename(FIXTURE_MEDIUM));
    await installRecorder();
    try {
      const modal = await enterLineage(page);

      // Pick the long-running operation. video-to-gif is the canonical
      // multi-second toolbox kind on medium.mp4.
      await selectChip(modal, /^Video → GIF$/);

      const continueBtn = modal.locator('button.btn.primary', { hasText: /^继续 →/ });
      await expect(continueBtn).toBeEnabled({ timeout: 10_000 });
      await continueBtn.click();

      // Cancel button is enabled only while `lineage.isRunning` is
      // true. It's right next to the trial / continue buttons in the
      // modal footer — we match by exact text to dodge the unrelated
      // "取消" links that may appear elsewhere.
      const cancelBtn = modal.locator('button.btn', { hasText: /^取消$/ });
      await expect(cancelBtn).toBeEnabled({ timeout: 10_000 });
      await cancelBtn.click();

      // After cancel, the pending node flips to aborted. We poll the
      // tree DOM for any node with data-status=aborted (the cancelled
      // step) — TreeView only renders 2 nodes after the abort: root
      // (done) + the aborted step.
      const abortedNode = modal.locator('[data-testid^="tb-lineage-tree-node-"][data-status="aborted"]');
      await expect(abortedNode).toHaveCount(1, { timeout: 15_000 });

      // SQLite mirror: exactly one persisted row, status='aborted'.
      // Root is never persisted, so we only see the aborted step.
      await expect.poll(async () => {
        const cid = await readLatestChainId(page);
        if (!cid) return null;
        const rows = await listChainRows(page, cid);
        const aborted = rows.find((r) => r.status === 'aborted');
        return aborted ? aborted.status : null;
      }, { timeout: 15_000, intervals: [200, 400, 600] }).toBe('aborted');

      await exitLineage(page, modal);
    } finally {
      await tearDownRecorder();
      await clearAllHistory(page).catch(() => undefined);
    }
  });

  /**
   * TREE-E-PERSIST — `hydrateFromChain` rehydrates the entire tree.
   *
   * Restarting Electron mid-spec is prohibitively slow (each cold
   * start runs the postinstall + asar mount path), so we simulate the
   * "user came back later" scenario by exit + re-enter:
   *
   *   1. Build a 3-node linear chain (TREE-A shape).
   *   2. Capture the chainId from sqlite.
   *   3. Exit lineage → modal unmounts → hook state goes away.
   *   4. Re-enter lineage on a fresh row → reset() seeds a brand-new
   *      single-root tree → TreeView hidden.
   *   5. Trigger the hidden `tb-lineage-hydrate` button with the
   *      captured chainId → hook calls `hydrateFromChain(cid)` →
   *      tree state is rebuilt from disk.
   *   6. TreeView reappears, every previously-seen node is back, and
   *      focus has been picked by `pickHydrateFocus` (deepest done
   *      leaf — the Optimize tail in our shape).
   */
  test('TREE-E-PERSIST hydrate rebuilds tree after modal remount', async () => {
    const { page } = getHarness();
    await clearAllHistory(page);
    await ensureToolboxTab(page);
    await seedHistoryRow(page, FIXTURE_GIF, 'gif-resize', 'tiny.gif');
    await installRecorder();
    const cleanups: (string | null)[] = [];
    try {
      // Build the 3-node TREE-A shape.
      let modal = await enterLineage(page);
      await selectChip(modal, /^GIF Resize$/);
      const step1 = await runStepAndWaitDone(modal, page);
      expect(step1.status).toBe('done');
      cleanups.push((step1.outputs ?? [])[0] ?? null);

      await selectChip(modal, /^GIF Optimize$/);
      const step2 = await runStepAndWaitDone(modal, page);
      expect(step2.status).toBe('done');
      cleanups.push((step2.outputs ?? [])[0] ?? null);

      await expect(treeNodes(modal)).toHaveCount(3, { timeout: 10_000 });

      // Snapshot the chainId BEFORE exit — listChainIds() returns the
      // most-recent id first/last (sqlite insertion order), so we can
      // safely re-read it later but the explicit capture is clearer.
      const chainId = await readLatestChainId(page);
      expect(chainId).toBeTruthy();

      // Capture the persisted nodeIds for cross-check after rehydrate.
      const beforeRows = await listChainRows(page, chainId as string);
      const beforeNodeIds = new Set(beforeRows.map((r) => r.nodeId));
      expect(beforeNodeIds.size).toBe(2); // root excluded from disk

      await exitLineage(page, modal);

      // Re-enter on the same seeded row. reset() runs synchronously
      // and seeds a fresh single-root tree — TreeView must be hidden.
      modal = await enterLineage(page);
      const treeView = modal.locator('[data-testid="tb-lineage-tree-view"]');
      await expect(treeView).toHaveCount(0);

      // Trigger hydrate via the hidden e2e affordance.
      await triggerHydrate(page, chainId as string);

      // TreeView returns and renders all 3 nodes (root + 2 persisted).
      await expect(treeView).toBeVisible({ timeout: 10_000 });
      await expect(treeNodes(modal)).toHaveCount(3, { timeout: 10_000 });

      // Every previously-persisted nodeId is back on screen.
      for (const nid of beforeNodeIds) {
        await expect(treeNode(modal, nid)).toBeVisible();
      }
      // Plus the synthetic root.
      await expect(treeNode(modal, 'root')).toBeVisible();

      // Focus picker landed on the deepest done leaf — that's the
      // last DOM node (createdAt-asc order, tail is Optimize).
      const tail = treeNodes(modal).last();
      await expect(tail).toHaveAttribute('data-focus', '1', { timeout: 10_000 });
      await expect(tail).toHaveAttribute('data-status', 'done');
      // Root must NOT be the focus after hydrate — pickHydrateFocus
      // explicitly skips synthetic root when any done leaf exists.
      await expect(treeNode(modal, 'root')).toHaveAttribute('data-focus', '0');

      await exitLineage(page, modal);
    } finally {
      await tearDownRecorder();
      for (const out of cleanups) rmDirOf(out);
      await clearAllHistory(page).catch(() => undefined);
    }
  });

  /**
   * TREE-F-WARN-INTEGRATION — TreeView paints the size-regression ⚠️.
   *
   * R-SIZE-REGRESSION-V1 surfaces the warning on three independent
   * UI surfaces:
   *   (1) the LineageProgressRow pill (covered by suite-size-regression
   *       SIZE-CROP-PERSIST-B),
   *   (2) the breadcrumb meta-row (covered by ToolboxLineageModal's
   *       fmtSizeCell unit test),
   *   (3) the TreeView node's size line — that's THIS case.
   *
   * The reproducer is identical to SIZE-CROP-WARN-A: build a tightly-
   * packed multi-frame gif via gifsicle -O3, then crop a 5px border.
   * ffmpeg's re-encode resets the LZW packing and inflates the file
   * past the 1.05 ratio threshold, which forces TreeView to render a
   * `<tspan data-testid="tb-lineage-tree-warn-{nodeId}">` next to the
   * size figure on the produced node.
   */
  test('TREE-F-WARN-INTEGRATION TreeView renders size-regression ⚠️ on regressing node', async () => {
    const { page } = getHarness();
    await clearAllHistory(page);
    await ensureToolboxTab(page);
    const goldGif = await buildHighlyOptimizedGif(page);
    expect(existsSync(goldGif)).toBe(true);
    await seedHistoryRow(page, goldGif, 'video-to-gif', path.basename(goldGif));
    await installRecorder();
    let outPath: string | null = null;
    try {
      const modal = await enterLineage(page);
      await selectChip(modal, /^Crop$/);
      const cropPane = modal.locator('.tb-crop-pane');
      await expect(cropPane).toBeVisible({ timeout: 15_000 });
      const labelToInput = (label: string): Locator =>
        cropPane.locator('label', { hasText: new RegExp(`^${label}$`) }).locator('input');
      // Same canonical 5px-border crop as SIZE-CROP-WARN-A.
      await labelToInput('X').fill('5');
      await labelToInput('Y').fill('5');
      await labelToInput('W').fill('470');
      await labelToInput('H').fill('350');
      await labelToInput('H').press('Tab');

      const final = await runStepAndWaitDone(modal, page);
      expect(final.status).toBe('done');
      outPath = (final.outputs ?? [])[0] ?? null;
      expect(outPath).toBeTruthy();
      if (outPath) {
        expect(existsSync(outPath)).toBe(true);
        expect(statSync(outPath).size).toBeGreaterThan(0);
      }

      // TreeView must be visible (we have 2 nodes: root + Crop).
      const treeView = modal.locator('[data-testid="tb-lineage-tree-view"]');
      await expect(treeView).toBeVisible({ timeout: 10_000 });

      // The crop row sits in sqlite with sizeRegressionRatio > 1.05 —
      // its TreeView node MUST carry the warn tspan.
      const cid = await readLatestChainId(page);
      expect(cid).toBeTruthy();
      const rows = await listChainRows(page, cid as string);
      const cropRow = rows.find((r) => r.kind === 'crop');
      expect(cropRow).toBeDefined();
      expect(cropRow!.sizeRegressionRatio ?? 0).toBeGreaterThan(1.05);

      const warn = modal.locator(`[data-testid="tb-lineage-tree-warn-${cropRow!.nodeId}"]`);
      await expect(warn).toBeVisible({ timeout: 5_000 });

      await exitLineage(page, modal);
    } finally {
      await tearDownRecorder();
      rmDirOf(outPath);
      rmDirOf(goldGif);
      await clearAllHistory(page).catch(() => undefined);
    }
  });

  /**
   * TREE-G-LOG — R-TB-LOG-V1 audit trail.
   *
   * Why: previously a failing chain only surfaced as a generic toaster
   * + a `failed` row in chain history; the user had no way to inspect
   * *which* substep blew up nor with what params. With R-TB-LOG-V1
   * every step start / done / failed / cancelled / size-regression
   * lands in the per-session log on disk, keyed by the tree-wide
   * chainId so a whole branching lineage shares one timeline.
   *
   * What we assert:
   * 1. After a normal 1-step chain, sessionLogs.read('tb:<chainId>')
   *    returns a non-null snapshot with origin='toolbox'.
   * 2. The snapshot includes (in order) the canonical chain.start,
   *    step.start, step.done substeps tagged stage='toolbox'.
   * 3. The snapshot's outcome is 'done' and the chain.start data
   *    payload carries lineageChainId equal to the chainId we read
   *    from sqlite.
   */
  test('TREE-G-LOG R-TB-LOG-V1 audit trail (chain.start / step.start / step.done) keyed by tree chainId', async () => {
    const { page } = getHarness();
    await clearAllHistory(page);
    await ensureToolboxTab(page);
    await seedHistoryRow(page, FIXTURE_GIF, 'gif-resize', 'tiny.gif');
    await installRecorder();

    try {
      const modal = await enterLineage(page);
      await selectChip(modal, /^GIF Resize$/);
      const result = await runStepAndWaitDone(modal, page);
      expect(result.status).toBe('done');

      const cid = await readLatestChainId(page);
      expect(cid).toBeTruthy();

      // The session id mirrors `tb:${tree-wide chainId}` (see
      // startToolboxChain: `tb:${lineageChainId || chainId}`). The
      // persistence is fire-and-forget so we wait briefly with a poll
      // rather than rely on a single read happening to win the race.
      let snap: SessionLogSnapshotLite | null = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        snap = await readSessionLog(page, `tb:${cid as string}`);
        if (snap && snap.entries.length >= 3) break;
        await page.waitForTimeout(150);
      }
      expect(snap).toBeTruthy();
      expect(snap!.origin).toBe('toolbox');

      const substeps = snap!.entries.map((e) => e.substep ?? '');
      expect(substeps).toContain('chain.start');
      expect(substeps).toContain('step.start');
      expect(substeps).toContain('step.done');

      // Every audit entry must be tagged with the toolbox stage so a
      // future `.log` export filter ('stage=toolbox') is non-empty.
      const toolboxEntries = snap!.entries.filter((e) => e.stage === 'toolbox');
      expect(toolboxEntries.length).toBeGreaterThanOrEqual(3);

      // chain.start carries the lineageChainId in its data payload.
      const chainStart = snap!.entries.find((e) => e.substep === 'chain.start');
      expect(chainStart).toBeTruthy();
      expect((chainStart!.data as { lineageChainId?: string })?.lineageChainId).toBe(cid);

      // The closing `session.done` line is logged by sessionLogger
      // itself (substep='session.done'), so the outcome is `done`.
      expect(snap!.outcome).toBe('done');

      await exitLineage(page, modal);
    } finally {
      await tearDownRecorder();
      await clearAllHistory(page).catch(() => undefined);
    }
  });
});
