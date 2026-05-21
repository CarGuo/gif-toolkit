/**
 * useEmbedResolve — extracts the embed (Vimeo / YouTube / Bilibili / …)
 * direct-link resolution flow that previously lived inline in App.tsx
 * (lines 1908-1987 of the original blob).
 *
 * Why this hook exists
 * --------------------
 * The "解析直链" workflow has three pieces of state that are tightly
 * coupled and must transition atomically per id:
 *   • `resolvedMap`      — id → ResolvedMedia (the success overlay)
 *   • `resolvingSet`     — ids currently being resolved (used for spinners
 *                          and to dedupe re-entrant calls)
 *   • `resolveErrorMap`  — id → human-readable error string (rendered as
 *                          a per-row error pill in MediaGrid)
 *
 * Pulling them into a hook means App.tsx no longer has to spell out the
 * guards / log-buffer / auto-trigger logic, and renderer-side tests can
 * exercise the resolution lifecycle without spinning up the entire
 * home-page tree.
 *
 * Why "deps" instead of owning everything
 * ---------------------------------------
 * Unlike useWorkspaces (which owns its own private state), embed resolve
 * is intrinsically coupled to *the active workspace's* `items`,
 * `selected`, log buffer, history record and live `result`. Owning them
 * here would mean re-implementing half of useWorkspaces. Instead the
 * hook accepts an `EmbedResolveDeps` bag — a small set of callbacks the
 * consumer (App.tsx) wires to its workspace setters / patchHistory
 * mutator. That keeps the hook portable and trivially mockable in tests.
 *
 * P1 (#5) FIX — single-source double-write
 * ----------------------------------------
 * The original inline code wrote a successful `ResolvedMedia` to TWO
 * different containers:
 *   1. `patchHistory(recId, ...)` so the SQLite-backed HistoryRecord's
 *      items[] contains the resolved payload — required so that on app
 *      restart, "重跑" / "下载" actions in the history detail modal pass
 *      the `requiresExternalDownload && !resolved` guard.
 *   2. `setResult((prev) => ...)` so the live home-page TaskTable /
 *      preview flows see the resolved media within the same session
 *      without us having to thread the in-memory overlay through every
 *      reader.
 *
 * Doing those two writes from inside this hook would force us to also
 * accept `patchHistory` + `activeHistoryIdRef` + `setResult` as deps,
 * which leaks too much App-shape into the hook. We collapse the pair
 * into a single `patchItemResolved(id, resolved)` callback: the hook
 * fires it ONCE on the success path, and the consumer is responsible
 * for splitting the write across `patchHistory` and `setResult`
 * atomically (see App.tsx). This preserves the P1 (#5) double-write
 * semantics while keeping the hook's surface minimal.
 *
 * Auto-trigger
 * ------------
 * The original code also fired off a resolve for every embed in the
 * fresh sniff result whenever `result` changed. We keep that behaviour
 * — the effect depends on `result` only (NOT on resolvedMap /
 * resolvingSet / resolveErrorMap) so it doesn't re-fire on every state
 * delta. The guards inside `onResolveEmbedById` are sufficient to dedupe.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResolvedMedia, SniffResult, SniffedMedia } from '../../shared/types';

export interface EmbedResolveDeps {
  items: SniffedMedia[];
  result: SniffResult | null;
  resolveEmbed: ((m: SniffedMedia) => Promise<ResolvedMedia>) | undefined;
  /** Append one log line to the consumer's logs buffer. */
  appendLog: (line: string) => void;
  /** Add an id to the consumer's `selected` set (auto-select after resolve). */
  addSelected: (id: string) => void;
  /**
   * Persist the resolved payload onto the owning record's items[] AND
   * the live `result.items` snapshot. See the P1 (#5) note in the file
   * header for why this collapses two writes into one callback.
   */
  patchItemResolved: (id: string, resolved: ResolvedMedia) => void;
}

export interface UseEmbedResolveApi {
  resolvedMap: Record<string, ResolvedMedia>;
  resolvingSet: Set<string>;
  resolveErrorMap: Record<string, string>;
  isResolving: (id: string) => boolean;
  onResolveEmbedById: (id: string) => Promise<void>;
  /**
   * Atomically clear all three overlays. Used by the URL-bar /
   * sniff-history / re-sniff entry points in App.tsx, which need to
   * drop the in-memory overlay before showing fresh items so a stale
   * resolved blob doesn't leak across sniffs.
   */
  reset: () => void;
}

export function useEmbedResolve(deps: EmbedResolveDeps): UseEmbedResolveApi {
  const [resolvedMap, setResolvedMap] = useState<Record<string, ResolvedMedia>>({});
  const [resolvingSet, setResolvingSet] = useState<Set<string>>(() => new Set());
  const [resolveErrorMap, setResolveErrorMap] = useState<Record<string, string>>({});

  // Mirror deps in a ref so the auto-trigger effect (which depends only
  // on `result`) can read the latest callbacks / items without taking
  // them as effect deps. This matches the semantics of the original
  // App.tsx effect, which deliberately ignored everything but `result`.
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const onResolveEmbedById = useCallback(async (id: string): Promise<void> => {
    const { items, resolveEmbed, appendLog, addSelected, patchItemResolved } = depsRef.current;
    if (!resolveEmbed) return;
    const m = items.find((i) => i.id === id);
    if (!m) return;
    if (!m.requiresExternalDownload) return;
    if (resolvedMap[id]) return;
    if (resolvingSet.has(id)) return;

    setResolvingSet((prev) => {
      const n = new Set(prev); n.add(id); return n;
    });
    setResolveErrorMap((prev) => {
      if (!prev[id]) return prev;
      const n = { ...prev }; delete n[id]; return n;
    });
    appendLog(`[resolve] ${m.embedHost} ← ${m.pageUrl}`);
    try {
      const r = await resolveEmbed(m);
      setResolvedMap((prev) => ({ ...prev, [id]: r }));
      // Auto-select the now-resolved item so the user can immediately batch.
      addSelected(id);
      // P1 (#5) FIX — collapse the historical "patchHistory + setResult"
      // pair into a single consumer callback. See file header for why.
      patchItemResolved(id, r);
      appendLog(`[resolve] ✓ ${r.qualityLabel || ''} ${r.width || '?'}x${r.height || '?'} (${r.extractor || 'ytdlp'})`);
    } catch (e) {
      const msg = (e as Error).message || '';
      const display = msg === 'YT_DLP_UNAVAILABLE'
        ? 'yt-dlp 不可用(可能离线且本地无缓存),稍后再试'
        : msg;
      setResolveErrorMap((prev) => ({ ...prev, [id]: display }));
      appendLog(`[resolve] 失败: ${display}`);
    } finally {
      setResolvingSet((prev) => {
        const n = new Set(prev); n.delete(id); return n;
      });
    }
  }, [resolvedMap, resolvingSet]);

  // Auto-batch-resolve: whenever the sniff result changes, kick off
  // resolve for every embed that still needs one. Concurrency is bounded
  // inside the main process resolver (yt-dlp is already CPU-bound), so
  // we just fire all pending IDs and let the resolver coalesce.
  //
  // Intentionally don't depend on resolvedMap/resolvingSet/errorMap to
  // avoid re-firing on every state delta — onResolveEmbedById's own
  // guards are enough to dedupe.
  useEffect(() => {
    const { result } = depsRef.current;
    if (!result || result.items.length === 0) return;
    const pending = result.items.filter(
      (m) => m.requiresExternalDownload
        && !resolvedMap[m.id]
        && !resolvingSet.has(m.id)
        && !resolveErrorMap[m.id]
    );
    for (const m of pending) {
      void onResolveEmbedById(m.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deps.result]);

  const isResolving = useCallback(
    (id: string): boolean => resolvingSet.has(id),
    [resolvingSet]
  );

  // Stable reset — depends on nothing because the three setters are
  // module-stable. Clears all three overlays in a single render pass.
  const reset = useCallback((): void => {
    setResolvedMap({});
    setResolvingSet(new Set());
    setResolveErrorMap({});
  }, []);

  return {
    resolvedMap,
    resolvingSet,
    resolveErrorMap,
    isResolving,
    onResolveEmbedById,
    reset
  };
}
