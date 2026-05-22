/**
 * R-LINEAGE-TREE-V1 — Persistence layer for the toolbox-chain
 * lineage tree. Backs the `chain_lineage_nodes` SQLite table
 * (DDL in [schema.ts](../schema.ts)).
 *
 * Domain model
 * ------------
 * A "lineage" is a directed tree of toolbox steps rooted at the
 * chain's input file. Each row in this table is one node:
 *
 *   - `nodeId`         — stable UUID (primary key).
 *   - `chainId`        — logical chain this node belongs to. The renderer
 *                        renders one tree per chainId.
 *   - `parentNodeId`   — points back into the same `chainId`; NULL marks
 *                        the root (the original input). Branching = two
 *                        children share a parent.
 *   - `kind` / `params` — which toolbox tool produced the node, plus its
 *                        params. `params` is stringified JSON on disk and
 *                        round-tripped via `parseJsonOrDefault` on read so
 *                        a tampered row never crashes the renderer.
 *   - `sizeBefore` / `sizeAfter` / `sizeRegressionRatio` — byte-level
 *                        regression metrics so the UI can flag a step that
 *                        produced a *bigger* output than its input.
 *   - `status`         — pending / done / failed / aborted (full lifecycle
 *                        owned by the chain runner; renderer is read-only
 *                        in steady state).
 *
 * API surface
 * -----------
 *   - `listByChain(chainId)`  → all nodes in a single chain (no order
 *                               guarantee — caller builds the tree from
 *                               `parentNodeId`).
 *   - `listChainIds()`        → distinct `chain_id` list, most-recent-first
 *                               by `MAX(createdAt)` so the picker sidebar
 *                               surfaces the latest chains at the top.
 *   - `upsert(row)`           → insert-or-update by `nodeId`. The chain
 *                               runner calls this on every status change.
 *   - `removeByChain(id)`     → drop one whole chain's nodes (used by the
 *                               renderer's "delete this chain" affordance).
 *   - `clear()`               → wipe the table (debug / "clear all
 *                               lineage" maintenance action).
 *
 * Style note: this repo follows the conventions established in
 * [toolboxChainHistoryRepo.ts](./toolboxChainHistoryRepo.ts) — local
 * `DbRow` interface, prepared statements created at construct time,
 * `ON CONFLICT(node_id) DO UPDATE` for upsert, and `parseJsonOrDefault`
 * for defensive JSON reads.
 */

import type Database from 'better-sqlite3';
import type {
  ChainLineageNodeRow,
  ChainLineageNodeStatus
} from '../../../shared/types';

interface DbRow {
  node_id: string;
  chain_id: string;
  parent_node_id: string | null;
  kind: string | null;
  params_json: string;
  input_path: string;
  output_path: string | null;
  size_before: number | null;
  size_after: number | null;
  size_regression_ratio: number | null;
  status: string;
  created_at: number;
  done_at: number | null;
}

function parseJsonOrDefault<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    const v = JSON.parse(s);
    return v === null ? fallback : (v as T);
  } catch {
    return fallback;
  }
}

const VALID_STATUS: ReadonlySet<string> = new Set<ChainLineageNodeStatus>([
  'pending',
  'done',
  'failed',
  'aborted'
]);

/**
 * Defensive coercion: rows may have been written by an older / tampered
 * build. Anything that doesn't match the runtime contract is dropped
 * (returns null) so the renderer never sees an invalid status token.
 */
function rowToEntry(r: DbRow): ChainLineageNodeRow | null {
  if (!VALID_STATUS.has(r.status)) return null;
  const params = parseJsonOrDefault<Record<string, unknown>>(r.params_json, {});
  return {
    nodeId: r.node_id,
    chainId: r.chain_id,
    parentNodeId: r.parent_node_id,
    kind: r.kind,
    params: params && typeof params === 'object' && !Array.isArray(params) ? params : {},
    inputPath: r.input_path,
    outputPath: r.output_path,
    sizeBefore: r.size_before,
    sizeAfter: r.size_after,
    sizeRegressionRatio: r.size_regression_ratio,
    status: r.status as ChainLineageNodeStatus,
    createdAt: r.created_at,
    doneAt: r.done_at
  };
}

export type { ChainLineageNodeRow };

export interface ChainLineageNodesRepo {
  listByChain(chainId: string): ChainLineageNodeRow[];
  listChainIds(): string[];
  upsert(row: ChainLineageNodeRow): void;
  removeByChain(chainId: string): void;
  clear(): void;
}

export function createChainLineageNodesRepo(db: Database.Database): ChainLineageNodesRepo {
  const selectByChain = db.prepare<[string], DbRow>(
    `SELECT node_id, chain_id, parent_node_id, kind, params_json, input_path,
            output_path, size_before, size_after, size_regression_ratio,
            status, created_at, done_at
       FROM chain_lineage_nodes
      WHERE chain_id = ?`
  );
  const selectChainIds = db.prepare<[], { chain_id: string }>(
    'SELECT chain_id FROM chain_lineage_nodes GROUP BY chain_id ORDER BY MAX(created_at) DESC'
  );
  const upsertStmt = db.prepare(
    `INSERT INTO chain_lineage_nodes (
       node_id, chain_id, parent_node_id, kind, params_json, input_path,
       output_path, size_before, size_after, size_regression_ratio,
       status, created_at, done_at
     ) VALUES (
       @node_id, @chain_id, @parent_node_id, @kind, @params_json, @input_path,
       @output_path, @size_before, @size_after, @size_regression_ratio,
       @status, @created_at, @done_at
     )
     ON CONFLICT(node_id) DO UPDATE SET
       chain_id = excluded.chain_id,
       parent_node_id = excluded.parent_node_id,
       kind = excluded.kind,
       params_json = excluded.params_json,
       input_path = excluded.input_path,
       output_path = excluded.output_path,
       size_before = excluded.size_before,
       size_after = excluded.size_after,
       size_regression_ratio = excluded.size_regression_ratio,
       status = excluded.status,
       created_at = excluded.created_at,
       done_at = excluded.done_at`
  );
  const removeByChainStmt = db.prepare('DELETE FROM chain_lineage_nodes WHERE chain_id = ?');
  const clearStmt = db.prepare('DELETE FROM chain_lineage_nodes');

  function rowToParams(r: ChainLineageNodeRow): Record<string, string | number | null> {
    return {
      node_id: r.nodeId,
      chain_id: r.chainId,
      parent_node_id: r.parentNodeId ?? null,
      kind: r.kind ?? null,
      params_json: JSON.stringify(r.params && typeof r.params === 'object' ? r.params : {}),
      input_path: r.inputPath,
      output_path: r.outputPath ?? null,
      size_before: r.sizeBefore ?? null,
      size_after: r.sizeAfter ?? null,
      size_regression_ratio: r.sizeRegressionRatio ?? null,
      status: r.status,
      created_at: r.createdAt,
      done_at: r.doneAt ?? null
    };
  }

  return {
    listByChain(chainId) {
      const out: ChainLineageNodeRow[] = [];
      for (const r of selectByChain.all(chainId)) {
        const e = rowToEntry(r);
        if (e) out.push(e);
      }
      return out;
    },
    listChainIds() {
      return selectChainIds.all().map((r) => r.chain_id);
    },
    upsert(row) {
      upsertStmt.run(rowToParams(row));
    },
    removeByChain(chainId) {
      removeByChainStmt.run(chainId);
    },
    clear() {
      clearStmt.run();
    }
  };
}
