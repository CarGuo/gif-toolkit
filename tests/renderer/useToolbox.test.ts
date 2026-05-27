/**
 * R-35 — useToolbox hook unit tests.
 *
 * The hook is a thin renderer-side state manager around the toolbox IPC
 * surface plus the SQLite-backed toolbox history. We exercise:
 *   1. Default params per kind (mirrors processor's defaults).
 *   2. setKind clears jobs/progress/lastOutputDir and resets params.
 *   3. addJobsFromPaths dedupes by inputPath.
 *   4. removeJob / clearJobs clean both jobs and progress.
 *   5. start() rejects when jobs is empty and rolls back isRunning on error.
 *   6. Progress events for foreign taskIds are ignored.
 *   7. isRunning auto-flips false once every owned job reaches terminal.
 *   8. R-39 — terminal events migrate jobs into history; the hook
 *      forwards toolbox-history mutations to the mocked
 *      window.giftk.db.toolboxHistory async stubs (readAll/upsert/
 *      remove/clear) and exposes a new `isHistoryLoading` flag.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { defaultParamsFor, useToolbox } from '../../src/renderer/components/useToolbox';
import type { TaskProgress, ToolboxStartResult } from '../../src/shared/types';

type ProgressListener = (p: TaskProgress) => void;

interface FakeToolboxDb {
  readAll: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  __rows: any[];
}

interface FakeGiftk {
  onProgress: (cb: ProgressListener) => () => void;
  toolboxPickFiles: ReturnType<typeof vi.fn>;
  startToolbox: ReturnType<typeof vi.fn>;
  cancelAll: ReturnType<typeof vi.fn>;
  openOutputDir: ReturnType<typeof vi.fn>;
  db: { toolboxHistory: FakeToolboxDb };
  __emit: (p: TaskProgress) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function installFakeToolboxDb(seed: any[] = []): FakeToolboxDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = seed.slice();
  const fake: FakeToolboxDb = {
    readAll: vi.fn(async () => rows.slice()),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upsert: vi.fn(async (e: any) => {
      const i = rows.findIndex((r) => r && r.id === e.id);
      if (i >= 0) rows[i] = e; else rows.unshift(e);
    }),
    remove: vi.fn(async (id: string) => {
      const i = rows.findIndex((r) => r && r.id === id);
      if (i >= 0) rows.splice(i, 1);
    }),
    clear: vi.fn(async () => { rows.length = 0; }),
    __rows: rows
  };
  return fake;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function installFakeGiftk(seedHistory: any[] = []): FakeGiftk {
  const listeners: ProgressListener[] = [];
  const fakeDb = installFakeToolboxDb(seedHistory);
  const fake: FakeGiftk = {
    onProgress: (cb) => {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    toolboxPickFiles: vi.fn(async () => [] as string[]),
    startToolbox: vi.fn(async (): Promise<ToolboxStartResult> => ({ ok: true, outputDir: '/tmp/toolbox/x' })),
    cancelAll: vi.fn(async () => undefined),
    openOutputDir: vi.fn(async () => undefined),
    db: { toolboxHistory: fakeDb },
    __emit: (p) => listeners.forEach((l) => l(p))
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).giftk = fake as any;
  return fake;
}

async function flushLoad(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('defaultParamsFor', () => {
  it('returns sensible defaults per kind', () => {
    expect(defaultParamsFor('video-to-gif')).toEqual({ fps: 12, width: 800, engine: 'ffmpeg' });
    expect(defaultParamsFor('video-to-webp')).toMatchObject({ quality: 75, loop: 0 });
    expect(defaultParamsFor('gif-resize')).toEqual({ targetWidth: 480 });
    expect(defaultParamsFor('gif-optimize')).toEqual({
      method: 'lossy',
      lossy: 80,
      colors: 128,
      dropEveryN: 2
    });
  });

  it('exposes R-37 toolbox defaults', () => {
    expect(defaultParamsFor('trim')).toEqual({});
    expect(defaultParamsFor('speed')).toEqual({ speedFactor: 1 });
    expect(defaultParamsFor('reverse')).toEqual({ reverseAudioMode: 'mute' });
    expect(defaultParamsFor('rotate')).toEqual({ rotateDegrees: 90, flipH: false, flipV: false });
  });

  it('exposes R-38 crop default (empty rect)', () => {
    expect(defaultParamsFor('crop')).toEqual({});
  });

  it('exposes R-42 gif-webp-convert default (target webp)', () => {
    expect(defaultParamsFor('gif-webp-convert')).toEqual({ targetFormat: 'webp' });
  });
});

describe('useToolbox', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).giftk;
    installFakeGiftk();
  });

  it('starts with isHistoryLoading true and flips false after the initial DB read', async () => {
    const { result } = renderHook(() => useToolbox());
    expect(result.current.isHistoryLoading).toBe(true);
    expect(result.current.toolboxHistory).toEqual([]);
    await flushLoad();
    expect(result.current.isHistoryLoading).toBe(false);
  });

  it('flips isHistoryLoading false when the bridge is unavailable', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).giftk;
    const { result } = renderHook(() => useToolbox());
    await flushLoad();
    expect(result.current.isHistoryLoading).toBe(false);
    expect(result.current.toolboxHistory).toEqual([]);
  });

  it('hydrates toolboxHistory from db.toolboxHistory.readAll on mount', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).giftk;
    const fake = installFakeGiftk([
      {
        id: 'h-1',
        kind: 'video-to-gif',
        inputPath: '/a/clip.mp4',
        displayName: 'clip.mp4',
        outputs: ['/o/clip.gif'],
        params: { fps: 12, width: 800 },
        status: 'done',
        finishedAt: 2000
      },
      {
        id: 'h-2',
        kind: 'gif-resize',
        inputPath: '/a/loop.gif',
        displayName: 'loop.gif',
        outputs: ['/o/loop.gif'],
        params: { targetWidth: 480 },
        status: 'failed',
        finishedAt: 1000
      }
    ]);
    const { result } = renderHook(() => useToolbox());
    await flushLoad();
    expect(fake.db.toolboxHistory.readAll).toHaveBeenCalledTimes(1);
    expect(result.current.toolboxHistory.map((e) => e.id)).toEqual(['h-1', 'h-2']);
  });

  it('defaults to video-to-gif and resets params on setKind', async () => {
    const { result } = renderHook(() => useToolbox());
    await flushLoad();
    expect(result.current.kind).toBe('video-to-gif');
    expect(result.current.params).toEqual({ fps: 12, width: 800, engine: 'ffmpeg' });

    act(() => {
      result.current.setKind('gif-resize');
    });
    expect(result.current.kind).toBe('gif-resize');
    expect(result.current.params).toEqual({ targetWidth: 480 });
  });

  it('addJobsFromPaths dedupes by inputPath', async () => {
    const { result } = renderHook(() => useToolbox());
    await flushLoad();
    act(() => {
      result.current.addJobsFromPaths(['/a/x.mp4', '/a/y.mp4']);
    });
    act(() => {
      result.current.addJobsFromPaths(['/a/x.mp4', '/a/z.mp4']);
    });
    expect(result.current.jobs.map((j) => j.inputPath)).toEqual([
      '/a/x.mp4',
      '/a/y.mp4',
      '/a/z.mp4'
    ]);
  });

  it('setKind keeps queued jobs whose extension is still allowed (R-38, updated R-41)', async () => {
    const { result } = renderHook(() => useToolbox());
    await flushLoad();
    act(() => {
      result.current.addJobsFromPaths(['/a/clip.mp4', '/a/clip.mov']);
    });
    expect(result.current.jobs).toHaveLength(2);

    act(() => {
      result.current.setKind('video-to-webp');
    });
    expect(result.current.jobs.map((j) => j.inputPath).sort()).toEqual([
      '/a/clip.mov',
      '/a/clip.mp4'
    ]);

    act(() => {
      result.current.setKind('gif-resize');
    });
    expect(result.current.jobs).toEqual([]);
  });

  it('setKind to reverse drops video jobs but keeps gif/webp (R-41)', async () => {
    const { result } = renderHook(() => useToolbox());
    await flushLoad();
    act(() => {
      result.current.addJobsFromPaths(['/a/clip.mp4', '/a/clip.mov']);
    });
    act(() => {
      result.current.setKind('trim');
    });
    act(() => {
      result.current.addJobsFromPaths(['/a/loop.gif', '/a/anim.webp']);
    });
    act(() => {
      result.current.setKind('reverse');
    });
    expect(result.current.jobs.map((j) => j.inputPath).sort()).toEqual([
      '/a/anim.webp',
      '/a/loop.gif'
    ]);
  });

  it('addJobsFromPaths under reverse accepts gif and webp, rejects video (R-41)', async () => {
    const { result } = renderHook(() => useToolbox());
    await flushLoad();
    act(() => {
      result.current.setKind('reverse');
    });
    act(() => {
      result.current.addJobsFromPaths(['/a/loop.gif', '/a/anim.webp', '/a/clip.mp4', '/a/movie.webm']);
    });
    expect(result.current.jobs.map((j) => j.inputPath).sort()).toEqual([
      '/a/anim.webp',
      '/a/loop.gif'
    ]);
  });

  it('setKind confirm callback can abort an incompatible switch (R-41)', async () => {
    const { result } = renderHook(() => useToolbox());
    await flushLoad();
    act(() => {
      result.current.addJobsFromPaths(['/a/clip.mp4', '/a/clip.mov']);
    });
    expect(result.current.jobs).toHaveLength(2);
    let returned: boolean | undefined;
    let droppedCount: number | undefined;
    act(() => {
      returned = result.current.setKind('reverse', {
        confirm: (n) => {
          droppedCount = n;
          return false;
        }
      });
    });
    expect(returned).toBe(false);
    expect(droppedCount).toBe(2);
    expect(result.current.kind).toBe('video-to-gif');
    expect(result.current.jobs).toHaveLength(2);

    act(() => {
      returned = result.current.setKind('reverse', { confirm: () => true });
    });
    expect(returned).toBe(true);
    expect(result.current.kind).toBe('reverse');
    expect(result.current.jobs).toEqual([]);
  });

  it('removeJob and clearJobs both purge progress entries', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).giftk;
    const fake = installFakeGiftk();
    fake.startToolbox.mockResolvedValueOnce({ ok: true, outputDir: '/o' });
    const { result } = renderHook(() => useToolbox());
    await flushLoad();
    act(() => {
      result.current.addJobsFromPaths(['/a/1.mp4', '/a/2.mp4']);
    });
    const ids = result.current.jobs.map((j) => j.id);
    await act(async () => {
      await result.current.start();
    });
    act(() => {
      fake.__emit({ taskId: ids[0], status: 'pending', percent: 0 });
      fake.__emit({ taskId: ids[1], status: 'pending', percent: 0 });
    });
    expect(Object.keys(result.current.progress)).toHaveLength(2);
    act(() => result.current.removeJob(ids[0]));
    expect(result.current.progress[ids[0]]).toBeUndefined();
    expect(Object.keys(result.current.progress)).toHaveLength(1);
    act(() => result.current.clearJobs());
    expect(result.current.progress).toEqual({});
    expect(result.current.jobs).toHaveLength(0);
  });

  it('start() rejects with error when no jobs are queued', async () => {
    const { result } = renderHook(() => useToolbox());
    await flushLoad();
    let r: { ok: boolean; error?: string } | undefined;
    await act(async () => {
      r = await result.current.start();
    });
    expect(r?.ok).toBe(false);
    expect(r?.error).toMatch(/no jobs/);
    expect(result.current.isRunning).toBe(false);
  });

  it('start() flips isRunning true and remembers outputDir on success', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).giftk;
    const fake = installFakeGiftk();
    fake.startToolbox.mockResolvedValueOnce({ ok: true, outputDir: '/out/toolbox/x' });
    const { result } = renderHook(() => useToolbox());
    await flushLoad();
    act(() => {
      result.current.addJobsFromPaths(['/a/1.mp4']);
    });
    await act(async () => {
      const r = await result.current.start();
      expect(r.ok).toBe(true);
    });
    expect(result.current.isRunning).toBe(true);
    expect(result.current.lastOutputDir).toBe('/out/toolbox/x');
  });

  it('start() rolls back isRunning when IPC throws', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).giftk;
    const fake = installFakeGiftk();
    fake.startToolbox.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useToolbox());
    await flushLoad();
    act(() => {
      result.current.addJobsFromPaths(['/a/1.mp4']);
    });
    let r: { ok: boolean; error?: string } | undefined;
    await act(async () => {
      r = await result.current.start();
    });
    expect(r?.ok).toBe(false);
    expect(r?.error).toMatch(/boom/);
    expect(result.current.isRunning).toBe(false);
  });

  it('progress events for foreign taskIds are ignored', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).giftk;
    const fake = installFakeGiftk();
    const { result } = renderHook(() => useToolbox());
    await flushLoad();
    act(() => {
      result.current.addJobsFromPaths(['/a/1.mp4']);
    });
    await act(async () => {
      await result.current.start();
    });
    const ownedId = result.current.jobs[0].id;
    act(() => {
      fake.__emit({ taskId: 'home-batch-task', status: 'pending', percent: 50 });
    });
    expect(result.current.progress).toEqual({});
    act(() => {
      fake.__emit({ taskId: ownedId, status: 'compressing', percent: 50 });
    });
    expect(result.current.progress[ownedId]?.status).toBe('compressing');
  });

  it('flips isRunning false after every owned job reaches a terminal status', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).giftk;
    const fake = installFakeGiftk();
    const { result } = renderHook(() => useToolbox());
    await flushLoad();
    act(() => {
      result.current.addJobsFromPaths(['/a/1.mp4', '/a/2.mp4']);
    });
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.isRunning).toBe(true);
    const [a, b] = result.current.jobs.map((j) => j.id);
    act(() => {
      fake.__emit({ taskId: a, status: 'done', percent: 100 });
    });
    expect(result.current.isRunning).toBe(true);
    act(() => {
      fake.__emit({ taskId: b, status: 'failed', percent: 0, error: 'oops' });
    });
    expect(result.current.isRunning).toBe(false);
  });

  it('done event migrates the job from queue into history and forwards db.toolboxHistory.upsert', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).giftk;
    const fake = installFakeGiftk();
    const { result } = renderHook(() => useToolbox());
    await flushLoad();
    act(() => {
      result.current.addJobsFromPaths(['/a/clip.mp4']);
    });
    await act(async () => {
      await result.current.start();
    });
    const id = result.current.jobs[0].id;
    expect(result.current.toolboxHistory).toHaveLength(0);

    act(() => {
      fake.__emit({ taskId: id, status: 'done', percent: 100, outputs: ['/o/clip.gif'] });
    });

    expect(result.current.jobs).toHaveLength(0);
    expect(result.current.progress[id]).toBeUndefined();
    expect(result.current.toolboxHistory).toHaveLength(1);
    expect(result.current.toolboxHistory[0]).toMatchObject({
      id,
      kind: 'video-to-gif',
      inputPath: '/a/clip.mp4',
      displayName: 'clip.mp4',
      outputs: ['/o/clip.gif'],
      status: 'done'
    });
    expect(fake.db.toolboxHistory.upsert).toHaveBeenCalledWith(expect.objectContaining({ id, status: 'done' }));
  });

  it('failed event also migrates the job (with error) into history', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).giftk;
    const fake = installFakeGiftk();
    const { result } = renderHook(() => useToolbox());
    await flushLoad();
    act(() => {
      result.current.addJobsFromPaths(['/a/bad.mp4']);
    });
    await act(async () => {
      await result.current.start();
    });
    const id = result.current.jobs[0].id;

    act(() => {
      fake.__emit({ taskId: id, status: 'failed', percent: 0, error: 'ffprobe boom' });
    });
    expect(result.current.jobs).toHaveLength(0);
    expect(result.current.toolboxHistory).toHaveLength(1);
    expect(result.current.toolboxHistory[0].status).toBe('failed');
    expect(result.current.toolboxHistory[0].error).toBe('ffprobe boom');
  });

  it('R-43 — addJobsFromPaths records the active kind, not a hard-coded one', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).giftk;
    const fake = installFakeGiftk();
    const { result } = renderHook(() => useToolbox());
    await flushLoad();
    act(() => {
      result.current.setKind('gif-webp-convert');
    });
    act(() => {
      result.current.addJobsFromPaths(['/a/anim.webp']);
    });
    expect(result.current.jobs).toHaveLength(1);
    expect(result.current.jobs[0].kind).toBe('gif-webp-convert');
    await act(async () => {
      await result.current.start();
    });
    const id = result.current.jobs[0].id;
    act(() => {
      fake.__emit({ taskId: id, status: 'done', percent: 100, outputs: ['/o/anim.gif'] });
    });
    expect(result.current.toolboxHistory).toHaveLength(1);
    expect(result.current.toolboxHistory[0].kind).toBe('gif-webp-convert');
  });

  it('history persists via the DB stub and survives remount', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).giftk;
    const fake = installFakeGiftk();
    const { result, unmount } = renderHook(() => useToolbox());
    await flushLoad();
    act(() => {
      result.current.addJobsFromPaths(['/a/clip.mp4']);
    });
    await act(async () => {
      await result.current.start();
    });
    const id = result.current.jobs[0].id;
    act(() => {
      fake.__emit({ taskId: id, status: 'done', percent: 100, outputs: ['/o/clip.gif'] });
    });
    expect(result.current.toolboxHistory).toHaveLength(1);
    // The fake DB now has the row.
    expect(fake.db.toolboxHistory.__rows).toHaveLength(1);
    expect(fake.db.toolboxHistory.__rows[0]).toMatchObject({ inputPath: '/a/clip.mp4', status: 'done' });

    unmount();
    // Re-mount against the same fake (giftk still installed) — it
    // reads the seeded row out of the DB stub.
    const remount = renderHook(() => useToolbox());
    await flushLoad();
    expect(remount.result.current.toolboxHistory).toHaveLength(1);
    expect(remount.result.current.toolboxHistory[0].id).toBe(id);
  });

  it('removeHistoryEntry forwards to db.toolboxHistory.remove and clearToolboxHistory calls clear', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).giftk;
    const fake = installFakeGiftk();
    const { result } = renderHook(() => useToolbox());
    await flushLoad();
    act(() => {
      result.current.addJobsFromPaths(['/a/x.mp4', '/a/y.mp4']);
    });
    await act(async () => {
      await result.current.start();
    });
    const ids = result.current.jobs.map((j) => j.id);
    act(() => {
      fake.__emit({ taskId: ids[0], status: 'done', percent: 100, outputs: ['/o/x.gif'] });
      fake.__emit({ taskId: ids[1], status: 'done', percent: 100, outputs: ['/o/y.gif'] });
    });
    expect(result.current.toolboxHistory).toHaveLength(2);

    act(() => {
      result.current.removeHistoryEntry(ids[0]);
    });
    expect(result.current.toolboxHistory).toHaveLength(1);
    expect(result.current.toolboxHistory[0].id).toBe(ids[1]);
    expect(fake.db.toolboxHistory.remove).toHaveBeenCalledWith(ids[0]);

    act(() => {
      result.current.clearToolboxHistory();
    });
    expect(result.current.toolboxHistory).toHaveLength(0);
    expect(fake.db.toolboxHistory.clear).toHaveBeenCalledTimes(1);
  });

  it('duplicate done events for the same id are idempotent', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).giftk;
    const fake = installFakeGiftk();
    const { result } = renderHook(() => useToolbox());
    await flushLoad();
    act(() => {
      result.current.addJobsFromPaths(['/a/x.mp4']);
    });
    await act(async () => {
      await result.current.start();
    });
    const id = result.current.jobs[0].id;
    act(() => {
      fake.__emit({ taskId: id, status: 'done', percent: 100, outputs: ['/o/x.gif'] });
      fake.__emit({ taskId: id, status: 'done', percent: 100, outputs: ['/o/x.gif'] });
    });
    expect(result.current.toolboxHistory).toHaveLength(1);
  });
});

// R-TRIM-CROP-SINGLE — Trim/Crop must operate on exactly one queued
// file at a time even when the queue holds many. The hook auto-pins
// `selectedJobId` to jobs[0] on enter and to the new head when the
// pinned row is removed; `start()` in these kinds dispatches ONLY the
// selected payload and leaves the rest of the queue intact for a
// follow-up run.
describe('useToolbox — R-TRIM-CROP-SINGLE single-file selection', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).giftk;
  });

  it('auto-pins selectedJobId to jobs[0] when entering trim with a non-empty queue', async () => {
    installFakeGiftk();
    const { result } = renderHook(() => useToolbox());
    await flushLoad();
    // R-41 — gif inputs are only accepted under gif-* / trim / crop /
    // ... kinds, NOT under the default video-to-gif. Switch first.
    act(() => { result.current.setKind('trim'); });
    act(() => {
      result.current.addJobsFromPaths(['/a/x.gif', '/a/y.gif', '/a/z.gif']);
    });
    expect(result.current.jobs).toHaveLength(3);
    expect(result.current.selectedJobId).toBe(result.current.jobs[0].id);
  });

  it('selectJob re-pins to a different row, and clears to jobs[0] when that row is removed', async () => {
    installFakeGiftk();
    const { result } = renderHook(() => useToolbox());
    await flushLoad();
    act(() => { result.current.setKind('trim'); });
    act(() => {
      result.current.addJobsFromPaths(['/a/x.gif', '/a/y.gif', '/a/z.gif']);
    });
    const second = result.current.jobs[1].id;
    act(() => { result.current.selectJob(second); });
    expect(result.current.selectedJobId).toBe(second);
    act(() => { result.current.removeJob(second); });
    // After removal the auto-pin effect should snap to the new jobs[0].
    expect(result.current.selectedJobId).toBe(result.current.jobs[0].id);
  });

  it('selectJob is a no-op for unknown ids (stale clicks cannot strand the panel)', async () => {
    installFakeGiftk();
    const { result } = renderHook(() => useToolbox());
    await flushLoad();
    act(() => { result.current.setKind('trim'); });
    act(() => { result.current.addJobsFromPaths(['/a/x.gif']); });
    const pinned = result.current.selectedJobId;
    act(() => { result.current.selectJob('does-not-exist'); });
    expect(result.current.selectedJobId).toBe(pinned);
  });

  it('start() in trim/crop dispatches ONLY the selected job, leaving the rest of the queue', async () => {
    const fake = installFakeGiftk();
    fake.startToolbox.mockResolvedValueOnce({ ok: true, outputDir: '/out/x' });
    const { result } = renderHook(() => useToolbox());
    await flushLoad();
    act(() => { result.current.setKind('trim'); });
    act(() => {
      result.current.addJobsFromPaths(['/a/x.gif', '/a/y.gif', '/a/z.gif']);
    });
    const second = result.current.jobs[1].id;
    const secondPath = result.current.jobs[1].inputPath;
    act(() => { result.current.selectJob(second); });
    await act(async () => {
      const r = await result.current.start();
      expect(r.ok).toBe(true);
    });
    expect(fake.startToolbox).toHaveBeenCalledTimes(1);
    const payload = fake.startToolbox.mock.calls[0][0] as Array<{ id: string; inputPath: string; kind: string }>;
    expect(payload).toHaveLength(1);
    expect(payload[0].id).toBe(second);
    expect(payload[0].inputPath).toBe(secondPath);
    expect(payload[0].kind).toBe('trim');
    // Other rows must remain queued for follow-up runs.
    expect(result.current.jobs.map((j) => j.inputPath)).toContain('/a/x.gif');
    expect(result.current.jobs.map((j) => j.inputPath)).toContain('/a/z.gif');
  });

  it('start() in non-single kinds (video-to-gif) still dispatches the entire queue', async () => {
    const fake = installFakeGiftk();
    fake.startToolbox.mockResolvedValueOnce({ ok: true, outputDir: '/out/x' });
    const { result } = renderHook(() => useToolbox());
    await flushLoad();
    act(() => {
      result.current.addJobsFromPaths(['/a/1.mp4', '/a/2.mp4', '/a/3.mp4']);
    });
    expect(result.current.kind).toBe('video-to-gif');
    await act(async () => {
      await result.current.start();
    });
    const payload = fake.startToolbox.mock.calls[0][0] as Array<unknown>;
    expect(payload).toHaveLength(3);
  });

  it('start() falls back to jobs[0] when selectedJobId is stale (defensive guard)', async () => {
    const fake = installFakeGiftk();
    fake.startToolbox.mockResolvedValueOnce({ ok: true, outputDir: '/out/x' });
    const { result } = renderHook(() => useToolbox());
    await flushLoad();
    act(() => { result.current.setKind('crop'); });
    act(() => {
      result.current.addJobsFromPaths(['/a/x.gif', '/a/y.gif']);
    });
    const firstPath = result.current.jobs[0].inputPath;
    await act(async () => { await result.current.start(); });
    const payload = fake.startToolbox.mock.calls[0][0] as Array<{ inputPath: string }>;
    expect(payload).toHaveLength(1);
    expect(payload[0].inputPath).toBe(firstPath);
  });
});
