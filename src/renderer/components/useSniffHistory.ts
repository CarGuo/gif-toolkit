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
 */
import { useCallback, useEffect, useState } from 'react';
import { readVersionedStorage, writeVersionedStorage } from './storageSchema';

export const SNIFF_HISTORY_STORAGE_KEY = 'giftk.sniffHistory.v1';
export const SNIFF_HISTORY_MAX_ENTRIES = 30;

/**
 * R-79b — see [storageSchema.ts](./storageSchema.ts) for rationale.
 * Currently version 1 with no migrations defined; legacy bare-array
 * blobs are accepted as v0 by the shared reader.
 */
export const SNIFF_HISTORY_SCHEMA_VERSION = 1;
const SNIFF_HISTORY_MIGRATORS: ReadonlyArray<(prev: unknown[]) => unknown[]> = [];

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

function readAll(): SniffHistoryEntry[] {
  if (typeof window === 'undefined') return [];
  const { payload } = readVersionedStorage<unknown>({
    key: SNIFF_HISTORY_STORAGE_KEY,
    currentVersion: SNIFF_HISTORY_SCHEMA_VERSION,
    migrators: SNIFF_HISTORY_MIGRATORS
  });
  try {
    const out: SniffHistoryEntry[] = [];
    const seen = new Set<string>();
    for (const e of payload) {
      if (!e || typeof e !== 'object') continue;
      const r = e as Partial<SniffHistoryEntry>;
      if (typeof r.url !== 'string' || !r.url) continue;
      // Normalise: drop dup URLs that may have crept in from a
      // partially-corrupt write; keep the *first* (newer when sorted).
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      out.push({
        url: r.url,
        title: typeof r.title === 'string' ? r.title : undefined,
        ts: typeof r.ts === 'number' ? r.ts : Date.now(),
        itemCount: typeof r.itemCount === 'number' ? r.itemCount : undefined
      });
    }
    // Sort newest-first; persist may have been interrupted mid-write
    // and we don't trust on-disk order.
    out.sort((a, b) => b.ts - a.ts);
    return out.slice(0, SNIFF_HISTORY_MAX_ENTRIES);
  } catch {
    return [];
  }
}

function writeAll(list: SniffHistoryEntry[]): void {
  writeVersionedStorage({
    key: SNIFF_HISTORY_STORAGE_KEY,
    currentVersion: SNIFF_HISTORY_SCHEMA_VERSION,
    payload: list
  });
}

export interface UseSniffHistoryApi {
  entries: SniffHistoryEntry[];
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
  const [entries, setEntries] = useState<SniffHistoryEntry[]>(() => readAll());

  // Trailing-edge debounce of disk writes — same rationale as
  // useHistory.ts (250ms is below human reaction time but coalesces
  // bursts from rapid sniff retries).
  useEffect(() => {
    const t = setTimeout(() => writeAll(entries), 250);
    return () => clearTimeout(t);
  }, [entries]);

  const addOrPromote = useCallback(
    (args: { url: string; title?: string; itemCount?: number; ts?: number }): SniffHistoryEntry => {
      let result: SniffHistoryEntry = { url: args.url, ts: args.ts ?? Date.now() };
      setEntries((prev) => {
        const next = applyAddOrPromote(prev, args);
        result = next[0];
        return next;
      });
      return result;
    },
    []
  );

  const remove = useCallback((url: string): void => {
    setEntries((prev) => prev.filter((e) => e.url !== url));
  }, []);

  const clear = useCallback((): void => {
    setEntries([]);
  }, []);

  return { entries, addOrPromote, remove, clear };
}
