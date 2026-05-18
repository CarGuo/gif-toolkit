/**
 * R-57 — Unified post-sniff filter pipeline.
 *
 * Background. Before this module landed, every sniff backend
 * (sniff:url / sniff:webview / sniff:system-chrome / sniff:ytdlp-direct
 * / sniff:offlineImport) constructed its own SniffResult.items[] and
 * returned it directly from the IPC handler. The "include static
 * images" toggle introduced in R-56 was applied only inside
 * `offlineImport.collectFromDom`, which meant a future filter (drop
 * tiny .ico, drop sub-100KB items, dedupe by hash, …) would have to
 * be re-implemented in five places — and inevitably drift.
 *
 * Design. `applySniffFilters(result, opts)` is the single chokepoint
 * every sniff handler now calls right before returning. New rules go
 * here and automatically apply across all 5 backends. The function
 * is intentionally:
 *
 *  - PURE: no I/O, no logging, no side effects. Easy to unit test.
 *  - ADDITIVE: rules only DROP items; they never mutate them. Drop
 *    decisions emit a one-line warning so the renderer can surface
 *    "12 items hidden by filters" if it wants to.
 *  - OPT-IN per rule: every rule has a default and an explicit opt
 *    in the SniffFilterOptions bag. The defaults match the most
 *    common user expectation (filter avatars / sprites away).
 *
 * Adding a rule. Append a new field to `SniffFilterOptions`, add a
 * predicate inside `applySniffFilters`, and write the corresponding
 * unit test in tests/main/sniffFilters.test.ts. No call-site change
 * is needed; every IPC handler will pick the new rule up.
 */
import path from 'path';
import type { SniffResult, SniffedMedia } from '../shared/types';

/**
 * Static-image extensions that almost always represent thumbnails /
 * avatars / sprite sheets when found on a saved page or scraped
 * article. We exclude `.gif` on purpose — the project's whole
 * raison-d'être is GIF processing.
 */
const STATIC_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.avif', '.ico', '.svg']);

export interface SniffFilterOptions {
  /**
   * R-56 — keep <img>-sourced static images (.png/.jpg/.webp/.bmp/
   *.avif/.ico/.svg) in the result.
   *
   * Default `false`. GIFs are NEVER affected by this rule (they
   * survive even when the flag is off). `<video>` / `<source>` /
   * og:video items are NEVER affected either — they are the project's
   * primary input.
   *
   * Renderer surfaces this as the「含静态图」 checkbox next to the
   * 离线导入 button. The other 4 sniff modes do not yet surface the
   * toggle in the UI but will pick it up the moment they do, because
   * they all flow through this filter.
   */
  includeStaticImages?: boolean;
}

/** Pull the file extension off a URL, lowercased, with the leading dot. */
function extOfUrl(u: string): string {
  try {
    // Handle data: / blob: / odd schemes safely.
    const noQuery = u.split('?')[0].split('#')[0];
    const e = path.extname(noQuery).toLowerCase();
    return e || '';
  } catch {
    return '';
  }
}

/**
 * `true` if the item should be DROPPED. We split this out as its own
 * function (instead of inlining in `applySniffFilters`) so a future
 * test can call it directly with a single `SniffedMedia` and assert
 * the predicate without building a whole `SniffResult` envelope.
 */
export function shouldDropForFilters(item: SniffedMedia, opts: SniffFilterOptions): boolean {
  // GIFs and videos are never filtered — they're the project's
  // primary input. Note that `kind === 'gif'` is set by every
  // backend (extractFromHtml / collectFromDom / webview probe /
  // ytdlp resolved kind) regardless of where in the page the URL
  // came from, so this check is mode-agnostic.
  if (item.kind !== 'image') return false;

  // The static-image filter only kicks in when explicitly off.
  if (opts.includeStaticImages) return false;

  // Belt-and-suspenders: if the kind is 'image' but the extension is
  // .gif (e.g. some saved pages mis-classify), keep it.
  const ext = extOfUrl(item.url);
  if (ext === '.gif') return false;

  // Treat unknown / extension-less image refs as static. The user
  // who wants to surface them can opt back in via includeStaticImages.
  return ext === '' || STATIC_IMAGE_EXTS.has(ext);
}

/**
 * Run every active filter against the SniffResult and return a fresh
 * envelope with the surviving items + any synthetic warning lines
 * produced by the filters. The original `result` is never mutated.
 *
 * Empty/missing `opts` is treated as "all defaults" so every existing
 * call site can append `applySniffFilters(r, opts)` with zero risk
 * of accidentally enabling a rule the caller did not ask for.
 */
export function applySniffFilters(
  result: SniffResult,
  opts: SniffFilterOptions = {}
): SniffResult {
  const beforeCount = result.items.length;
  const survivors: SniffedMedia[] = [];
  let droppedStatic = 0;

  for (const item of result.items) {
    if (shouldDropForFilters(item, opts)) {
      droppedStatic += 1;
      continue;
    }
    survivors.push(item);
  }

  // Fast-path: nothing changed → return the original envelope so
  // upstream identity-equality checks (e.g. memoisation) remain valid.
  if (survivors.length === beforeCount) return result;

  // R-67 — The static-image filter is a *by-design* drop, not a failure.
  // Pre-R-67 we pushed this into `warnings`, which the renderer renders
  // red — making a perfectly normal sniff look like an error. The
  // message now goes to `infoNotices` (rendered in muted/info style)
  // so the user can see WHY counts went down without panicking. Real
  // failures (timeout, no media at all, fetch error) still go to
  // `warnings` and stay red.
  const infoNotices = [...(result.infoNotices ?? [])];
  if (droppedStatic > 0) {
    infoNotices.push(
      `已自动过滤 ${droppedStatic} 个静态图像(.png/.jpg/.webp/.bmp/.avif/.ico/.svg);` +
      ' 如果你需要它们,请勾选「含静态图」后重试。GIF 与 <video> 不受此过滤影响。'
    );
  }

  return {
    ...result,
    items: survivors,
    infoNotices
  };
}
