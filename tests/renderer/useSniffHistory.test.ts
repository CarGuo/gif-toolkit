/**
 * R-32 — unit tests for the sniff-URL LRU hook.
 *
 * Mirrors useHistory.test.ts's structure (same 250ms debounce, same
 * localStorage isolation, same act/renderHook pattern) so future
 * readers don't have to learn two conventions.
 *
 * Critical invariants:
 *   1. addOrPromote dedupes by URL (revisiting an existing URL
 *      moves it to the front and refreshes ts/title/itemCount).
 *   2. The 30-entry cap holds; the oldest is evicted.
 *   3. addOrPromote preserves a previously-known title when the
 *      new sniff didn't pass one (no accidental erasure).
 *   4. Persistence round-trips localStorage on mount/unmount.
 *   5. clear() empties both memory and storage.
 *   6. remove() is a no-op for unknown URLs (defensive).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  SNIFF_HISTORY_STORAGE_KEY,
  SNIFF_HISTORY_MAX_ENTRIES,
  applyAddOrPromote,
  useSniffHistory,
  type SniffHistoryEntry
} from '../../src/renderer/components/useSniffHistory';

beforeEach(() => {
  window.localStorage.clear();
});

async function flushPersist(): Promise<void> {
  await act(async () => {
    await new Promise((res) => setTimeout(res, 260));
  });
}

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
    // Fill with `max` items, ts decreasing so the last one is eldest.
    for (let i = 0; i < SNIFF_HISTORY_MAX_ENTRIES; i++) {
      seed.push({ url: `https://a${i}.test`, ts: 10_000 - i });
    }
    const next = applyAddOrPromote(seed, { url: 'https://new.test', ts: 99_999 });
    expect(next.length).toBe(SNIFF_HISTORY_MAX_ENTRIES);
    expect(next[0].url).toBe('https://new.test');
    // The eldest (last) was evicted — no entry with that URL remains.
    expect(next.find((e) => e.url === `https://a${SNIFF_HISTORY_MAX_ENTRIES - 1}.test`)).toBeUndefined();
  });
});

describe('useSniffHistory', () => {
  it('starts empty when storage is clean', () => {
    const { result } = renderHook(() => useSniffHistory());
    expect(result.current.entries).toEqual([]);
  });

  it('addOrPromote adds, dedupes, and keeps order', () => {
    const { result } = renderHook(() => useSniffHistory());
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
    expect(result.current.entries[0].title).toBe('A'); // preserved
    expect(result.current.entries[0].itemCount).toBe(4);
  });

  it('remove drops a URL; unknown URLs are a no-op', () => {
    const { result } = renderHook(() => useSniffHistory());
    act(() => {
      result.current.addOrPromote({ url: 'https://a.test', ts: 1 });
      result.current.addOrPromote({ url: 'https://b.test', ts: 2 });
    });
    act(() => {
      result.current.remove('https://a.test');
    });
    expect(result.current.entries.map((e) => e.url)).toEqual(['https://b.test']);
    act(() => {
      // Defensive: removing a URL that's not in the list shouldn't
      // throw or empty the list.
      result.current.remove('https://nonexistent.test');
    });
    expect(result.current.entries.map((e) => e.url)).toEqual(['https://b.test']);
  });

  it('clear empties memory and storage', async () => {
    const { result } = renderHook(() => useSniffHistory());
    act(() => {
      result.current.addOrPromote({ url: 'https://a.test', ts: 1 });
    });
    await flushPersist();
    expect(window.localStorage.getItem(SNIFF_HISTORY_STORAGE_KEY)).toBeTruthy();
    act(() => {
      result.current.clear();
    });
    expect(result.current.entries).toEqual([]);
    await flushPersist();
    const raw = window.localStorage.getItem(SNIFF_HISTORY_STORAGE_KEY);
    expect(raw).toBe('[]');
  });

  it('persists across remount', async () => {
    const { result, unmount } = renderHook(() => useSniffHistory());
    act(() => {
      result.current.addOrPromote({ url: 'https://a.test', ts: 1000, title: 'A' });
      result.current.addOrPromote({ url: 'https://b.test', ts: 2000, title: 'B' });
    });
    await flushPersist();
    unmount();
    const { result: after } = renderHook(() => useSniffHistory());
    expect(after.current.entries.map((e) => e.url)).toEqual(['https://b.test', 'https://a.test']);
  });

  it('tolerates corrupt/foreign storage payloads (returns []]', () => {
    window.localStorage.setItem(SNIFF_HISTORY_STORAGE_KEY, 'not json');
    const { result } = renderHook(() => useSniffHistory());
    expect(result.current.entries).toEqual([]);
  });
});
