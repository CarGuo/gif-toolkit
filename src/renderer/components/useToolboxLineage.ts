/**
 * R-LINEAGE-TREE-V1 — useToolboxLineage (tree model).
 *
 * Why this rewrite (and how it differs from R-TB-CHAIN-V2 Phase 2.1)
 * -----------------------------------------------------------------
 * The original lineage hook modeled the chain as a *linear* breadcrumb
 * (`nodes: LineageNode[]` + `focusIndex`) and dropped the abandoned
 * tail whenever the user branched off an earlier step. That worked
 * for the MVP "one path through the tree" UX but fundamentally cannot
 * represent forks, which the persistence layer (`chain_lineage_nodes`)
 * and the upcoming TreeView panel both require.
 *
 * This rewrite re-grounds the renderer state on a *tree*:
 *
 *   - Internal source of truth is `tree: LineageTreeNode[]`, a flat
 *     array of nodes whose shape matches the SQLite row exactly so
 *     `hydrateFromChain` can rehydrate without lossy projection.
 *   - The legacy `nodes` field is preserved as a derived value: the
 *     ancestor chain from root → focus (inclusive). That keeps the
 *     existing breadcrumb consumer (ToolboxLineageModal) bit-for-bit
 *     compatible while the new TreeView reads `tree` for the full
 *     graph.
 *   - `focusIndex` is also derived: index of the focused node within
 *     the derived `nodes` ancestor chain.
 *   - Branching (`focusNode` + `runNextStep` on a non-tail node) no
 *     longer drops abandoned siblings — they stay in `tree` and on
 *     disk so the user can navigate back to a fork later.
 *
 * Persistence (fire-and-forget)
 * -----------------------------
 * Every state-changing transition (`pending` insert on runNextStep
 * start; `done` / `failed` / `aborted` on terminal emit / cancel /
 * reset-while-busy) is mirrored to
 * `window.giftk.db.chainLineageNodes.upsert` with `.catch(() => undefined)`
 * so the UI is never blocked by disk I/O. The synthetic root is NOT
 * persisted — every chain has exactly one root and writing it would
 * pollute `listChainIds()`.
 *
 * Pure helpers (id generation, ext sniffing, ancestor walks, row
 * decoration / SQL projection, hydrate-focus picker) live in
 * `useToolboxLineageHelpers.ts` so this file stays focused on the
 * stateful orchestration and the IPC listener wiring.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ToolboxKind,
  ToolboxParams,
  TaskProgress
} from '../../shared/types';
import type {
  ChainLineageNodeRow,
  ChainLineageNodeStatus
} from '../../shared/types/chainLineage';
import {
  type LineageTreeNode,
  type LineageNode,
  makeChainId,
  makeIpcChainId,
  deriveNextKinds,
  asLineageNode,
  ancestorsTo,
  toSqlRow,
  fromSqlRow,
  pickHydrateFocus,
  maxNumericSuffix,
  makeRootNode
} from './useToolboxLineageHelpers';

export type { LineageTreeNode, LineageNode } from './useToolboxLineageHelpers';

export interface UseToolboxLineageResult {
  /** Backwards-compatible: ancestor chain from root → focus. */
  nodes: readonly LineageNode[];
  /** Backwards-compatible: index of focus within `nodes`. */
  focusIndex: number;
  /** Convenience accessor for the focus node, or null when uninitialised. */
  focus: LineageNode | null;
  /** True iff a runNextStep call is mid-flight. */
  isRunning: boolean;
  /** Last error message; cleared by reset/runNextStep/cancel. */
  error: string | null;
  /** Initialise (or re-initialise) the lineage from a single input path. */
  reset: (inputPath: string) => void;
  /** Move focus to nodeId. Tree model: does NOT drop siblings. */
  focusNode: (nodeId: string) => void;
  /** Run a single step from the current focus. Resolves with the produced node. */
  runNextStep: (kind: ToolboxKind, params: ToolboxParams) => Promise<LineageNode>;
  /** Cancel the in-flight step. No-op when idle. */
  cancel: () => Promise<void>;
  /** Compatible next-step kinds for the current focus. */
  nextKindOptions: readonly ToolboxKind[];
  /** Latest non-terminal `process:progress` event for the in-flight step. */
  currentProgress: TaskProgress | null;

  // R-LINEAGE-TREE-V1 additions —————————————————————————————

  /** Flat list of every node in the current tree (in createdAt asc order). */
  tree: readonly LineageTreeNode[];
  /** Stable id for the lineage instance (one per reset()). null before reset. */
  chainId: string | null;
  /** Currently focused node id, or null when uninitialised. */
  focusNodeId: string | null;
  /** root → focus ancestor chain (inclusive). Same data as `nodes`. */
  pathToFocus: readonly LineageTreeNode[];
  /** Rehydrate the tree from SQLite for a saved chainId. No-op if not found. */
  hydrateFromChain: (chainId: string) => Promise<void>;
  /** Explicit fork-point selection. Alias for focusNode with clearer intent. */
  branchFromNode: (nodeId: string) => void;
}

interface ToolboxBridge {
  startToolboxChain(payload: {
    chainId: string;
    inputPath: string;
    steps: Array<{ id: string; kind: ToolboxKind; params: ToolboxParams }>;
    outputDirOverride?: string;
    /** R-TB-LOG-V1 — tree-wide chainId; main uses it as the session
     *  log id so the entire branching lineage shares one timeline. */
    lineageChainId?: string;
    /** R-TB-LOG-V1 — display label for the log session row. */
    chainInputName?: string;
  }): Promise<{ ok: boolean; chainId: string; outputDir: string }>;
  cancelToolboxChain(chainId: string): Promise<{ ok: boolean }>;
  resumeToolboxChain(
    chainId: string,
    stepIndex: number,
    paramsPatch: Partial<ToolboxParams>
  ): Promise<{ ok: boolean }>;
  onProgress(cb: (p: TaskProgress) => void): () => void;
}

interface DbBridge {
  chainLineageNodes?: {
    listByChain(chainId: string): Promise<ChainLineageNodeRow[]>;
    upsert(row: ChainLineageNodeRow): Promise<void>;
  };
}

function getBridge(): ToolboxBridge {
  const w = window as unknown as { giftk?: ToolboxBridge };
  if (!w.giftk) throw new Error('toolbox lineage: window.giftk preload bridge missing');
  return w.giftk;
}

function getDbBridge(): DbBridge['chainLineageNodes'] | null {
  try {
    const w = window as unknown as { giftk?: { db?: DbBridge } };
    return w.giftk?.db?.chainLineageNodes ?? null;
  } catch {
    return null;
  }
}

/** Fire-and-forget upsert; never blocks the UI, never throws. */
function persistRow(row: LineageTreeNode): void {
  const repo = getDbBridge();
  if (!repo) return;
  void repo.upsert(toSqlRow(row)).catch(() => undefined);
}

/** Build a terminal-state row reusing the pending node's fixed fields. */
function buildTerminalRow(
  pending: PendingStep,
  status: ChainLineageNodeStatus,
  outputPath: string | null,
  sizeAfter: number | null,
  sizeRegressionRatio: number | null,
  sizeRegressionReverted?: boolean
): LineageTreeNode {
  return {
    nodeId: pending.nodeId,
    parentNodeId: pending.parentNodeId,
    chainId: pending.treeChainId,
    ipcChainId: pending.ipcChainId,
    kind: pending.kind,
    params: pending.params,
    inputPath: pending.inputPath,
    outputPath,
    sizeBefore: pending.sizeBefore,
    sizeAfter,
    sizeRegressionRatio,
    sizeRegressionReverted,
    status,
    createdAt: pending.createdAt,
    doneAt: Date.now()
  };
}

interface PendingStep {
  ipcChainId: string;
  treeChainId: string;
  nodeId: string;
  parentNodeId: string;
  kind: ToolboxKind;
  params: ToolboxParams;
  inputPath: string;
  sizeBefore: number | null;
  createdAt: number;
  resolve: (n: LineageNode) => void;
  reject: (err: Error) => void;
}

export function useToolboxLineage(): UseToolboxLineageResult {
  const [tree, setTree] = useState<LineageTreeNode[]>([]);
  const [chainId, setChainId] = useState<string | null>(null);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [currentProgress, setCurrentProgress] = useState<TaskProgress | null>(null);

  // Per-step IPC chainId of the in-flight runNextStep — used by cancel()
  // and the progress listener for routing. Distinct from the tree-wide
  // chainId (which never changes mid-step).
  const inflightIpcChainIdRef = useRef<string | null>(null);
  const nodeCounterRef = useRef<number>(0);
  // Stable refs for the global progress listener — useState closures
  // capture stale slices and would mis-route emits otherwise.
  const treeRef = useRef<LineageTreeNode[]>([]);
  useEffect(() => { treeRef.current = tree; }, [tree]);
  const focusNodeIdRef = useRef<string | null>(null);
  useEffect(() => { focusNodeIdRef.current = focusNodeId; }, [focusNodeId]);
  const chainIdRef = useRef<string | null>(null);
  useEffect(() => { chainIdRef.current = chainId; }, [chainId]);

  const pendingRef = useRef<PendingStep | null>(null);

  const reset = useCallback((inputPath: string): void => {
    // Stragglers: a step still in-flight when the caller resets must
    // be cancelled at the IPC layer and rejected on the JS side, or the
    // promise dangles and the main process keeps churning out an
    // orphaned artifact.
    const stragglerIpcId = inflightIpcChainIdRef.current;
    const stragglerPending = pendingRef.current;
    inflightIpcChainIdRef.current = null;
    pendingRef.current = null;
    if (stragglerIpcId) {
      try {
        const bridge = getBridge();
        void bridge.cancelToolboxChain(stragglerIpcId).catch(() => undefined);
      } catch { /* no bridge — test env */ }
    }
    if (stragglerPending) {
      const aborted = buildTerminalRow(stragglerPending, 'aborted', null, null, null);
      persistRow(aborted);
      stragglerPending.reject(new Error('lineage reset: in-flight step abandoned'));
    }

    const newChainId = makeChainId();
    const now = Date.now();
    const rootNode = makeRootNode(newChainId, inputPath, now);
    setTree([rootNode]);
    setChainId(newChainId);
    setFocusNodeId('root');
    setIsRunning(false);
    setError(null);
    setCurrentProgress(null);
    nodeCounterRef.current = 0;
    // Intentionally do NOT persist the root — see header comment.
  }, []);

  const focusNode = useCallback((nodeId: string): void => {
    setTree((prev) => {
      if (!prev.some((n) => n.nodeId === nodeId)) return prev;
      setFocusNodeId(nodeId);
      return prev;
    });
  }, []);

  // R-LINEAGE-TREE-V1 — `branchFromNode` is a semantic alias for
  // focusNode. Keeping the two names lets callers express intent
  // ("I'm forking off this node") without polluting the type system.
  const branchFromNode = focusNode;

  const cancel = useCallback(async (): Promise<void> => {
    const id = inflightIpcChainIdRef.current;
    const pending = pendingRef.current;
    if (!id) return;
    inflightIpcChainIdRef.current = null;
    pendingRef.current = null;
    setIsRunning(false);
    setCurrentProgress(null);
    try {
      const bridge = getBridge();
      await bridge.cancelToolboxChain(id);
    } catch {
      // best-effort — main process IPC may already be gone
    }
    if (pending) {
      const aborted = buildTerminalRow(pending, 'aborted', null, null, null);
      persistRow(aborted);
      // Update the in-memory node too so a future TreeView shows the
      // aborted state and the legacy `nodes` ancestor chain doesn't
      // misleadingly include a stuck 'pending' row.
      setTree((prev) => prev.map((n) => n.nodeId === pending.nodeId ? aborted : n));
      pending.reject(new Error('cancelled'));
    }
  }, []);

  // Progress listener — single global subscription per hook instance,
  // filtered by `pending.ipcChainId` so stray emits from elsewhere are
  // ignored.
  useEffect(() => {
    let bridge: ToolboxBridge;
    try {
      bridge = getBridge();
    } catch {
      // No bridge (e.g. test env without preload mock) — runNextStep
      // will surface the same error when invoked.
      return;
    }
    const off = bridge.onProgress((p: TaskProgress) => {
      const pending = pendingRef.current;
      if (!pending) return;
      if (typeof p.taskId !== 'string') return;
      // Strict equality keeps prefix-collisions impossible (R-TB-CHAIN R7).
      if (p.taskId !== `${pending.ipcChainId}-s1`) return;
      handleProgressEmit(p, pending);
    });
    return () => { off(); };
    // The handler closes over local setters which are stable across
    // renders, so we don't list them in deps. The pending lookup goes
    // through the ref and is always current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function clearInflight(): void {
    pendingRef.current = null;
    inflightIpcChainIdRef.current = null;
    setIsRunning(false);
  }

  function handleProgressEmit(p: TaskProgress, pending: PendingStep): void {
    const status = p.status;
    if (status === 'done') {
      handleDoneEmit(p, pending);
    } else if (status === 'failed' || status === 'cancelled') {
      handleFailureEmit(p, pending, status);
    } else if (status === 'awaiting-input') {
      handleAwaitingInputEmit(p, pending);
    } else {
      // Intermediate status — just stash the latest snapshot for the UI.
      setCurrentProgress(p);
    }
  }

  function handleDoneEmit(p: TaskProgress, pending: PendingStep): void {
    const out = (p.outputs ?? [])[0];
    if (!out) {
      const failed = buildTerminalRow(pending, 'failed', null, null, null);
      persistRow(failed);
      setTree((prev) => prev.map((n) => n.nodeId === pending.nodeId ? failed : n));
      pending.reject(new Error('done emit had no outputs'));
      clearInflight();
      setCurrentProgress(null);
      setError('done emit had no outputs');
      return;
    }
    const reg = p.sizeRegression;
    const sizeAfter = typeof reg?.afterBytes === 'number' ? reg.afterBytes : null;
    const sizeBefore = typeof reg?.beforeBytes === 'number' ? reg.beforeBytes : pending.sizeBefore;
    const ratio = typeof reg?.ratio === 'number'
      ? reg.ratio
      : (sizeAfter && sizeBefore && sizeBefore > 0 ? sizeAfter / sizeBefore : null);
    // R-SIZE-REGRESSION-REVERT-V1 — main emits substep
    // 'size-regression-reverted' (and/or sizeRegression.reverted=true)
    // when it detected a regression and auto-copied the input as the
    // output. Surface that as a renderer-only flag so the tree view
    // can paint an amber "auto-reverted" badge instead of (or before)
    // the red ⚠️.
    const reverted = reg?.reverted === true || p.substep === 'size-regression-reverted';
    const doneRow: LineageTreeNode = {
      ...buildTerminalRow(pending, 'done', out, sizeAfter, ratio, reverted || undefined),
      sizeBefore
    };
    persistRow(doneRow);
    // Update the existing pending node in place (do NOT append) so the
    // tree shape stays stable across the pending → done transition.
    setTree((prev) => prev.map((n) => n.nodeId === pending.nodeId ? doneRow : n));
    setFocusNodeId(pending.nodeId);
    // R-SIZE-REGRESSION-V1 — keep the last frame visible so the row
    // badge persists across the run. Also keep it when the step was
    // auto-reverted so the progress row's amber badge survives.
    setCurrentProgress(p.sizeRegression || reverted ? p : null);
    clearInflight();
    pending.resolve(asLineageNode(doneRow));
  }

  function handleFailureEmit(
    p: TaskProgress,
    pending: PendingStep,
    status: 'failed' | 'cancelled'
  ): void {
    const msg = p.error ?? `step ${status}`;
    const finalStatus: ChainLineageNodeStatus = status === 'failed' ? 'failed' : 'aborted';
    const failed = buildTerminalRow(pending, finalStatus, null, null, null);
    persistRow(failed);
    setTree((prev) => prev.map((n) => n.nodeId === pending.nodeId ? failed : n));
    pending.reject(new Error(msg));
    clearInflight();
    setCurrentProgress(null);
    setError(msg);
  }

  function handleAwaitingInputEmit(p: TaskProgress, pending: PendingStep): void {
    // R-TB-CHAIN-LINEAGE-RESUME-V1 — auto-resume on PAUSING_KINDS.
    // The lineage modal bakes crop rect into params before the IPC
    // fires, so we never need a follow-up UI gate.
    const pendingIpcId = pending.ipcChainId;
    let bridge2: ToolboxBridge | null = null;
    try { bridge2 = getBridge(); } catch { bridge2 = null; }
    if (bridge2) {
      const wireIdx = typeof p.stepIndex === 'number' ? p.stepIndex : 1;
      const zeroBased = Math.max(0, wireIdx - 1);
      bridge2.resumeToolboxChain(pendingIpcId, zeroBased, {}).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        const cur = pendingRef.current;
        if (cur && cur.ipcChainId === pendingIpcId) {
          cur.reject(new Error(`resume failed: ${msg}`));
          pendingRef.current = null;
        }
        if (inflightIpcChainIdRef.current === pendingIpcId) {
          inflightIpcChainIdRef.current = null;
        }
        setIsRunning(false);
        setCurrentProgress(null);
        setError(`resume failed: ${msg}`);
      });
    }
    setCurrentProgress(p);
  }

  const runNextStep = useCallback(
    async (kind: ToolboxKind, params: ToolboxParams): Promise<LineageNode> => {
      if (pendingRef.current) {
        const e = new Error('step already running');
        setError(e.message);
        throw e;
      }
      const focusId = focusNodeIdRef.current;
      const focusNodeOnTree = focusId ? treeRef.current.find((n) => n.nodeId === focusId) ?? null : null;
      const treeChainId = chainIdRef.current;
      if (!focusNodeOnTree || !treeChainId) {
        const e = new Error('lineage not initialised: call reset(inputPath) first');
        setError(e.message);
        throw e;
      }
      const ipcChainId = makeIpcChainId();
      const stepId = `${ipcChainId}-s1`;
      nodeCounterRef.current += 1;
      const nodeId = `n-${treeChainId.slice(-6)}-${nodeCounterRef.current}`;
      const focusPath = focusNodeOnTree.outputPath ?? focusNodeOnTree.inputPath;
      const createdAt = Date.now();

      const pendingNode: LineageTreeNode = {
        nodeId,
        parentNodeId: focusNodeOnTree.nodeId,
        chainId: treeChainId,
        ipcChainId,
        kind,
        params,
        inputPath: focusPath,
        outputPath: null,
        sizeBefore: null,
        sizeAfter: null,
        sizeRegressionRatio: null,
        status: 'pending',
        createdAt,
        doneAt: null
      };

      setError(null);
      setIsRunning(true);
      setCurrentProgress(null);
      // Insert the pending node into the tree immediately so the UI
      // can render a 'pending' indicator without waiting for the IPC
      // round-trip. Stable createdAt-asc ordering helps TreeView
      // render left-to-right deterministically.
      setTree((prev) => [...prev, pendingNode]);
      persistRow(pendingNode);
      inflightIpcChainIdRef.current = ipcChainId;

      let localReject: ((e: Error) => void) | null = null;
      const promise = new Promise<LineageNode>((resolve, reject) => {
        localReject = reject as (e: Error) => void;
        pendingRef.current = {
          ipcChainId,
          treeChainId,
          nodeId,
          parentNodeId: focusNodeOnTree.nodeId,
          kind,
          params,
          inputPath: focusPath,
          sizeBefore: null,
          createdAt,
          resolve,
          reject
        };
      });
      try {
        const bridge = getBridge();
        // R-TB-LOG-V1 — pass the tree-wide chainId so main keeps the
        // whole branching lineage on a single session log timeline.
        // chainInputName is the leaf basename of the focused input
        // path; trims any URL noise to a stable display label.
        const fileBaseName = focusPath.split(/[/\\]/).pop() || focusPath;
        await bridge.startToolboxChain({
          chainId: ipcChainId,
          inputPath: focusPath,
          steps: [{ id: stepId, kind, params }],
          lineageChainId: treeChainId,
          chainInputName: fileBaseName
        });
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        const pending = pendingRef.current as PendingStep | null;
        if (pending && pending.ipcChainId === ipcChainId) {
          pendingRef.current = null;
        }
        if (inflightIpcChainIdRef.current === ipcChainId) {
          inflightIpcChainIdRef.current = null;
        }
        // Synchronous IPC veto — flip the just-inserted pending row to
        // failed so disk + memory both reflect the unrecoverable state.
        const failedRow: LineageTreeNode = {
          ...pendingNode,
          status: 'failed',
          doneAt: Date.now()
        };
        persistRow(failedRow);
        setTree((prev) => prev.map((n) => n.nodeId === nodeId ? failedRow : n));
        setIsRunning(false);
        setCurrentProgress(null);
        setError(e.message);
        const reject = localReject as ((e: Error) => void) | null;
        if (reject) reject(e);
        throw e;
      }
      return promise;
    },
    []
  );

  const hydrateFromChain = useCallback(async (cid: string): Promise<void> => {
    const repo = getDbBridge();
    if (!repo) return;
    let rows: ChainLineageNodeRow[];
    try {
      rows = await repo.listByChain(cid);
    } catch {
      return;
    }
    if (!rows || rows.length === 0) return;
    const projected = rows.map(fromSqlRow);
    // createdAt-asc ordering — deterministic and matches runNextStep insert.
    projected.sort((a, b) => a.createdAt - b.createdAt);
    // Root is intentionally NOT persisted to sqlite (see runNextStep /
    // reset header comment), so hydrate must synthesise one or the
    // TreeView has no anchor to render from. We rebuild root from the
    // earliest persisted row's inputPath (== root.inputPath, root being
    // a no-op pass-through).
    const earliest = projected[0];
    const rootCreatedAt = Math.max(0, earliest.createdAt - 1);
    const rootNode = makeRootNode(cid, earliest.inputPath, rootCreatedAt);
    const treeWithRoot = [rootNode, ...projected];
    const focusPick = pickHydrateFocus(projected);
    setTree(treeWithRoot);
    setChainId(cid);
    setFocusNodeId(focusPick ? focusPick.nodeId : 'root');
    setIsRunning(false);
    setError(null);
    setCurrentProgress(null);
    // Re-seed the local id counter so future runNextStep ids don't
    // collide with what's already on disk. Best-effort — unknown
    // formats start fresh from N+1.
    nodeCounterRef.current = maxNumericSuffix(projected);
  }, []);

  // Derived views — `nodes` and `pathToFocus` are the same data
  // (root → focus chain). The flat `tree` field is exposed
  // undecorated (no path getter, no chainId override) so new
  // TreeView consumers see the SQL-shaped row directly.
  const pathToFocus = useMemo<LineageTreeNode[]>(
    () => ancestorsTo(tree, focusNodeId),
    [tree, focusNodeId]
  );
  const nodes = useMemo<LineageNode[]>(
    () => pathToFocus.map((n) => asLineageNode(n)),
    [pathToFocus]
  );
  const focusIndex = useMemo<number>(() => {
    if (!focusNodeId) return -1;
    return nodes.findIndex((n) => n.nodeId === focusNodeId);
  }, [nodes, focusNodeId]);
  const focus = focusIndex >= 0 && focusIndex < nodes.length ? nodes[focusIndex] : null;
  const nextKindOptions = useMemo(
    () => deriveNextKinds(focus ? focus.path : null),
    [focus]
  );

  return {
    nodes, focusIndex, focus, isRunning, error,
    reset, focusNode, runNextStep, cancel,
    nextKindOptions, currentProgress,
    tree, chainId, focusNodeId, pathToFocus,
    hydrateFromChain, branchFromNode
  };
}
