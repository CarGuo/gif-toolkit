/**
 * Renderer-side hook around the main-process session-log store.
 *
 * Surface:
 *   - `snapshot`   — Latest [SessionLogSnapshot](../../shared/types/log.ts) for the
 *                     supplied `sessionId` (or `null` while loading / when
 *                     the id is missing).
 *   - `loading`    — `true` during the initial fetch + while a manual
 *                     `reload()` is in flight.
 *   - `reload()`   — Re-fetch from the DB. Cheap; the panel calls it
 *                     after destructive ops (export / clear).
 *   - `exportLog`  — Trigger the native save-dialog with the chosen
 *                     `.log` / `.json` format. Resolves with the chosen
 *                     path or `null` on cancel.
 *
 * Live updates: the hook subscribes to `giftk.onSessionLog` and
 * append-merges entries that match the current `sessionId` so an
 * in-flight session refreshes as ffmpeg / uploader fires events. We
 * only patch the local snapshot when seq is strictly greater than the
 * last we've seen, so re-broadcasts during reconnect don't duplicate
 * lines.
 *
 * Failure mode: any IPC error is swallowed and surfaced via
 * `error` (string). The hook never throws so a broken DB connection
 * doesn't crash the parent modal.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  SessionLogEntry,
  SessionLogExportFormat,
  SessionLogSnapshot
} from '../../shared/types';

const giftk = (typeof window !== 'undefined' ? window.giftk : undefined);

export interface UseSessionLogsApi {
  snapshot: SessionLogSnapshot | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  exportLog: (
    format: SessionLogExportFormat,
    suggestedName?: string
  ) => Promise<{ ok: boolean; cancelled?: boolean; path?: string } | null>;
}

export function useSessionLogs(sessionId: string | undefined): UseSessionLogsApi {
  const [snapshot, setSnapshot] = useState<SessionLogSnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    if (!sessionId || !giftk?.db?.sessionLogs?.read) {
      setSnapshot(null);
      setLoading(false);
      return;
    }
    const my = ++reqRef.current;
    setLoading(true);
    setError(null);
    try {
      const snap = await giftk.db.sessionLogs.read(sessionId);
      if (my !== reqRef.current) return;
      setSnapshot(snap ?? null);
    } catch (e) {
      if (my !== reqRef.current) return;
      setError((e as Error)?.message || String(e));
      setSnapshot(null);
    } finally {
      if (my === reqRef.current) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Live append: subscribe once and patch in entries matching this sid.
  useEffect(() => {
    if (!sessionId || !giftk?.onSessionLog) return;
    const off = giftk.onSessionLog((ev) => {
      if (ev.kind === 'append') {
        const entry = ev.entry as SessionLogEntry;
        if (entry.sessionId !== sessionId) return;
        setSnapshot((prev) => {
          if (!prev) return prev;
          // Drop duplicates if the same entry was re-broadcast.
          const lastSeq = prev.entries.length > 0
            ? prev.entries[prev.entries.length - 1].seq
            : -1;
          if (entry.seq <= lastSeq) return prev;
          return { ...prev, entries: [...prev.entries, entry] };
        });
      } else if (ev.kind === 'close') {
        if (ev.snapshot.sessionId !== sessionId) return;
        setSnapshot((prev) => prev
          ? {
              ...prev,
              closedAt: ev.snapshot.closedAt,
              outcome: ev.snapshot.outcome
            }
          : prev);
      } else if (ev.kind === 'open') {
        if (ev.snapshot.sessionId !== sessionId) return;
        // Open → trigger a full reload so we see any pre-pin entries.
        void reload();
      }
    });
    return off;
  }, [sessionId, reload]);

  const exportLog = useCallback(async (
    format: SessionLogExportFormat,
    suggestedName?: string
  ): Promise<{ ok: boolean; cancelled?: boolean; path?: string } | null> => {
    if (!sessionId || !giftk?.db?.sessionLogs?.export) return null;
    try {
      return await giftk.db.sessionLogs.export({
        sessionId,
        format,
        suggestedName
      });
    } catch (e) {
      setError((e as Error)?.message || String(e));
      return null;
    }
  }, [sessionId]);

  return { snapshot, loading, error, reload, exportLog };
}
