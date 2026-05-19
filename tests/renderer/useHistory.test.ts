/**
 * R-27 — unit tests for the persistent history hook + helpers.
 *
 * R-80 — Storage moved from localStorage to a main-process SQLite
 * store. These tests mock window.giftk.db.history as async stubs
 * (readAll/upsert/remove/clear) so the hook's IPC round-trips run
 * against an in-memory fake instead of real Electron IPC. The hook
 * exposes a new `isLoading` flag that flips false after the initial
 * `readAll` resolves; tests use act() to await that microtask.
 *
 * Critical invariants checked:
 *   1. pushOrReplace dedupes by id (same id => replace, new id => prepend).
 *   2. The 30-entry cap holds; the oldest is evicted.
 *   3. mergeProgressIntoRecord:
 *      - dedupes outputs across re-emits;
 *      - never lets a non-terminal status overwrite a terminal one.
 *   4. The hook persists via the mocked DB upsert/remove/clear stubs
 *      and re-hydrates from readAll on a fresh mount.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  HISTORY_MAX_ENTRIES,
  makeHistoryRecord,
  mergeProgressIntoRecord,
  useHistory,
  type HistoryRecord
} from '../../src/renderer/components/useHistory';
import { DEFAULT_OPTIONS } from '../../src/shared/types';
import type { SniffedMedia, TaskProgress } from '../../src/shared/types';

const fakeMedia: SniffedMedia = {
  id: 'm-1',
  kind: 'video',
  url: 'https://x.test/v.mp4',
  pageUrl: 'https://x.test/p',
  source: 'video-tag'
};

function rec(id: string, createdAt: number, items: SniffedMedia[] = [fakeMedia]): HistoryRecord {
  return makeHistoryRecord({
    id,
    createdAt,
    pageUrl: 'https://x.test/p',
    title: `t-${id}`,
    items,
    options: DEFAULT_OPTIONS
  });
}

interface FakeHistoryDb {
  readAll: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  __rows: HistoryRecord[];
}

/**
 * Install a fake `window.giftk.db.history` backed by an in-memory
 * array. Each method returns a Promise so the hook's async load /
 * fire-and-forget upsert paths exercise their real code paths.
 */
function installFakeHistoryDb(seed: HistoryRecord[] = []): FakeHistoryDb {
  const rows: HistoryRecord[] = seed.slice();
  const fake: FakeHistoryDb = {
    readAll: vi.fn(async () => rows.slice()),
    upsert: vi.fn(async (rec: HistoryRecord) => {
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
    db: { history: fake }
  };
  return fake;
}

/**
 * Drain microtasks (so the `readAll().then(...)` chain inside the
 * mount effect commits before assertions run) and then advance past
 * the 250ms upsert debounce so any queued IPC writes are flushed
 * before tests inspect the mocked stubs.
 */
async function flushPersist(): Promise<void> {
  await act(async () => {
    // Settle the initial-load promise chain.
    await Promise.resolve();
    await Promise.resolve();
    // Upsert/remove queue debounce window is 250ms.
    await new Promise((res) => setTimeout(res, 260));
  });
}

/** Drain only the initial async readAll without waiting on debounce. */
async function flushLoad(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).giftk;
});

describe('makeHistoryRecord', () => {
  it('produces a record with empty maps and the provided id/timestamp', () => {
    const r = rec('a', 1000);
    expect(r.id).toBe('a');
    expect(r.createdAt).toBe(1000);
    expect(r.outputsByTaskId).toEqual({});
    expect(r.taskStatus).toEqual({});
    expect(r.outputDir).toBeUndefined();
  });

  it('autogenerates id and createdAt when not provided', () => {
    const r = makeHistoryRecord({
      pageUrl: 'https://x.test/p',
      items: [],
      options: DEFAULT_OPTIONS
    });
    expect(r.id).toMatch(/^hist-\d+-[0-9a-f]+$/);
    expect(typeof r.createdAt).toBe('number');
    expect(r.createdAt).toBeGreaterThan(0);
  });
});

describe('mergeProgressIntoRecord', () => {
  it('appends and dedupes outputs across multiple emits', () => {
    let r = rec('a', 1000);
    const p1: TaskProgress = {
      taskId: 'm-1',
      status: 'converting',
      percent: 50,
      outputs: ['/out/a.gif']
    } as TaskProgress;
    r = mergeProgressIntoRecord(r, p1);
    const p2: TaskProgress = {
      taskId: 'm-1',
      status: 'done',
      percent: 100,
      outputs: ['/out/a.gif', '/out/a.mp4']
    } as TaskProgress;
    r = mergeProgressIntoRecord(r, p2);
    expect(r.outputsByTaskId['m-1']).toEqual(['/out/a.gif', '/out/a.mp4']);
    expect(r.taskStatus['m-1']).toBe('done');
  });

  it('does NOT regress a terminal status when a later non-terminal arrives', () => {
    let r = rec('a', 1000);
    r = mergeProgressIntoRecord(r, {
      taskId: 'm-1',
      status: 'done',
      percent: 100,
      outputs: ['/out/a.gif']
    } as TaskProgress);
    r = mergeProgressIntoRecord(r, {
      taskId: 'm-1',
      status: 'converting',
      percent: 80
    } as TaskProgress);
    expect(r.taskStatus['m-1']).toBe('done');
  });

  it('keeps prior outputs when the emit has no outputs[]', () => {
    let r = rec('a', 1000);
    r = mergeProgressIntoRecord(r, {
      taskId: 'm-1',
      status: 'done',
      percent: 100,
      outputs: ['/out/a.gif']
    } as TaskProgress);
    r = mergeProgressIntoRecord(r, {
      taskId: 'm-1',
      status: 'done',
      percent: 100
    } as TaskProgress);
    expect(r.outputsByTaskId['m-1']).toEqual(['/out/a.gif']);
  });

  it('does NOT let one terminal overwrite another (done then cancelled stays done)', () => {
    let r = rec('a', 1000);
    r = mergeProgressIntoRecord(r, {
      taskId: 'm-1',
      status: 'done',
      percent: 100,
      outputs: ['/out/a.gif']
    } as TaskProgress);
    r = mergeProgressIntoRecord(r, {
      taskId: 'm-1',
      status: 'cancelled',
      percent: 100
    } as TaskProgress);
    expect(r.taskStatus['m-1']).toBe('done');
  });
});

describe('useHistory hook', () => {
  it('starts with isLoading true and flips false after the initial DB read', async () => {
    installFakeHistoryDb();
    const { result } = renderHook(() => useHistory());
    // Synchronous-mount snapshot: readAll has been kicked off but not
    // yet resolved, so the panel should show its loading affordance.
    expect(result.current.isLoading).toBe(true);
    expect(result.current.history).toEqual([]);
    await flushLoad();
    expect(result.current.isLoading).toBe(false);
  });

  it('flips isLoading false when the bridge is unavailable', async () => {
    // No giftk on window — the hook short-circuits and gives up.
    const { result } = renderHook(() => useHistory());
    await flushLoad();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.history).toEqual([]);
  });

  it('hydrates the in-memory list from db.history.readAll on mount', async () => {
    const fake = installFakeHistoryDb([rec('a', 1000), rec('b', 2000)]);
    const { result } = renderHook(() => useHistory());
    await flushLoad();
    expect(fake.readAll).toHaveBeenCalledTimes(1);
    // Sorted by createdAt desc.
    expect(result.current.history.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('starts empty and prepends new records (most-recent first)', async () => {
    installFakeHistoryDb();
    const { result } = renderHook(() => useHistory());
    await flushLoad();
    expect(result.current.history).toEqual([]);
    act(() => {
      result.current.pushOrReplace(rec('a', 1000));
      result.current.pushOrReplace(rec('b', 2000));
    });
    expect(result.current.history.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('replaces records that share an id rather than duplicating', async () => {
    installFakeHistoryDb();
    const { result } = renderHook(() => useHistory());
    await flushLoad();
    act(() => {
      result.current.pushOrReplace(rec('a', 1000));
      result.current.pushOrReplace({
        ...rec('a', 5000),
        title: 't-a-updated'
      });
    });
    expect(result.current.history).toHaveLength(1);
    expect(result.current.history[0].title).toBe('t-a-updated');
  });

  it('caps at HISTORY_MAX_ENTRIES, evicting the oldest', async () => {
    installFakeHistoryDb();
    const { result } = renderHook(() => useHistory());
    await flushLoad();
    act(() => {
      for (let i = 0; i <= HISTORY_MAX_ENTRIES; i++) {
        result.current.pushOrReplace(rec(`r-${i}`, 1000 + i));
      }
    });
    expect(result.current.history).toHaveLength(HISTORY_MAX_ENTRIES);
    expect(result.current.history.find((r) => r.id === 'r-0')).toBeUndefined();
  });

  it('forwards pushOrReplace to db.history.upsert via the debounced queue', async () => {
    const fake = installFakeHistoryDb();
    const { result } = renderHook(() => useHistory());
    await flushLoad();
    act(() => {
      result.current.pushOrReplace(rec('a', 1000));
      result.current.pushOrReplace(rec('b', 2000));
    });
    // Upserts are coalesced behind a 250ms idle window.
    expect(fake.upsert).toHaveBeenCalledTimes(0);
    await flushPersist();
    expect(fake.upsert).toHaveBeenCalledTimes(2);
    const ids = fake.upsert.mock.calls.map((c) => (c[0] as HistoryRecord).id).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('persists via the DB stub and re-hydrates a fresh hook from the same store', async () => {
    const fake = installFakeHistoryDb();
    const first = renderHook(() => useHistory());
    await flushLoad();
    act(() => {
      first.result.current.pushOrReplace(rec('a', 1000));
      first.result.current.pushOrReplace(rec('b', 2000));
    });
    await flushPersist();
    // The fake's backing array now contains both records.
    expect(fake.__rows.map((r) => r.id).sort()).toEqual(['a', 'b']);

    // New mount reads them back.
    const second = renderHook(() => useHistory());
    await flushLoad();
    expect(second.result.current.history.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('patch only mutates the targeted record', async () => {
    installFakeHistoryDb();
    const { result } = renderHook(() => useHistory());
    await flushLoad();
    act(() => {
      result.current.pushOrReplace(rec('a', 1000));
      result.current.pushOrReplace(rec('b', 2000));
      result.current.patch('a', (r) => ({ ...r, outputDir: '/out/a' }));
    });
    const a = result.current.history.find((r) => r.id === 'a');
    const b = result.current.history.find((r) => r.id === 'b');
    expect(a?.outputDir).toBe('/out/a');
    expect(b?.outputDir).toBeUndefined();
  });

  it('remove drops just the targeted record and calls db.history.remove', async () => {
    const fake = installFakeHistoryDb();
    const { result } = renderHook(() => useHistory());
    await flushLoad();
    act(() => {
      result.current.pushOrReplace(rec('a', 1000));
      result.current.pushOrReplace(rec('b', 2000));
    });
    act(() => {
      result.current.remove('a');
    });
    expect(result.current.history.map((r) => r.id)).toEqual(['b']);
    await flushPersist();
    expect(fake.remove).toHaveBeenCalledWith('a');
  });

  it('clear wipes memory and calls db.history.clear', async () => {
    const fake = installFakeHistoryDb();
    const { result } = renderHook(() => useHistory());
    await flushLoad();
    act(() => {
      result.current.pushOrReplace(rec('a', 1000));
      result.current.pushOrReplace(rec('b', 2000));
    });
    act(() => result.current.clear());
    expect(result.current.history).toEqual([]);
    expect(fake.clear).toHaveBeenCalledTimes(1);
  });

  it('drops malformed entries during hydration', async () => {
    // Seed the fake store with a mix of valid + garbage rows.
    const goodRow = {
      id: 'good',
      pageUrl: 'https://x.test',
      items: [],
      createdAt: 1,
      options: DEFAULT_OPTIONS,
      outputsByTaskId: {},
      taskStatus: {}
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fake = installFakeHistoryDb([goodRow as any, { id: 42 } as any, null as any, { foo: 'bar' } as any]);
    const { result } = renderHook(() => useHistory());
    await flushLoad();
    expect(fake.readAll).toHaveBeenCalledTimes(1);
    expect(result.current.history.map((r) => r.id)).toEqual(['good']);
  });

  // R-34 — reload() force-resyncs from the DB. Two scenarios matter:
  //   1. an EXTERNAL writer updated the DB while this hook was mounted
  //      → reload picks up the change;
  //   2. the IN-MEMORY state is newer than disk → reload flushes
  //      pending upserts first so disk is at least as fresh as memory
  //      before reading back.
  it('reload picks up external writes that happened after mount', async () => {
    const fake = installFakeHistoryDb();
    const { result } = renderHook(() => useHistory());
    await flushLoad();
    act(() => {
      result.current.pushOrReplace(rec('a', 1000));
    });
    await flushPersist();
    // External writer drops a brand-new record and removes 'a'.
    fake.__rows.length = 0;
    fake.__rows.push({
      id: 'x',
      pageUrl: 'https://x.test/p',
      title: 't-x',
      items: [],
      createdAt: 9999,
      options: DEFAULT_OPTIONS,
      outputsByTaskId: {},
      taskStatus: {}
    });
    expect(result.current.history.map((r) => r.id)).toEqual(['a']);
    act(() => result.current.reload());
    await flushLoad();
    expect(result.current.history.map((r) => r.id)).toEqual(['x']);
  });

  it('reload flushes pending in-memory state before re-reading', async () => {
    const fake = installFakeHistoryDb();
    const { result } = renderHook(() => useHistory());
    await flushLoad();
    act(() => {
      result.current.pushOrReplace(rec('a', 1000));
      // No flushPersist; debounce hasn't fired.
      result.current.reload();
    });
    await flushLoad();
    expect(result.current.history.map((r) => r.id)).toEqual(['a']);
    // reload's pre-flush wrote 'a' through to the DB stub.
    expect(fake.upsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
  });
});
