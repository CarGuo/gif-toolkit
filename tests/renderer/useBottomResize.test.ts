/**
 * Unit tests for the useBottomResize hook.
 *
 * Coverage matrix:
 *   1. localStorage absent              → bottomH === BOTTOM_H_DEFAULT.
 *   2. localStorage has a valid number  → bottomH === that number.
 *   3. localStorage has too-small value → falls back to default.
 *   4. localStorage has non-numeric     → falls back to default.
 *   5. Full drag gesture: mousedown → mousemove → mouseup updates
 *      state, persists to localStorage, and toggles body.style.cursor.
 *
 * happy-dom is configured automatically for tests under tests/renderer
 * via `environmentMatchGlobs` in vitest.config.ts. Each test starts
 * from a clean localStorage in `beforeEach`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  BOTTOM_H_DEFAULT,
  BOTTOM_H_KEY,
  BOTTOM_H_MIN,
  useBottomResize,
} from '../../src/renderer/components/useBottomResize';

// Minimal stub matching the React.MouseEvent surface that the hook
// actually touches. Keeping this as a typed helper means we don't need
// to render an actual element to drive the gesture, which keeps the
// tests fast and decoupled from the DOM tree.
function makeMouseDown(clientY: number): {
  preventDefault: () => void;
  clientY: number;
  preventDefaultCalls: number;
} {
  const ref = { calls: 0 };
  return {
    clientY,
    preventDefault() {
      ref.calls += 1;
    },
    get preventDefaultCalls() {
      return ref.calls;
    },
  };
}

describe('useBottomResize', () => {
  beforeEach(() => {
    // Isolate every test from the previous one's persisted state and
    // any leftover body-style mutations from a partially-completed
    // gesture in a sibling test.
    window.localStorage.clear();
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  it('initialises to BOTTOM_H_DEFAULT when localStorage is empty', () => {
    const { result } = renderHook(() => useBottomResize());
    expect(result.current.bottomH).toBe(BOTTOM_H_DEFAULT);
    expect(BOTTOM_H_DEFAULT).toBe(180);
  });

  it('initialises from a valid localStorage entry', () => {
    window.localStorage.setItem(BOTTOM_H_KEY, '250');
    const { result } = renderHook(() => useBottomResize());
    expect(result.current.bottomH).toBe(250);
  });

  it('falls back to default when persisted value is below BOTTOM_H_MIN', () => {
    window.localStorage.setItem(BOTTOM_H_KEY, '50'); // < BOTTOM_H_MIN (80)
    const { result } = renderHook(() => useBottomResize());
    expect(result.current.bottomH).toBe(BOTTOM_H_DEFAULT);
    expect(BOTTOM_H_MIN).toBe(80);
  });

  it('falls back to default when persisted value is non-numeric', () => {
    window.localStorage.setItem(BOTTOM_H_KEY, 'abc');
    const { result } = renderHook(() => useBottomResize());
    expect(result.current.bottomH).toBe(BOTTOM_H_DEFAULT);
  });

  it(
    'updates bottomH on mousemove, persists on mouseup, and toggles ' +
      'body.style.cursor across the gesture',
    () => {
      // Pin innerHeight so the maxH clamp is deterministic. happy-dom
      // exposes window.innerHeight as a writable property; we restore
      // it implicitly by virtue of each test getting a fresh window.
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: 1000,
      });

      const { result } = renderHook(() => useBottomResize());
      // Sanity: we start at the default (180).
      expect(result.current.bottomH).toBe(BOTTOM_H_DEFAULT);

      // Begin the gesture at clientY=500. Cursor moving UP (smaller
      // clientY) should grow the panel: dy = 500 - 400 = 100 → next
      // height = 180 + 100 = 280, well under maxH = floor(1000*0.7) =
      // 700, so no clamp applies.
      const ev = makeMouseDown(500);
      act(() => {
        result.current.onBottomResizeStart(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ev as any,
        );
      });
      // The hook must call preventDefault to suppress text selection.
      expect(ev.preventDefaultCalls).toBe(1);
      // While the gesture is live, body should advertise the resize
      // cursor and disable text selection.
      expect(document.body.style.cursor).toBe('ns-resize');
      expect(document.body.style.userSelect).toBe('none');

      // Drive a mousemove via a real MouseEvent so the document-level
      // listener registered inside the hook receives it.
      act(() => {
        document.dispatchEvent(
          new MouseEvent('mousemove', { clientY: 400 }),
        );
      });
      expect(result.current.bottomH).toBe(280);

      // End the gesture. Body cosmetics must be restored, the new
      // height must be persisted to localStorage.
      act(() => {
        document.dispatchEvent(new MouseEvent('mouseup'));
      });
      expect(document.body.style.cursor).toBe('');
      expect(document.body.style.userSelect).toBe('');
      expect(window.localStorage.getItem(BOTTOM_H_KEY)).toBe('280');

      // Stray events after mouseup must be ignored — listeners are
      // detached, so state should not change.
      act(() => {
        document.dispatchEvent(
          new MouseEvent('mousemove', { clientY: 0 }),
        );
      });
      expect(result.current.bottomH).toBe(280);
    },
  );

  it('resetBottomH restores BOTTOM_H_DEFAULT and persists it', () => {
    // Start from a non-default persisted height so we can observe the
    // reset writing back the default explicitly (rather than no-op).
    window.localStorage.setItem(BOTTOM_H_KEY, '300');
    const { result } = renderHook(() => useBottomResize());
    expect(result.current.bottomH).toBe(300);

    act(() => {
      result.current.resetBottomH();
    });
    expect(result.current.bottomH).toBe(BOTTOM_H_DEFAULT);
    expect(window.localStorage.getItem(BOTTOM_H_KEY)).toBe(
      String(BOTTOM_H_DEFAULT),
    );
  });
});
