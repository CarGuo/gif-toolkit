/**
 * Unit tests for usePreviewState — the Step-11C extraction that owns
 * the preview-modal state triplet (`preview` / `previewing` /
 * `previewOverride`).
 *
 * Coverage matrix:
 *   1. Initial values: preview=null, previewing=false, override={}.
 *   2. Setters update the corresponding slice and leave siblings
 *      untouched (independence guarantee).
 *   3. Setter identities are stable across re-renders (this is the
 *      contract App.tsx and useSniffSession depend on — they capture
 *      `setPreview` once during render and reuse it from refs).
 *   4. The hook returns a fresh API object per render, but the
 *      individual setter references inside it are the SAME function
 *      identities (React useState dispatcher contract).
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePreviewState } from '../../src/renderer/components/usePreviewState';

describe('usePreviewState', () => {
  it('starts with the documented null / false / {} defaults', () => {
    const { result } = renderHook(() => usePreviewState());
    expect(result.current.preview).toBeNull();
    expect(result.current.previewing).toBe(false);
    expect(result.current.previewOverride).toEqual({});
  });

  it('setPreview updates only `preview` — siblings untouched', () => {
    const { result } = renderHook(() => usePreviewState());
    act(() => {
      result.current.setPreview({
        taskId: 't1',
        durationSec: 1,
        width: 100,
        height: 100,
        frames: []
      });
    });
    expect(result.current.preview).not.toBeNull();
    expect(result.current.preview?.taskId).toBe('t1');
    // Independence: previewing and previewOverride must NOT have
    // moved as a side effect of the preview write.
    expect(result.current.previewing).toBe(false);
    expect(result.current.previewOverride).toEqual({});
  });

  it('setPreviewing updates only `previewing` — siblings untouched', () => {
    const { result } = renderHook(() => usePreviewState());
    act(() => { result.current.setPreviewing(true); });
    expect(result.current.previewing).toBe(true);
    expect(result.current.preview).toBeNull();
    expect(result.current.previewOverride).toEqual({});
  });

  it('setPreviewOverride updates only `previewOverride` — siblings untouched', () => {
    const { result } = renderHook(() => usePreviewState());
    act(() => {
      result.current.setPreviewOverride({ startSec: 0, endSec: 5 });
    });
    expect(result.current.previewOverride).toEqual({ startSec: 0, endSec: 5 });
    expect(result.current.preview).toBeNull();
    expect(result.current.previewing).toBe(false);
  });

  it('setter identities are stable across re-renders (useState contract)', () => {
    const { result, rerender } = renderHook(() => usePreviewState());
    const firstSetters = {
      setPreview: result.current.setPreview,
      setPreviewing: result.current.setPreviewing,
      setPreviewOverride: result.current.setPreviewOverride
    };
    // Trigger a state change → guaranteed re-render.
    act(() => { result.current.setPreviewing(true); });
    rerender();
    expect(result.current.setPreview).toBe(firstSetters.setPreview);
    expect(result.current.setPreviewing).toBe(firstSetters.setPreviewing);
    expect(result.current.setPreviewOverride).toBe(firstSetters.setPreviewOverride);
  });

  it('setPreview(null) clears a previously-set preview (close-modal path)', () => {
    const { result } = renderHook(() => usePreviewState());
    act(() => {
      result.current.setPreview({
        taskId: 't1', durationSec: 1, width: 1, height: 1, frames: []
      });
      result.current.setPreviewing(true);
    });
    expect(result.current.preview).not.toBeNull();
    // Mimic onPreview()'s race-cancellation path: setPreview(null) +
    // setPreviewing(false) in the same React batch.
    act(() => {
      result.current.setPreview(null);
      result.current.setPreviewing(false);
    });
    expect(result.current.preview).toBeNull();
    expect(result.current.previewing).toBe(false);
  });

  it('setPreviewOverride({}) resets the override (close-modal path, P1.2)', () => {
    const { result } = renderHook(() => usePreviewState());
    act(() => {
      result.current.setPreviewOverride({ startSec: 1, endSec: 4, crop: { x: 0, y: 0, w: 10, h: 10 } });
    });
    expect(result.current.previewOverride).not.toEqual({});
    act(() => { result.current.setPreviewOverride({}); });
    expect(result.current.previewOverride).toEqual({});
  });
});
