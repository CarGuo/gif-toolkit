/**
 * Smoke tests for shared default options. R-25 (#4) raises the default
 * minSize from 240 → 450 and keeps concurrency at 3 (explicit, no longer
 * undefined). Anything depending on these defaults — IPC schemas, presets,
 * regression fixtures — should derive from this constant rather than
 * hard-coding numbers, so a single check here protects every consumer.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS } from '../../src/shared/types';

describe('DEFAULT_OPTIONS (R-25 #4)', () => {
  it('has minSize raised to 450', () => {
    expect(DEFAULT_OPTIONS.minSize).toBe(450);
  });

  it('keeps concurrency at 3 (default batch parallelism)', () => {
    expect(DEFAULT_OPTIONS.concurrency).toBe(3);
  });

  it('still respects R-22 maxSegmentSec=20 default', () => {
    expect(DEFAULT_OPTIONS.maxSegmentSec).toBe(20);
  });

  it('does not regress maxWidth / fps / softMaxBytes / maxBytes invariants', () => {
    // These are not the focus of R-25 but are easy to break by accident
    // when shuffling defaults around. Lock them in here.
    expect(DEFAULT_OPTIONS.maxWidth).toBe(800);
    expect(DEFAULT_OPTIONS.fps).toBe(12);
    expect(DEFAULT_OPTIONS.softMaxBytes).toBe(2 * 1024 * 1024);
    expect(DEFAULT_OPTIONS.maxBytes).toBe(4 * 1024 * 1024);
  });
});
