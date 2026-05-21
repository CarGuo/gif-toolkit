/**
 * Repo unit tests for `session_logs` + `session_log_entries`.
 *
 * Same in-memory-DB pattern as `repos.test.ts`. We exercise the
 * append-only contract, the FK cascade on `remove`, the
 * `INSERT OR IGNORE`-style idempotent `open`, and the
 * data_json round-trip + corruption tolerance documented on
 * [createSessionLogRepo](../../../src/main/db/repos/sessionLogRepo.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDb, type TestDb } from './openTestDb';
import { createSessionLogRepo } from '../../../src/main/db/repos/sessionLogRepo';

describe('sessionLogRepo', () => {
  let db: TestDb;
  beforeEach(() => {
    db = openTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it('open + append + read round-trip', () => {
    const repo = createSessionLogRepo(db);
    repo.open({ sessionId: 's1', openedAt: 100, pageUrl: 'https://x', title: 'X', origin: 'sniff:url' });
    repo.append([
      { sessionId: 's1', seq: 1, ts: 110, level: 'info', stage: 'sniff', substep: 'http.fetch', message: 'GET https://x' },
      { sessionId: 's1', seq: 2, ts: 120, level: 'debug', stage: 'sniff', message: 'parsed', data: { count: 3 } },
      { sessionId: 's1', seq: 3, ts: 130, level: 'warn', stage: 'process', message: 'phaseB skipped' }
    ]);
    repo.close({ sessionId: 's1', closedAt: 200, outcome: 'done' });

    const snap = repo.read('s1');
    expect(snap).not.toBeNull();
    expect(snap!.sessionId).toBe('s1');
    expect(snap!.openedAt).toBe(100);
    expect(snap!.closedAt).toBe(200);
    expect(snap!.outcome).toBe('done');
    expect(snap!.title).toBe('X');
    expect(snap!.entries).toHaveLength(3);
    expect(snap!.entries[1].data).toEqual({ count: 3 });
    expect(snap!.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('open is idempotent (re-open does NOT overwrite metadata)', () => {
    const repo = createSessionLogRepo(db);
    repo.open({ sessionId: 's1', openedAt: 100, pageUrl: 'https://a', origin: 'sniff:url' });
    repo.open({ sessionId: 's1', openedAt: 999, pageUrl: 'https://b', origin: 'process:start' });
    const snap = repo.read('s1');
    expect(snap!.openedAt).toBe(100);
    expect(snap!.pageUrl).toBe('https://a');
    expect(snap!.origin).toBe('sniff:url');
  });

  it('updateMeta patches title / pageUrl without clobbering other fields', () => {
    const repo = createSessionLogRepo(db);
    repo.open({ sessionId: 's1', openedAt: 100, pageUrl: '' });
    repo.updateMeta({ sessionId: 's1', title: 'Late title', pageUrl: 'https://late' });
    const snap = repo.read('s1');
    expect(snap!.title).toBe('Late title');
    expect(snap!.pageUrl).toBe('https://late');
  });

  it('listAll orders newest-first and omits entries', () => {
    const repo = createSessionLogRepo(db);
    repo.open({ sessionId: 's-old', openedAt: 100, pageUrl: 'a' });
    repo.open({ sessionId: 's-new', openedAt: 200, pageUrl: 'b' });
    repo.append([{ sessionId: 's-new', seq: 1, ts: 201, level: 'info', stage: 'sniff', message: 'hi' }]);
    const list = repo.listAll();
    expect(list.map((s) => s.sessionId)).toEqual(['s-new', 's-old']);
    // listAll should NOT pull entries (cost optimisation).
    expect((list[0] as { entries?: unknown }).entries).toBeUndefined();
  });

  it('remove cascades to entries via FK', () => {
    const repo = createSessionLogRepo(db);
    repo.open({ sessionId: 's1', openedAt: 100, pageUrl: 'a' });
    repo.append([{ sessionId: 's1', seq: 1, ts: 101, level: 'info', stage: 'sniff', message: 'x' }]);
    repo.remove('s1');
    expect(repo.read('s1')).toBeNull();
    const remaining = db.prepare('SELECT COUNT(*) AS c FROM session_log_entries').get() as { c: number };
    expect(remaining.c).toBe(0);
  });

  it('clear empties both tables', () => {
    const repo = createSessionLogRepo(db);
    repo.open({ sessionId: 's1', openedAt: 100, pageUrl: 'a' });
    repo.append([{ sessionId: 's1', seq: 1, ts: 101, level: 'info', stage: 'sniff', message: 'x' }]);
    repo.clear();
    expect(repo.listAll()).toHaveLength(0);
    const remaining = db.prepare('SELECT COUNT(*) AS c FROM session_log_entries').get() as { c: number };
    expect(remaining.c).toBe(0);
  });

  it('rejects duplicate (sessionId, seq)', () => {
    const repo = createSessionLogRepo(db);
    repo.open({ sessionId: 's1', openedAt: 100, pageUrl: 'a' });
    repo.append([{ sessionId: 's1', seq: 1, ts: 101, level: 'info', stage: 'sniff', message: 'x' }]);
    expect(() => repo.append([
      { sessionId: 's1', seq: 1, ts: 102, level: 'info', stage: 'sniff', message: 'dup' }
    ])).toThrow();
  });

  it('tolerates corrupt data_json on read', () => {
    const repo = createSessionLogRepo(db);
    repo.open({ sessionId: 's1', openedAt: 100, pageUrl: 'a' });
    db.prepare(
      `INSERT INTO session_log_entries (session_id, seq, ts, level, stage, substep, message, data_json)
       VALUES (@sid, 1, 101, 'info', 'sniff', NULL, 'broken', '{not-json')`
    ).run({ sid: 's1' });
    const snap = repo.read('s1');
    expect(snap!.entries).toHaveLength(1);
    expect(snap!.entries[0].data).toBeUndefined();
  });

  it('pruneClosedBefore drops only closed-and-old sessions', () => {
    const repo = createSessionLogRepo(db);
    repo.open({ sessionId: 's-keep-open', openedAt: 100, pageUrl: 'a' });
    repo.open({ sessionId: 's-keep-recent', openedAt: 100, pageUrl: 'b' });
    repo.close({ sessionId: 's-keep-recent', closedAt: 999, outcome: 'done' });
    repo.open({ sessionId: 's-prune', openedAt: 100, pageUrl: 'c' });
    repo.close({ sessionId: 's-prune', closedAt: 200, outcome: 'done' });
    const removed = repo.pruneClosedBefore(500);
    expect(removed).toBe(1);
    expect(repo.read('s-prune')).toBeNull();
    expect(repo.read('s-keep-open')).not.toBeNull();
    expect(repo.read('s-keep-recent')).not.toBeNull();
  });

  it('reopen clears closed_at + outcome but preserves entries', () => {
    const repo = createSessionLogRepo(db);
    repo.open({ sessionId: 's1', openedAt: 100, pageUrl: 'a' });
    repo.append([
      { sessionId: 's1', seq: 1, ts: 110, level: 'info', stage: 'sniff', message: 'one' }
    ]);
    repo.close({ sessionId: 's1', closedAt: 200, outcome: 'done' });
    expect(repo.read('s1')!.closedAt).toBe(200);
    expect(repo.read('s1')!.outcome).toBe('done');

    repo.reopen('s1');
    const after = repo.read('s1')!;
    expect(after.closedAt).toBeUndefined();
    expect(after.outcome).toBeUndefined();
    expect(after.entries).toHaveLength(1);
    expect(after.entries[0].seq).toBe(1);

    // Subsequent appends must continue from seq=2 (caller still
    // controls seq numbering — the repo only enforces uniqueness).
    repo.append([
      { sessionId: 's1', seq: 2, ts: 300, level: 'info', stage: 'upload', message: 'after-reopen' }
    ]);
    expect(repo.read('s1')!.entries.map((e) => e.seq)).toEqual([1, 2]);

    // Re-close with new outcome works.
    repo.close({ sessionId: 's1', closedAt: 400, outcome: 'cancelled' });
    expect(repo.read('s1')!.closedAt).toBe(400);
    expect(repo.read('s1')!.outcome).toBe('cancelled');
  });

  it('reopen on a non-existent session is a no-op', () => {
    const repo = createSessionLogRepo(db);
    expect(() => repo.reopen('does-not-exist')).not.toThrow();
    expect(repo.read('does-not-exist')).toBeNull();
  });
});
