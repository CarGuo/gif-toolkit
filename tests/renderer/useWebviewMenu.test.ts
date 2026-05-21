/**
 * Tests for src/renderer/components/useWebviewMenu.ts.
 *
 * What we lock in
 * ---------------
 *  • Sensible defaults: closed popup, `embed` preferred mode when
 *    nothing is persisted yet.
 *  • localStorage round-trip: setPreferredMode writes under the exact
 *    key App.tsx historically used (`giftk:preferredWebviewMode`).
 *  • Initial-read tolerance: a previously-persisted valid value is
 *    honoured; an invalid value is ignored and we fall back to
 *    `embed` (i.e. corruption / schema drift never breaks the UI).
 *  • Keyboard navigation: ArrowDown/ArrowUp wrap, Home/End jump to
 *    the bounds. We exercise this against a fake 3-button itemRefs
 *    array so the test is independent of any DOM rendering.
 *  • Open/close lifecycle: the effect-driven listeners attach and
 *    detach without throwing, even with no caret/menu DOM attached.
 *
 * These checks describe the contract App.tsx will rely on once the
 * inlined logic is replaced with this hook.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  useWebviewMenu,
  type WebviewMode
} from '../../src/renderer/components/useWebviewMenu';

const STORAGE_KEY = 'giftk:preferredWebviewMode';

/**
 * Build a fake button whose `focus()` flips a tracked flag — lets us
 * assert which item the keyboard handler tried to focus, without
 * needing a real DOM tree.
 */
const makeFakeButton = (label: string): {
  el: HTMLButtonElement;
  focused: () => boolean;
} => {
  let wasFocused = false;
  const el = {
    focus: () => {
      wasFocused = true;
    },
    dataset: { label }
  } as unknown as HTMLButtonElement;
  return { el, focused: () => wasFocused };
};

/**
 * Minimal stand-in for a React keyboard event. Only the fields the
 * hook actually reads are populated; we type-cast at the boundary so
 * the test file itself stays in regular TS.
 */
const kev = (
  key: string
): React.KeyboardEvent<HTMLButtonElement> => {
  let prevented = false;
  return {
    key,
    preventDefault: () => {
      prevented = true;
    },
    // Surfaced for debugging only — not used by assertions.
    get defaultPrevented() {
      return prevented;
    }
  } as unknown as React.KeyboardEvent<HTMLButtonElement>;
};

describe('useWebviewMenu', () => {
  // Reset persisted state between tests so initial-mode reads are
  // deterministic. happy-dom gives every test file its own
  // localStorage but cleaning it explicitly here keeps each `it`
  // independent of order.
  beforeEach(() => {
    localStorage.clear();
  });

  it('seeds with closed popup and `embed` mode by default', () => {
    const { result } = renderHook(() => useWebviewMenu());
    expect(result.current.open).toBe(false);
    expect(result.current.preferredMode).toBe<WebviewMode>('embed');
    expect(result.current.anchor).toBe('right');
  });

  it('setPreferredMode persists under giftk:preferredWebviewMode', () => {
    const { result } = renderHook(() => useWebviewMenu());
    act(() => {
      result.current.setPreferredMode('ytdlp-direct');
    });
    expect(result.current.preferredMode).toBe<WebviewMode>('ytdlp-direct');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('ytdlp-direct');
  });

  it('initialises from localStorage when a valid value is stored', () => {
    localStorage.setItem(STORAGE_KEY, 'system-chrome');
    const { result } = renderHook(() => useWebviewMenu());
    expect(result.current.preferredMode).toBe<WebviewMode>('system-chrome');
  });

  it('falls back to `embed` when localStorage holds an invalid value', () => {
    localStorage.setItem(STORAGE_KEY, 'totally-not-a-mode');
    const { result } = renderHook(() => useWebviewMenu());
    expect(result.current.preferredMode).toBe<WebviewMode>('embed');
  });

  it('onItemKeyDown handles ArrowDown/ArrowUp wrap, Home and End', () => {
    const { result } = renderHook(() => useWebviewMenu());

    // Wire 3 fake buttons into the itemRefs array. We mutate
    // `current` directly because that is exactly what App.tsx will
    // do via JSX `ref={el => { itemRefs.current[i] = el; }}`.
    const b0 = makeFakeButton('embed');
    const b1 = makeFakeButton('system-chrome');
    const b2 = makeFakeButton('ytdlp-direct');
    result.current.itemRefs.current = [b0.el, b1.el, b2.el];

    // ArrowDown at last index wraps to 0.
    act(() => {
      result.current.onItemKeyDown(kev('ArrowDown'), 2);
    });
    expect(b0.focused()).toBe(true);

    // ArrowUp at first index wraps to last.
    act(() => {
      result.current.onItemKeyDown(kev('ArrowUp'), 0);
    });
    expect(b2.focused()).toBe(true);

    // Reset the focus flags so we can isolate Home/End.
    const b0b = makeFakeButton('embed');
    const b1b = makeFakeButton('system-chrome');
    const b2b = makeFakeButton('ytdlp-direct');
    result.current.itemRefs.current = [b0b.el, b1b.el, b2b.el];

    act(() => {
      result.current.onItemKeyDown(kev('Home'), 2);
    });
    expect(b0b.focused()).toBe(true);
    expect(b2b.focused()).toBe(false);

    act(() => {
      result.current.onItemKeyDown(kev('End'), 0);
    });
    expect(b2b.focused()).toBe(true);
  });

  it('open → close lifecycle attaches and detaches without throwing', () => {
    const { result } = renderHook(() => useWebviewMenu());
    // Toggle through both transitions; the layout effect & document
    // listener wiring should mount and tear down cleanly even though
    // we never attach caret/menu DOM nodes.
    expect(() => {
      act(() => {
        result.current.setOpen(true);
      });
      act(() => {
        result.current.setOpen(false);
      });
    }).not.toThrow();
    expect(result.current.open).toBe(false);
  });
});
