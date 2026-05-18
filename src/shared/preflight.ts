/**
 * R-74 — Pre-flight orchestrator (pure helpers).
 *
 * Why this module exists:
 *   `dispatchBatch` in App.tsx now runs in two phases — first probe
 *   every task's dims via the new `media:probeDims` IPC, then evaluate
 *   the size guard against the freshly-probed dims, then either
 *   dispatch directly (no will-fail) or stop on a banner that lets
 *   the user one-click 「批量强制允许」 / 「跳过这些项」 / 「取消」.
 *
 *   The probe loop, the dim-merge fold, and the verdict-bucketing
 *   are all stateless transformations that map perfectly to pure
 *   functions. Lifting them out of App.tsx means we get the same
 *   coverage guarantee as [src/shared/sizeGuard.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/sizeGuard.ts):
 *   the renderer's React layer is a thin shell around well-tested
 *   helpers, the unit tests can exercise edge cases (stale results,
 *   probe failures, all-ok early exit) without React.
 *
 * What lives here vs. App.tsx:
 *   - `pickProbeInput`: given a SniffedMedia, decide which URL +
 *     headers to send to ffprobe. Honours `resolved` first.
 *   - `mergeProbedDims`: fold a per-task probe result into a fresh
 *     `{width, height}` pair, falling back to whatever the sniff
 *     layer already had so a probe failure doesn't downgrade us
 *     below the existing baseline.
 *   - `bucketVerdicts`: walk a list of probed tasks and split them
 *     into ok / will-fail / unknown buckets ready for the banner.
 *
 * What stays in App.tsx:
 *   - The `useState` machine, the React effect, the IPC fan-out,
 *     the per-task progress reporting (because that needs the
 *     real Date.now and the real setState).
 *
 * IMPORTANT: keep this module pure (same constraint as sizeGuard.ts).
 */
import { evaluateSizeGuard, type SizeGuardVerdict } from './sizeGuard';
import type { ProbeDimsResult, SniffedMedia } from './types';

/**
 * Compute the URL + headers we should send to the main-side ffprobe.
 *
 * Priority:
 *   1. `m.resolved?.url` (yt-dlp / embed resolver direct link). If it's
 *      present we always pair it with `m.resolved.headers` because most
 *      resolved CDNs (Bilibili, certain Twitter mirrors) gate on Referer
 *      and would 403 the bare URL.
 *   2. Otherwise the original sniffed `m.url` with no headers — this is
 *      the common case for plain `<video>` / `<source>` tags on a page.
 *   3. Local-file media (`m.url` starts with `file://` or absolute path)
 *      flows through the same code path; ffprobe handles both URL forms
 *      transparently.
 *
 * Returns `null` when there is genuinely no URL to probe (an item that
 * sniffed only as a YouTube embed shell with no resolver result yet);
 * caller should treat that task as `unknown`.
 */
export function pickProbeInput(m: SniffedMedia): {
  input: string;
  headers?: Record<string, string>;
} | null {
  const resolvedUrl = m.resolved?.url;
  if (resolvedUrl && typeof resolvedUrl === 'string') {
    const headers = m.resolved?.headers;
    return {
      input: resolvedUrl,
      headers: headers && Object.keys(headers).length > 0 ? { ...headers } : undefined
    };
  }
  if (m.url && typeof m.url === 'string') {
    return { input: m.url };
  }
  return null;
}

/**
 * Fold an IPC probe result back into a `{width, height}` pair the size
 * guard can chew on. We prefer probed dims, fall back to whatever was
 * already on the sniffed media (resolved.width/height, then m.width/
 * height) so a transient ffprobe failure doesn't drop a task that
 * already had perfectly-good dims from yt-dlp.
 */
export function mergeProbedDims(
  m: SniffedMedia,
  probe: ProbeDimsResult | null
): { width: number; height: number } {
  if (probe && probe.ok && probe.width > 0 && probe.height > 0) {
    return { width: probe.width, height: probe.height };
  }
  const w = m.resolved?.width ?? m.width ?? 0;
  const h = m.resolved?.height ?? m.height ?? 0;
  return { width: w, height: h };
}

export interface PreflightTaskRow<T> {
  task: T;
  media: SniffedMedia;
  width: number;
  height: number;
  verdict: SizeGuardVerdict;
  /** True when we tried to probe and got `{ok:false}` (or threw). The
   *  banner uses this count to tell the user "X 项无法预检" so the
   *  fallback to the runtime guard is visible. */
  probeFailed: boolean;
}

/**
 * Walk a list of (task, media, probe-result) triples and produce
 * bucketed verdicts the banner can render directly. The caller passes
 * the `options` so the same evaluator runs in pre-flight as runs
 * later in the processor — there's no chance for divergence.
 *
 * `forceAllowSmallSide: true` on the global options short-circuits the
 * whole evaluation: we mark every task as `ok` so the banner stays
 * silent, matching the documented "I know, just dispatch" override.
 */
export function bucketVerdicts<T extends { id: string; media: SniffedMedia }>(
  rows: Array<{ task: T; probe: ProbeDimsResult | null; probeFailed: boolean }>,
  options: { maxWidth: number; minSize: number; forceAllowSmallSide?: boolean }
): {
  rows: PreflightTaskRow<T>[];
  willFail: PreflightTaskRow<T>[];
  unknown: PreflightTaskRow<T>[];
  ok: PreflightTaskRow<T>[];
} {
  const out: PreflightTaskRow<T>[] = [];
  const willFail: PreflightTaskRow<T>[] = [];
  const unknown: PreflightTaskRow<T>[] = [];
  const ok: PreflightTaskRow<T>[] = [];
  for (const r of rows) {
    const dims = mergeProbedDims(r.task.media, r.probe);
    const verdict = options.forceAllowSmallSide
      ? ({ state: 'ok' } as SizeGuardVerdict)
      : evaluateSizeGuard(dims, options);
    const row: PreflightTaskRow<T> = {
      task: r.task,
      media: r.task.media,
      width: dims.width,
      height: dims.height,
      verdict,
      probeFailed: r.probeFailed
    };
    out.push(row);
    if (verdict.state === 'will-fail') willFail.push(row);
    else if (verdict.state === 'unknown') unknown.push(row);
    else ok.push(row);
  }
  return { rows: out, willFail, unknown, ok };
}
