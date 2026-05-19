/**
 * R-80 — bootstrapImport unit tests.
 *
 * The importer is the seam that takes the renderer's raw localStorage
 * JSON strings (R-79b envelope `{ version, payload }` *or* legacy
 * bare-array) and lifts them into SQLite under a single transaction
 * with INSERT OR IGNORE semantics. We test:
 *   - Envelope and bare-array shapes both decode.
 *   - Malformed JSON produces zero inserts (no throw).
 *   - Already-present rows are skipped (idempotent re-run).
 *   - Per-family insert counts in the result match what's in the DB.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDb, type TestDb } from './openTestDb';
import { bootstrapImport } from '../../../src/main/db/bootstrapImport';
import { createHistoryRepo } from '../../../src/main/db/repos/historyRepo';
import { createSniffHistoryRepo } from '../../../src/main/db/repos/sniffHistoryRepo';
import { createUploadHistoryRepo } from '../../../src/main/db/repos/uploadHistoryRepo';
import { createToolboxHistoryRepo } from '../../../src/main/db/repos/toolboxHistoryRepo';

function envelope(version: number, payload: unknown[]): string {
  return JSON.stringify({ version, payload });
}

describe('R-80 bootstrapImport', () => {
  let db: TestDb;
  beforeEach(() => {
    db = openTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it('imports envelope-shaped history payload', () => {
    const histPayload = envelope(1, [
      {
        id: 'h1',
        createdAt: 100,
        pageUrl: 'https://x',
        title: 't',
        items: [],
        options: {},
        outputsByTaskId: {},
        taskStatus: {}
      }
    ]);
    const result = bootstrapImport(db, { history: histPayload });
    expect(result).toEqual({
      history: 1,
      uploadHistory: 0,
      sniffHistory: 0,
      toolboxHistory: 0
    });
    expect(createHistoryRepo(db).readAll()).toHaveLength(1);
  });

  it('accepts legacy bare-array payload (pre-R-79b shape)', () => {
    const bareArr = JSON.stringify([
      { url: 'https://a', ts: 100, title: 't1' },
      { url: 'https://b', ts: 200 }
    ]);
    const result = bootstrapImport(db, { sniffHistory: bareArr });
    expect(result.sniffHistory).toBe(2);
    expect(createSniffHistoryRepo(db).readAll()).toHaveLength(2);
  });

  it('returns zero counts for malformed JSON without throwing', () => {
    const result = bootstrapImport(db, {
      history: '{not json',
      uploadHistory: 'also broken',
      sniffHistory: '[}',
      toolboxHistory: 'NaN'
    });
    expect(result).toEqual({
      history: 0,
      uploadHistory: 0,
      sniffHistory: 0,
      toolboxHistory: 0
    });
  });

  it('is idempotent: a second call inserts zero new rows', () => {
    const upPayload = envelope(1, [
      {
        id: 'u1',
        createdAt: 100,
        backend: 'github',
        items: [
          { jobId: 'j1', filePath: '/tmp/a', fileName: 'a', status: 'done' }
        ]
      }
    ]);
    const r1 = bootstrapImport(db, { uploadHistory: upPayload });
    expect(r1.uploadHistory).toBe(1);
    const r2 = bootstrapImport(db, { uploadHistory: upPayload });
    expect(r2.uploadHistory).toBe(0);
    expect(createUploadHistoryRepo(db).readAll()).toHaveLength(1);
  });

  it('drops malformed individual rows but keeps valid neighbours', () => {
    const tbPayload = envelope(1, [
      // valid
      {
        id: 't1',
        kind: 'gif-resize',
        inputPath: '/tmp/in.gif',
        displayName: 'in.gif',
        outputs: ['/tmp/out.gif'],
        params: {},
        status: 'done',
        finishedAt: 100
      },
      // missing required fields
      { id: 't2', kind: 'gif-resize' },
      // invalid status
      {
        id: 't3',
        kind: 'gif-resize',
        inputPath: '/in',
        displayName: 'in',
        outputs: [],
        params: {},
        status: 'bogus',
        finishedAt: 200
      }
    ]);
    const result = bootstrapImport(db, { toolboxHistory: tbPayload });
    expect(result.toolboxHistory).toBe(1);
    expect(createToolboxHistoryRepo(db).readAll().map((r) => r.id)).toEqual(['t1']);
  });
});
