/**
 * R-45 — Tests for the renderer-side upload-history hook + helpers.
 *
 * Covers:
 *   1. Pure helpers (applyProgressToRecord folding rules incl. R-54
 *      hash/reused fields and R-73 percent handling, statusBadge,
 *      summarizeRecord, isUploadConfigured, findUploadByHash,
 *      paginateHistory).
 *   2. R-80 — useUploadHistory hook against a mocked
 *      window.giftk.db.uploadHistory async stub
 *      (readAll/upsert/remove/clear). The hook now exposes an
 *      `isLoading` flag that flips false after the initial readAll
 *      resolves; mutating helpers (start/applyProgress/remove/clear)
 *      forward to the corresponding DB methods, with start/
 *      applyProgress coalesced behind a 250ms idle window.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  applyProgressToRecord,
  isUploadConfigured,
  findUploadByHash,
  paginateHistory,
  useUploadHistory
} from '../../src/renderer/components/useUploadHistory';
import { statusBadge, summarizeRecord } from '../../src/renderer/components/UploadResultModal';
import type { UploadConfigs, UploadHistoryRecord } from '../../src/shared/types';

function makeRecord(): UploadHistoryRecord {
  return {
    id: 'rec-1',
    createdAt: 1700000000000,
    backend: 'customWeb',
    items: [
      { jobId: 'j1', fileName: 'a.gif', filePath: '/o/a.gif', status: 'pending' }
    ]
  };
}

interface FakeUploadDb {
  readAll: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  __rows: UploadHistoryRecord[];
}

function installFakeUploadDb(seed: UploadHistoryRecord[] = []): FakeUploadDb {
  const rows: UploadHistoryRecord[] = seed.slice();
  const fake: FakeUploadDb = {
    readAll: vi.fn(async () => rows.slice()),
    upsert: vi.fn(async (rec: UploadHistoryRecord) => {
      const i = rows.findIndex((r) => r.id === rec.id);
      if (i >= 0) rows[i] = rec; else rows.unshift(rec);
    }),
    remove: vi.fn(async (id: string) => {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
    }),
    clear: vi.fn(async () => { rows.length = 0; }),
    __rows: rows
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).giftk = {
    ...((window as any).giftk || {}),
    db: { uploadHistory: fake }
  };
  return fake;
}

async function flushLoad(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function flushPersist(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    // 250ms upsert debounce window inside the hook.
    await new Promise((res) => setTimeout(res, 260));
  });
}

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).giftk;
});

describe('applyProgressToRecord', () => {
  it('updates status / url / markdown on a matching jobId', () => {
    const before = makeRecord();
    const after = applyProgressToRecord(before, {
      jobId: 'j1', status: 'done', percent: 100, url: 'https://x', markdown: '![a](https://x)'
    });
    expect(after).not.toBe(before);
    expect(after.items[0].status).toBe('done');
    expect(after.items[0].url).toBe('https://x');
    expect(after.items[0].markdown).toBe('![a](https://x)');
  });

  it('returns the same object when no item matches', () => {
    const before = makeRecord();
    const after = applyProgressToRecord(before, {
      jobId: 'nope', status: 'done', percent: 100
    });
    expect(after).toBe(before);
  });

  it('preserves terminal status against later non-terminal emits', () => {
    const before: UploadHistoryRecord = {
      ...makeRecord(),
      items: [{ jobId: 'j1', fileName: 'a.gif', filePath: '/o/a.gif', status: 'done', url: 'https://x' }]
    };
    const after = applyProgressToRecord(before, {
      jobId: 'j1', status: 'uploading', percent: 50
    });
    expect(after.items[0].status).toBe('done');
  });

  it('returns the same object when nothing meaningful changed', () => {
    const before: UploadHistoryRecord = {
      ...makeRecord(),
      items: [{ jobId: 'j1', fileName: 'a.gif', filePath: '/o/a.gif', status: 'done', url: 'https://x', markdown: '![a](https://x)' }]
    };
    const after = applyProgressToRecord(before, {
      jobId: 'j1', status: 'done', percent: 100, url: 'https://x', markdown: '![a](https://x)'
    });
    expect(after).toBe(before);
  });

  it('captures error on failure', () => {
    const before = makeRecord();
    const after = applyProgressToRecord(before, {
      jobId: 'j1', status: 'failed', percent: 0, error: 'boom'
    });
    expect(after.items[0].status).toBe('failed');
    expect(after.items[0].error).toBe('boom');
  });

  it('R-54: folds fileHash and reused flag from progress into the row', () => {
    const before = makeRecord();
    const after = applyProgressToRecord(before, {
      jobId: 'j1',
      status: 'done',
      percent: 100,
      url: 'https://x',
      markdown: '![a](https://x)',
      fileHash: 'abc123',
      reused: true
    });
    expect(after.items[0].fileHash).toBe('abc123');
    expect(after.items[0].reused).toBe(true);
  });

  it('R-54: keeps a previously-set fileHash sticky against a later emit without one', () => {
    const before: UploadHistoryRecord = {
      ...makeRecord(),
      items: [{
        jobId: 'j1', fileName: 'a.gif', filePath: '/o/a.gif',
        status: 'uploading', fileHash: 'sha-old', reused: false
      }]
    };
    const after = applyProgressToRecord(before, {
      jobId: 'j1', status: 'done', percent: 100, url: 'https://x'
    });
    expect(after.items[0].status).toBe('done');
    expect(after.items[0].fileHash).toBe('sha-old');
  });

  it('R-73: folds streaming percent into a non-terminal row', () => {
    const before = makeRecord();
    const after = applyProgressToRecord(before, {
      jobId: 'j1', status: 'uploading', percent: 42
    });
    expect(after.items[0].status).toBe('uploading');
    expect(after.items[0].percent).toBe(42);
  });

  it('R-73: clamps percent to 0..100', () => {
    const r1 = applyProgressToRecord(makeRecord(), {
      jobId: 'j1', status: 'uploading', percent: 250
    });
    expect(r1.items[0].percent).toBe(100);
    const r2 = applyProgressToRecord(makeRecord(), {
      jobId: 'j1', status: 'uploading', percent: -10
    });
    expect(r2.items[0].percent).toBe(0);
  });

  it('R-73: clears percent when the row transitions to a terminal status', () => {
    const before: UploadHistoryRecord = {
      ...makeRecord(),
      items: [{ jobId: 'j1', fileName: 'a.gif', filePath: '/o/a.gif', status: 'uploading', percent: 47 }]
    };
    const after = applyProgressToRecord(before, {
      jobId: 'j1', status: 'done', percent: 100, url: 'https://x'
    });
    expect(after.items[0].status).toBe('done');
    expect(after.items[0].percent).toBeUndefined();
  });

  it('R-73: keeps prior percent when emit omits it on a non-terminal row', () => {
    const before: UploadHistoryRecord = {
      ...makeRecord(),
      items: [{ jobId: 'j1', fileName: 'a.gif', filePath: '/o/a.gif', status: 'uploading', percent: 30 }]
    };
    const after = applyProgressToRecord(before, {
      jobId: 'j1', status: 'uploading'
    } as never);
    expect(after.items[0].percent).toBe(30);
  });
});

describe('R-73 statusBadge', () => {
  it('returns a distinct icon for each terminal state', () => {
    expect(statusBadge('done').icon).toBe('✓');
    expect(statusBadge('failed').icon).toBe('✗');
    expect(statusBadge('cancelled').icon).toBe('⊘');
  });

  it('returns a spinner icon while uploading', () => {
    expect(statusBadge('uploading').icon).toBe('⟳');
  });

  it('falls back to the pending icon for an unknown status', () => {
    expect(statusBadge('weird-future-status' as never).icon).toBe('…');
  });
});

describe('R-73 summarizeRecord', () => {
  it('counts per-status and reports finished only when nothing is in flight', () => {
    const s1 = summarizeRecord([
      { jobId: 'j1', fileName: 'a', filePath: '/a', status: 'done', url: 'https://a' },
      { jobId: 'j2', fileName: 'b', filePath: '/b', status: 'uploading' },
      { jobId: 'j3', fileName: 'c', filePath: '/c', status: 'failed', error: 'x' }
    ]);
    expect(s1.done).toBe(1);
    expect(s1.failed).toBe(1);
    expect(s1.inFlight).toBe(1);
    expect(s1.total).toBe(3);
    expect(s1.finished).toBe(false);
  });

  it('reports finished=true when all rows reached a terminal status', () => {
    const s = summarizeRecord([
      { jobId: 'j1', fileName: 'a', filePath: '/a', status: 'done', url: 'https://a' },
      { jobId: 'j2', fileName: 'b', filePath: '/b', status: 'cancelled' }
    ]);
    expect(s.finished).toBe(true);
    expect(s.inFlight).toBe(0);
  });

  it('treats pending as in-flight, not finished', () => {
    const s = summarizeRecord([
      { jobId: 'j1', fileName: 'a', filePath: '/a', status: 'pending' }
    ]);
    expect(s.finished).toBe(false);
    expect(s.inFlight).toBe(1);
  });
});

describe('R-54 isUploadConfigured', () => {
  it('returns false when configs are null / undefined', () => {
    expect(isUploadConfigured(null)).toBe(false);
    expect(isUploadConfigured(undefined)).toBe(false);
  });

  it('rejects customWeb without a valid http(s) url', () => {
    const c: UploadConfigs = { active: 'customWeb', customWeb: { url: '', headers: {}, fieldName: 'file' } as never };
    expect(isUploadConfigured(c)).toBe(false);
  });

  it('accepts customWeb with an https url', () => {
    const c: UploadConfigs = {
      active: 'customWeb',
      customWeb: { url: 'https://up.example.com/api', headers: {}, fieldName: 'file' } as never
    };
    expect(isUploadConfigured(c)).toBe(true);
  });

  it('rejects github without token / repo', () => {
    const cNoToken: UploadConfigs = { active: 'github', github: { token: '', repo: 'u/r', branch: 'main' } as never };
    const cNoRepo: UploadConfigs = { active: 'github', github: { token: 't', repo: '', branch: 'main' } as never };
    expect(isUploadConfigured(cNoToken)).toBe(false);
    expect(isUploadConfigured(cNoRepo)).toBe(false);
  });

  it('accepts a fully-filled github config', () => {
    const c: UploadConfigs = {
      active: 'github',
      github: { token: 't', repo: 'u/r', branch: 'main' } as never
    };
    expect(isUploadConfigured(c)).toBe(true);
  });

  it('rejects qiniu missing any of accessKey/secretKey/bucket/domain', () => {
    const base = { accessKey: 'a', secretKey: 'b', bucket: 'c', domain: 'https://d' };
    for (const k of ['accessKey', 'secretKey', 'bucket', 'domain'] as const) {
      const broken = { ...base, [k]: '' };
      expect(isUploadConfigured({ active: 'qiniu', qiniu: broken } as UploadConfigs)).toBe(false);
    }
    expect(isUploadConfigured({ active: 'qiniu', qiniu: base } as UploadConfigs)).toBe(true);
  });
});

describe('R-54 findUploadByHash', () => {
  function recOf(items: UploadHistoryRecord['items'], backend: UploadHistoryRecord['backend'] = 'customWeb'): UploadHistoryRecord {
    return { id: `r-${Math.random()}`, createdAt: Date.now(), backend, items };
  }

  it('returns null on empty hash', () => {
    expect(findUploadByHash([], '', 'customWeb')).toBe(null);
  });

  it('finds the newest done row whose hash matches and backend matches', () => {
    const history: UploadHistoryRecord[] = [
      recOf([{ jobId: 'j1', fileName: 'a.gif', filePath: '/o/a.gif', status: 'done', url: 'https://new', fileHash: 'h1' }]),
      recOf([{ jobId: 'j0', fileName: 'a.gif', filePath: '/o/a.gif', status: 'done', url: 'https://old', fileHash: 'h1' }])
    ];
    const got = findUploadByHash(history, 'h1', 'customWeb');
    expect(got?.url).toBe('https://new');
  });

  it('skips rows whose backend differs from the requested backend', () => {
    const history: UploadHistoryRecord[] = [
      recOf([{ jobId: 'j1', fileName: 'a.gif', filePath: '/o/a.gif', status: 'done', url: 'https://gh', fileHash: 'h1' }], 'github')
    ];
    expect(findUploadByHash(history, 'h1', 'customWeb')).toBe(null);
  });

  it('skips rows that did not actually finish', () => {
    const history: UploadHistoryRecord[] = [
      recOf([{ jobId: 'j1', fileName: 'a.gif', filePath: '/o/a.gif', status: 'failed', error: 'x', fileHash: 'h1' }])
    ];
    expect(findUploadByHash(history, 'h1', 'customWeb')).toBe(null);
  });
});

describe('R-54 paginateHistory', () => {
  it('returns the right slice for an in-bounds page', () => {
    const list = [1, 2, 3, 4, 5, 6, 7];
    const { rows, pageCount, safePage } = paginateHistory(list, 2, 3);
    expect(rows).toEqual([4, 5, 6]);
    expect(pageCount).toBe(3);
    expect(safePage).toBe(2);
  });

  it('clamps an out-of-range page to the last page', () => {
    const list = [1, 2, 3, 4, 5];
    const { rows, safePage } = paginateHistory(list, 99, 2);
    expect(safePage).toBe(3);
    expect(rows).toEqual([5]);
  });

  it('reports pageCount=1 for an empty list and safePage=1', () => {
    const { rows, pageCount, safePage } = paginateHistory([], 1, 20);
    expect(rows).toEqual([]);
    expect(pageCount).toBe(1);
    expect(safePage).toBe(1);
  });
});

// R-80 — Hook-lifecycle tests against the mocked DB stub.
describe('useUploadHistory hook (R-80 DB-backed)', () => {
  it('starts with isLoading true and flips false after the initial DB read', async () => {
    installFakeUploadDb();
    const { result } = renderHook(() => useUploadHistory());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.history).toEqual([]);
    await flushLoad();
    expect(result.current.isLoading).toBe(false);
  });

  it('flips isLoading false when the bridge is unavailable', async () => {
    const { result } = renderHook(() => useUploadHistory());
    await flushLoad();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.history).toEqual([]);
  });

  it('hydrates from db.uploadHistory.readAll on mount', async () => {
    const seed: UploadHistoryRecord = {
      id: 'rec-1', createdAt: 1, backend: 'customWeb',
      items: [{ jobId: 'j1', fileName: 'a.gif', filePath: '/o/a.gif', status: 'done', url: 'https://x' }]
    };
    const fake = installFakeUploadDb([seed]);
    const { result } = renderHook(() => useUploadHistory());
    await flushLoad();
    expect(fake.readAll).toHaveBeenCalledTimes(1);
    expect(result.current.history.map((r) => r.id)).toEqual(['rec-1']);
  });

  it('start() prepends a new record and forwards a debounced upsert to the DB', async () => {
    const fake = installFakeUploadDb();
    const { result } = renderHook(() => useUploadHistory());
    await flushLoad();
    let id = '';
    act(() => {
      id = result.current.start({
        backend: 'customWeb',
        items: [{ jobId: 'j1', fileName: 'a.gif', filePath: '/o/a.gif', status: 'pending' }]
      });
    });
    expect(result.current.history).toHaveLength(1);
    expect(result.current.history[0].id).toBe(id);
    // Debounced — not yet flushed.
    expect(fake.upsert).not.toHaveBeenCalled();
    await flushPersist();
    expect(fake.upsert).toHaveBeenCalledWith(expect.objectContaining({ id }));
  });

  it('applyProgress folds an emit into the matching record and queues an upsert', async () => {
    const fake = installFakeUploadDb();
    const { result } = renderHook(() => useUploadHistory());
    await flushLoad();
    let id = '';
    act(() => {
      id = result.current.start({
        backend: 'customWeb',
        items: [{ jobId: 'j1', fileName: 'a.gif', filePath: '/o/a.gif', status: 'pending' }]
      });
    });
    act(() => {
      result.current.applyProgress(id, { jobId: 'j1', status: 'done', percent: 100, url: 'https://x' });
    });
    expect(result.current.history[0].items[0].status).toBe('done');
    expect(result.current.history[0].items[0].url).toBe('https://x');
    await flushPersist();
    // The post-progress upsert payload reflects the merged shape.
    const last = fake.upsert.mock.calls[fake.upsert.mock.calls.length - 1][0] as UploadHistoryRecord;
    expect(last.id).toBe(id);
    expect(last.items[0].status).toBe('done');
  });

  it('remove drops the record and forwards to db.uploadHistory.remove', async () => {
    const fake = installFakeUploadDb();
    const { result } = renderHook(() => useUploadHistory());
    await flushLoad();
    let id = '';
    act(() => {
      id = result.current.start({
        backend: 'customWeb',
        items: [{ jobId: 'j1', fileName: 'a.gif', filePath: '/o/a.gif', status: 'pending' }]
      });
    });
    act(() => {
      result.current.remove(id);
    });
    expect(result.current.history).toHaveLength(0);
    expect(fake.remove).toHaveBeenCalledWith(id);
  });

  it('clear empties memory and calls db.uploadHistory.clear', async () => {
    const fake = installFakeUploadDb();
    const { result } = renderHook(() => useUploadHistory());
    await flushLoad();
    act(() => {
      result.current.start({
        backend: 'customWeb',
        items: [{ jobId: 'j1', fileName: 'a.gif', filePath: '/o/a.gif', status: 'pending' }]
      });
    });
    act(() => {
      result.current.clear();
    });
    expect(result.current.history).toEqual([]);
    expect(fake.clear).toHaveBeenCalledTimes(1);
  });
});
