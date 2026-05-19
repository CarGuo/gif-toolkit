/**
 * R-80 — Repo for `sniff_history`. Trivial single-table model: one
 * row per URL, INSERT OR REPLACE for upsert (URL is the primary key).
 */

import type Database from 'better-sqlite3';

export interface SniffHistoryRow {
  url: string;
  title?: string;
  ts: number;
  itemCount?: number;
}

interface DbRow {
  url: string;
  title: string | null;
  ts: number;
  item_count: number | null;
}

function rowToEntry(r: DbRow): SniffHistoryRow {
  const e: SniffHistoryRow = { url: r.url, ts: r.ts };
  if (r.title != null) e.title = r.title;
  if (r.item_count != null) e.itemCount = r.item_count;
  return e;
}

export interface SniffHistoryRepo {
  readAll(): SniffHistoryRow[];
  upsert(entry: SniffHistoryRow): void;
  remove(url: string): void;
  clear(): void;
  insertManyRaw(rows: SniffHistoryRow[]): number;
}

export function createSniffHistoryRepo(db: Database.Database): SniffHistoryRepo {
  const selectAll = db.prepare<[], DbRow>(
    'SELECT url, title, ts, item_count FROM sniff_history ORDER BY ts DESC'
  );
  const upsertStmt = db.prepare(
    `INSERT INTO sniff_history (url, title, ts, item_count) VALUES (@url, @title, @ts, @item_count)
     ON CONFLICT(url) DO UPDATE SET title = excluded.title, ts = excluded.ts, item_count = excluded.item_count`
  );
  const insertIgnoreStmt = db.prepare(
    'INSERT OR IGNORE INTO sniff_history (url, title, ts, item_count) VALUES (@url, @title, @ts, @item_count)'
  );
  const removeStmt = db.prepare('DELETE FROM sniff_history WHERE url = ?');
  const clearStmt = db.prepare('DELETE FROM sniff_history');

  function entryToParams(e: SniffHistoryRow): Record<string, string | number | null> {
    return {
      url: e.url,
      title: e.title ?? null,
      ts: e.ts,
      item_count: e.itemCount ?? null
    };
  }

  return {
    readAll() {
      return selectAll.all().map(rowToEntry);
    },
    upsert(entry) {
      upsertStmt.run(entryToParams(entry));
    },
    remove(url) {
      removeStmt.run(url);
    },
    clear() {
      clearStmt.run();
    },
    insertManyRaw(rows) {
      let inserted = 0;
      const txn = db.transaction((batch: SniffHistoryRow[]) => {
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
