/**
 * SUITE SESSION-LOGS-IPC — `db:sessionLogs:*` schema-and-defence lock
 * (R-SESSION-LOGS-IPC-V1).
 *
 * Why this SUITE exists
 * ---------------------
 * The session log channel is the only persistent surface the user can
 * see ("查看日志" button on every history row) and *export* to disk —
 * meaning a silent regression here turns into a support ticket.
 *
 *   - [db:sessionLogs:list](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/db/dbIpc.ts#L250-L250)
 *     MUST return an array of meta-only [SessionLogSnapshot](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types/log.ts#L75-L95) objects
 *     (no `entries`, the picker doesn't need them).
 *   - [db:sessionLogs:read](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/db/dbIpc.ts#L251-L254)
 *     resolves with `null` for non-existent / empty sessionId — never
 *     throws. Bridge enforces type via [ensureString](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/index.ts#L41-L44).
 *   - [db:sessionLogs:remove](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/db/dbIpc.ts#L255-L258)
 *     is idempotent: removing an unknown id resolves with `void`.
 *   - [db:sessionLogs:clear](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/db/dbIpc.ts#L259-L261)
 *     wipes everything; observable via a follow-up `list` returning
 *     length 0.
 *   - [db:sessionLogs:export](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/db/dbIpc.ts#L265-L291)
 *     rejects on missing payload / missing sessionId / unknown
 *     sessionId — the renderer relies on this to surface a toast.
 */
import { test, expect } from '@playwright/test';
import { getHarness } from './_harness';

interface SessionMetaWire {
  sessionId: string;
  openedAt: number;
  closedAt?: number;
  pageUrl: string;
  title?: string;
  origin?: string;
  outcome?: 'done' | 'cancelled' | 'error';
}

interface SessionLogEntryWire {
  sessionId: string;
  seq: number;
  ts: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  stage: 'session' | 'sniff' | 'process' | 'upload' | 'resolve' | 'toolbox';
  substep?: string;
  message: string;
  data?: Record<string, unknown>;
}

interface SessionSnapshotWire extends SessionMetaWire {
  entries: SessionLogEntryWire[];
}

test.describe('SUITE SESSION-LOGS-IPC — db:sessionLogs:* schema + defence', () => {
  test('SUITE LOGS-A — list returns an array of meta-only snapshots (no `entries` field)', async () => {
    test.setTimeout(15_000);
    const { page } = getHarness();
    const r = (await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: { db: { sessionLogs: { list(): Promise<unknown[]> } } };
      };
      return w.giftk.db.sessionLogs.list();
    })) as SessionMetaWire[];
    expect(Array.isArray(r)).toBe(true);
    // Each meta MUST satisfy the documented shape and MUST NOT carry
    // an `entries` array (it's stripped server-side to keep the picker
    // payload small).
    for (const meta of r) {
      expect(typeof meta.sessionId).toBe('string');
      expect(meta.sessionId.length).toBeGreaterThan(0);
      expect(typeof meta.openedAt).toBe('number');
      expect(Number.isFinite(meta.openedAt)).toBe(true);
      expect(typeof meta.pageUrl).toBe('string');
      expect((meta as unknown as { entries?: unknown }).entries).toBeUndefined();
      if (meta.outcome !== undefined) {
        expect(['done', 'cancelled', 'error']).toContain(meta.outcome);
      }
    }
  });

  test('SUITE LOGS-B — read resolves null for unknown sessionId; bridge rejects empty / non-string', async () => {
    test.setTimeout(15_000);
    const { page } = getHarness();
    const r = await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: {
          db: {
            sessionLogs: {
              read(sessionId: string): Promise<SessionSnapshotWire | null>;
            };
          };
        };
      };
      // Random nonexistent id — main returns null (never throws).
      const unknown = await w.giftk.db.sessionLogs.read('does-not-exist-' + Date.now());
      // Empty string — bridge ensureString only checks typeof, so it
      // *passes* through to main, which short-circuits to null.
      const empty = await w.giftk.db.sessionLogs.read('');
      // Non-string — bridge ensureString throws synchronously.
      let nullKind: string;
      try {
        await (w.giftk.db.sessionLogs.read as unknown as (
          v: unknown
        ) => Promise<SessionSnapshotWire | null>)(null);
        nullKind = 'resolved';
      } catch {
        nullKind = 'threw';
      }
      return { unknown, empty, nullKind };
    });
    expect(r.unknown).toBeNull();
    expect(r.empty).toBeNull();
    expect(r.nullKind).toBe('threw');
  });

  test('SUITE LOGS-C — remove on unknown id is idempotent (resolves void, no throw)', async () => {
    test.setTimeout(15_000);
    const { page } = getHarness();
    const r = await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: {
          db: {
            sessionLogs: {
              remove(sessionId: string): Promise<void>;
            };
          };
        };
      };
      // Two consecutive calls on the same nonexistent id — both must
      // resolve, neither must throw, the second must NOT see leftover
      // state from the first.
      const id = 'unknown-session-' + Date.now();
      const a = await w.giftk.db.sessionLogs.remove(id);
      const b = await w.giftk.db.sessionLogs.remove(id);
      return { a, b };
    });
    // remove resolves with `void` — strict-equal to undefined.
    expect(r.a).toBeUndefined();
    expect(r.b).toBeUndefined();
  });

  test('SUITE LOGS-D — export rejects missing payload / missing sessionId / unknown sessionId', async () => {
    test.setTimeout(15_000);
    const { page } = getHarness();
    // The bridge ensures the payload is an object (ensureObject).
    // The main handler then runs three further checks: payload object
    // existence, sessionId non-empty string, and snapshot lookup.
    // We exercise all three rejection paths — the renderer relies on
    // them to surface a toast instead of opening an empty save dialog.
    const r = await page.evaluate(async () => {
      const w = window as unknown as {
        giftk: {
          db: {
            sessionLogs: {
              export(p: unknown): Promise<{ ok: boolean; cancelled?: boolean; path?: string }>;
            };
          };
        };
      };
      const probe = async (p: unknown): Promise<string> => {
        try {
          await w.giftk.db.sessionLogs.export(p);
          return 'resolved';
        } catch (e) {
          return (e as Error).message || 'threw';
        }
      };
      const nullPayload = await probe(null);
      const stringPayload = await probe('not-an-object');
      const missingSession = await probe({ format: 'log' });
      const emptySession = await probe({ sessionId: '', format: 'log' });
      const unknownSession = await probe({
        sessionId: 'unknown-' + Date.now(),
        format: 'log',
      });
      return { nullPayload, stringPayload, missingSession, emptySession, unknownSession };
    });
    // Bridge ensureObject rejects null + non-objects.
    expect(r.nullPayload).not.toBe('resolved');
    expect(r.stringPayload).not.toBe('resolved');
    // Main rejects missing / empty sessionId and unknown sessionId.
    expect(r.missingSession).not.toBe('resolved');
    expect(r.emptySession).not.toBe('resolved');
    expect(r.unknownSession).not.toBe('resolved');
    // Unknown session error message MUST mention `session not found`
    // so the renderer can branch on it for a more helpful toast.
    expect(r.unknownSession.toLowerCase()).toContain('session not found');
  });
});
