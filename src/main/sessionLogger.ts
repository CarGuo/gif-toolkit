/**
 * Per-session structured operation logger.
 *
 * One "session" corresponds to a sniff round (URL parse → HTTP /
 * webview / system-chrome / yt-dlp / offline → dedup → SniffResult)
 * plus any subsequent batch / upload that the renderer pins to the
 * same id via the `sessionId` parameter. The same id is persisted
 * onto the corresponding HistoryRecord so a user can later open the
 * detail panel and replay why a given GIF appeared / was duplicated /
 * is missing.
 *
 * Architecture
 * ============
 *   - One in-memory sequence-number counter per session id, so
 *     `seq` is monotone even when emits arrive on different ticks.
 *   - Mutations are forwarded synchronously to the SQLite repo and
 *     fanned out as `session:log` IPC events to the focused window
 *     so the renderer can render a live tail without polling.
 *   - DB writes are best-effort: a SQL failure logs to the global
 *     [logger](./logger.ts) ring buffer but never throws back to the
 *     emitter, because losing one log line must not abort a sniff.
 *
 * Lifecycle
 * =========
 *   openSession({ sessionId, pageUrl, ... })
 *      → emit('session:open')
 *      → log('session', 'session.open', ...)
 *      → IPC 'session:log:open'
 *
 *   log({ sessionId, stage, ... })  // many times
 *      → bump seq, persist entry, IPC 'session:log:append'
 *
 *   closeSession({ sessionId, outcome })
 *      → log('session', 'session.close', ...)
 *      → emit('session:close')
 *      → IPC 'session:log:close'
 *
 * Re-opening a session id (e.g. the renderer pins the same sniff
 * round to a follow-up batch) is supported: the in-memory counter
 * resumes from MAX(seq) + 1 by reading it back from the DB on
 * first touch.
 */

import { BrowserWindow } from 'electron';
import { openDb } from './db';
import { createSessionLogRepo, type SessionLogRepo } from './db/repos/sessionLogRepo';
import { log as appLog } from './logger';
import type {
  SessionLogEntry,
  SessionLogLevel,
  SessionLogStage,
  SessionLogSnapshot
} from '../shared/types/log';

let cachedRepo: SessionLogRepo | null = null;

function getRepo(): SessionLogRepo {
  if (!cachedRepo) cachedRepo = createSessionLogRepo(openDb());
  return cachedRepo;
}

/** Session-local seq counters. Lazily seeded from DB on first emit. */
const seqMap = new Map<string, number>();

/** Targets we broadcast `session:log:*` events to. main/index.ts wires
 *  the active mainWindow in here on app ready so the logger module
 *  doesn't have to import the BrowserWindow holder transitively. */
const broadcastTargets: Set<BrowserWindow> = new Set();

export function attachSessionLogBroadcast(win: BrowserWindow): void {
  broadcastTargets.add(win);
  win.on('closed', () => broadcastTargets.delete(win));
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of broadcastTargets) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch {
      /* swallow — logging never crashes the host */
    }
  }
}

function nextSeq(sessionId: string): number {
  const cur = seqMap.get(sessionId);
  if (cur !== undefined) {
    const next = cur + 1;
    seqMap.set(sessionId, next);
    return next;
  }
  // First touch — seed from the DB so a re-pin on an existing session
  // continues the seq instead of overwriting earlier entries.
  let seed = 0;
  try {
    const snap = getRepo().read(sessionId);
    if (snap && snap.entries.length > 0) {
      seed = snap.entries[snap.entries.length - 1].seq;
    }
  } catch {
    /* ignore — we degrade to seq=0 if the DB is unhappy */
  }
  const first = seed + 1;
  seqMap.set(sessionId, first);
  return first;
}

export interface OpenSessionArgs {
  sessionId: string;
  pageUrl?: string;
  title?: string;
  origin?: string;
}

/** Mint or re-attach a session row. Idempotent — safe to call multiple
 *  times for the same id. */
export function openSession(args: OpenSessionArgs): void {
  const openedAt = Date.now();
  try {
    getRepo().open({
      sessionId: args.sessionId,
      openedAt,
      pageUrl: args.pageUrl ?? '',
      title: args.title,
      origin: args.origin
    });
  } catch (e) {
    appLog(`[sessionLogger] open(${args.sessionId}) failed: ${(e as Error).message}`);
  }
  broadcast('session:log:open', {
    sessionId: args.sessionId,
    openedAt,
    pageUrl: args.pageUrl ?? '',
    title: args.title,
    origin: args.origin
  });
  // Seed with a session-level entry so the .log export always starts
  // with a clear "── session opened ──" line.
  log({
    sessionId: args.sessionId,
    stage: 'session',
    level: 'info',
    substep: 'session.open',
    message: `session opened: ${args.origin ?? 'sniff'}${args.pageUrl ? ' ' + args.pageUrl : ''}`,
    data: {
      pageUrl: args.pageUrl ?? '',
      title: args.title,
      origin: args.origin
    }
  });
}

/** Re-open a previously closed session so a new pipeline stage (e.g.
 *  upload arriving after process already finalised the row) can keep
 *  emitting entries against the same session_id. Clears `closed_at`
 *  and `outcome` in the DB row, broadcasts a `session:log:open` so
 *  renderer state machines flip back to "in progress", and emits a
 *  `session.reopen` entry so the audit trail is explicit about the
 *  resurrection. No-op if the session does not exist. */
export function reopenSession(args: { sessionId: string; origin?: string }): void {
  try {
    const existing = getRepo().read(args.sessionId);
    if (!existing) {
      // Nothing to reopen — caller should have called openSession first.
      return;
    }
    getRepo().reopen(args.sessionId);
    broadcast('session:log:open', {
      sessionId: args.sessionId,
      openedAt: existing.openedAt,
      pageUrl: existing.pageUrl,
      title: existing.title,
      origin: args.origin ?? existing.origin
    });
    log({
      sessionId: args.sessionId,
      stage: 'session',
      level: 'info',
      substep: 'session.reopen',
      message: `session reopened: ${args.origin ?? 'unknown'}`,
      data: { origin: args.origin }
    });
  } catch (e) {
    appLog(`[sessionLogger] reopen(${args.sessionId}) failed: ${(e as Error).message}`);
  }
}

export interface UpdateSessionMetaArgs {
  sessionId: string;
  title?: string;
  pageUrl?: string;
}

/** Patch the session row's meta after the fact (the page <title> is
 *  often only known after the first DOM scan). */
export function updateSessionMeta(args: UpdateSessionMetaArgs): void {
  try {
    getRepo().updateMeta(args);
  } catch (e) {
    appLog(`[sessionLogger] updateMeta(${args.sessionId}) failed: ${(e as Error).message}`);
  }
}

export interface LogArgs {
  sessionId: string;
  stage: SessionLogStage;
  level?: SessionLogLevel;
  substep?: string;
  message: string;
  data?: Record<string, unknown>;
}

/** Append one entry. Never throws. */
export function log(args: LogArgs): SessionLogEntry | null {
  if (!args.sessionId) return null;
  const seq = nextSeq(args.sessionId);
  const ts = Date.now();
  const level: SessionLogLevel = args.level ?? 'info';
  const entry: SessionLogEntry = {
    sessionId: args.sessionId,
    seq,
    ts,
    level,
    stage: args.stage,
    message: args.message
  };
  if (args.substep) entry.substep = args.substep;
  if (args.data) entry.data = args.data;
  try {
    getRepo().append([
      {
        sessionId: entry.sessionId,
        seq: entry.seq,
        ts: entry.ts,
        level: entry.level,
        stage: entry.stage,
        substep: entry.substep,
        message: entry.message,
        data: entry.data
      }
    ]);
  } catch (e) {
    appLog(`[sessionLogger] append(${args.sessionId}) failed: ${(e as Error).message}`);
  }
  broadcast('session:log:append', entry);
  return entry;
}

export interface CloseSessionArgs {
  sessionId: string;
  outcome: 'done' | 'cancelled' | 'error';
  message?: string;
  data?: Record<string, unknown>;
}

export function closeSession(args: CloseSessionArgs): void {
  log({
    sessionId: args.sessionId,
    stage: 'session',
    level: args.outcome === 'error' ? 'error' : 'info',
    substep: `session.${args.outcome}`,
    message: args.message ?? `session ${args.outcome}`,
    data: args.data
  });
  const closedAt = Date.now();
  try {
    getRepo().close({ sessionId: args.sessionId, closedAt, outcome: args.outcome });
  } catch (e) {
    appLog(`[sessionLogger] close(${args.sessionId}) failed: ${(e as Error).message}`);
  }
  broadcast('session:log:close', {
    sessionId: args.sessionId,
    closedAt,
    outcome: args.outcome
  });
  // Drop the in-memory counter so the next openSession on this id
  // re-seeds from DB cleanly.
  seqMap.delete(args.sessionId);
}

/** Synchronous DB read — used by the IPC layer. */
export function readSession(sessionId: string): SessionLogSnapshot | null {
  try {
    return getRepo().read(sessionId);
  } catch (e) {
    appLog(`[sessionLogger] read(${sessionId}) failed: ${(e as Error).message}`);
    return null;
  }
}

export function listSessions(): Array<Omit<SessionLogSnapshot, 'entries'>> {
  try {
    return getRepo().listAll();
  } catch (e) {
    appLog(`[sessionLogger] listAll failed: ${(e as Error).message}`);
    return [];
  }
}

export function removeSession(sessionId: string): void {
  try {
    getRepo().remove(sessionId);
  } catch (e) {
    appLog(`[sessionLogger] remove(${sessionId}) failed: ${(e as Error).message}`);
  }
  seqMap.delete(sessionId);
}

export function clearSessions(): void {
  try {
    getRepo().clear();
  } catch (e) {
    appLog(`[sessionLogger] clear failed: ${(e as Error).message}`);
  }
  seqMap.clear();
}

/**
 * Render a session snapshot to a plain-text `.log` payload, one entry
 * per line. Format:
 *
 *     [2026-05-20T10:00:00.000Z] [INFO ] [sniff/http.fetch] message
 *       data: {"url":"https://example.com"}
 *
 * The `data:` indent is only emitted when the entry carries a payload.
 */
export function snapshotToLogText(snap: SessionLogSnapshot): string {
  const lines: string[] = [];
  lines.push(`# session ${snap.sessionId}`);
  lines.push(`# opened ${new Date(snap.openedAt).toISOString()}`);
  if (snap.closedAt) {
    lines.push(`# closed ${new Date(snap.closedAt).toISOString()} outcome=${snap.outcome ?? 'unknown'}`);
  }
  if (snap.pageUrl) lines.push(`# pageUrl ${snap.pageUrl}`);
  if (snap.title) lines.push(`# title ${snap.title}`);
  if (snap.origin) lines.push(`# origin ${snap.origin}`);
  lines.push('');
  for (const e of snap.entries) {
    const ts = new Date(e.ts).toISOString();
    const level = e.level.toUpperCase().padEnd(5, ' ');
    const tag = e.substep ? `${e.stage}/${e.substep}` : e.stage;
    lines.push(`[${ts}] [${level}] [${tag}] ${e.message}`);
    if (e.data && Object.keys(e.data).length > 0) {
      lines.push(`  data: ${JSON.stringify(e.data)}`);
    }
  }
  return lines.join('\n');
}

export function snapshotToJsonText(snap: SessionLogSnapshot): string {
  return JSON.stringify(snap, null, 2);
}

/** Test helper — drop the cached repo so a re-`openDb()` (the
 *  test harness pattern) gets fresh prepared statements. */
export function _resetSessionLoggerCacheForTests(): void {
  cachedRepo = null;
  seqMap.clear();
  broadcastTargets.clear();
}
