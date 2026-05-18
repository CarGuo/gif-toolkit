/**
 * R-74 — Tests for the pre-flight orchestrator's pure helpers.
 *
 * These cover [src/shared/preflight.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/preflight.ts):
 *
 *   - `pickProbeInput`: routes through resolved.url first, falls back
 *     to the bare sniffed URL, returns null when neither is set.
 *   - `mergeProbedDims`: prefers a successful probe but falls back to
 *     resolved.width/height and then m.width/height so a transient
 *     ffprobe failure can't drop dims that the sniff layer already
 *     had.
 *   - `bucketVerdicts`: splits a probed task list into the three
 *     buckets the banner renders (will-fail / unknown / ok), and
 *     short-circuits to all-ok when `forceAllowSmallSide` is on.
 *
 * The pure-function shape (no IO, no React) means we don't need any
 * test runner hacks — vitest picks these up automatically.
 */
import { describe, expect, it } from 'vitest';
import {
  pickProbeInput,
  mergeProbedDims,
  bucketVerdicts
} from '../../src/shared/preflight';
import type { SniffedMedia } from '../../src/shared/types';

const baseMedia = (over: Partial<SniffedMedia> = {}): SniffedMedia => ({
  id: over.id ?? 'm1',
  url: over.url ?? 'https://example.test/v.mp4',
  pageUrl: over.pageUrl ?? 'https://example.test/',
  kind: over.kind ?? 'video',
  source: over.source ?? 'video-tag',
  ...over
});

describe('pickProbeInput', () => {
  it('uses resolved.url when present and forwards headers', () => {
    const m = baseMedia({
      resolved: {
        url: 'https://cdn.example.test/v.mp4',
        headers: { Referer: 'https://example.test/' },
        source: 'ytdlp'
      }
    });
    expect(pickProbeInput(m)).toEqual({
      input: 'https://cdn.example.test/v.mp4',
      headers: { Referer: 'https://example.test/' }
    });
  });

  it('falls back to media.url when resolved is absent', () => {
    const m = baseMedia({ url: 'https://plain.test/v.mp4' });
    expect(pickProbeInput(m)).toEqual({ input: 'https://plain.test/v.mp4' });
  });

  it('omits headers when resolved.headers is empty', () => {
    const m = baseMedia({
      resolved: { url: 'https://cdn.example.test/v.mp4', headers: {}, source: 'ytdlp' }
    });
    expect(pickProbeInput(m)).toEqual({
      input: 'https://cdn.example.test/v.mp4',
      headers: undefined
    });
  });

  it('returns null when neither resolved nor url are usable', () => {
    const m = baseMedia({ url: '' });
    expect(pickProbeInput(m)).toBeNull();
  });
});

describe('mergeProbedDims', () => {
  it('prefers probed dims when ok and positive', () => {
    const m = baseMedia({ width: 100, height: 50 });
    expect(
      mergeProbedDims(m, { ok: true, width: 1920, height: 1080, durationSec: 5 })
    ).toEqual({ width: 1920, height: 1080 });
  });

  it('falls back to resolved.width/height when probe failed', () => {
    const m = baseMedia({
      width: 100,
      height: 50,
      resolved: { url: 'x', width: 800, height: 600, source: 'ytdlp' }
    });
    expect(mergeProbedDims(m, { ok: false, error: 'timeout' })).toEqual({
      width: 800,
      height: 600
    });
  });

  it('falls back to media.width/height when no resolved dims', () => {
    const m = baseMedia({ width: 320, height: 240 });
    expect(mergeProbedDims(m, null)).toEqual({ width: 320, height: 240 });
  });

  it('returns 0/0 when nothing is known', () => {
    const m = baseMedia();
    expect(mergeProbedDims(m, null)).toEqual({ width: 0, height: 0 });
  });

  it('treats zero-dim probe results as failure (ignores 0/0)', () => {
    const m = baseMedia({ width: 1024, height: 768 });
    expect(
      mergeProbedDims(m, { ok: true, width: 0, height: 0, durationSec: 0 })
    ).toEqual({ width: 1024, height: 768 });
  });
});

describe('bucketVerdicts', () => {
  const opt = { maxWidth: 800, minSize: 240 };

  const task = (id: string, m: SniffedMedia) => ({ id, media: m });

  it('routes ok tasks into the ok bucket', () => {
    const t = task('ok1', baseMedia({ id: 'ok1' }));
    const buckets = bucketVerdicts(
      [{ task: t, probe: { ok: true, width: 800, height: 600, durationSec: 1 }, probeFailed: false }],
      opt
    );
    expect(buckets.ok).toHaveLength(1);
    expect(buckets.willFail).toHaveLength(0);
    expect(buckets.unknown).toHaveLength(0);
  });

  it('routes ratio-violating tasks into willFail and exposes the verdict shape', () => {
    // 4000x300 capped at 800 → short = round(300*800/4000) = 60 < 240
    const t = task('thin', baseMedia({ id: 'thin' }));
    const buckets = bucketVerdicts(
      [{ task: t, probe: { ok: true, width: 4000, height: 300, durationSec: 1 }, probeFailed: false }],
      opt
    );
    expect(buckets.willFail).toHaveLength(1);
    const row = buckets.willFail[0];
    expect(row.verdict.state).toBe('will-fail');
    if (row.verdict.state === 'will-fail') {
      expect(row.verdict.origW).toBe(4000);
      expect(row.verdict.shortSideAtMax).toBe(60);
      expect(row.verdict.minSide).toBe(240);
    }
  });

  it('routes dim-less tasks (probe failed and no fallback) into unknown', () => {
    const t = task('mystery', baseMedia({ id: 'mystery' }));
    const buckets = bucketVerdicts(
      [{ task: t, probe: { ok: false, error: 'timeout' }, probeFailed: true }],
      opt
    );
    expect(buckets.unknown).toHaveLength(1);
    expect(buckets.willFail).toHaveLength(0);
    expect(buckets.ok).toHaveLength(0);
  });

  it('marks every task ok when forceAllowSmallSide is globally on', () => {
    const t = task('thin', baseMedia({ id: 'thin' }));
    const buckets = bucketVerdicts(
      [{ task: t, probe: { ok: true, width: 4000, height: 300, durationSec: 1 }, probeFailed: false }],
      { ...opt, forceAllowSmallSide: true }
    );
    expect(buckets.willFail).toHaveLength(0);
    expect(buckets.unknown).toHaveLength(0);
    expect(buckets.ok).toHaveLength(1);
  });

  it('preserves probeFailed flag on the row regardless of bucket', () => {
    // Probe failed but a sniff fallback gave us ok dims → ok bucket but
    // probeFailed=true so the banner can still note "X 项无法预检".
    const m = baseMedia({ id: 'sniffed', width: 800, height: 600 });
    const t = task('sniffed', m);
    const buckets = bucketVerdicts(
      [{ task: t, probe: { ok: false, error: 'timeout' }, probeFailed: true }],
      opt
    );
    expect(buckets.ok).toHaveLength(1);
    expect(buckets.ok[0].probeFailed).toBe(true);
  });

  it('handles a mixed batch and counts each bucket independently', () => {
    const rows = [
      {
        task: task('a', baseMedia({ id: 'a' })),
        probe: { ok: true, width: 800, height: 600, durationSec: 1 } as const,
        probeFailed: false
      },
      {
        task: task('b', baseMedia({ id: 'b' })),
        probe: { ok: true, width: 4000, height: 300, durationSec: 1 } as const,
        probeFailed: false
      },
      {
        task: task('c', baseMedia({ id: 'c' })),
        probe: { ok: false, error: 'x' } as const,
        probeFailed: true
      }
    ];
    const buckets = bucketVerdicts(rows, opt);
    expect(buckets.ok).toHaveLength(1);
    expect(buckets.willFail).toHaveLength(1);
    expect(buckets.unknown).toHaveLength(1);
    expect(buckets.rows).toHaveLength(3);
  });
});
