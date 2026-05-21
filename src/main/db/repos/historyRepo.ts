/**
 * R-80 — Repo for the `history` table (processing-history records).
 *
 * Wire format
 * -----------
 * The renderer's `HistoryRecord` interface is preserved verbatim
 * across the IPC boundary. The repo does the row⇄record split:
 * outer columns (`id`, `created_at`, `page_url`, `title`,
 * `output_dir`) for queries; deep nested fields (`items`, `options`,
 * `outputsByTaskId`, `taskStatus`, `uploadsByOutputPath`) live in
 * JSON columns. See [docs/R-80-SQLITE-NOTES.md](../../../../docs/R-80-SQLITE-NOTES.md)
 * §"history schema decision" for why the inner shapes are JSON-blobbed
 * rather than further normalised.
 *
 * Defensive parse:
 * - readAll() never throws; corrupt rows are dropped with a warning.
 *   The renderer tolerated this in the localStorage path (see
 *   useHistory's per-row try/catch) and we keep the same contract so
 *   a partial-write or human-edited DB row can't take the panel down.
 *
 * INSERT OR IGNORE on bootstrap:
 * - The bootstrap importer (R-80 Commit B) needs idempotency in case
 *   the user kills the app mid-import; we expose `insertManyRaw` for
 *   that, distinct from `upsert` (which clobbers on PK conflict).
 */

import type Database from 'better-sqlite3';

/**
 * Mirror of the renderer's `HistoryRecord` type but kept as `unknown`-
 * shaped here so the main-process bundle does NOT depend on renderer
 * code. The IPC layer above this repo enforces shape via the
 * preload contract; the repo treats the JSON columns as opaque blobs
 * for round-tripping.
 */
export interface HistoryRow {
  id: string;
  createdAt: number;
  pageUrl: string;
  title?: string;
  outputDir?: string;
  items: unknown[];
  options: unknown;
  outputsByTaskId: Record<string, unknown>;
  taskStatus: Record<string, unknown>;
  uploadsByOutputPath?: Record<string, unknown>;
  /** R-X — pin the row to a session_logs.session_id so the history
   *  detail panel can pull the full sniff→process→upload log.
   *  Optional because (a) legacy rows imported before R-X have NULL,
   *  (b) renderer may not have a sessionId for some toolbox-only paths. */
  sessionId?: string;
}

interface DbRow {
  id: string;
  created_at: number;
  page_url: string;
  title: string | null;
  output_dir: string | null;
  items_json: string;
  options_json: string;
  outputs_json: string;
  status_json: string;
  uploads_json: string;
  session_id: string | null;
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

function tryParseJson<T>(s: string | null | undefined): { ok: true; value: T } | { ok: false } {
  if (s === null || s === undefined || s === '') return { ok: true, value: undefined as unknown as T };
  try {
    return { ok: true, value: JSON.parse(s) as T };
  } catch {
    return { ok: false };
  }
}

function rowToRecord(r: DbRow): HistoryRow | null {
  try {
    const itemsResult = tryParseJson<unknown>(r.items_json);
    if (!itemsResult.ok) return null;
    const items = itemsResult.value;
    if (!Array.isArray(items)) return null;
    const rec: HistoryRow = {
      id: r.id,
      createdAt: r.created_at,
      pageUrl: r.page_url ?? '',
      items,
      options: parseJsonOrDefault<unknown>(r.options_json, {}),
      outputsByTaskId: parseJsonOrDefault<Record<string, unknown>>(r.outputs_json, {}),
      taskStatus: parseJsonOrDefault<Record<string, unknown>>(r.status_json, {})
    };
    if (r.title) rec.title = r.title;
    if (r.output_dir) rec.outputDir = r.output_dir;
    if (r.session_id) rec.sessionId = r.session_id;
    const uploads = parseJsonOrDefault<Record<string, unknown> | null>(
      r.uploads_json,
      null
    );
    if (uploads && typeof uploads === 'object') rec.uploadsByOutputPath = uploads;
    return rec;
  } catch {
    return null;
  }
}

export interface HistoryRepo {
  readAll(): HistoryRow[];
  upsert(rec: HistoryRow): void;
  remove(id: string): void;
  clear(): void;
  /** Bulk-insert raw rows for the bootstrap importer. Skips rows
   *  whose id already exists. All rows in a single transaction. */
  insertManyRaw(rows: HistoryRow[]): number;
}

export function createHistoryRepo(db: Database.Database): HistoryRepo {
  const selectAll = db.prepare<[], DbRow>(
    'SELECT id, created_at, page_url, title, output_dir, items_json, options_json, outputs_json, status_json, uploads_json, session_id FROM history ORDER BY created_at DESC'
  );
  const upsertStmt = db.prepare(
    `INSERT INTO history (id, created_at, page_url, title, output_dir, items_json, options_json, outputs_json, status_json, uploads_json, session_id)
     VALUES (@id, @created_at, @page_url, @title, @output_dir, @items_json, @options_json, @outputs_json, @status_json, @uploads_json, @session_id)
     ON CONFLICT(id) DO UPDATE SET
       created_at = excluded.created_at,
       page_url = excluded.page_url,
       title = excluded.title,
       output_dir = excluded.output_dir,
       items_json = excluded.items_json,
       options_json = excluded.options_json,
       outputs_json = excluded.outputs_json,
       status_json = excluded.status_json,
       uploads_json = excluded.uploads_json,
       session_id = excluded.session_id`
  );
  const insertIgnoreStmt = db.prepare(
    `INSERT OR IGNORE INTO history (id, created_at, page_url, title, output_dir, items_json, options_json, outputs_json, status_json, uploads_json, session_id)
     VALUES (@id, @created_at, @page_url, @title, @output_dir, @items_json, @options_json, @outputs_json, @status_json, @uploads_json, @session_id)`
  );
  const removeStmt = db.prepare('DELETE FROM history WHERE id = ?');
  const clearStmt = db.prepare('DELETE FROM history');

  function recToParams(rec: HistoryRow): Record<string, string | number | null> {
    return {
      id: rec.id,
      created_at: rec.createdAt,
      page_url: rec.pageUrl ?? '',
      title: rec.title ?? null,
      output_dir: rec.outputDir ?? null,
      items_json: JSON.stringify(rec.items ?? []),
      options_json: JSON.stringify(rec.options ?? {}),
      outputs_json: JSON.stringify(rec.outputsByTaskId ?? {}),
      status_json: JSON.stringify(rec.taskStatus ?? {}),
      uploads_json: JSON.stringify(rec.uploadsByOutputPath ?? {}),
      session_id: rec.sessionId ?? null
    };
  }

  return {
    readAll() {
      const rows = selectAll.all();
      const out: HistoryRow[] = [];
      for (const r of rows) {
        const rec = rowToRecord(r);
        if (rec) out.push(rec);
      }
      return out;
    },
    upsert(rec) {
      upsertStmt.run(recToParams(rec));
    },
    remove(id) {
      removeStmt.run(id);
    },
    clear() {
      clearStmt.run();
    },
    insertManyRaw(rows) {
      let inserted = 0;
      const txn = db.transaction((batch: HistoryRow[]) => {
        for (const r of batch) {
          const info = insertIgnoreStmt.run(recToParams(r));
          if (info.changes > 0) inserted += 1;
        }
      });
      txn(rows);
      return inserted;
    }
  };
}
