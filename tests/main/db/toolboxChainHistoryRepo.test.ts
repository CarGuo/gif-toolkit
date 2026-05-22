/**
 * R-TB-CHAIN — toolbox_chain_history repo unit tests.
 *
 * Coverage parallels [repos.test.ts](./repos.test.ts) for the batch
 * toolbox table:
 *   1. CRUD round-trip — readAll / upsert / remove / clear.
 *   2. readAll orders rows by finished_at DESC.
 *   3. Defensive JSON parsing — readAll drops rows whose status is
 *      out of contract or whose steps_json is malformed; valid steps
 *      inside a partial row survive.
 *   4. upsert replaces an existing id verbatim.
 *
 * NOTE: Requires the host-Node ABI build of better-sqlite3. Run with
 *   `npm run test:db:to-node && npm run test:db:run`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDb, type TestDb } from './openTestDb';
import { createToolboxChainHistoryRepo } from '../../../src/main/db/repos/toolboxChainHistoryRepo';
import type { ToolboxChainHistoryEntry } from '../../../src/shared/types';

function sampleEntry(
  id: string,
  finishedAt: number,
  overrides: Partial<ToolboxChainHistoryEntry> = {}
): ToolboxChainHistoryEntry {
  return {
    id,
    inputPath: `/tmp/${id}.mp4`,
    displayName: `${id}.mp4`,
    status: 'done',
    outputDir: `/tmp/toolbox/chain-20260522/${id}`,
    finishedAt,
    steps: [
      {
        kind: 'video-to-gif',
        params: { fps: 12 },
        status: 'done',
        outputs: [`/tmp/toolbox/chain-20260522/${id}/step-1-video-to-gif.gif`]
      },
      {
        kind: 'gif-optimize',
        params: { method: 'lossy', lossy: 80 },
        status: 'done',
        outputs: [`/tmp/toolbox/chain-20260522/${id}/step-2-gif-optimize.gif`]
      }
    ],
    ...overrides
  };
}

describe('toolboxChainHistoryRepo', () => {
  let db: TestDb;
  beforeEach(() => {
    db = openTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it('round-trips an upsert through readAll', () => {
    const repo = createToolboxChainHistoryRepo(db);
    repo.upsert(sampleEntry('chain-a', 1000));
    const rows = repo.readAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('chain-a');
    expect(rows[0].steps).toHaveLength(2);
    expect(rows[0].steps[0].kind).toBe('video-to-gif');
    expect(rows[0].steps[1].outputs[0]).toMatch(/step-2-gif-optimize\.gif$/);
  });

  it('orders rows by finished_at DESC', () => {
    const repo = createToolboxChainHistoryRepo(db);
    repo.upsert(sampleEntry('chain-old', 100));
    repo.upsert(sampleEntry('chain-new', 5000));
    repo.upsert(sampleEntry('chain-mid', 1000));
    const rows = repo.readAll();
    expect(rows.map((r) => r.id)).toEqual(['chain-new', 'chain-mid', 'chain-old']);
  });

  it('upsert replaces an existing id and updates every column', () => {
    const repo = createToolboxChainHistoryRepo(db);
    repo.upsert(sampleEntry('chain-x', 100));
    repo.upsert(
      sampleEntry('chain-x', 200, {
        status: 'failed',
        error: 'step 2 produced no outputs',
        steps: [
          {
            kind: 'video-to-gif',
            params: {},
            status: 'done',
            outputs: ['/tmp/step1.gif']
          },
          {
            kind: 'gif-optimize',
            params: {},
            status: 'failed',
            outputs: [],
            error: 'gifsicle returned non-zero'
          }
        ]
      })
    );
    const rows = repo.readAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error).toBe('step 2 produced no outputs');
    expect(rows[0].finishedAt).toBe(200);
    expect(rows[0].steps[1].status).toBe('failed');
    expect(rows[0].steps[1].error).toBe('gifsicle returned non-zero');
  });

  it('remove deletes only the targeted row', () => {
    const repo = createToolboxChainHistoryRepo(db);
    repo.upsert(sampleEntry('a', 100));
    repo.upsert(sampleEntry('b', 200));
    repo.remove('a');
    const rows = repo.readAll();
    expect(rows.map((r) => r.id)).toEqual(['b']);
  });

  it('clear empties the table', () => {
    const repo = createToolboxChainHistoryRepo(db);
    repo.upsert(sampleEntry('a', 100));
    repo.upsert(sampleEntry('b', 200));
    repo.clear();
    expect(repo.readAll()).toHaveLength(0);
  });

  it('readAll drops rows with an out-of-contract status', () => {
    const repo = createToolboxChainHistoryRepo(db);
    repo.upsert(sampleEntry('valid', 100));
    // Inject a corrupted row directly to bypass the repo's contract.
    db.prepare(
      `INSERT INTO toolbox_chain_history (id, input_path, display_name, status, error, output_dir, finished_at, steps_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('bad-status', '/tmp/x.mp4', 'x.mp4', 'awaiting-input', null, '/tmp/out', 50, '[]');
    const rows = repo.readAll();
    expect(rows.map((r) => r.id)).toEqual(['valid']);
  });

  it('readAll tolerates malformed steps_json by returning an empty steps array', () => {
    const repo = createToolboxChainHistoryRepo(db);
    db.prepare(
      `INSERT INTO toolbox_chain_history (id, input_path, display_name, status, error, output_dir, finished_at, steps_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('garbled', '/tmp/x.mp4', 'x.mp4', 'done', null, '/tmp/out', 100, '{not json');
    const rows = repo.readAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].steps).toEqual([]);
  });

  it('readAll filters out individually-bad steps but keeps valid ones in the same row', () => {
    const repo = createToolboxChainHistoryRepo(db);
    const stepsJson = JSON.stringify([
      // valid
      { kind: 'video-to-gif', params: {}, status: 'done', outputs: ['/tmp/a.gif'] },
      // bad: missing kind
      { params: {}, status: 'done', outputs: [] },
      // bad: invalid status
      { kind: 'gif-optimize', params: {}, status: 'awaiting-input', outputs: [] },
      // valid: skipped status
      { kind: 'gif-resize', params: {}, status: 'skipped', outputs: [] }
    ]);
    db.prepare(
      `INSERT INTO toolbox_chain_history (id, input_path, display_name, status, error, output_dir, finished_at, steps_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('mixed', '/tmp/x.mp4', 'x.mp4', 'done', null, '/tmp/out', 100, stepsJson);
    const rows = repo.readAll();
    expect(rows).toHaveLength(1);
    const kinds = rows[0].steps.map((s) => s.kind);
    expect(kinds).toEqual(['video-to-gif', 'gif-resize']);
  });

  it('readAll preserves the optional error field on chain row only when non-null', () => {
    const repo = createToolboxChainHistoryRepo(db);
    repo.upsert(sampleEntry('no-err', 100));
    repo.upsert(sampleEntry('with-err', 200, { status: 'failed', error: 'boom' }));
    const rows = repo.readAll();
    const map = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(map['no-err'].error).toBeUndefined();
    expect(map['with-err'].error).toBe('boom');
  });
});
