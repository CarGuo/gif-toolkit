/**
 * R-32 — Persistent history of *sniffed URLs* (lightweight LRU).
 *
 * Distinct from useHistory.ts (which records full batch sessions —
 * items / options / outputDir / per-task status). This hook only
 * remembers URLs the user has sniffed, plus the page title and how
 * many media items the sniff returned, so we can offer a quick
 * "recently sniffed" picker on the URL input.
 *
 * Design choices:
 *  - Independent LRU keyed by URL, capped at 30 (matches the user's
 *    answer in the design clarification — "添加的最多").
 *  - Same key versioning convention as useHistory.ts (giftk.* v1).
 *  - The hook never auto-triggers a sniff; the caller decides what
 *    to do with the chosen URL (the App glue calls setUrlInput so
 *    the user has to press 嗅探 themselves — see R-32 design Q3).
 *  - Failures during read/write are silently swallowed, like the
 *    sister hook — sniff history is purely a convenience.
 *  - Mutations debounce localStorage writes (250ms trailing) so a
 *    burst of `add` calls during fast user typing or repeated
 *    sniffs doesn't thrash the disk.
 *
 * R-80 — storage was migrated from localStorage to a main-process
 * SQLite store. The hook still owns an in-memory copy for fast
 * synchronous reads (the panel renders entries directly), but
 * mutations are now fire-and-forget IPC upserts. Initial load is
 * asynchronous — `isLoading` is `true` until the first IPC
 * round-trip resolves so UI can show a placeholder. Bootstrap
 * import from the legacy localStorage key is handled centrally on
 * app boot (see App.tsx) so this hook can assume the DB is the
 * source of truth from mount onward.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export const SNIFF_HISTORY_STORAGE_KEY = 'giftk.sniffHistory.v1';
export const SNIFF_HISTORY_MAX_ENTRIES = 30;

/**
 * R-79b — see [storageSchema.ts](./storageSchema.ts) for rationale.
 * Currently version 1 with no migrations defined; legacy bare-array
 * blobs are accepted as v0 by the shared reader.
 */
export const SNIFF_HISTORY_SCHEMA_VERSION = 1;

/** One entry per *unique URL*. `addOrPromote` dedupes by URL. */
export interface SniffHistoryEntry {
  /** The URL the user sniffed — also serves as the entry's identity. */
  url: string;
  /** The page <title> as captured at sniff time, if any. May be
   *  refreshed by a later sniff of the same URL. */
  title?: string;
  /** Wall-clock ms when this entry was last sniffed. The list is kept
   *  sorted by ts desc. */
  ts: number;
  /** How many media items the most recent sniff of this URL produced.
   *  Optional because very early callers may not know yet (we still
   *  want to log the URL). */
  itemCount?: number;
}

function parseEntry(e: unknown): SniffHistoryEntry | null {
  if (!e || typeof e !== 'object') return null;
  const r = e as Partial<SniffHistoryEntry>;
  if (typeof r.url !== 'string' || !r.url) return null;
  return {
    url: r.url,
    title: typeof r.title === 'string' ? r.title : undefined,
    ts: typeof r.ts === 'number' ? r.ts : Date.now(),
    itemCount: typeof r.itemCount === 'number' ? r.itemCount : undefined
  };
}

export interface UseSniffHistoryApi {
  entries: SniffHistoryEntry[];
  /** R-80 — true while the initial DB read is in flight. Panels should
   *  render a placeholder ("加载中…" / spinner) and avoid the empty-
   *  state CTA so the user doesn't see a flash of "no history" before
   *  the IPC round-trip resolves. */
  isLoading: boolean;
  /** Add a URL (or move it to the front if it already exists),
   *  refreshing its title / itemCount with whatever the latest sniff
   *  reported. Returns the canonical (deduped) entry. */
  addOrPromote(args: { url: string; title?: string; itemCount?: number; ts?: number }): SniffHistoryEntry;
  /** Drop a single URL from history. */
  remove(url: string): void;
  /** Wipe everything (UI is expected to confirm). */
  clear(): void;
}

/** Pure helper — extracted for unit-testing the LRU policy without
 *  the React + DOM stack. */
export function applyAddOrPromote(
  prev: SniffHistoryEntry[],
  args: { url: string; title?: string; itemCount?: number; ts?: number }
): SniffHistoryEntry[] {
  const ts = args.ts ?? Date.now();
  const idx = prev.findIndex((e) => e.url === args.url);
  let next: SniffHistoryEntry[];
  if (idx >= 0) {
    // Promote: refresh title/itemCount/ts; keep older fields as
    // fallback when the new sniff didn't report them (avoid
    // accidentally erasing a previously-known title).
    const old = prev[idx];
    const updated: SniffHistoryEntry = {
      url: args.url,
      title: args.title ?? old.title,
      ts,
      itemCount: args.itemCount ?? old.itemCount
    };
    next = [updated, ...prev.slice(0, idx), ...prev.slice(idx + 1)];
  } else {
    next = [{ url: args.url, title: args.title, ts, itemCount: args.itemCount }, ...prev];
  }
  if (next.length > SNIFF_HISTORY_MAX_ENTRIES) {
    next = next.slice(0, SNIFF_HISTORY_MAX_ENTRIES);
  }
  return next;
}

export function useSniffHistory(): UseSniffHistoryApi {
  const [entries, setEntries] = useState<SniffHistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  // R-80 — guard against late-resolving bootstrap reads writing to an
  // unmounted component (StrictMode double-invokes the effect). The
  // ref is checked inside the async then-block.
  const mountedRef = useRef<boolean>(true);

  // Initial DB load.
  useEffect(() => {
    mountedRef.current = true;
    const api = typeof window !== 'undefined' ? window.giftk?.db?.sniffHistory : undefined;
    if (!api) {
      // No bridge (e.g. test harness without preload) — flip loading
      // off immediately so the consumer doesn't hang on a spinner.
      setIsLoading(false);
      return () => {
        mountedRef.current = false;
      };
    }
    api
      .readAll()
      .then((rows) => {
        if (!mountedRef.current) return;
        const out: SniffHistoryEntry[] = [];
        const seen = new Set<string>();
        for (const r of rows) {
          const e = parseEntry(r);
          if (!e || seen.has(e.url)) continue;
          seen.add(e.url);
          out.push(e);
        }
        out.sort((a, b) => b.ts - a.ts);
        setEntries(out.slice(0, SNIFF_HISTORY_MAX_ENTRIES));
      })
      .catch(() => {
        // Sniff history is convenience-only; an IPC failure leaves
        // the in-memory list empty rather than crashing the panel.
      })
      .finally(() => {
        if (mountedRef.current) setIsLoading(false);
      });
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const addOrPromote = useCallback(
    (args: { url: string; title?: string; itemCount?: number; ts?: number }): SniffHistoryEntry => {
      let result: SniffHistoryEntry = { url: args.url, ts: args.ts ?? Date.now() };
      setEntries((prev) => {
        const next = applyAddOrPromote(prev, args);
        result = next[0];
        return next;
      });
      // Fire-and-forget DB upsert. We intentionally don't await — the
      // optimistic in-memory update has already happened and the user
      // sees the new entry immediately. A later read-back (e.g. after
      // reload) will pick up whatever main persisted.
      const api = typeof window !== 'undefined' ? window.giftk?.db?.sniffHistory : undefined;
      if (api) {
        api.upsert(result).catch(() => {
          /* best-effort; sniff history is non-load-bearing. */
        });
      }
      return result;
    },
    []
  );

  const remove = useCallback((url: string): void => {
    setEntries((prev) => prev.filter((e) => e.url !== url));
    const api = typeof window !== 'undefined' ? window.giftk?.db?.sniffHistory : undefined;
    if (api) {
      api.remove(url).catch(() => {
        /* best-effort. */
      });
    }
  }, []);

  const clear = useCallback((): void => {
    setEntries([]);
    const api = typeof window !== 'undefined' ? window.giftk?.db?.sniffHistory : undefined;
    if (api) {
      api.clear().catch(() => {
        /* best-effort. */
      });
    }
  }, []);

  return { entries, isLoading, addOrPromote, remove, clear };
}
