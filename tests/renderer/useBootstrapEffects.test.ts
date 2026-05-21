/**
 * Unit tests for useBootstrapEffects — the Step-11A extraction that
 * consolidates the four mount-once App-level side effects.
 *
 * What we cover here
 * ------------------
 *   1. Bootstrap effect — when the legacy import returns >0 rows we
 *      reload all three families exactly once. When it returns 0 we
 *      do not call any reload (no-op fast path).
 *   2. dbErrorBus listener — `setDbErrorListener` is called once on
 *      mount; firing a `reportDbError(...)` triggers the toaster.push
 *      bridge with the family-mapped title.
 *   3. Capability probe — every issue from `getCapabilities()` is
 *      forwarded to `toaster.pushCapability`. Missing IPC bridge
 *      (window.giftk.getCapabilities undefined) must NOT crash the
 *      render.
 *   4. Pre-quit flush ack — `db.onFlushBeforeQuit` callback awaits
 *      both `flushPending` queues then calls `acked()` (R-80 #8).
 *      Single failed flush must not block the other (Promise.allSettled).
 *
 * Mocking strategy
 * ----------------
 *   - `bootstrapImportFromLocalStorage` and `setDbErrorListener` /
 *     `reportDbError` are spy'd via `vi.mock` of their respective
 *     modules. We also keep the real `dbErrorBus` reset helper to
 *     scrub the module-level "fired-once" guard between tests.
 *   - `window.giftk` is stubbed inline per-test with the slice of the
 *     IPC surface each effect touches, then cleared in `afterEach`.
 *   - The toaster API is a hand-rolled spy bag matching the shape of
 *     `useToaster()`'s return.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// IMPORTANT — vi.mock is hoisted, so we put the factories first.
vi.mock('../../src/renderer/components/storageSchema', () => ({
  bootstrapImportFromLocalStorage: vi.fn()
}));

import { useBootstrapEffects } from '../../src/renderer/components/useBootstrapEffects';
import { bootstrapImportFromLocalStorage } from '../../src/renderer/components/storageSchema';
import {
  setDbErrorListener,
  reportDbError,
  _resetDbErrorBusForTests
} from '../../src/renderer/components/dbErrorBus';

const bootstrapMock = vi.mocked(bootstrapImportFromLocalStorage);

interface ToasterSpy {
  handleSetter: () => void;
  push: ReturnType<typeof vi.fn>;
  pushCapability: ReturnType<typeof vi.fn>;
  clear: () => void;
}

function makeToaster(): ToasterSpy {
  return {
    handleSetter: vi.fn(),
    push: vi.fn(),
    pushCapability: vi.fn(),
    clear: vi.fn()
  };
}

interface DepsSpy {
  reloadHistory: ReturnType<typeof vi.fn>;
  reloadSniffHistory: ReturnType<typeof vi.fn>;
  reloadUploadHistory: ReturnType<typeof vi.fn>;
  flushHistoryPending: ReturnType<typeof vi.fn>;
  flushUploadHistoryPending: ReturnType<typeof vi.fn>;
}

function makeDeps(overrides: Partial<DepsSpy> = {}): DepsSpy {
  return {
    reloadHistory: vi.fn(),
    reloadSniffHistory: vi.fn(),
    reloadUploadHistory: vi.fn(),
    flushHistoryPending: vi.fn().mockResolvedValue(undefined),
    flushUploadHistoryPending: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

// Captured every time the hook's Effect 4 calls
// `window.giftk.db.onFlushBeforeQuit(cb)`. The test uses this to
// invoke main's pre-quit handshake synchronously.
let flushBeforeQuitCb: ((acked: () => void) => void) | null = null;
let onFlushOff: ReturnType<typeof vi.fn>;

beforeEach(() => {
  bootstrapMock.mockReset();
  _resetDbErrorBusForTests();
  flushBeforeQuitCb = null;
  onFlushOff = vi.fn();
  // Fresh window.giftk per test.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).giftk = {
    getCapabilities: vi.fn().mockResolvedValue({ issues: [] }),
    db: {
      onFlushBeforeQuit: vi.fn((cb: (acked: () => void) => void) => {
        flushBeforeQuitCb = cb;
        return onFlushOff;
      })
    }
  };
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).giftk;
  setDbErrorListener(null);
});

describe('useBootstrapEffects — Effect 1 (legacy import → reload)', () => {
  it('calls reload* on every family when bootstrap returns >0 rows', async () => {
    bootstrapMock.mockResolvedValue({
      history: 3, uploadHistory: 0, sniffHistory: 1, toolboxHistory: 0
    });
    const toaster = makeToaster();
    const deps = makeDeps();
    renderHook(() => useBootstrapEffects(toaster, deps));

    await waitFor(() => {
      expect(deps.reloadHistory).toHaveBeenCalledTimes(1);
    });
    expect(deps.reloadSniffHistory).toHaveBeenCalledTimes(1);
    expect(deps.reloadUploadHistory).toHaveBeenCalledTimes(1);
  });

  it('skips reload when bootstrap returns 0 rows (idempotent re-run)', async () => {
    bootstrapMock.mockResolvedValue({
      history: 0, uploadHistory: 0, sniffHistory: 0, toolboxHistory: 0
    });
    const toaster = makeToaster();
    const deps = makeDeps();
    renderHook(() => useBootstrapEffects(toaster, deps));

    // Wait one microtask + flush so the bootstrap promise settles
    // before we assert "never called".
    await waitFor(() => {
      expect(bootstrapMock).toHaveBeenCalled();
    });
    expect(deps.reloadHistory).not.toHaveBeenCalled();
    expect(deps.reloadSniffHistory).not.toHaveBeenCalled();
    expect(deps.reloadUploadHistory).not.toHaveBeenCalled();
  });

  it('swallows a bootstrap rejection — reload is never invoked', async () => {
    bootstrapMock.mockRejectedValue(new Error('disk full'));
    const toaster = makeToaster();
    const deps = makeDeps();
    expect(() => renderHook(() => useBootstrapEffects(toaster, deps))).not.toThrow();

    await waitFor(() => {
      expect(bootstrapMock).toHaveBeenCalled();
    });
    expect(deps.reloadHistory).not.toHaveBeenCalled();
  });

  it('a reload throwing does not break the other reloads (best-effort)', async () => {
    bootstrapMock.mockResolvedValue({
      history: 1, uploadHistory: 1, sniffHistory: 1, toolboxHistory: 0
    });
    const toaster = makeToaster();
    const deps = makeDeps({
      reloadHistory: vi.fn(() => { throw new Error('boom'); })
    });
    renderHook(() => useBootstrapEffects(toaster, deps));

    await waitFor(() => {
      expect(deps.reloadSniffHistory).toHaveBeenCalledTimes(1);
    });
    expect(deps.reloadUploadHistory).toHaveBeenCalledTimes(1);
  });
});

describe('useBootstrapEffects — Effect 2 (dbErrorBus → toaster)', () => {
  it('forwards the first reportDbError to toaster.push with the family label', async () => {
    bootstrapMock.mockResolvedValue({
      history: 0, uploadHistory: 0, sniffHistory: 0, toolboxHistory: 0
    });
    const toaster = makeToaster();
    renderHook(() => useBootstrapEffects(toaster, makeDeps()));

    // Effect 2 registers the listener synchronously after mount.
    await waitFor(() => {
      // Drive the bus.
      reportDbError('uploadHistory', 'upsert', new Error('disk full'));
      expect(toaster.push).toHaveBeenCalledTimes(1);
    });
    const call = toaster.push.mock.calls[0][0];
    expect(call.severity).toBe('warn');
    expect(call.title).toContain('上传历史');
    expect(call.id).toBe('db-error-uploadHistory-upsert');
  });

  it('on unmount the listener is detached (subsequent reports drop silently)', async () => {
    bootstrapMock.mockResolvedValue({
      history: 0, uploadHistory: 0, sniffHistory: 0, toolboxHistory: 0
    });
    const toaster = makeToaster();
    const { unmount } = renderHook(() => useBootstrapEffects(toaster, makeDeps()));
    unmount();
    // After unmount the bus must not call anyone.
    reportDbError('history', 'upsert', new Error('late'));
    expect(toaster.push).not.toHaveBeenCalled();
  });
});

describe('useBootstrapEffects — Effect 3 (capabilities probe)', () => {
  it('forwards every issue from getCapabilities to toaster.pushCapability', async () => {
    bootstrapMock.mockResolvedValue({
      history: 0, uploadHistory: 0, sniffHistory: 0, toolboxHistory: 0
    });
    const issues = [
      { id: 'cap-1', title: 'A', detail: 'a', severity: 'warn' },
      { id: 'cap-2', title: 'B', detail: 'b', severity: 'info' }
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).giftk.getCapabilities = vi.fn().mockResolvedValue({ issues });

    const toaster = makeToaster();
    renderHook(() => useBootstrapEffects(toaster, makeDeps()));

    await waitFor(() => {
      expect(toaster.pushCapability).toHaveBeenCalledTimes(2);
    });
    expect(toaster.pushCapability.mock.calls[0][0]).toEqual(issues[0]);
    expect(toaster.pushCapability.mock.calls[1][0]).toEqual(issues[1]);
  });

  it('does not crash when window.giftk.getCapabilities is undefined', async () => {
    bootstrapMock.mockResolvedValue({
      history: 0, uploadHistory: 0, sniffHistory: 0, toolboxHistory: 0
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).giftk.getCapabilities = undefined;
    const toaster = makeToaster();
    expect(() => renderHook(() => useBootstrapEffects(toaster, makeDeps()))).not.toThrow();
    // Settle any in-flight promises so vitest doesn't flag dangling.
    await Promise.resolve();
    expect(toaster.pushCapability).not.toHaveBeenCalled();
  });

  it('a rejecting getCapabilities is swallowed — no crash, no pushCapability calls', async () => {
    bootstrapMock.mockResolvedValue({
      history: 0, uploadHistory: 0, sniffHistory: 0, toolboxHistory: 0
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).giftk.getCapabilities = vi.fn().mockRejectedValue(new Error('ipc broken'));
    const toaster = makeToaster();
    expect(() => renderHook(() => useBootstrapEffects(toaster, makeDeps()))).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(toaster.pushCapability).not.toHaveBeenCalled();
  });
});

describe('useBootstrapEffects — Effect 4 (pre-quit flush ack, R-80 #8)', () => {
  it('subscribes once to db.onFlushBeforeQuit', () => {
    bootstrapMock.mockResolvedValue({
      history: 0, uploadHistory: 0, sniffHistory: 0, toolboxHistory: 0
    });
    const toaster = makeToaster();
    renderHook(() => useBootstrapEffects(toaster, makeDeps()));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((window as any).giftk.db.onFlushBeforeQuit).toHaveBeenCalledTimes(1);
    expect(typeof flushBeforeQuitCb).toBe('function');
  });

  it('calls both flushPending then acks (sequential happy path)', async () => {
    bootstrapMock.mockResolvedValue({
      history: 0, uploadHistory: 0, sniffHistory: 0, toolboxHistory: 0
    });
    const toaster = makeToaster();
    const deps = makeDeps();
    renderHook(() => useBootstrapEffects(toaster, deps));
    expect(flushBeforeQuitCb).not.toBeNull();

    const acked = vi.fn();
    flushBeforeQuitCb!(acked);
    expect(deps.flushHistoryPending).toHaveBeenCalledTimes(1);
    expect(deps.flushUploadHistoryPending).toHaveBeenCalledTimes(1);
    // Wait for Promise.allSettled to resolve and the .finally() chain.
    await waitFor(() => {
      expect(acked).toHaveBeenCalledTimes(1);
    });
  });

  it('a single failing flush still acks (Promise.allSettled — main can quit)', async () => {
    bootstrapMock.mockResolvedValue({
      history: 0, uploadHistory: 0, sniffHistory: 0, toolboxHistory: 0
    });
    const toaster = makeToaster();
    const deps = makeDeps({
      flushHistoryPending: vi.fn().mockRejectedValue(new Error('write failed'))
    });
    renderHook(() => useBootstrapEffects(toaster, deps));
    const acked = vi.fn();
    flushBeforeQuitCb!(acked);
    await waitFor(() => {
      expect(acked).toHaveBeenCalledTimes(1);
    });
    // The other flush still ran.
    expect(deps.flushUploadHistoryPending).toHaveBeenCalledTimes(1);
  });

  it('uses the LATEST flushPending identity (ref-mirror) — re-render picks up new closure', async () => {
    bootstrapMock.mockResolvedValue({
      history: 0, uploadHistory: 0, sniffHistory: 0, toolboxHistory: 0
    });
    const toaster = makeToaster();
    const firstFlushHistory = vi.fn().mockResolvedValue(undefined);
    const secondFlushHistory = vi.fn().mockResolvedValue(undefined);

    const { rerender } = renderHook(
      ({ flushHistory }: { flushHistory: () => Promise<unknown> }) =>
        useBootstrapEffects(toaster, makeDeps({ flushHistoryPending: flushHistory })),
      { initialProps: { flushHistory: firstFlushHistory as () => Promise<unknown> } }
    );

    // Re-render with a brand-new flushHistory identity. Effect 4 must
    // NOT re-subscribe (still 1 onFlushBeforeQuit call), but the
    // pre-quit handler must call the LATEST identity, not the captured
    // first one.
    rerender({ flushHistory: secondFlushHistory });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((window as any).giftk.db.onFlushBeforeQuit).toHaveBeenCalledTimes(1);

    const acked = vi.fn();
    flushBeforeQuitCb!(acked);
    await waitFor(() => {
      expect(acked).toHaveBeenCalledTimes(1);
    });
    expect(secondFlushHistory).toHaveBeenCalledTimes(1);
    expect(firstFlushHistory).not.toHaveBeenCalled();
  });

  it('on unmount the off() returned by onFlushBeforeQuit is invoked', () => {
    bootstrapMock.mockResolvedValue({
      history: 0, uploadHistory: 0, sniffHistory: 0, toolboxHistory: 0
    });
    const toaster = makeToaster();
    const { unmount } = renderHook(() => useBootstrapEffects(toaster, makeDeps()));
    expect(onFlushOff).not.toHaveBeenCalled();
    unmount();
    expect(onFlushOff).toHaveBeenCalledTimes(1);
  });
});
