/**
 * R-LINEAGE-TREE-V1 — Window bridge helpers extracted from
 * [useToolboxLineage.ts](./useToolboxLineage.ts).
 *
 * Why a separate file
 * -------------------
 * useToolboxLineage.ts crossed the eslint `max-lines: 600` ceiling
 * after a series of R-COMPRESS-V1 / sizeRegression.reverted additions.
 * The pure-tree helpers in [useToolboxLineageHelpers.ts](./useToolboxLineageHelpers.ts)
 * are deliberately window-free; the bridge wiring (preload IPC,
 * SQLite-via-IPC, fire-and-forget upsert) lives here so the hook
 * itself stays focused on stateful orchestration.
 *
 * Everything in this module assumes a renderer environment (uses
 * `window.giftk`); the tree helpers stay node-runnable for unit tests.
 */
import type { ToolboxKind, ToolboxParams, TaskProgress } from '../../shared/types';
import type {
  ChainLineageNodeRow,
  ChainLineageNodeStatus
} from '../../shared/types/chainLineage';
import { type LineageTreeNode, toSqlRow } from './useToolboxLineageHelpers';

export interface ToolboxBridge {
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

export interface DbBridge {
  chainLineageNodes?: {
    listByChain(chainId: string): Promise<ChainLineageNodeRow[]>;
    upsert(row: ChainLineageNodeRow): Promise<void>;
  };
}

export function getBridge(): ToolboxBridge {
  const w = window as unknown as { giftk?: ToolboxBridge };
  if (!w.giftk) throw new Error('toolbox lineage: window.giftk preload bridge missing');
  return w.giftk;
}

export function getDbBridge(): DbBridge['chainLineageNodes'] | null {
  try {
    const w = window as unknown as { giftk?: { db?: DbBridge } };
    return w.giftk?.db?.chainLineageNodes ?? null;
  } catch {
    return null;
  }
}

/** Fire-and-forget upsert; never blocks the UI, never throws. */
export function persistRow(row: LineageTreeNode): void {
  const repo = getDbBridge();
  if (!repo) return;
  void repo.upsert(toSqlRow(row)).catch(() => undefined);
}

export interface PendingStep {
  ipcChainId: string;
  treeChainId: string;
  nodeId: string;
  parentNodeId: string;
  kind: ToolboxKind;
  params: ToolboxParams;
  inputPath: string;
  sizeBefore: number | null;
  createdAt: number;
  resolve: (n: import('./useToolboxLineageHelpers').LineageNode) => void;
  reject: (err: Error) => void;
}

/** Build a terminal-state row reusing the pending node's fixed fields. */
export function buildTerminalRow(
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
