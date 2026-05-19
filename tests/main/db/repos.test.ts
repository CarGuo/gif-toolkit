/**
 * R-80 — Repo unit tests. One describe block per repo, exercising
 * the CRUD round-trip + idempotency contracts.
 *
 * What we test:
 *   - readAll returns rows in the documented order (created_at DESC
 *     for outer records, position ASC for upload items).
 *   - upsert inserts then replaces the same id.
 *   - remove deletes only the targeted row.
 *   - clear empties the table.
 *   - insertManyRaw skips conflicts (INSERT OR IGNORE) and reports
 *     the number of new rows added.
 *
 * What we don't test:
 *   - The renderer ⇄ wire-shape conversion is delegated to
 *     bootstrapImport.test.ts — repos receive already-shaped rows.
 *   - We don't fuzz JSON corruption here; the defensive `parseJson`
 *     fallback is exercised by feeding malformed values directly
 *     into the underlying tables and reading back via readAll.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDb, type TestDb } from './openTestDb';
import {
  createHistoryRepo,
  type HistoryRow
} from '../../../src/main/db/repos/historyRepo';
import {
  createUploadHistoryRepo,
  type UploadHistoryRow
} from '../../../src/main/db/repos/uploadHistoryRepo';
import {
  createSniffHistoryRepo,
  type SniffHistoryRow
} from '../../../src/main/db/repos/sniffHistoryRepo';
import {
  createToolboxHistoryRepo,
  type ToolboxHistoryRow
} from '../../../src/main/db/repos/toolboxHistoryRepo';

describe('historyRepo', () => {
  let db: TestDb;
  beforeEach(() => {
    db = openTestDb();
  });
  afterEach(() => {
    db.close();
  });

  function sample(id: string, createdAt: number): HistoryRow {
    return {
      id,
      createdAt,
      pageUrl: `https://example.test/${id}`,
      title: `t-${id}`,
      outputDir: '/tmp/out',
      items: [{ id: 'i1', kind: 'video' }],
      options: { framerate: 12 },
      outputsByTaskId: { i1: ['/tmp/a.gif'] },
      taskStatus: { i1: 'done' },
      uploadsByOutputPath: { '/tmp/a.gif': { backend: 'github' } }
    };
  }

  it('round-trips a record with deep JSON columns', () => {
    const repo = createHistoryRepo(db);
    const rec = sample('h1', 1000);
    repo.upsert(rec);
    const all = repo.readAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject(rec);
  });

  it('orders readAll by created_at desc', () => {
    const repo = createHistoryRepo(db);
    repo.upsert(sample('a', 100));
    repo.upsert(sample('b', 300));
    repo.upsert(sample('c', 200));
    expect(repo.readAll().map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('upsert replaces an existing row', () => {
    const repo = createHistoryRepo(db);
    repo.upsert(sample('h1', 100));
    const updated = { ...sample('h1', 100), title: 'updated' };
    repo.upsert(updated);
    const all = repo.readAll();
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('updated');
  });

  it('remove and clear', () => {
    const repo = createHistoryRepo(db);
    repo.upsert(sample('h1', 1));
    repo.upsert(sample('h2', 2));
    repo.remove('h1');
    expect(repo.readAll().map((r) => r.id)).toEqual(['h2']);
    repo.clear();
    expect(repo.readAll()).toEqual([]);
  });

  it('insertManyRaw skips duplicates and reports new-row count', () => {
    const repo = createHistoryRepo(db);
    repo.upsert(sample('h1', 1));
    const inserted = repo.insertManyRaw([sample('h1', 1), sample('h2', 2), sample('h3', 3)]);
    expect(inserted).toBe(2);
    expect(repo.readAll().map((r) => r.id)).toEqual(['h3', 'h2', 'h1']);
  });

  it('drops corrupt items_json rows from readAll', () => {
    db.prepare(
      `INSERT INTO history (id, created_at, page_url, items_json, options_json) VALUES (?, ?, ?, ?, ?)`
    ).run('bad', 100, 'https://x', '{not valid json', '{}');
    const repo = createHistoryRepo(db);
    expect(repo.readAll()).toEqual([]);
  });
});

describe('uploadHistoryRepo', () => {
  let db: TestDb;
  beforeEach(() => {
    db = openTestDb();
  });
  afterEach(() => {
    db.close();
  });

  function sample(id: string, createdAt: number): UploadHistoryRow {
    return {
      id,
      createdAt,
      backend: 'github',
      items: [
        {
          jobId: `${id}-1`,
          filePath: '/tmp/a.gif',
          fileName: 'a.gif',
          status: 'done',
          url: 'https://cdn/a.gif',
          markdown: '![a](https://cdn/a.gif)',
          fileHash: 'sha256:abc',
          reused: false,
          percent: 100
        },
        {
          jobId: `${id}-2`,
          filePath: '/tmp/b.gif',
          fileName: 'b.gif',
          status: 'failed',
          error: 'bang'
        }
      ]
    };
  }

  it('round-trips a record with multiple items in insertion order', () => {
    const repo = createUploadHistoryRepo(db);
    const rec = sample('u1', 100);
    repo.upsert(rec);
    const all = repo.readAll();
    expect(all).toHaveLength(1);
    expect(all[0].items.map((i) => i.jobId)).toEqual(['u1-1', 'u1-2']);
    expect(all[0].items[0]).toMatchObject({
      url: 'https://cdn/a.gif',
      reused: false,
      percent: 100
    });
    expect(all[0].items[1].error).toBe('bang');
  });

  it('upsert wholesale-replaces children (delete-then-insert)', () => {
    const repo = createUploadHistoryRepo(db);
    repo.upsert(sample('u1', 100));
    const replacement: UploadHistoryRow = {
      id: 'u1',
      createdAt: 100,
      backend: 'qiniu',
      items: [
        {
          jobId: 'u1-only',
          filePath: '/tmp/only.gif',
          fileName: 'only.gif',
          status: 'done'
        }
      ]
    };
    repo.upsert(replacement);
    const all = repo.readAll();
    expect(all[0].backend).toBe('qiniu');
    expect(all[0].items.map((i) => i.jobId)).toEqual(['u1-only']);
  });

  it('remove cascades to upload_history_items', () => {
    const repo = createUploadHistoryRepo(db);
    repo.upsert(sample('u1', 100));
    repo.remove('u1');
    const cnt = db.prepare('SELECT COUNT(*) AS n FROM upload_history_items').get() as { n: number };
    expect(cnt.n).toBe(0);
  });

  it('insertManyRaw skips duplicate parents', () => {
    const repo = createUploadHistoryRepo(db);
    repo.upsert(sample('u1', 100));
    const n = repo.insertManyRaw([sample('u1', 100), sample('u2', 200)]);
    expect(n).toBe(1);
    expect(repo.readAll().map((r) => r.id)).toEqual(['u2', 'u1']);
  });
});

describe('sniffHistoryRepo', () => {
  let db: TestDb;
  beforeEach(() => {
    db = openTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it('upsert dedupes by URL', () => {
    const repo = createSniffHistoryRepo(db);
    const e: SniffHistoryRow = { url: 'https://x', title: 't1', ts: 100, itemCount: 3 };
    repo.upsert(e);
    repo.upsert({ ...e, title: 't2', ts: 200, itemCount: 5 });
    const all = repo.readAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ title: 't2', ts: 200, itemCount: 5 });
  });

  it('orders by ts desc', () => {
    const repo = createSniffHistoryRepo(db);
    repo.upsert({ url: 'a', ts: 100 });
    repo.upsert({ url: 'b', ts: 300 });
    repo.upsert({ url: 'c', ts: 200 });
    expect(repo.readAll().map((r) => r.url)).toEqual(['b', 'c', 'a']);
  });

  it('insertManyRaw + clear', () => {
    const repo = createSniffHistoryRepo(db);
    const n = repo.insertManyRaw([
      { url: 'a', ts: 1 },
      { url: 'b', ts: 2 }
    ]);
    expect(n).toBe(2);
    repo.clear();
    expect(repo.readAll()).toEqual([]);
  });
});

describe('toolboxHistoryRepo', () => {
  let db: TestDb;
  beforeEach(() => {
    db = openTestDb();
  });
  afterEach(() => {
    db.close();
  });

  function sample(id: string, finishedAt: number): ToolboxHistoryRow {
    return {
      id,
      kind: 'gif-resize',
      inputPath: '/tmp/in.gif',
      displayName: 'in.gif',
      outputs: ['/tmp/out.gif'],
      params: { width: 480 },
      status: 'done',
      finishedAt
    };
  }

  it('round-trips a single entry', () => {
    const repo = createToolboxHistoryRepo(db);
    repo.upsert(sample('t1', 100));
    const all = repo.readAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: 't1', kind: 'gif-resize', status: 'done' });
    expect(all[0].outputs).toEqual(['/tmp/out.gif']);
    expect(all[0].params).toEqual({ width: 480 });
  });

  it('drops invalid status rows from readAll', () => {
    db.prepare(
      `INSERT INTO toolbox_history (id, kind, input_path, display_name, status, finished_at, outputs_json, params_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('bad', 'gif-resize', '/tmp/in', 'in', 'mystery-status', 100, '[]', '{}');
    const repo = createToolboxHistoryRepo(db);
    expect(repo.readAll()).toEqual([]);
  });

  it('orders by finished_at desc', () => {
    const repo = createToolboxHistoryRepo(db);
    repo.upsert(sample('a', 100));
    repo.upsert(sample('b', 300));
    repo.upsert(sample('c', 200));
    expect(repo.readAll().map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });
});
