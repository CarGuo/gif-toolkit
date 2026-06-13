/**
 * R-LINEAGE-TREE-V1 — pure helpers extracted from useToolboxLineage.
 *
 * Why a separate file
 * -------------------
 * The hook itself is mostly side-effect orchestration (refs, state,
 * IPC listener). The pure pieces — id generation, ext sniffing,
 * ancestor walks, row decoration, persistence projection — have no
 * React or window dependency and are individually unit-testable. We
 * pull them out so:
 *
 *   1. The main hook file stays under the 500-LOC architectural
 *      ceiling.
 *   2. Future tests can exercise these helpers in isolation without
 *      mounting a hook.
 *   3. New consumers (e.g. the upcoming ToolboxLineageTreeView) can
 *      reuse `ancestorsTo` / `asLineageNode` without importing the
 *      hook (which carries IPC bridge side effects).
 */
import type { ToolboxKind, ToolboxParams } from '../../shared/types';
import { TOOLBOX_INPUT_EXTENSIONS } from '../../shared/types/toolbox';
import type { ChainLineageNodeRow } from '../../shared/types/chainLineage';

export interface LineageTreeNode {
  nodeId: string;
  parentNodeId: string | null;
  chainId: string;
  kind: ToolboxKind | null;
  params: ToolboxParams;
  inputPath: string;
  outputPath: string | null;
  sizeBefore: number | null;
  sizeAfter: number | null;
  sizeRegressionRatio: number | null;
  /**
   * R-SIZE-REGRESSION-REVERT-V1 — renderer-only flag indicating the
   * main process detected a size regression and **auto-reverted** the
   * step's output to the input bytes (i.e. the step was a no-op for
   * the user). When true the lineage UI should surface an amber
   * "auto-reverted" badge instead of the red ⚠️, even though
   * `sizeRegressionRatio` will be ~1.0 (since after≈before). NOT
   * persisted to SQLite — sourced from the terminal `done` progress
   * emit (`TaskProgress.sizeRegression.reverted` or
   * `substep === 'size-regression-reverted'`).
   */
  sizeRegressionReverted?: boolean;
  status: ChainLineageNodeRow['status'];
  createdAt: number;
  doneAt: number | null;
  /**
   * Per-step IPC chainId (`startToolboxChain` payload.chainId) used to
   * route progress events for a single step. NOT persisted to SQLite —
   * this is renderer-only metadata. Distinct from `chainId`, which is
   * the tree-wide stable id all nodes in the same lineage share.
   *
   * Kept on the node for backward compatibility: pre-tree consumers
   * (and the unit-test suite) read `node.chainId` expecting the IPC
   * id they used to start the step. The legacy `LineageNode` alias
   * projects this field onto its `chainId` getter.
   */
  ipcChainId?: string | null;
}

/**
 * Legacy alias retained for ToolboxLineageModal and existing tests.
 * `path` (= `outputPath ?? inputPath`) and `chainId` (widened to
 * `string | null` so the synthetic root can preserve null) are
 * decorations applied by `asLineageNode`.
 */
export type LineageNode = Omit<LineageTreeNode, 'chainId'> & {
  readonly path: string;
  readonly chainId: string | null;
};

/** Tree-wide stable id; one per `reset()` call. */
export function makeChainId(): string {
  return `tblineage-tree-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Per-step IPC chainId; distinct from the tree-wide chainId. */
export function makeIpcChainId(): string {
  return `tblineage-ipc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Lowercase extension including dot, or '' when path has none. */
export function extOf(p: string): string {
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  const base = slash >= 0 ? p.slice(slash + 1) : p;
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot).toLowerCase() : '';
}

export function deriveNextKinds(focusPath: string | null): ToolboxKind[] {
  if (!focusPath) return [];
  const ext = extOf(focusPath);
  if (!ext) return [];
  const out: ToolboxKind[] = [];
  for (const k of Object.keys(TOOLBOX_INPUT_EXTENSIONS) as ToolboxKind[]) {
    if (TOOLBOX_INPUT_EXTENSIONS[k].includes(ext)) out.push(k);
  }
  return out;
}

/** Wrap a tree node so legacy `path` / `chainId` access keeps working.
 *
 * Returns a fresh object whose own enumerable properties are the
 * tree node's, plus a `path` getter (= `outputPath ?? inputPath`).
 * The `chainId` field is rewritten:
 *   - root          → null   (legacy "synthetic root has no chain" contract)
 *   - other nodes   → ipcChainId, falling back to the tree chainId.
 *
 * The IPC override exists for callers who started a single step with
 * `startToolboxChain({ chainId: <ipcId> })` and expect the produced
 * node to carry the same id. The flat `tree` field is exposed
 * undecorated, so new TreeView consumers see the SQL-shaped row
 * (`chainId` = tree-wide, `ipcChainId` = per-step).
 */
export function asLineageNode(n: LineageTreeNode): LineageNode {
  const isRoot = n.parentNodeId == null && n.nodeId === 'root';
  let projectedChainId: string | null;
  if (isRoot) {
    projectedChainId = null;
  } else if (typeof n.ipcChainId === 'string') {
    projectedChainId = n.ipcChainId;
  } else {
    projectedChainId = n.chainId;
  }
  const wrapped = {
    ...n,
    chainId: projectedChainId
  };
  Object.defineProperty(wrapped, 'path', {
    get(this: LineageTreeNode) { return this.outputPath ?? this.inputPath; },
    enumerable: true,
    configurable: false
  });
  return wrapped as LineageNode;
}

/** Build the root-to-focus ancestor chain from a flat tree.
 *
 * Walks `parentNodeId` upward from the focus node, collecting every
 * ancestor (focus included) into an array, then reverses so the
 * caller sees `[root, ..., focus]`. Tolerates a corrupt tree (missing
 * parent / cycle) by short-circuiting on first repeat or first
 * unresolved parent — the partial chain is still useful for the UI.
 */
export function ancestorsTo(
  tree: readonly LineageTreeNode[],
  focusNodeId: string | null
): LineageTreeNode[] {
  if (!focusNodeId) return [];
  const byId = new Map<string, LineageTreeNode>();
  for (const n of tree) byId.set(n.nodeId, n);
  const out: LineageTreeNode[] = [];
  let cur: LineageTreeNode | undefined = byId.get(focusNodeId);
  const seen = new Set<string>();
  while (cur) {
    if (seen.has(cur.nodeId)) break;
    seen.add(cur.nodeId);
    out.push(cur);
    if (cur.parentNodeId == null) break;
    cur = byId.get(cur.parentNodeId);
  }
  return out.reverse();
}

/** Project a LineageTreeNode into the SQL row shape. */
export function toSqlRow(row: LineageTreeNode): ChainLineageNodeRow {
  return {
    nodeId: row.nodeId,
    chainId: row.chainId,
    parentNodeId: row.parentNodeId,
    kind: row.kind,
    params: row.params as Record<string, unknown>,
    inputPath: row.inputPath,
    outputPath: row.outputPath,
    sizeBefore: row.sizeBefore,
    sizeAfter: row.sizeAfter,
    sizeRegressionRatio: row.sizeRegressionRatio,
    status: row.status,
    createdAt: row.createdAt,
    doneAt: row.doneAt
  };
}

/** Project a SQL row back into a LineageTreeNode. */
export function fromSqlRow(r: ChainLineageNodeRow): LineageTreeNode {
  return {
    nodeId: r.nodeId,
    parentNodeId: r.parentNodeId,
    chainId: r.chainId,
    kind: (r.kind as ToolboxKind | null) ?? null,
    params: r.params as ToolboxParams,
    inputPath: r.inputPath,
    outputPath: r.outputPath,
    sizeBefore: r.sizeBefore,
    sizeAfter: r.sizeAfter,
    sizeRegressionRatio: r.sizeRegressionRatio,
    status: r.status,
    createdAt: r.createdAt,
    doneAt: r.doneAt
  };
}

/**
 * Pick the focus node when rehydrating from disk. Prefer the most
 * recently-completed leaf so the user lands on the freshest result;
 * fall back to the deepest leaf, then to the root, so a chain that
 * never finished still gets a sensible focus.
 */
export function pickHydrateFocus(projected: LineageTreeNode[]): LineageTreeNode | null {
  if (projected.length === 0) return null;
  const childCount = new Map<string, number>();
  for (const n of projected) {
    if (n.parentNodeId) childCount.set(n.parentNodeId, (childCount.get(n.parentNodeId) ?? 0) + 1);
  }
  const leaves = projected.filter((n) => (childCount.get(n.nodeId) ?? 0) === 0);
  const doneLeaves = leaves.filter((n) => n.status === 'done');
  if (doneLeaves.length > 0) {
    return doneLeaves.reduce((a, b) => (b.doneAt ?? b.createdAt) > (a.doneAt ?? a.createdAt) ? b : a);
  }
  if (leaves.length > 0) {
    return leaves.reduce((a, b) => b.createdAt > a.createdAt ? b : a);
  }
  return projected.find((n) => n.parentNodeId == null) ?? projected[0];
}

/** Highest numeric suffix across `n-...-N` style ids; used to
 *  re-seed the runNextStep counter after `hydrateFromChain`. */
export function maxNumericSuffix(nodes: readonly LineageTreeNode[]): number {
  let m = 0;
  for (const n of nodes) {
    const match = /-(\d+)$/.exec(n.nodeId);
    if (match) {
      const v = Number(match[1]);
      if (Number.isFinite(v) && v > m) m = v;
    }
  }
  return m;
}

/**
 * Synthesize the implicit root node. Root is intentionally NOT
 * persisted to sqlite (see runNextStep header comment), so both
 * `reset()` and `hydrateFromChain()` rebuild it locally from the
 * known inputPath. Keeping the constructor here keeps the hook
 * itself tight and ensures both code paths produce identical rows.
 */
export function makeRootNode(
  chainId: string,
  inputPath: string,
  createdAt: number
): LineageTreeNode {
  return {
    nodeId: 'root',
    parentNodeId: null,
    chainId,
    kind: null,
    params: {},
    inputPath,
    outputPath: null,
    sizeBefore: null,
    sizeAfter: null,
    sizeRegressionRatio: null,
    status: 'done',
    createdAt,
    doneAt: createdAt
  };
}
