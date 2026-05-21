/**
 * Pure-function tests for `snapshotToLogText` / `snapshotToJsonText`.
 *
 * The full sessionLogger module imports `electron` and the DB; the
 * lifecycle (open/log/close + DB persistence + IPC broadcast) is
 * already covered indirectly by [sessionLogRepo.test.ts](./db/sessionLogRepo.test.ts).
 * Here we only exercise the two pure renderers — they have to handle
 * minimal snapshots, missing optional metadata, and entries with
 * structured `data` payloads in a deterministic order.
 *
 * Electron and `./db` are stubbed so importing the module doesn't
 * touch userData paths or open a SQLite connection.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { SessionLogSnapshot } from '../../src/shared/types/log';

vi.mock('electron', () => ({
  BrowserWindow: class {
    isDestroyed(): boolean { return false; }
    webContents = { send: () => undefined };
    on(): void { /* noop */ }
  }
}));

vi.mock('../../src/main/db', () => ({
  openDb: () => { throw new Error('DB should not be opened in pure tests'); }
}));

vi.mock('../../src/main/logger', () => ({
  log: () => undefined
}));

let snapshotToLogText: (s: SessionLogSnapshot) => string;
let snapshotToJsonText: (s: SessionLogSnapshot) => string;

beforeAll(async () => {
  const mod = await import('../../src/main/sessionLogger');
  snapshotToLogText = mod.snapshotToLogText;
  snapshotToJsonText = mod.snapshotToJsonText;
});

function makeSnap(): SessionLogSnapshot {
  return {
    sessionId: 's1',
    openedAt: Date.UTC(2026, 4, 20, 10, 0, 0),
    closedAt: Date.UTC(2026, 4, 20, 10, 0, 5),
    pageUrl: 'https://example.com',
    title: 'Example',
    origin: 'sniff:url',
    outcome: 'done',
    entries: [
      {
        sessionId: 's1', seq: 1,
        ts: Date.UTC(2026, 4, 20, 10, 0, 1),
        level: 'info', stage: 'sniff', substep: 'http.fetch',
        message: 'GET https://example.com'
      },
      {
        sessionId: 's1', seq: 2,
        ts: Date.UTC(2026, 4, 20, 10, 0, 2),
        level: 'warn', stage: 'process',
        message: 'phaseB skipped',
        data: { reason: 'too-large', sizeBytes: 1234 }
      }
    ]
  };
}

describe('snapshotToLogText', () => {
  it('renders a header block + entries with data line when present', () => {
    const out = snapshotToLogText(makeSnap());
    const lines = out.split('\n');
    expect(lines[0]).toBe('# session s1');
    expect(lines).toContain('# pageUrl https://example.com');
    expect(lines).toContain('# title Example');
    expect(lines).toContain('# origin sniff:url');
    // First entry — INFO with substep, no data line
    expect(out).toContain('[INFO ] [sniff/http.fetch] GET https://example.com');
    // Second entry — WARN with no substep, indented data line
    expect(out).toContain('[WARN ] [process] phaseB skipped');
    expect(out).toContain('  data: {"reason":"too-large","sizeBytes":1234}');
  });

  it('omits closed/title/origin lines when those fields are absent', () => {
    const out = snapshotToLogText({
      sessionId: 's2',
      openedAt: 100,
      pageUrl: '',
      entries: []
    });
    expect(out).toContain('# session s2');
    expect(out).not.toContain('# closed');
    expect(out).not.toContain('# title');
    expect(out).not.toContain('# origin');
  });
});

describe('snapshotToJsonText', () => {
  it('round-trips through JSON.parse', () => {
    const snap = makeSnap();
    const txt = snapshotToJsonText(snap);
    const parsed: SessionLogSnapshot = JSON.parse(txt) as SessionLogSnapshot;
    expect(parsed.sessionId).toBe('s1');
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[1].data).toEqual({ reason: 'too-large', sizeBytes: 1234 });
  });

  it('pretty-prints (indented JSON)', () => {
    const txt = snapshotToJsonText(makeSnap());
    expect(txt).toContain('\n  ');
  });
});
