/**
 * R-27 — unit tests for the persistent history hook + helpers.
 *
 * We deliberately avoid rendering React here; useHistory's pure
 * helpers (mergeProgressIntoRecord, makeHistoryRecord) and its
 * reducer-style API (pushOrReplace / patch / remove / clear) are
 * exercised through the hook with @testing-library/react.
 *
 * Critical invariants checked:
 *   1. pushOrReplace dedupes by id (same id => replace, new id => prepend).
 *   2. The 30-entry cap holds; the oldest is evicted.
 *   3. mergeProgressIntoRecord:
 *      - dedupes outputs across re-emits;
 *      - never lets a non-terminal status overwrite a terminal one
 *        (defensive against late-arriving 'compressing' after 'done').
 *   4. localStorage write/read survives a hook re-mount.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  HISTORY_STORAGE_KEY,
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

beforeEach(() => {
  // Clean storage between tests so they're isolated.
  window.localStorage.clear();
});

// R-27 (post-review): the persistence effect now debounces writes by
// 250ms so a flood of progress events doesn't thrash localStorage.
// Tests that assert "raw storage shape" or "fresh hook re-hydrates"
// must therefore advance past 250ms before peeking at storage.
async function flushPersist(): Promise<void> {
  await act(async () => {
    await new Promise((res) => setTimeout(res, 260));
  });
}

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
    // A late event from a long-tailed pipeline — must NOT roll back.
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
    // R-27 (post-review #4.2): cancelAll cleanup races emit a terminal
    // 'cancelled' AFTER a real 'done' for the same task. The merge MUST
    // preserve the original terminal value so completed work isn't
    // visually downgraded.
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
  it('starts empty and prepends new records (most-recent first)', () => {
    const { result } = renderHook(() => useHistory());
    expect(result.current.history).toEqual([]);
    act(() => {
      result.current.pushOrReplace(rec('a', 1000));
      result.current.pushOrReplace(rec('b', 2000));
    });
    expect(result.current.history.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('replaces records that share an id rather than duplicating', () => {
    const { result } = renderHook(() => useHistory());
    act(() => {
      result.current.pushOrReplace(rec('a', 1000));
      // Same id, newer createdAt — should replace, not append.
      result.current.pushOrReplace({
        ...rec('a', 5000),
        title: 't-a-updated'
      });
    });
    expect(result.current.history).toHaveLength(1);
    expect(result.current.history[0].title).toBe('t-a-updated');
  });

  it('caps at HISTORY_MAX_ENTRIES, evicting the oldest', () => {
    const { result } = renderHook(() => useHistory());
    act(() => {
      // Insert one more than the cap.
      for (let i = 0; i <= HISTORY_MAX_ENTRIES; i++) {
        result.current.pushOrReplace(rec(`r-${i}`, 1000 + i));
      }
    });
    expect(result.current.history).toHaveLength(HISTORY_MAX_ENTRIES);
    // The very oldest (`r-0`) must be gone.
    expect(result.current.history.find((r) => r.id === 'r-0')).toBeUndefined();
  });

  it('persists to localStorage and re-hydrates on a fresh hook instance', async () => {
    const first = renderHook(() => useHistory());
    act(() => {
      first.result.current.pushOrReplace(rec('a', 1000));
      first.result.current.pushOrReplace(rec('b', 2000));
    });
    await flushPersist();
    // Confirm raw storage shape.
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string)).toHaveLength(2);
    // New mount reads back the same list.
    const second = renderHook(() => useHistory());
    expect(second.result.current.history.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('patch only mutates the targeted record', () => {
    const { result } = renderHook(() => useHistory());
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

  it('remove drops just the targeted record; clear wipes all', async () => {
    const { result } = renderHook(() => useHistory());
    act(() => {
      result.current.pushOrReplace(rec('a', 1000));
      result.current.pushOrReplace(rec('b', 2000));
      result.current.remove('a');
    });
    expect(result.current.history.map((r) => r.id)).toEqual(['b']);
    act(() => result.current.clear());
    expect(result.current.history).toEqual([]);
    await flushPersist();
    expect(window.localStorage.getItem(HISTORY_STORAGE_KEY)).toBe('[]');
  });

  it('drops malformed entries during hydration', () => {
    window.localStorage.setItem(
      HISTORY_STORAGE_KEY,
      JSON.stringify([
        { id: 'good', pageUrl: 'https://x.test', items: [], createdAt: 1, options: DEFAULT_OPTIONS, outputsByTaskId: {}, taskStatus: {} },
        { id: 42 }, // wrong type
        null,
        { foo: 'bar' } // missing fields
      ])
    );
    const { result } = renderHook(() => useHistory());
    expect(result.current.history.map((r) => r.id)).toEqual(['good']);
  });

  // R-34 — reload() force-resyncs from localStorage.
  // Two scenarios matter:
  //   1. an EXTERNAL writer (another renderer/window) has updated the
  //      key while this hook was mounted — reload picks up the change;
  //   2. the IN-MEMORY state is newer than disk (debounce hasn't
  //      fired yet) — reload flushes first so disk is at least as
  //      fresh as memory before reading back, ensuring no data loss.
  it('reload picks up external writes that happened after mount', async () => {
    const { result } = renderHook(() => useHistory());
    act(() => {
      result.current.pushOrReplace(rec('a', 1000));
    });
    await flushPersist();
    // External writer drops in a brand-new record + drops 'a'.
    const externalRec = {
      id: 'x',
      pageUrl: 'https://x.test/p',
      title: 't-x',
      items: [],
      createdAt: 9999,
      options: DEFAULT_OPTIONS,
      outputsByTaskId: {},
      taskStatus: {}
    };
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify([externalRec]));
    // Sanity: in-memory is still 'a' until reload.
    expect(result.current.history.map((r) => r.id)).toEqual(['a']);
    act(() => result.current.reload());
    expect(result.current.history.map((r) => r.id)).toEqual(['x']);
  });

  it('reload flushes pending in-memory state before re-reading', () => {
    // We do NOT awaitflushPersist here — the debounce is still in
    // flight when we call reload. Without the writeAll-first step
    // inside reload, the readAll would observe an empty key and
    // overwrite our brand-new in-memory record.
    const { result } = renderHook(() => useHistory());
    act(() => {
      result.current.pushOrReplace(rec('a', 1000));
      // No flushPersist; debounce hasn't fired.
      result.current.reload();
    });
    expect(result.current.history.map((r) => r.id)).toEqual(['a']);
    // Disk should now also have it (reload's flush wrote it through).
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string).map((r: { id: string }) => r.id)).toEqual(['a']);
  });
});
