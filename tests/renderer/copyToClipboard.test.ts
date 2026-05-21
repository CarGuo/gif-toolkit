/**
 * R-WS-90 P5f — copyToClipboard() unit tests.
 *
 * Validates the priority chain:
 *   1. window.giftk.clipboardWriteText (IPC)
 *   2. navigator.clipboard.writeText
 *   3. document.execCommand('copy')
 * Each path can fail and the next must take over. Empty payload is
 * a noop. We also confirm `__giftkLastCopy` debug breadcrumb gets
 * stamped on success.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { copyToClipboard } from '../../src/renderer/components/copyToClipboard';

declare global {
  interface Window {
    giftk?: { clipboardWriteText?: (text: string) => Promise<unknown> } & Record<string, unknown>;
    __giftkLastCopy?: { ts: number; via: string; length: number; preview: string };
  }
}

describe('copyToClipboard', () => {
  beforeEach(() => {
    delete (window as Window).giftk;
    delete (window as Window).__giftkLastCopy;
    Object.defineProperty(global.navigator, 'clipboard', {
      value: undefined,
      writable: true,
      configurable: true
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok:false on empty input', async () => {
    const r = await copyToClipboard('');
    expect(r.ok).toBe(false);
    expect(r.via).toBe('noop');
  });

  it('uses the IPC path first when window.giftk is available', async () => {
    const ipc = vi.fn().mockResolvedValue({ ok: true, length: 5 });
    (window as Window).giftk = { clipboardWriteText: ipc } as Window['giftk'];
    const r = await copyToClipboard('hello');
    expect(r.ok).toBe(true);
    expect(r.via).toBe('ipc');
    expect(ipc).toHaveBeenCalledWith('hello');
    expect((window as Window).__giftkLastCopy?.via).toBe('ipc');
  });

  it('falls back to navigator.clipboard when IPC reports failure', async () => {
    const ipc = vi.fn().mockResolvedValue({ ok: false, reason: 'whatever' });
    (window as Window).giftk = { clipboardWriteText: ipc } as Window['giftk'];
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(global.navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true
    });
    const r = await copyToClipboard('payload');
    expect(r.ok).toBe(true);
    expect(r.via).toBe('navigator');
    expect(writeText).toHaveBeenCalledWith('payload');
  });

  it('falls back to navigator.clipboard when IPC throws', async () => {
    const ipc = vi.fn().mockRejectedValue(new Error('ipc-down'));
    (window as Window).giftk = { clipboardWriteText: ipc } as Window['giftk'];
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(global.navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true
    });
    const r = await copyToClipboard('payload');
    expect(r.ok).toBe(true);
    expect(r.via).toBe('navigator');
  });
});
