/**
 * Repo for `session_logs` + `session_log_entries`.
 *
 * Each "session" corresponds to a sniff round (or a standalone batch
 * / upload that doesn't have a sniff). Entries are append-only,
 * ordered by `(session_id, seq)`. Mutations are wrapped in
 * transactions so a crash mid-batch doesn't leave half-written
 * entries.
 *
 * The repo is intentionally narrow: it does NOT understand the
 * domain (stage names, level names, etc) — those are validated at
 * the [sessionLogger](../../sessionLogger.ts) seam so a tampered
 * IPC payload can't write garbage into the table directly.
 */

import type Database from 'better-sqlite3';
import type {
  SessionLogEntry,
  SessionLogLevel,
  SessionLogSnapshot,
  SessionLogStage
} from '../../../shared/types/log';

interface SessionRow {
  session_id: string;
  opened_at: number;
  closed_at: number | null;
  page_url: string;
  title: string | null;
  origin: string | null;
  outcome: string | null;
}

interface EntryRow {
  session_id: string;
  seq: number;
  ts: number;
  level: string;
  stage: string;
  substep: string | null;
  message: string;
  data_json: string | null;
}

export interface OpenSessionInput {
  sessionId: string;
  openedAt: number;
  pageUrl: string;
  title?: string;
  origin?: string;
}

export interface CloseSessionInput {
  sessionId: string;
  closedAt: number;
  outcome: 'done' | 'cancelled' | 'error';
}

export interface AppendEntryInput {
  sessionId: string;
  seq: number;
  ts: number;
  level: SessionLogLevel;
  stage: SessionLogStage;
  substep?: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface SessionLogRepo {
  /** Idempotent: running open twice with the same id is a no-op. */
  open(input: OpenSessionInput): void;
  /** Update the existing session row's title (set during sniff once
   *  the page <title> is known). */
  updateMeta(args: { sessionId: string; title?: string; pageUrl?: string }): void;
  close(input: CloseSessionInput): void;
  /** Reopen an already-closed session: clears closed_at + outcome so
   *  downstream stages (e.g. upload after a process batch already
   *  finalised the row) can keep emitting entries against the same
   *  session_id without the UI showing it as terminated. No-op if the
   *  session does not exist or is still open. */
  reopen(sessionId: string): void;
  /** Append one entry. Throws on duplicate (session_id, seq). */
  append(entries: AppendEntryInput[]): void;
  /** Pull a session + every entry, ordered by seq. Returns null if
   *  the session id is unknown. */
  read(sessionId: string): SessionLogSnapshot | null;
  /** List all session metadata rows newest-first. Used by the export
   *  picker; entries are NOT joined here for cost reasons. */
  listAll(): Array<Omit<SessionLogSnapshot, 'entries'>>;
  /** Drop one session and its entries (FK cascade). */
  remove(sessionId: string): void;
  /** Wipe everything. */
  clear(): void;
  /** Convenience for tests / housekeeping: prune sessions older than
   *  `cutoffMs` wall-clock that are also closed. Returns the number
   *  of rows removed. */
  pruneClosedBefore(cutoffMs: number): number;
}

function rowToMeta(r: SessionRow): Omit<SessionLogSnapshot, 'entries'> {
  const out: Omit<SessionLogSnapshot, 'entries'> = {
    sessionId: r.session_id,
    openedAt: r.opened_at,
    pageUrl: r.page_url
  };
  if (r.closed_at != null) out.closedAt = r.closed_at;
  if (r.title != null) out.title = r.title;
  if (r.origin != null) out.origin = r.origin;
  if (r.outcome === 'done' || r.outcome === 'cancelled' || r.outcome === 'error') {
    out.outcome = r.outcome;
  }
  return out;
}

function rowToEntry(r: EntryRow): SessionLogEntry {
  const e: SessionLogEntry = {
    sessionId: r.session_id,
    seq: r.seq,
    ts: r.ts,
    level: (r.level as SessionLogLevel),
    stage: (r.stage as SessionLogStage),
    message: r.message
  };
  if (r.substep != null) e.substep = r.substep;
  if (r.data_json != null) {
    try {
      const parsed: unknown = JSON.parse(r.data_json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        e.data = parsed as Record<string, unknown>;
      }
    } catch {
      // ignore corrupt blob — entry is still readable without data
    }
  }
  return e;
}

export function createSessionLogRepo(db: Database.Database): SessionLogRepo {
  const insertSession = db.prepare(
    `INSERT INTO session_logs (session_id, opened_at, closed_at, page_url, title, origin, outcome)
     VALUES (@session_id, @opened_at, @closed_at, @page_url, @title, @origin, @outcome)
     ON CONFLICT(session_id) DO NOTHING`
  );
  const updateMetaStmt = db.prepare(
    `UPDATE session_logs
       SET title = COALESCE(@title, title),
           page_url = COALESCE(@page_url, page_url)
     WHERE session_id = @session_id`
  );
  const closeStmt = db.prepare(
    `UPDATE session_logs SET closed_at = @closed_at, outcome = @outcome WHERE session_id = @session_id`
  );
  const reopenStmt = db.prepare(
    `UPDATE session_logs SET closed_at = NULL, outcome = NULL WHERE session_id = ?`
  );
  const insertEntry = db.prepare(
    `INSERT INTO session_log_entries (session_id, seq, ts, level, stage, substep, message, data_json)
     VALUES (@session_id, @seq, @ts, @level, @stage, @substep, @message, @data_json)`
  );
  const selectSession = db.prepare<[string], SessionRow>(
    'SELECT session_id, opened_at, closed_at, page_url, title, origin, outcome FROM session_logs WHERE session_id = ?'
  );
  const selectEntries = db.prepare<[string], EntryRow>(
    'SELECT session_id, seq, ts, level, stage, substep, message, data_json FROM session_log_entries WHERE session_id = ? ORDER BY seq ASC'
  );
  const listAllStmt = db.prepare<[], SessionRow>(
    'SELECT session_id, opened_at, closed_at, page_url, title, origin, outcome FROM session_logs ORDER BY opened_at DESC'
  );
  const removeStmt = db.prepare('DELETE FROM session_logs WHERE session_id = ?');
  const clearStmt = db.prepare('DELETE FROM session_logs');
  const pruneStmt = db.prepare(
    'DELETE FROM session_logs WHERE closed_at IS NOT NULL AND closed_at < ?'
  );

  return {
    open(input) {
      insertSession.run({
        session_id: input.sessionId,
        opened_at: input.openedAt,
        closed_at: null,
        page_url: input.pageUrl,
        title: input.title ?? null,
        origin: input.origin ?? null,
        outcome: null
      });
    },
    updateMeta({ sessionId, title, pageUrl }) {
      updateMetaStmt.run({
        session_id: sessionId,
        title: title ?? null,
        page_url: pageUrl ?? null
      });
    },
    close(input) {
      closeStmt.run({
        session_id: input.sessionId,
        closed_at: input.closedAt,
        outcome: input.outcome
      });
    },
    reopen(sessionId) {
      reopenStmt.run(sessionId);
    },
    append(entries) {
      if (entries.length === 0) return;
      const txn = db.transaction((batch: AppendEntryInput[]) => {
        for (const e of batch) {
          insertEntry.run({
            session_id: e.sessionId,
            seq: e.seq,
            ts: e.ts,
            level: e.level,
            stage: e.stage,
            substep: e.substep ?? null,
            message: e.message,
            data_json: e.data ? safeStringify(e.data) : null
          });
        }
      });
      txn(entries);
    },
    read(sessionId) {
      const row = selectSession.get(sessionId);
      if (!row) return null;
      const entries = selectEntries.all(sessionId).map(rowToEntry);
      return { ...rowToMeta(row), entries };
    },
    listAll() {
      return listAllStmt.all().map(rowToMeta);
    },
    remove(sessionId) {
      removeStmt.run(sessionId);
    },
    clear() {
      clearStmt.run();
    },
    pruneClosedBefore(cutoffMs) {
      const info = pruneStmt.run(cutoffMs);
      return Number(info.changes ?? 0);
    }
  };
}

/** JSON.stringify wrapper that survives circular refs and BigInts —
 *  log payloads are user-defined, so we don't trust them to be
 *  serialisable. Failures degrade to `'{"_serialiseError":"..."}'`
 *  rather than throwing the entire append away. */
function safeStringify(data: Record<string, unknown>): string {
  try {
    return JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch (e) {
    return JSON.stringify({ _serialiseError: (e as Error).message });
  }
}
