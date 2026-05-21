// @vitest-environment happy-dom
/**
 * Tests for useUploadOrchestrator
 * (src/renderer/components/useUploadOrchestrator.ts).
 *
 * What we lock in
 * ---------------
 *  • Mount-once: uploadGetSettings is called once and the result is
 *    handed to setUploadConfigs.
 *  • Mount-once swallows rejection (.catch(() => { /* ignore *\/ })) so
 *    a missing settings file (the normal first-run state) does NOT
 *    bubble an unhandled rejection.
 *  • onUploadOne with empty outputs appends the verbatim
 *    `[upload] 跳过:任务 ${id} 没有可用输出` line and does NOT call
 *    dispatchUpload.
 *  • onUploadOne with outputs[0] hands a single-entry plan (using the
 *    FIRST output) to dispatchUpload.
 *  • onUploadAll filters: only items whose progress[id]?.status ===
 *    'done' AND has outputs[0] make it into the plan.
 *  • onUploadAll empty plan still calls dispatchUpload([]) — the
 *    "no uploadable products" message is owned by dispatchUpload, not
 *    the orchestrator.
 *  • onSaveUploadSettings push → re-pull → setUploadConfigs.
 *  • uploadAllStats empty-items branch returns the configured-aware
 *    shape (driven by isUploadConfigured(uploadConfigs)).
 *  • uploadAllReady is true ONLY when allDone && hasUploadable.
 *  • uploadAllTitle returns the right one of FOUR distinct messages
 *    per branch (zero-items, not-configured, not-allDone, no-uploadable, ready).
 */
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  useUploadOrchestrator,
  type UploadOrchestratorDeps
} from '../../src/renderer/components/useUploadOrchestrator';
import type {
  SniffedMedia,
  TaskProgress,
  UploadConfigs
} from '../../src/shared/types';

const makeMedia = (id: string, overrides: Partial<SniffedMedia> = {}): SniffedMedia => ({
  id,
  url: `https://media.test/${id}.mp4`,
  kind: 'video',
  source: 'video',
  pageUrl: 'https://host.test/page',
  ...overrides
});

const makeProgress = (overrides: Partial<TaskProgress> = {}): TaskProgress => ({
  taskId: 't',
  status: 'pending',
  percent: 0,
  ...overrides
});

const makeGithubConfigs = (): UploadConfigs => ({
  active: 'github',
  github: {
    token: 'gh-token',
    repo: 'owner/repo'
  }
});

interface Handles {
  deps: UploadOrchestratorDeps;
  giftk: {
    uploadGetSettings: ReturnType<typeof vi.fn>;
    uploadSetSettings: ReturnType<typeof vi.fn>;
  };
  dispatchUpload: ReturnType<typeof vi.fn>;
  setUploadConfigs: ReturnType<typeof vi.fn>;
  setLogs: ReturnType<typeof vi.fn>;
}

interface MakeDepsOpts {
  items?: SniffedMedia[];
  progress?: Record<string, TaskProgress>;
  uploadConfigs?: UploadConfigs | null;
  uploadGetSettingsImpl?: () => Promise<UploadConfigs>;
  uploadSetSettingsImpl?: (c: UploadConfigs) => Promise<{ ok: boolean }>;
  dispatchImpl?: (
    plan: Array<{ media: SniffedMedia; filePath: string }>
  ) => Promise<void>;
}

const makeDeps = (opts: MakeDepsOpts = {}): Handles => {
  const uploadGetSettings = vi.fn(opts.uploadGetSettingsImpl ?? (async () => makeGithubConfigs()));
  const uploadSetSettings = vi.fn(opts.uploadSetSettingsImpl ?? (async () => ({ ok: true })));
  const dispatchUpload = vi.fn(opts.dispatchImpl ?? (async () => undefined));
  const setUploadConfigs = vi.fn();
  const setLogs = vi.fn();
  const giftk = { uploadGetSettings, uploadSetSettings };

  return {
    giftk,
    dispatchUpload,
    setUploadConfigs,
    setLogs,
    deps: {
      giftk,
      dispatchUpload,
      items: opts.items ?? [],
      progress: opts.progress ?? {},
      uploadConfigs: opts.uploadConfigs ?? null,
      setUploadConfigs,
      setLogs
    }
  };
};

const flushAsync = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('useUploadOrchestrator', () => {
  it('mount: loads uploadGetSettings → setUploadConfigs called once', async () => {
    const cfg = makeGithubConfigs();
    const handles = makeDeps({ uploadGetSettingsImpl: async () => cfg });
    renderHook(() => useUploadOrchestrator(handles.deps));

    await waitFor(() => {
      expect(handles.giftk.uploadGetSettings).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(handles.setUploadConfigs).toHaveBeenCalledTimes(1);
    });
    expect(handles.setUploadConfigs).toHaveBeenCalledWith(cfg);
  });

  it('mount: swallows uploadGetSettings rejection without throwing', async () => {
    const handles = makeDeps({
      uploadGetSettingsImpl: async () => { throw new Error('NO_SETTINGS_FILE'); }
    });

    expect(() => renderHook(() => useUploadOrchestrator(handles.deps))).not.toThrow();
    await flushAsync();
    expect(handles.giftk.uploadGetSettings).toHaveBeenCalledTimes(1);
    // setUploadConfigs is NEVER called on the rejection path.
    expect(handles.setUploadConfigs).not.toHaveBeenCalled();
  });

  it('onUploadOne with empty outputs logs the skip line and does NOT call dispatchUpload', async () => {
    const m = makeMedia('m1');
    const handles = makeDeps();
    const { result } = renderHook(() => useUploadOrchestrator(handles.deps));
    await flushAsync();
    handles.dispatchUpload.mockClear();
    handles.setLogs.mockClear();

    await act(async () => {
      await result.current.onUploadOne(m, makeProgress({ outputs: [] }));
    });

    expect(handles.dispatchUpload).not.toHaveBeenCalled();
    // The setLogs reducer MUST be called once with a function that
    // appends the verbatim skip line.
    expect(handles.setLogs).toHaveBeenCalledTimes(1);
    const reducer = handles.setLogs.mock.calls[0][0] as (prev: string[]) => string[];
    const next = reducer([]);
    expect(next).toEqual([`[upload] 跳过:任务 m1 没有可用输出`]);
  });

  it('onUploadOne preserves slice(-300) cap on the log buffer', async () => {
    const m = makeMedia('m-cap');
    const handles = makeDeps();
    const { result } = renderHook(() => useUploadOrchestrator(handles.deps));
    await flushAsync();
    handles.setLogs.mockClear();

    await act(async () => {
      await result.current.onUploadOne(m, makeProgress({ outputs: [] }));
    });
    const reducer = handles.setLogs.mock.calls[0][0] as (prev: string[]) => string[];
    const huge = Array.from({ length: 500 }, (_, i) => `line-${i}`);
    const out = reducer(huge);
    expect(out.length).toBe(300);
    // Last entry is the freshly-appended skip line.
    expect(out[out.length - 1]).toBe(`[upload] 跳过:任务 m-cap 没有可用输出`);
    // The first 201 lines were dropped by slice(-300) (501 → keep last 300).
    expect(out[0]).toBe('line-201');
  });

  it('onUploadOne with non-empty outputs calls dispatchUpload with the FIRST output', async () => {
    const m = makeMedia('m2');
    const handles = makeDeps();
    const { result } = renderHook(() => useUploadOrchestrator(handles.deps));
    await flushAsync();
    handles.dispatchUpload.mockClear();

    await act(async () => {
      await result.current.onUploadOne(m, makeProgress({
        status: 'done',
        outputs: ['/out/a.gif', '/out/a.webp']
      }));
    });

    expect(handles.dispatchUpload).toHaveBeenCalledTimes(1);
    expect(handles.dispatchUpload).toHaveBeenCalledWith([
      { media: m, filePath: '/out/a.gif' }
    ]);
  });

  it('onUploadAll filters: only done rows with outputs[0] are planned', async () => {
    const a = makeMedia('a');
    const b = makeMedia('b');
    const c = makeMedia('c');
    const d = makeMedia('d');
    const items = [a, b, c, d];
    const progress: Record<string, TaskProgress> = {
      a: makeProgress({ status: 'done', outputs: ['/out/a.gif'] }),
      b: makeProgress({ status: 'failed', outputs: ['/out/b.gif'] }),
      c: makeProgress({ status: 'done', outputs: [] }),
      d: makeProgress({ status: 'done', outputs: ['/out/d.gif', '/out/d.webp'] })
    };
    const handles = makeDeps({ items, progress });
    const { result } = renderHook(() => useUploadOrchestrator(handles.deps));
    await flushAsync();
    handles.dispatchUpload.mockClear();

    await act(async () => {
      await result.current.onUploadAll();
    });

    expect(handles.dispatchUpload).toHaveBeenCalledTimes(1);
    expect(handles.dispatchUpload).toHaveBeenCalledWith([
      { media: a, filePath: '/out/a.gif' },
      { media: d, filePath: '/out/d.gif' }
    ]);
  });

  it('onUploadAll empty plan still calls dispatchUpload([]) (dispatchUpload owns the empty-plan log)', async () => {
    const handles = makeDeps({ items: [], progress: {} });
    const { result } = renderHook(() => useUploadOrchestrator(handles.deps));
    await flushAsync();
    handles.dispatchUpload.mockClear();

    await act(async () => {
      await result.current.onUploadAll();
    });

    expect(handles.dispatchUpload).toHaveBeenCalledTimes(1);
    expect(handles.dispatchUpload).toHaveBeenCalledWith([]);
  });

  it('onSaveUploadSettings: uploadSetSettings → uploadGetSettings → setUploadConfigs', async () => {
    const fresh = makeGithubConfigs();
    let getCount = 0;
    const handles = makeDeps({
      uploadGetSettingsImpl: async () => {
        getCount += 1;
        return fresh;
      }
    });
    const { result } = renderHook(() => useUploadOrchestrator(handles.deps));
    // First get is the mount-once load.
    await waitFor(() => expect(getCount).toBe(1));
    handles.setUploadConfigs.mockClear();

    const next: UploadConfigs = {
      active: 'github',
      github: { token: 'new-token', repo: 'a/b' }
    };
    await act(async () => {
      await result.current.onSaveUploadSettings(next);
    });

    expect(handles.giftk.uploadSetSettings).toHaveBeenCalledTimes(1);
    expect(handles.giftk.uploadSetSettings).toHaveBeenCalledWith(next);
    // uploadGetSettings is fired again to pull masked secrets back.
    expect(getCount).toBe(2);
    expect(handles.setUploadConfigs).toHaveBeenCalledTimes(1);
    expect(handles.setUploadConfigs).toHaveBeenCalledWith(fresh);
  });

  it('uploadAllStats: empty items returns the configured-aware shape', async () => {
    const cfg = makeGithubConfigs();
    const handles = makeDeps({ items: [], uploadConfigs: cfg });
    const { result } = renderHook(() => useUploadOrchestrator(handles.deps));
    await flushAsync();

    expect(result.current.uploadAllStats).toEqual({
      allDone: false,
      hasUploadable: false,
      configured: true,
      total: 0,
      doneCount: 0
    });
    expect(result.current.uploadAllReady).toBe(false);
  });

  it('uploadAllStats: empty items + null configs reflects configured: false', async () => {
    const handles = makeDeps({ items: [], uploadConfigs: null });
    const { result } = renderHook(() => useUploadOrchestrator(handles.deps));
    await flushAsync();

    expect(result.current.uploadAllStats.configured).toBe(false);
    expect(result.current.uploadAllStats.total).toBe(0);
  });

  it('uploadAllReady: true only when allDone && hasUploadable', async () => {
    const a = makeMedia('a');
    const b = makeMedia('b');

    // Case 1: allDone but no outputs → not ready.
    const h1 = makeDeps({
      items: [a, b],
      uploadConfigs: makeGithubConfigs(),
      progress: {
        a: makeProgress({ status: 'done', outputs: [] }),
        b: makeProgress({ status: 'done', outputs: [] })
      }
    });
    const { result: r1 } = renderHook(() => useUploadOrchestrator(h1.deps));
    await flushAsync();
    expect(r1.current.uploadAllStats.allDone).toBe(true);
    expect(r1.current.uploadAllStats.hasUploadable).toBe(false);
    expect(r1.current.uploadAllReady).toBe(false);

    // Case 2: hasUploadable but not allDone → not ready.
    const h2 = makeDeps({
      items: [a, b],
      uploadConfigs: makeGithubConfigs(),
      progress: {
        a: makeProgress({ status: 'done', outputs: ['/out/a.gif'] }),
        b: makeProgress({ status: 'running', outputs: [] })
      }
    });
    const { result: r2 } = renderHook(() => useUploadOrchestrator(h2.deps));
    await flushAsync();
    expect(r2.current.uploadAllStats.allDone).toBe(false);
    expect(r2.current.uploadAllStats.hasUploadable).toBe(true);
    expect(r2.current.uploadAllReady).toBe(false);

    // Case 3: both true → ready.
    const h3 = makeDeps({
      items: [a, b],
      uploadConfigs: makeGithubConfigs(),
      progress: {
        a: makeProgress({ status: 'done', outputs: ['/out/a.gif'] }),
        b: makeProgress({ status: 'done', outputs: ['/out/b.gif'] })
      }
    });
    const { result: r3 } = renderHook(() => useUploadOrchestrator(h3.deps));
    await flushAsync();
    expect(r3.current.uploadAllReady).toBe(true);
  });

  it('uploadAllTitle: zero-items branch returns the empty-products message', async () => {
    const handles = makeDeps({ items: [] });
    const { result } = renderHook(() => useUploadOrchestrator(handles.deps));
    await flushAsync();
    expect(result.current.uploadAllTitle).toBe('当前没有可上传的产物');
  });

  it('uploadAllTitle: not-configured branch returns the configure-first message', async () => {
    const a = makeMedia('a');
    const handles = makeDeps({
      items: [a],
      uploadConfigs: null,
      progress: { a: makeProgress({ status: 'done', outputs: ['/out/a.gif'] }) }
    });
    const { result } = renderHook(() => useUploadOrchestrator(handles.deps));
    await flushAsync();
    expect(result.current.uploadAllTitle).toBe('当前图床尚未配置完整,先去「📤 上传设置」里配置一个可用图床');
  });

  it('uploadAllTitle: not-allDone branch reports doneCount/total', async () => {
    const a = makeMedia('a');
    const b = makeMedia('b');
    const c = makeMedia('c');
    const handles = makeDeps({
      items: [a, b, c],
      uploadConfigs: makeGithubConfigs(),
      progress: {
        a: makeProgress({ status: 'done', outputs: ['/out/a.gif'] }),
        b: makeProgress({ status: 'running' }),
        c: makeProgress({ status: 'pending' })
      }
    });
    const { result } = renderHook(() => useUploadOrchestrator(handles.deps));
    await flushAsync();
    expect(result.current.uploadAllTitle).toBe('还有任务未完成 (1/3),所有产物都搞定了才能点击');
  });

  it('uploadAllTitle: no-uploadable branch when allDone but no outputs', async () => {
    const a = makeMedia('a');
    const handles = makeDeps({
      items: [a],
      uploadConfigs: makeGithubConfigs(),
      progress: { a: makeProgress({ status: 'done', outputs: [] }) }
    });
    const { result } = renderHook(() => useUploadOrchestrator(handles.deps));
    await flushAsync();
    expect(result.current.uploadAllTitle).toBe('所有任务都完成,但没有可上传的输出文件');
  });

  it('uploadAllTitle: ready branch returns the upload-all hint', async () => {
    const a = makeMedia('a');
    const handles = makeDeps({
      items: [a],
      uploadConfigs: makeGithubConfigs(),
      progress: { a: makeProgress({ status: 'done', outputs: ['/out/a.gif'] }) }
    });
    const { result } = renderHook(() => useUploadOrchestrator(handles.deps));
    await flushAsync();
    expect(result.current.uploadAllTitle).toBe('把所有已完成任务的产物上传到当前默认图床(可在「📤 上传设置」中切换)');
  });
});
