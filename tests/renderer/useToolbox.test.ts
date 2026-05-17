/**
 * R-35 — useToolbox hook unit tests.
 *
 * The hook is a thin renderer-side state manager around the toolbox IPC
 * surface. We exercise:
 *   1. Default params per kind (mirrors processor's defaults).
 *   2. setKind clears jobs/progress/lastOutputDir and resets params.
 *   3. addJobsFromPaths dedupes by inputPath.
 *   4. removeJob / clearJobs clean both jobs and progress.
 *   5. start() rejects when jobs is empty and rolls back isRunning on error.
 *   6. start() ignores `process:progress` events whose taskId we don't own
 *      (so an unrelated home-tab batch can't poison toolbox state).
 *   7. isRunning auto-flips false once every owned job reaches a terminal
 *      status.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { defaultParamsFor, useToolbox, TOOLBOX_HISTORY_STORAGE_KEY } from '../../src/renderer/components/useToolbox';
import type { TaskProgress, ToolboxStartResult } from '../../src/shared/types';

type ProgressListener = (p: TaskProgress) => void;

interface FakeGiftk {
  onProgress: (cb: ProgressListener) => () => void;
  toolboxPickFiles: ReturnType<typeof vi.fn>;
  startToolbox: ReturnType<typeof vi.fn>;
  cancelAll: ReturnType<typeof vi.fn>;
  openOutputDir: ReturnType<typeof vi.fn>;
  __emit: (p: TaskProgress) => void;
}

function installFakeGiftk(): FakeGiftk {
  const listeners: ProgressListener[] = [];
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
    __emit: (p) => listeners.forEach((l) => l(p))
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).giftk = fake as any;
  return fake;
}

describe('defaultParamsFor', () => {
  it('returns sensible defaults per kind', () => {
    expect(defaultParamsFor('video-to-gif')).toEqual({ fps: 12, width: 800 });
    expect(defaultParamsFor('video-to-webp')).toMatchObject({ quality: 75, loop: 0 });
    expect(defaultParamsFor('gif-resize')).toEqual({ targetWidth: 480 });
    // R-36 — gif-optimize default surfaces a `method` so the renderer
    // form can render the right sub-fields without an explicit pick.
    expect(defaultParamsFor('gif-optimize')).toEqual({
      method: 'lossy',
      lossy: 80,
      colors: 128,
      dropEveryN: 2
    });
  });

  // R-37 — Trim/Speed/Reverse/Rotate defaults. The hook + main-side
  // sanitiser both rely on these exact shapes; keep them in lockstep.
  it('exposes R-37 toolbox defaults', () => {
    expect(defaultParamsFor('trim')).toEqual({});
    expect(defaultParamsFor('speed')).toEqual({ speedFactor: 1 });
    expect(defaultParamsFor('reverse')).toEqual({ reverseAudioMode: 'mute' });
    expect(defaultParamsFor('rotate')).toEqual({ rotateDegrees: 90, flipH: false, flipV: false });
  });

  // R-38 — Crop ships with no rect by default; the user must drag one.
  // The renderer also enforces a single-file Start guard, but the hook
  // itself stays kind-agnostic so backend integrations remain reusable.
  it('exposes R-38 crop default (empty rect)', () => {
    expect(defaultParamsFor('crop')).toEqual({});
  });

  // R-42 — gif-webp-convert defaults to webp output. The actual flip
  // (input is .webp → default to .gif and vice versa) lives in the
  // ToolboxPanel effect, not the hook, because the hook is purposely
  // unaware of which file types live in the queue.
  it('exposes R-42 gif-webp-convert default (target webp)', () => {
    expect(defaultParamsFor('gif-webp-convert')).toEqual({ targetFormat: 'webp' });
  });
});

describe('useToolbox', () => {
  beforeEach(() => {
    installFakeGiftk();
    // R-39 — every test starts with an empty history so localStorage
    // residue from earlier tests doesn't leak in.
    try { window.localStorage.removeItem(TOOLBOX_HISTORY_STORAGE_KEY); } catch { /* ignore */ }
  });

  it('defaults to video-to-gif and resets params on setKind', () => {
    const { result } = renderHook(() => useToolbox());
    expect(result.current.kind).toBe('video-to-gif');
    expect(result.current.params).toEqual({ fps: 12, width: 800 });

    act(() => {
      result.current.setKind('gif-resize');
    });
    expect(result.current.kind).toBe('gif-resize');
    expect(result.current.params).toEqual({ targetWidth: 480 });
  });

  it('addJobsFromPaths dedupes by inputPath', () => {
    const { result } = renderHook(() => useToolbox());
    act(() => {
      result.current.addJobsFromPaths(['/a/x.mp4', '/a/y.mp4']);
    });
    act(() => {
      // Re-add one duplicate plus a new one.
      result.current.addJobsFromPaths(['/a/x.mp4', '/a/z.mp4']);
    });
    expect(result.current.jobs.map((j) => j.inputPath)).toEqual([
      '/a/x.mp4',
      '/a/y.mp4',
      '/a/z.mp4'
    ]);
  });

  it('setKind keeps queued jobs whose extension is still allowed (R-38, updated R-41)', () => {
    // Before R-38 setKind unconditionally cleared jobs. The new behaviour
    // is to filter jobs by the *new* kind's extension whitelist so that
    // switching e.g. video-to-gif → video-to-webp (both accept video)
    // preserves user work, while switching to a GIF/WebP-only tool
    // drops video items.
    // R-41 — Trim no longer accepts .mp4 (it's GIF_OR_WEBP now). Use
    // video-to-gif as the multi-video seed and trim as the
    // multi-image seed.
    const { result } = renderHook(() => useToolbox());
    act(() => {
      result.current.addJobsFromPaths(['/a/clip.mp4', '/a/clip.mov']);
    });
    expect(result.current.jobs).toHaveLength(2);

    // video-to-webp also accepts video → both should remain.
    act(() => {
      result.current.setKind('video-to-webp');
    });
    expect(result.current.jobs.map((j) => j.inputPath).sort()).toEqual([
      '/a/clip.mov',
      '/a/clip.mp4'
    ]);

    // gif-resize only accepts .gif/.webp → both .mp4/.mov should be dropped.
    act(() => {
      result.current.setKind('gif-resize');
    });
    expect(result.current.jobs).toEqual([]);
  });

  // R-41 — Reverse / Trim / Speed / Rotate / Crop accept .gif AND .webp.
  // Switching from a video-only kind to one of those tools must drop
  // video rows but preserve gif/webp rows. Switching from one GIF/WebP
  // tool to another should preserve everything.
  it('setKind to reverse drops video jobs but keeps gif/webp (R-41)', () => {
    const { result } = renderHook(() => useToolbox());
    // Seed under video-to-gif (accepts mp4/mov/webm) for the videos,
    // then add gif/webp under trim (accepts those).
    act(() => {
      result.current.addJobsFromPaths(['/a/clip.mp4', '/a/clip.mov']);
    });
    act(() => {
      result.current.setKind('trim');
    });
    act(() => {
      result.current.addJobsFromPaths(['/a/loop.gif', '/a/anim.webp']);
    });
    // Switching trim → reverse keeps both .gif and .webp (both are in
    // GIF_OR_WEBP whitelist). The earlier .mp4/.mov entries were
    // already filtered when we entered trim.
    act(() => {
      result.current.setKind('reverse');
    });
    expect(result.current.jobs.map((j) => j.inputPath).sort()).toEqual([
      '/a/anim.webp',
      '/a/loop.gif'
    ]);
  });

  // R-41 — addJobsFromPaths under reverse must reject .mp4 but accept
  // both .gif and .webp.
  it('addJobsFromPaths under reverse accepts gif and webp, rejects video (R-41)', () => {
    const { result } = renderHook(() => useToolbox());
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

  // R-41 — setKind exposes an optional `confirm` callback. When the
  // target kind would drop incompatible jobs, the hook calls confirm
  // with the drop count. If confirm returns false, the kind switch is
  // aborted (kind + jobs both unchanged) and setKind returns false.
  // If confirm returns true (or isn't provided), the switch proceeds
  // and incompatible rows are filtered.
  it('setKind confirm callback can abort an incompatible switch (R-41)', () => {
    const { result } = renderHook(() => useToolbox());
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
    // Confirm rejected → kind stays as the previous video-to-gif and
    // queue is untouched.
    expect(returned).toBe(false);
    expect(droppedCount).toBe(2);
    expect(result.current.kind).toBe('video-to-gif');
    expect(result.current.jobs).toHaveLength(2);

    // Now approve the drop and confirm the kind/jobs flip.
    act(() => {
      returned = result.current.setKind('reverse', { confirm: () => true });
    });
    expect(returned).toBe(true);
    expect(result.current.kind).toBe('reverse');
    expect(result.current.jobs).toEqual([]);
  });

  it('removeJob and clearJobs both purge progress entries', async () => {
    const fake = installFakeGiftk();
    fake.startToolbox.mockResolvedValueOnce({ ok: true, outputDir: '/o' });
    const { result } = renderHook(() => useToolbox());
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
    let r: { ok: boolean; error?: string } | undefined;
    await act(async () => {
      r = await result.current.start();
    });
    expect(r?.ok).toBe(false);
    expect(r?.error).toMatch(/no jobs/);
    expect(result.current.isRunning).toBe(false);
  });

  it('start() flips isRunning true and remembers outputDir on success', async () => {
    const fake = installFakeGiftk();
    fake.startToolbox.mockResolvedValueOnce({ ok: true, outputDir: '/out/toolbox/x' });
    const { result } = renderHook(() => useToolbox());
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
    const fake = installFakeGiftk();
    fake.startToolbox.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useToolbox());
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
    const fake = installFakeGiftk();
    const { result } = renderHook(() => useToolbox());
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
    const fake = installFakeGiftk();
    const { result } = renderHook(() => useToolbox());
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

  // R-39 — terminal-status progress events promote the row out of `jobs`
  // into `toolboxHistory`, persist it to localStorage and clear the
  // matching `progress` entry. The audit log keeps both successful and
  // failed runs (the UI distinguishes them via row classes).
  it('done event migrates the job from queue into history', async () => {
    const fake = installFakeGiftk();
    const { result } = renderHook(() => useToolbox());
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
  });

  it('failed event also migrates the job (with error) into history', async () => {
    const fake = installFakeGiftk();
    const { result } = renderHook(() => useToolbox());
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

  // R-43 H-2 — addJobsFromPaths uses the closure `kind` rather than the
  // hard-coded literal 'video-to-gif'. A queued job under any non-default
  // kind must report that kind both on the live row and (after a `done`
  // event) in toolbox history; otherwise history would mislabel every
  // run as video-to-gif and downstream filters would break.
  it('R-43 — addJobsFromPaths records the active kind, not a hard-coded one', async () => {
    const fake = installFakeGiftk();
    const { result } = renderHook(() => useToolbox());
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

  it('history persists to localStorage and survives reload', async () => {
    const fake = installFakeGiftk();
    const { result, unmount } = renderHook(() => useToolbox());
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

    // Persisted blob lives in localStorage under the well-known key.
    const raw = window.localStorage.getItem(TOOLBOX_HISTORY_STORAGE_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ inputPath: '/a/clip.mp4', status: 'done' });

    unmount();
    // Re-mount; the new hook instance reads localStorage on init.
    const remount = renderHook(() => useToolbox());
    expect(remount.result.current.toolboxHistory).toHaveLength(1);
    expect(remount.result.current.toolboxHistory[0].id).toBe(id);
  });

  it('removeHistoryEntry and clearToolboxHistory both update storage', async () => {
    const fake = installFakeGiftk();
    const { result } = renderHook(() => useToolbox());
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

    act(() => {
      result.current.clearToolboxHistory();
    });
    expect(result.current.toolboxHistory).toHaveLength(0);
    const raw = window.localStorage.getItem(TOOLBOX_HISTORY_STORAGE_KEY);
    expect(raw).toBe('[]');
  });

  it('duplicate done events for the same id are idempotent', async () => {
    const fake = installFakeGiftk();
    const { result } = renderHook(() => useToolbox());
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
