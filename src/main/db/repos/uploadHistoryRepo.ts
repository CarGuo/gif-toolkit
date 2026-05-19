/**
 * R-80 — Repo for `upload_history` + `upload_history_items`.
 *
 * Layout
 * ------
 * Two tables in a parent/child relationship:
 *   - `upload_history`        — one row per upload batch
 *   - `upload_history_items`  — N rows per batch (preserves order)
 *
 * The renderer's `UploadHistoryRecord` interface is reconstructed by
 * joining items back to their parent in `created_at DESC, position
 * ASC` order. ON DELETE CASCADE makes parent removal a single
 * statement; we still set `foreign_keys = ON` in [openDb()](../index.ts)
 * so the cascade actually fires.
 *
 * upsert semantics
 * ----------------
 * `upsert` is "replace one record's whole subtree". The renderer
 * already mutates a record by full replacement (it calls
 * `setRecords(prev => prev.map(r => r.id === rec.id ? newRec : r))`)
 * so wholesale replace at the persistence layer matches that
 * mental model and avoids a fragile per-item diff. We delete the
 * existing items rows, then re-insert at the new positions, all in
 * one transaction.
 */

import type Database from 'better-sqlite3';

export interface UploadHistoryItemRow {
  jobId: string;
  filePath: string;
  fileName: string;
  status: string;
  url?: string;
  markdown?: string;
  error?: string;
  bytesTotal?: number;
  percent?: number;
  fileHash?: string;
  reused?: boolean;
}

export interface UploadHistoryRow {
  id: string;
  createdAt: number;
  backend: string;
  items: UploadHistoryItemRow[];
}

interface ParentDbRow {
  id: string;
  created_at: number;
  backend: string;
}

interface ItemDbRow {
  job_id: string;
  record_id: string;
  file_path: string | null;
  file_name: string | null;
  status: string | null;
  url: string | null;
  markdown: string | null;
  error: string | null;
  bytes_total: number | null;
  percent: number | null;
  file_hash: string | null;
  reused: number | null;
  position: number;
}

function rowToItem(r: ItemDbRow): UploadHistoryItemRow {
  const item: UploadHistoryItemRow = {
    jobId: r.job_id,
    filePath: r.file_path ?? '',
    fileName: r.file_name ?? '',
    status: r.status ?? 'pending'
  };
  if (r.url != null) item.url = r.url;
  if (r.markdown != null) item.markdown = r.markdown;
  if (r.error != null) item.error = r.error;
  if (r.bytes_total != null) item.bytesTotal = r.bytes_total;
  if (r.percent != null) item.percent = r.percent;
  if (r.file_hash != null) item.fileHash = r.file_hash;
  if (r.reused != null) item.reused = r.reused === 1;
  return item;
}

export interface UploadHistoryRepo {
  readAll(): UploadHistoryRow[];
  upsert(rec: UploadHistoryRow): void;
  remove(id: string): void;
  clear(): void;
  insertManyRaw(rows: UploadHistoryRow[]): number;
}

export function createUploadHistoryRepo(db: Database.Database): UploadHistoryRepo {
  const selectParents = db.prepare<[], ParentDbRow>(
    'SELECT id, created_at, backend FROM upload_history ORDER BY created_at DESC'
  );
  const selectItems = db.prepare<[], ItemDbRow>(
    'SELECT job_id, record_id, file_path, file_name, status, url, markdown, error, bytes_total, percent, file_hash, reused, position FROM upload_history_items ORDER BY record_id, position ASC'
  );
  const upsertParent = db.prepare(
    `INSERT INTO upload_history (id, created_at, backend) VALUES (@id, @created_at, @backend)
     ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, backend = excluded.backend`
  );
  const insertParentIgnore = db.prepare(
    'INSERT OR IGNORE INTO upload_history (id, created_at, backend) VALUES (@id, @created_at, @backend)'
  );
  const deleteItemsByRecord = db.prepare(
    'DELETE FROM upload_history_items WHERE record_id = ?'
  );
  const insertItem = db.prepare(
    `INSERT INTO upload_history_items
       (job_id, record_id, file_path, file_name, status, url, markdown, error, bytes_total, percent, file_hash, reused, position)
     VALUES (@job_id, @record_id, @file_path, @file_name, @status, @url, @markdown, @error, @bytes_total, @percent, @file_hash, @reused, @position)`
  );
  const insertItemIgnore = db.prepare(
    `INSERT OR IGNORE INTO upload_history_items
       (job_id, record_id, file_path, file_name, status, url, markdown, error, bytes_total, percent, file_hash, reused, position)
     VALUES (@job_id, @record_id, @file_path, @file_name, @status, @url, @markdown, @error, @bytes_total, @percent, @file_hash, @reused, @position)`
  );
  const deleteParent = db.prepare('DELETE FROM upload_history WHERE id = ?');
  const clearParents = db.prepare('DELETE FROM upload_history');

  function itemToParams(
    recordId: string,
    item: UploadHistoryItemRow,
    position: number
  ): Record<string, string | number | null> {
    return {
      job_id: item.jobId,
      record_id: recordId,
      file_path: item.filePath ?? null,
      file_name: item.fileName ?? null,
      status: item.status ?? null,
      url: item.url ?? null,
      markdown: item.markdown ?? null,
      error: item.error ?? null,
      bytes_total: item.bytesTotal ?? null,
      percent: item.percent ?? null,
      file_hash: item.fileHash ?? null,
      reused: item.reused == null ? null : item.reused ? 1 : 0,
      position
    };
  }

  return {
    readAll() {
      const parents = selectParents.all();
      if (parents.length === 0) return [];
      const itemsByParent = new Map<string, UploadHistoryItemRow[]>();
      for (const r of selectItems.all()) {
        const arr = itemsByParent.get(r.record_id) ?? [];
        arr.push(rowToItem(r));
        itemsByParent.set(r.record_id, arr);
      }
      return parents.map((p) => ({
        id: p.id,
        createdAt: p.created_at,
        backend: p.backend,
        items: itemsByParent.get(p.id) ?? []
      }));
    },
    upsert(rec) {
      const txn = db.transaction(() => {
        upsertParent.run({ id: rec.id, created_at: rec.createdAt, backend: rec.backend });
        deleteItemsByRecord.run(rec.id);
        let position = 0;
        for (const item of rec.items) {
          insertItem.run(itemToParams(rec.id, item, position));
          position += 1;
        }
      });
      txn();
    },
    remove(id) {
      deleteParent.run(id);
    },
    clear() {
      clearParents.run();
    },
    insertManyRaw(rows) {
      let inserted = 0;
      const txn = db.transaction((batch: UploadHistoryRow[]) => {
        for (const rec of batch) {
          const info = insertParentIgnore.run({
            id: rec.id,
            created_at: rec.createdAt,
            backend: rec.backend
          });
          if (info.changes === 0) continue;
          inserted += 1;
          let position = 0;
          for (const item of rec.items) {
            insertItemIgnore.run(itemToParams(rec.id, item, position));
            position += 1;
          }
        }
      });
      txn(rows);
      return inserted;
    }
  };
}
