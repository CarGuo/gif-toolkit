/**
 * R-LINEAGE-TREE-V1 — Renderer-facing row shape for the
 * `chain_lineage_nodes` SQLite table. One row is one toolbox-chain
 * step in a tree rooted at the chain's input file: `parentNodeId`
 * points to another node within the same `chainId` (NULL for the
 * root step). The renderer reads these via
 * `window.giftk.db.chainLineageNodes.*` to render the lineage tree
 * panel.
 *
 * Naming note: snake_case columns in SQL are projected to camelCase
 * here so the renderer never deals with raw row dicts. The
 * persistence layer (`chainLineageNodesRepo`) does the translation
 * on the way in/out.
 */

/**
 * Lifecycle status of a single lineage node.
 *
 * - `'pending'`  — created, not yet executed (queued / awaiting input).
 * - `'done'`     — step succeeded; `outputPath` populated.
 * - `'failed'`   — step threw / non-zero exit; `outputPath` may be null.
 * - `'aborted'`  — user-cancelled (chain cancelled mid-flight).
 */
export type ChainLineageNodeStatus = 'pending' | 'done' | 'failed' | 'aborted';

export interface ChainLineageNodeRow {
  /** Stable per-node id (UUID). PRIMARY KEY in SQL. */
  nodeId: string;
  /** Logical chain this node belongs to. Multiple nodes share a chainId. */
  chainId: string;
  /** Parent step in the same chain; NULL for the root. */
  parentNodeId: string | null;
  /** Toolbox kind that produced this node (null for the synthetic root). */
  kind: string | null;
  /** Tool params used to run this step. Free-form JSON; defaults to `{}`. */
  params: Record<string, unknown>;
  /** Absolute path of the input file fed into this step. */
  inputPath: string;
  /** Absolute path of the produced output file; null while pending / on failure. */
  outputPath: string | null;
  /** Bytes of `inputPath` when the step started. Null if not yet measured. */
  sizeBefore: number | null;
  /** Bytes of `outputPath` when the step settled. Null if not yet measured. */
  sizeAfter: number | null;
  /** sizeAfter / sizeBefore. Null when either side is missing or zero. */
  sizeRegressionRatio: number | null;
  status: ChainLineageNodeStatus;
  /** Epoch ms when the row was first inserted. */
  createdAt: number;
  /** Epoch ms when status moved out of `'pending'`. Null while pending. */
  doneAt: number | null;
}
