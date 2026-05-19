/**
 * R-80 — Repo for `toolbox_history`. Single flat table with two
 * JSON columns (`outputs_json`, `params_json`) for the structured
 * per-kind payloads.
 */

import type Database from 'better-sqlite3';

export interface ToolboxHistoryRow {
  id: string;
  kind: string;
  inputPath: string;
  displayName: string;
  outputs: string[];
  params: unknown;
  status: 'done' | 'failed' | 'cancelled' | 'skipped';
  error?: string;
  finishedAt: number;
}

interface DbRow {
  id: string;
  kind: string;
  input_path: string;
  display_name: string;
  status: string;
  error: string | null;
  finished_at: number;
  outputs_json: string;
  params_json: string;
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

function rowToEntry(r: DbRow): ToolboxHistoryRow | null {
  const status = r.status as ToolboxHistoryRow['status'];
  if (status !== 'done' && status !== 'failed' && status !== 'cancelled' && status !== 'skipped') {
    return null;
  }
  const outputs = parseJsonOrDefault<string[]>(r.outputs_json, []);
  if (!Array.isArray(outputs)) return null;
  const e: ToolboxHistoryRow = {
    id: r.id,
    kind: r.kind,
    inputPath: r.input_path,
    displayName: r.display_name,
    outputs: outputs.filter((s): s is string => typeof s === 'string'),
    params: parseJsonOrDefault<unknown>(r.params_json, {}),
    status,
    finishedAt: r.finished_at
  };
  if (r.error != null) e.error = r.error;
  return e;
}

export interface ToolboxHistoryRepo {
  readAll(): ToolboxHistoryRow[];
  upsert(entry: ToolboxHistoryRow): void;
  remove(id: string): void;
  clear(): void;
  insertManyRaw(rows: ToolboxHistoryRow[]): number;
}

export function createToolboxHistoryRepo(db: Database.Database): ToolboxHistoryRepo {
  const selectAll = db.prepare<[], DbRow>(
    'SELECT id, kind, input_path, display_name, status, error, finished_at, outputs_json, params_json FROM toolbox_history ORDER BY finished_at DESC'
  );
  const upsertStmt = db.prepare(
    `INSERT INTO toolbox_history (id, kind, input_path, display_name, status, error, finished_at, outputs_json, params_json)
     VALUES (@id, @kind, @input_path, @display_name, @status, @error, @finished_at, @outputs_json, @params_json)
     ON CONFLICT(id) DO UPDATE SET
       kind = excluded.kind,
       input_path = excluded.input_path,
       display_name = excluded.display_name,
       status = excluded.status,
       error = excluded.error,
       finished_at = excluded.finished_at,
       outputs_json = excluded.outputs_json,
       params_json = excluded.params_json`
  );
  const insertIgnoreStmt = db.prepare(
    `INSERT OR IGNORE INTO toolbox_history (id, kind, input_path, display_name, status, error, finished_at, outputs_json, params_json)
     VALUES (@id, @kind, @input_path, @display_name, @status, @error, @finished_at, @outputs_json, @params_json)`
  );
  const removeStmt = db.prepare('DELETE FROM toolbox_history WHERE id = ?');
  const clearStmt = db.prepare('DELETE FROM toolbox_history');

  function entryToParams(e: ToolboxHistoryRow): Record<string, string | number | null> {
    return {
      id: e.id,
      kind: e.kind,
      input_path: e.inputPath,
      display_name: e.displayName,
      status: e.status,
      error: e.error ?? null,
      finished_at: e.finishedAt,
      outputs_json: JSON.stringify(e.outputs ?? []),
      params_json: JSON.stringify(e.params ?? {})
    };
  }

  return {
    readAll() {
      const out: ToolboxHistoryRow[] = [];
      for (const r of selectAll.all()) {
        const e = rowToEntry(r);
        if (e) out.push(e);
      }
      return out;
    },
    upsert(entry) {
      upsertStmt.run(entryToParams(entry));
    },
    remove(id) {
      removeStmt.run(id);
    },
    clear() {
      clearStmt.run();
    },
    insertManyRaw(rows) {
      let inserted = 0;
      const txn = db.transaction((batch: ToolboxHistoryRow[]) => {
        for (const e of batch) {
          const info = insertIgnoreStmt.run(entryToParams(e));
          if (info.changes > 0) inserted += 1;
        }
      });
      txn(rows);
      return inserted;
    }
  };
}
