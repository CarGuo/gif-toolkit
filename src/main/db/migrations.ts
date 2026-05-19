/**
 * R-80 — Per-table migrations runner.
 *
 * Design
 * ------
 * Each table family in `schema_meta` carries its own integer version.
 * On boot the runner reads the version, then steps it forward by
 * applying each `migrators[v + 1]` in sequence until reaching the
 * current head from {@link HEAD_VERSIONS}. Each step runs inside a
 * single transaction; if the step throws, the transaction is rolled
 * back and the error bubbles so the main process surfaces it (we'd
 * rather refuse to boot than silently corrupt the user's history).
 *
 * The v0 → v1 migrator for every table is just "execute the head
 * DDL" because we ship v1 as the first published schema. Subsequent
 * schema changes (rename column, add table, etc.) MUST be appended
 * to the migrators array AND bump {@link HEAD_VERSIONS} AND update
 * the canonical DDL strings in schema.ts (so fresh installs jump
 * straight to head — they'll still walk the migrators[] chain but
 * each step will be a no-op on already-correct shape, the typical
 * pattern is `IF NOT EXISTS` + `IF EXISTS` guards).
 */

import type Database from 'better-sqlite3';
import {
  HISTORY_DDL,
  UPLOAD_HISTORY_DDL,
  SNIFF_HISTORY_DDL,
  TOOLBOX_HISTORY_DDL,
  HEAD_VERSIONS,
  type TableFamily
} from './schema';

type Migrator = (db: Database.Database) => void;

/**
 * Migrators per table family, indexed by *target* version. Index 0
 * is unused (no "upgrade to v0"). To bump a family's head, append a
 * new function and update {@link HEAD_VERSIONS}.
 */
const MIGRATORS: Readonly<Record<TableFamily, ReadonlyArray<Migrator>>> = {
  history: [
    () => undefined,
    (db) => {
      db.exec(HISTORY_DDL);
    }
  ],
  upload_history: [
    () => undefined,
    (db) => {
      db.exec(UPLOAD_HISTORY_DDL);
    }
  ],
  sniff_history: [
    () => undefined,
    (db) => {
      db.exec(SNIFF_HISTORY_DDL);
    }
  ],
  toolbox_history: [
    () => undefined,
    (db) => {
      db.exec(TOOLBOX_HISTORY_DDL);
    }
  ]
};

/**
 * Read the current schema version for a single family, defaulting
 * to 0 (fresh install / pre-existence) when no row is present yet.
 */
function getVersion(db: Database.Database, family: TableFamily): number {
  const row = db
    .prepare('SELECT v FROM schema_meta WHERE k = ?')
    .get(family) as { v: number } | undefined;
  return row?.v ?? 0;
}

function setVersion(db: Database.Database, family: TableFamily, v: number): void {
  db.prepare(
    'INSERT INTO schema_meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'
  ).run(family, v);
}

/**
 * Walk every family from its current version up to its head version,
 * applying migrators inside per-step transactions. Idempotent: a
 * second call on a fully-migrated DB is a fast no-op (just N SELECTs).
 */
export function runMigrations(db: Database.Database): void {
  const families: TableFamily[] = [
    'history',
    'upload_history',
    'sniff_history',
    'toolbox_history'
  ];
  for (const family of families) {
    const head = HEAD_VERSIONS[family];
    let cur = getVersion(db, family);
    while (cur < head) {
      const next = cur + 1;
      const step = MIGRATORS[family][next];
      if (typeof step !== 'function') {
        throw new Error(
          `[db] missing migrator ${family}@v${next} (head=${head})`
        );
      }
      const txn = db.transaction(() => {
        step(db);
        setVersion(db, family, next);
      });
      txn();
      cur = next;
    }
  }
}
