/**
 * R-80 — DDL strings for the four history tables (history /
 * upload_history / sniff_history / toolbox_history) plus the
 * shared `schema_meta` book-keeping table.
 *
 * Why DDL is co-located here (instead of inside migrations.ts):
 * - The v0 → v1 migrator for every table is literally "create the
 *   table". Keeping the canonical CREATE TABLE strings here lets
 *   the migrations runner reuse them and lets repo unit tests open
 *   an in-memory DB against the *current* head schema without
 *   playing back the whole upgrade log.
 * - Subsequent breaking changes (rename / drop) MUST be expressed
 *   as a separate migrator step in migrations.ts, NOT by editing
 *   the strings here. After such a change, this file is updated to
 *   reflect the *new* head schema so fresh installs skip straight
 *   there.
 *
 * One file family / table mapping:
 *   - 'history'         → useHistory          (processing sessions)
 *   - 'upload_history'  → useUploadHistory    (R-45 uploader)
 *   - 'sniff_history'   → useSniffHistory     (recent URLs)
 *   - 'toolbox_history' → useToolbox          (R-39 toolbox jobs)
 *
 * Ordering note: foreign keys point from upload_history_items into
 * upload_history, so creating tables in the array order below
 * keeps the FK target valid. SQLite is lenient (FK to a not-yet-
 * created table is fine until enforcement runs) but we still order
 * deterministically for clarity.
 */

export const SCHEMA_META_DDL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);
` as const;

export const HISTORY_DDL = `
CREATE TABLE IF NOT EXISTS history (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  page_url TEXT NOT NULL DEFAULT '',
  title TEXT,
  output_dir TEXT,
  items_json TEXT NOT NULL,
  options_json TEXT NOT NULL,
  outputs_json TEXT NOT NULL DEFAULT '{}',
  status_json TEXT NOT NULL DEFAULT '{}',
  uploads_json TEXT NOT NULL DEFAULT '{}',
  /* R-X — link to session_logs.session_id so the history detail
     panel can pull the full sniff→process→upload session log.
     Nullable so legacy rows imported pre-R-X stay valid. */
  session_id TEXT
);
CREATE INDEX IF NOT EXISTS history_created_idx ON history(created_at DESC);
CREATE INDEX IF NOT EXISTS history_page_url_idx ON history(page_url);
CREATE INDEX IF NOT EXISTS history_session_idx ON history(session_id);
` as const;

export const UPLOAD_HISTORY_DDL = `
CREATE TABLE IF NOT EXISTS upload_history (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  backend TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS upload_history_created_idx ON upload_history(created_at DESC);

CREATE TABLE IF NOT EXISTS upload_history_items (
  job_id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES upload_history(id) ON DELETE CASCADE,
  file_path TEXT,
  file_name TEXT,
  status TEXT,
  url TEXT,
  markdown TEXT,
  error TEXT,
  bytes_total INTEGER,
  percent INTEGER,
  file_hash TEXT,
  reused INTEGER,
  position INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS upload_history_items_rid_idx ON upload_history_items(record_id, position);
CREATE INDEX IF NOT EXISTS upload_history_items_hash_idx ON upload_history_items(file_hash);
` as const;

export const SNIFF_HISTORY_DDL = `
CREATE TABLE IF NOT EXISTS sniff_history (
  url TEXT PRIMARY KEY,
  title TEXT,
  ts INTEGER NOT NULL,
  item_count INTEGER
);
CREATE INDEX IF NOT EXISTS sniff_history_ts_idx ON sniff_history(ts DESC);
` as const;

export const TOOLBOX_HISTORY_DDL = `
CREATE TABLE IF NOT EXISTS toolbox_history (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  input_path TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  finished_at INTEGER NOT NULL,
  outputs_json TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS toolbox_history_finished_idx ON toolbox_history(finished_at DESC);
` as const;

/**
 * R-TB-CHAIN — independent table for single-input toolbox chains.
 * Kept separate from `toolbox_history` (per the "独立 SQLite 表"
 * decision) because a chain has fundamentally different semantics:
 * it's one logical run with N audited steps, not a flat job. The
 * full per-step audit trail (kind / params / status / outputs / error)
 * lives in `steps_json` so we don't need a child table — chains are
 * append-only and the renderer always reads the whole row.
 */
export const TOOLBOX_CHAIN_HISTORY_DDL = `
CREATE TABLE IF NOT EXISTS toolbox_chain_history (
  id TEXT PRIMARY KEY,
  input_path TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  output_dir TEXT NOT NULL,
  finished_at INTEGER NOT NULL,
  steps_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS toolbox_chain_history_finished_idx ON toolbox_chain_history(finished_at DESC);
` as const;

/**
 * R-LINEAGE-TREE-V1 — persistent lineage tree for toolbox chains.
 * Each row is one chain step (a "node") in a directed tree rooted
 * at the chain's input file. `parent_node_id` references another
 * node within the same `chain_id`, NULL for roots. We index on
 * (chain_id) for whole-chain reads and on (chain_id, parent_node_id)
 * for child lookups when rendering the tree view.
 *
 * Independent table from `toolbox_chain_history` (which keeps the
 * flat per-chain audit row) because lineage nodes are per-step and
 * outlive a single chain run — branching / re-runs append new nodes
 * with the same chain_id but different parent_node_ids.
 */
export const CHAIN_LINEAGE_NODES_DDL = `
CREATE TABLE IF NOT EXISTS chain_lineage_nodes (
  node_id TEXT PRIMARY KEY,
  chain_id TEXT NOT NULL,
  parent_node_id TEXT,
  kind TEXT,
  params_json TEXT NOT NULL DEFAULT '{}',
  input_path TEXT NOT NULL,
  output_path TEXT,
  size_before INTEGER,
  size_after INTEGER,
  size_regression_ratio REAL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS chain_lineage_nodes_chain_idx ON chain_lineage_nodes(chain_id);
CREATE INDEX IF NOT EXISTS chain_lineage_nodes_parent_idx ON chain_lineage_nodes(chain_id, parent_node_id);
` as const;

/**
 * Per-session operation log family. Two tables:
 *
 *   - `session_logs`        — one row per session (sniff round / batch /
 *                             upload). Carries open / close meta so the
 *                             history detail panel can render an
 *                             "outcome" label without scanning entries.
 *   - `session_log_entries` — append-only buffer of every event inside
 *                             the session. ON DELETE CASCADE means
 *                             clearing a session also clears its
 *                             entries — convenient for the wipe-history
 *                             button.
 *
 * Both tables are indexed on `session_id` so the renderer can pull a
 * full snapshot in a single SELECT, ordered by `seq` for replay
 * stability across tight bursts (Date.now() can repeat).
 */
export const SESSION_LOGS_DDL = `
CREATE TABLE IF NOT EXISTS session_logs (
  session_id TEXT PRIMARY KEY,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  page_url TEXT NOT NULL DEFAULT '',
  title TEXT,
  origin TEXT,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS session_logs_opened_idx ON session_logs(opened_at DESC);

CREATE TABLE IF NOT EXISTS session_log_entries (
  session_id TEXT NOT NULL REFERENCES session_logs(session_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  stage TEXT NOT NULL,
  substep TEXT,
  message TEXT NOT NULL,
  data_json TEXT,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS session_log_entries_session_idx ON session_log_entries(session_id, seq);
` as const;

/**
 * Logical "table family" key used in `schema_meta(k, v)`. Each family
 * owns its own version counter and migration chain — that way adding
 * a column to `toolbox_history` doesn't force a bump on the much
 * larger `history` family.
 */
export type TableFamily =
  | 'history'
  | 'upload_history'
  | 'sniff_history'
  | 'toolbox_history'
  | 'toolbox_chain_history'
  | 'session_logs'
  | 'chain_lineage_nodes';

/** Current head version per family. Bump and append a migrator in
 *  migrations.ts when changing the schema. */
export const HEAD_VERSIONS: Readonly<Record<TableFamily, number>> = {
  history: 2,
  upload_history: 1,
  sniff_history: 1,
  toolbox_history: 1,
  toolbox_chain_history: 1,
  session_logs: 1,
  chain_lineage_nodes: 1
};
