/**
 * R-WS-90 P5f — formatBytes() unit tests.
 *
 * The helper is dead-simple but UI relies on it for consistent
 * display across [UploadResultModal](src/renderer/components/UploadResultModal.tsx)
 * and [UploadHistoryPanel](src/renderer/components/UploadHistoryPanel.tsx).
 * 这里固化它的契约,避免后续误改 1024-base / decimal places。
 */
import { describe, it, expect } from 'vitest';
import { formatBytes } from '../../src/renderer/components/formatBytes';

describe('formatBytes', () => {
  it('returns empty string for unknown / invalid sizes', () => {
    expect(formatBytes(undefined)).toBe('');
    expect(formatBytes(null as unknown as number)).toBe('');
    expect(formatBytes(NaN)).toBe('');
    expect(formatBytes(-1)).toBe('');
  });

  it('renders bytes (<1KiB) without a decimal', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('renders KB / MB with one decimal', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 5 + 512 * 1024)).toBe('5.5 MB');
  });

  it('renders GB with two decimals', () => {
    const gb = 1024 * 1024 * 1024;
    expect(formatBytes(gb)).toBe('1.00 GB');
    expect(formatBytes(gb * 2 + gb / 4)).toBe('2.25 GB');
  });
});
