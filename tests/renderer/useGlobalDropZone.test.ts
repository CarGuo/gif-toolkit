/**
 * Unit tests for useGlobalDropZone — the Step-11B extraction that
 * owns the window-level dragover/drop fallback for offline import.
 *
 * Coverage matrix:
 *   1. View === 'home' attaches both listeners; non-home views do not
 *      (and a previously-attached listener is detached on view flip).
 *   2. dragover with `Files` in dataTransfer.types calls preventDefault
 *      and sets dropEffect = 'copy'. Without `Files` it MUST be a no-op
 *      (so dragging text or a div around the page doesn't grab the
 *      cursor).
 *   3. drop short-circuits when `e.defaultPrevented` (R-68 — a child
 *      React onDrop already consumed the drop).
 *   4. drop dispatches `runOfflineImport(file.path, { includeStaticImages: false })`
 *      ONLY when the file carries a non-empty `path` (Electron
 *      OS-origin marker, R-10 escape hatch).
 *   5. drop with no files in dataTransfer.files is ignored.
 *   6. Switching back to `home` re-attaches a listener.
 *
 * happy-dom limitation note
 * -------------------------
 * happy-dom doesn't expose a constructable DragEvent so we synthesise
 * one by dispatching a regular Event and decorating it with a stub
 * `dataTransfer` matching the small slice of the API the hook reads:
 * `types[]`, `files[]`, `dropEffect`. We also override `preventDefault`
 * and `defaultPrevented` so we can observe the hook's behaviour.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useGlobalDropZone, type AppView } from '../../src/renderer/components/useGlobalDropZone';

interface StubDataTransfer {
  types: string[];
  files: File[];
  dropEffect: string;
}

function dispatchDrag(
  type: 'dragover' | 'drop',
  data: Partial<StubDataTransfer>,
  opts: { defaultPrevented?: boolean } = {}
): { event: Event; preventDefaultCalls: number; dataTransfer: StubDataTransfer } {
  const dt: StubDataTransfer = {
    types: data.types ?? [],
    files: data.files ?? [],
    dropEffect: data.dropEffect ?? 'none'
  };
  const event = new Event(type, { cancelable: true, bubbles: true });
  // We can't construct a real DragEvent in happy-dom; decorate the
  // bare Event with the slice of the API the hook reads.
  Object.defineProperty(event, 'dataTransfer', {
    configurable: true,
    get: () => dt
  });
  let pdCalls = 0;
  const origPD = event.preventDefault.bind(event);
  event.preventDefault = () => { pdCalls += 1; origPD(); };
  if (opts.defaultPrevented) {
    Object.defineProperty(event, 'defaultPrevented', {
      configurable: true,
      get: () => true
    });
  }
  window.dispatchEvent(event);
  return {
    event,
    get preventDefaultCalls() { return pdCalls; },
    dataTransfer: dt
  };
}

function fileWithPath(name: string, path: string | undefined): File {
  const f = new File([new Uint8Array([0])], name);
  // Electron's non-standard `path` property — tests may set it to
  // undefined to simulate a renderer-fetched blob.
  if (path !== undefined) {
    Object.defineProperty(f, 'path', { configurable: true, value: path });
  }
  return f;
}

describe('useGlobalDropZone', () => {
  beforeEach(() => {
    // No global listeners should leak across tests; renderHook's
    // unmount in the previous test cleans up via the hook's effect
    // teardown. This is a belt-and-braces guard.
  });

  it('attaches dragover + drop listeners on the home view', () => {
    const runImport = vi.fn();
    renderHook(() => useGlobalDropZone('home', runImport));

    const result = dispatchDrag('dragover', { types: ['Files'] });
    expect(result.preventDefaultCalls).toBe(1);
    expect(result.dataTransfer.dropEffect).toBe('copy');
  });

  it('does NOT attach when view !== home (toolbox)', () => {
    const runImport = vi.fn();
    renderHook(() => useGlobalDropZone('toolbox' as AppView, runImport));
    const result = dispatchDrag('dragover', { types: ['Files'] });
    // Listener was never attached → preventDefault must NOT have been
    // called by the hook, and dropEffect must remain its default.
    expect(result.preventDefaultCalls).toBe(0);
    expect(result.dataTransfer.dropEffect).toBe('none');
  });

  it('switching home → toolbox detaches the listener', () => {
    const runImport = vi.fn();
    const { rerender } = renderHook(
      ({ view }: { view: AppView }) => useGlobalDropZone(view, runImport),
      { initialProps: { view: 'home' as AppView } }
    );
    // Sanity: home is attached.
    expect(dispatchDrag('dragover', { types: ['Files'] }).preventDefaultCalls).toBe(1);
    rerender({ view: 'toolbox' });
    // After flip the listener must be gone.
    expect(dispatchDrag('dragover', { types: ['Files'] }).preventDefaultCalls).toBe(0);
  });

  it('switching toolbox → home re-attaches a fresh listener', () => {
    const runImport = vi.fn();
    const { rerender } = renderHook(
      ({ view }: { view: AppView }) => useGlobalDropZone(view, runImport),
      { initialProps: { view: 'toolbox' as AppView } }
    );
    expect(dispatchDrag('dragover', { types: ['Files'] }).preventDefaultCalls).toBe(0);
    rerender({ view: 'home' });
    expect(dispatchDrag('dragover', { types: ['Files'] }).preventDefaultCalls).toBe(1);
  });

  it('dragover without Files in types is a no-op (text drag, etc.)', () => {
    const runImport = vi.fn();
    renderHook(() => useGlobalDropZone('home', runImport));
    const result = dispatchDrag('dragover', { types: ['text/plain'] });
    expect(result.preventDefaultCalls).toBe(0);
    expect(result.dataTransfer.dropEffect).toBe('none');
  });

  it('drop with a File carrying `path` dispatches runOfflineImport with includeStaticImages=false', () => {
    const runImport = vi.fn();
    renderHook(() => useGlobalDropZone('home', runImport));
    dispatchDrag('drop', { files: [fileWithPath('demo.mp4', '/abs/demo.mp4')] });
    expect(runImport).toHaveBeenCalledTimes(1);
    expect(runImport).toHaveBeenCalledWith('/abs/demo.mp4', { includeStaticImages: false });
  });

  it('drop with a renderer-fetched blob (no path) is ignored', () => {
    const runImport = vi.fn();
    renderHook(() => useGlobalDropZone('home', runImport));
    dispatchDrag('drop', { files: [fileWithPath('blob.mp4', undefined)] });
    expect(runImport).not.toHaveBeenCalled();
  });

  it('drop with no files is ignored', () => {
    const runImport = vi.fn();
    renderHook(() => useGlobalDropZone('home', runImport));
    dispatchDrag('drop', { files: [] });
    expect(runImport).not.toHaveBeenCalled();
  });

  it('drop short-circuits on defaultPrevented (R-68 nested onDrop already handled)', () => {
    const runImport = vi.fn();
    renderHook(() => useGlobalDropZone('home', runImport));
    const result = dispatchDrag(
      'drop',
      { files: [fileWithPath('demo.mp4', '/abs/demo.mp4')] },
      { defaultPrevented: true }
    );
    expect(runImport).not.toHaveBeenCalled();
    // The hook MUST NOT call preventDefault again — the inner handler
    // already did. (We only count calls our own preventDefault stub
    // observed; native defaultPrevented stays true regardless.)
    expect(result.preventDefaultCalls).toBe(0);
  });

  it('only the first file is forwarded (single-source-of-truth offline import)', () => {
    const runImport = vi.fn();
    renderHook(() => useGlobalDropZone('home', runImport));
    dispatchDrag('drop', {
      files: [
        fileWithPath('first.mp4', '/abs/first.mp4'),
        fileWithPath('second.mp4', '/abs/second.mp4')
      ]
    });
    expect(runImport).toHaveBeenCalledTimes(1);
    expect(runImport).toHaveBeenCalledWith('/abs/first.mp4', { includeStaticImages: false });
  });

  it('on unmount the listeners are removed (no late dispatches after teardown)', () => {
    const runImport = vi.fn();
    const { unmount } = renderHook(() => useGlobalDropZone('home', runImport));
    unmount();
    dispatchDrag('drop', { files: [fileWithPath('demo.mp4', '/abs/demo.mp4')] });
    expect(runImport).not.toHaveBeenCalled();
  });
});
