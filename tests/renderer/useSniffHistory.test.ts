/**
 * R-32 — unit tests for the sniff-URL LRU hook.
 *
 * R-80 — Storage moved from localStorage to a main-process SQLite
 * store. These tests mock window.giftk.db.sniffHistory as async
 * stubs (readAll/upsert/remove/clear) so the hook's IPC calls run
 * against an in-memory fake. The hook now exposes an `isLoading`
 * flag that flips false after the initial readAll resolves; tests
 * use act() to await that microtask.
 *
 * Critical invariants:
 *   1. addOrPromote dedupes by URL (revisiting an existing URL
 *      moves it to the front and refreshes ts/title/itemCount).
 *   2. The 30-entry cap holds; the oldest is evicted.
 *   3. addOrPromote preserves a previously-known title when the
 *      new sniff didn't pass one.
 *   4. addOrPromote / remove / clear forward to the mocked DB stubs.
 *   5. Hydration tolerates malformed rows.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  SNIFF_HISTORY_MAX_ENTRIES,
  applyAddOrPromote,
  useSniffHistory,
  type SniffHistoryEntry
} from '../../src/renderer/components/useSniffHistory';

interface FakeSniffDb {
  readAll: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  __rows: SniffHistoryEntry[];
}

function installFakeSniffDb(seed: SniffHistoryEntry[] = []): FakeSniffDb {
  const rows: SniffHistoryEntry[] = seed.slice();
  const fake: FakeSniffDb = {
    readAll: vi.fn(async () => rows.slice()),
    // Sniff history dedupes by URL — same semantics as the
    // user-described "upsertOrPromote": replace by url, otherwise
    // prepend, sorted by ts desc on read.
    upsert: vi.fn(async (e: SniffHistoryEntry) => {
      const i = rows.findIndex((r) => r.url === e.url);
      if (i >= 0) rows[i] = e; else rows.unshift(e);
    }),
    remove: vi.fn(async (url: string) => {
      const i = rows.findIndex((r) => r.url === url);
      if (i >= 0) rows.splice(i, 1);
    }),
    clear: vi.fn(async () => { rows.length = 0; }),
    __rows: rows
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).giftk = {
    ...((window as any).giftk || {}),
    db: { sniffHistory: fake }
  };
  return fake;
}

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

describe('applyAddOrPromote', () => {
  it('prepends a brand-new URL', () => {
    const next = applyAddOrPromote([], { url: 'https://a.test', ts: 1000 });
    expect(next).toEqual([{ url: 'https://a.test', title: undefined, ts: 1000, itemCount: undefined }]);
  });

  it('moves an existing URL to the front and refreshes fields', () => {
    const seed: SniffHistoryEntry[] = [
      { url: 'https://a.test', ts: 1000, title: 'old', itemCount: 3 },
      { url: 'https://b.test', ts: 2000 }
    ];
    const next = applyAddOrPromote(seed, {
      url: 'https://a.test',
      ts: 3000,
      title: 'new',
      itemCount: 5
    });
    expect(next.map((e) => e.url)).toEqual(['https://a.test', 'https://b.test']);
    expect(next[0]).toEqual({ url: 'https://a.test', ts: 3000, title: 'new', itemCount: 5 });
  });

  it('preserves prior title/itemCount when the new sniff omits them', () => {
    const seed: SniffHistoryEntry[] = [
      { url: 'https://a.test', ts: 1000, title: 'cached', itemCount: 7 }
    ];
    const next = applyAddOrPromote(seed, { url: 'https://a.test', ts: 2000 });
    expect(next[0]).toEqual({ url: 'https://a.test', ts: 2000, title: 'cached', itemCount: 7 });
  });

  it('caps at SNIFF_HISTORY_MAX_ENTRIES and evicts the oldest', () => {
    const seed: SniffHistoryEntry[] = [];
    for (let i = 0; i < SNIFF_HISTORY_MAX_ENTRIES; i++) {
      seed.push({ url: `https://a${i}.test`, ts: 10_000 - i });
    }
    const next = applyAddOrPromote(seed, { url: 'https://new.test', ts: 99_999 });
    expect(next.length).toBe(SNIFF_HISTORY_MAX_ENTRIES);
    expect(next[0].url).toBe('https://new.test');
    expect(next.find((e) => e.url === `https://a${SNIFF_HISTORY_MAX_ENTRIES - 1}.test`)).toBeUndefined();
  });
});

describe('useSniffHistory', () => {
  it('starts with isLoading true and flips false after the initial DB read', async () => {
    installFakeSniffDb();
    const { result } = renderHook(() => useSniffHistory());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.entries).toEqual([]);
    await flushLoad();
    expect(result.current.isLoading).toBe(false);
  });

  it('flips isLoading false when the bridge is unavailable', async () => {
    const { result } = renderHook(() => useSniffHistory());
    await flushLoad();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.entries).toEqual([]);
  });

  it('hydrates entries from db.sniffHistory.readAll on mount, sorted by ts desc', async () => {
    const fake = installFakeSniffDb([
      { url: 'https://a.test', ts: 1000, title: 'A' },
      { url: 'https://b.test', ts: 2000, title: 'B' }
    ]);
    const { result } = renderHook(() => useSniffHistory());
    await flushLoad();
    expect(fake.readAll).toHaveBeenCalledTimes(1);
    expect(result.current.entries.map((e) => e.url)).toEqual(['https://b.test', 'https://a.test']);
  });

  it('addOrPromote adds, dedupes, keeps order, and forwards to db.sniffHistory.upsert', async () => {
    const fake = installFakeSniffDb();
    const { result } = renderHook(() => useSniffHistory());
    await flushLoad();
    act(() => {
      result.current.addOrPromote({ url: 'https://a.test', ts: 1000, title: 'A' });
    });
    act(() => {
      result.current.addOrPromote({ url: 'https://b.test', ts: 2000, title: 'B' });
    });
    expect(result.current.entries.map((e) => e.url)).toEqual(['https://b.test', 'https://a.test']);
    act(() => {
      result.current.addOrPromote({ url: 'https://a.test', ts: 3000, itemCount: 4 });
    });
    expect(result.current.entries.map((e) => e.url)).toEqual(['https://a.test', 'https://b.test']);
    // Title preserved across the third (untitled) emit.
    expect(result.current.entries[0].title).toBe('A');
    expect(result.current.entries[0].itemCount).toBe(4);
    // Three upserts forwarded to the DB stub (fire-and-forget).
    expect(fake.upsert).toHaveBeenCalledTimes(3);
  });

  it('remove drops a URL and forwards to db.sniffHistory.remove; unknown URLs are a no-op', async () => {
    const fake = installFakeSniffDb();
    const { result } = renderHook(() => useSniffHistory());
    await flushLoad();
    act(() => {
      result.current.addOrPromote({ url: 'https://a.test', ts: 1 });
      result.current.addOrPromote({ url: 'https://b.test', ts: 2 });
    });
    act(() => {
      result.current.remove('https://a.test');
    });
    expect(result.current.entries.map((e) => e.url)).toEqual(['https://b.test']);
    expect(fake.remove).toHaveBeenCalledWith('https://a.test');
    act(() => {
      result.current.remove('https://nonexistent.test');
    });
    expect(result.current.entries.map((e) => e.url)).toEqual(['https://b.test']);
  });

  it('clear empties memory and calls db.sniffHistory.clear', async () => {
    const fake = installFakeSniffDb();
    const { result } = renderHook(() => useSniffHistory());
    await flushLoad();
    act(() => {
      result.current.addOrPromote({ url: 'https://a.test', ts: 1 });
    });
    act(() => {
      result.current.clear();
    });
    expect(result.current.entries).toEqual([]);
    expect(fake.clear).toHaveBeenCalledTimes(1);
  });

  it('persists across remount via the shared DB store', async () => {
    const fake = installFakeSniffDb();
    const first = renderHook(() => useSniffHistory());
    await flushLoad();
    act(() => {
      first.result.current.addOrPromote({ url: 'https://a.test', ts: 1000, title: 'A' });
      first.result.current.addOrPromote({ url: 'https://b.test', ts: 2000, title: 'B' });
    });
    // Backing store now has both rows (hook calls upsert synchronously
    // after each addOrPromote, no debounce).
    expect(fake.__rows.map((r) => r.url).sort()).toEqual(['https://a.test', 'https://b.test']);

    const after = renderHook(() => useSniffHistory());
    await flushLoad();
    expect(after.result.current.entries.map((e) => e.url)).toEqual(['https://b.test', 'https://a.test']);
  });

  it('tolerates malformed rows from the DB (drops them silently)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fake = installFakeSniffDb([
      { url: 'https://good.test', ts: 1 },
      // Garbage rows below — exercise the parseEntry guard.
      { url: 42 } as any,
      null as any,
      { foo: 'bar' } as any
    ] as any);
    const { result } = renderHook(() => useSniffHistory());
    await flushLoad();
    expect(fake.readAll).toHaveBeenCalledTimes(1);
    expect(result.current.entries.map((e) => e.url)).toEqual(['https://good.test']);
  });
});
