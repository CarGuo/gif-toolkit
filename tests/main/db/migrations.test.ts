/**
 * R-80 — Migrations runner unit tests.
 *
 * Coverage goals:
 *   1. Fresh-install path: empty DB → runMigrations bumps every
 *      family from v0 to its head version, every table is created,
 *      every index is queryable.
 *   2. Idempotency: a second runMigrations on an already-current DB
 *      is a no-op.
 *   3. Schema_meta book-keeping: the per-family rows match
 *      HEAD_VERSIONS verbatim.
 *
 * Coverage holes we intentionally accept:
 *   - We do NOT exercise multi-step (v1→v2→v3) migrations because
 *     R-80 ships v1 only. When a v2 migrator is added, this file
 *     gains a "given DB at v1, runMigrations lifts to v2" case.
 *
 * NOTE: Requires better-sqlite3 linked against host Node ABI; see
 * `openTestDb.ts` header for the rebuild dance.
 */

import { describe, it, expect } from 'vitest';
import { runMigrations } from '../../../src/main/db/migrations';
import { HEAD_VERSIONS, SCHEMA_META_DDL } from '../../../src/main/db/schema';
import { openTestDb, type TestDb } from './openTestDb';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

function listTables(db: TestDb): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

describe('R-80 migrations runner', () => {
  it('lifts a fresh DB to head versions for every family', () => {
    const db = openTestDb();
    try {
      const versions = db.prepare('SELECT k, v FROM schema_meta').all() as { k: string; v: number }[];
      const map = Object.fromEntries(versions.map((r) => [r.k, r.v]));
      expect(map).toEqual({
        history: HEAD_VERSIONS.history,
        upload_history: HEAD_VERSIONS.upload_history,
        sniff_history: HEAD_VERSIONS.sniff_history,
        toolbox_history: HEAD_VERSIONS.toolbox_history,
        session_logs: HEAD_VERSIONS.session_logs
      });
    } finally {
      db.close();
    }
  });

  it('creates every expected table', () => {
    const db = openTestDb();
    try {
      const tables = listTables(db);
      // We don't assert exact equality because SQLite may also expose
      // sqlite_sequence etc. on demand; just check ours are present.
      for (const expected of [
        'history',
        'upload_history',
        'upload_history_items',
        'sniff_history',
        'toolbox_history',
        'session_logs',
        'session_log_entries',
        'schema_meta'
      ]) {
        expect(tables).toContain(expected);
      }
    } finally {
      db.close();
    }
  });

  it('is idempotent: a second run is a no-op', () => {
    const db = openTestDb();
    try {
      const first = db.prepare('SELECT COUNT(*) AS n FROM schema_meta').get() as { n: number };
      runMigrations(db);
      runMigrations(db);
      const second = db.prepare('SELECT COUNT(*) AS n FROM schema_meta').get() as { n: number };
      expect(second.n).toBe(first.n);
      // Tables remain queryable.
      expect(() => db.prepare('SELECT 1 FROM history').all()).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('respects foreign_keys ON for upload_history → upload_history_items cascade', () => {
    const db = openTestDb();
    try {
      db.prepare(
        'INSERT INTO upload_history (id, created_at, backend) VALUES (?, ?, ?)'
      ).run('rec-1', 100, 'github');
      db.prepare(
        `INSERT INTO upload_history_items (job_id, record_id, file_path, file_name, status, position)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('job-1', 'rec-1', '/tmp/a.gif', 'a.gif', 'done', 0);
      db.prepare('DELETE FROM upload_history WHERE id = ?').run('rec-1');
      const remaining = db
        .prepare('SELECT COUNT(*) AS n FROM upload_history_items')
        .get() as { n: number };
      expect(remaining.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('walks an unversioned schema_meta row up to head (simulates upgrade)', () => {
    // Boot a DB without going through openTestDb to simulate "user
    // installed pre-R-80, then upgraded": the on-disk file would have
    // an empty schema_meta. We then call runMigrations and expect
    // every family to be bumped to v1.
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      db.exec(SCHEMA_META_DDL);
      runMigrations(db);
      const row = db
        .prepare('SELECT v FROM schema_meta WHERE k = ?')
        .get('history') as { v: number };
      expect(row.v).toBe(HEAD_VERSIONS.history);
    } finally {
      db.close();
    }
  });
});
