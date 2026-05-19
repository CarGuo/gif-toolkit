/**
 * R-80 — Main-process SQLite singleton.
 *
 * Why a singleton:
 *   - better-sqlite3 holds a synchronous handle to the DB file. We
 *     only ever want one open handle per process so the WAL pragma
 *     and PRAGMA foreign_keys settings apply consistently and the
 *     repos can share prepared statements transparently (better-
 *     sqlite3 caches them per `Database` instance).
 *
 * Lazy import:
 *   - `better-sqlite3` is a native addon. Importing it at module
 *     top-level would trip the renderer test runner (Vitest, Node
 *     ABI) the moment ANY main-process file is touched. We require
 *     it inside `openDb()` so unit tests that don't actually need
 *     the DB never load the binary, and tests that do can mock at
 *     the `openDb` layer. The path to the file lives in `userData`
 *     in production but tests pass `:memory:` for ephemeral runs.
 *
 * WAL pragma:
 *   - WAL is the standard Electron-app choice: better concurrency
 *     between long-lived reads (UI hydrate) and the occasional
 *     mutating write, plus crash-resilience without the journal
 *     file overhead. Synchronous=NORMAL is paired with WAL because
 *     FULL is overkill for a personal-history database (we are not
 *     a banking system).
 *
 * Foreign keys:
 *   - upload_history_items references upload_history(id) ON DELETE
 *     CASCADE; FK enforcement is OFF by default in SQLite, so we
 *     turn it on per connection.
 */

import path from 'path';
import { app } from 'electron';
import { runMigrations } from './migrations';
import { SCHEMA_META_DDL } from './schema';

type BetterSqlite3Database = import('better-sqlite3').Database;

let _db: BetterSqlite3Database | null = null;

/**
 * Resolve the file path used in production. Tests pass an explicit
 * `:memory:` so this is never called from them.
 */
function resolveDbPath(): string {
  return path.join(app.getPath('userData'), 'giftk-history.db');
}

export interface OpenDbOptions {
  /** Override the file path. Pass `:memory:` for tests. Defaults to
   *  `<userData>/giftk-history.db`. */
  filename?: string;
}

/**
 * Open (or return the cached) DB handle. Idempotent: a second call
 * with the same options is a fast no-op. Calling with a different
 * `filename` after the first open is treated as a programmer error
 * — this should not happen in production where there's exactly one
 * userData path; tests that need multiple DBs should call closeDb()
 * between opens.
 */
export function openDb(opts: OpenDbOptions = {}): BetterSqlite3Database {
  if (_db) return _db;
  // We resolve `better-sqlite3` lazily via require() instead of a top-
  // level import so the renderer test runner (which never opens a DB)
  // doesn't try to load the native binary. The two disables below cover
  // both the Node-style require AND the assignment-form rule depending
  // on which @typescript-eslint version is active.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  const filename = opts.filename ?? resolveDbPath();
  const db = new Database(filename);
  // Pragmas first — they're connection-level and we want them
  // applied before any DDL or repo write.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  // schema_meta must exist before runMigrations can SELECT from it.
  db.exec(SCHEMA_META_DDL);
  runMigrations(db);
  _db = db;
  return db;
}

/**
 * Close the cached handle, if any. Called from the `before-quit`
 * hook so the WAL is checkpointed cleanly. Tests also call this
 * between cases to swap between in-memory DBs.
 */
export function closeDb(): void {
  if (_db) {
    try {
      _db.close();
    } finally {
      _db = null;
    }
  }
}

/**
 * Test helper — exposed so unit tests can swap an in-memory DB in
 * without going through `app.getPath('userData')`. Production code
 * should call `openDb()` with no args.
 */
export function _resetDbSingletonForTests(): void {
  _db = null;
}
