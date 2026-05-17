/**
 * R-45 — Upload-history hook (renderer side, localStorage-backed).
 *
 * Mirrors the design of useHistory.ts but with a much simpler shape:
 * a flat reverse-chrono list of UploadHistoryRecord. We DON'T merge
 * upload progress into the processing-history record because:
 *
 *  1) lifecycle is independent (a user can re-upload a single file
 *     from a historic batch without re-running processing);
 *  2) the listing UX wants a single "all my uploads" feed for finding
 *     a recent URL to paste into a doc, not the grouped-by-page card
 *     grid that processing history uses;
 *  3) keeping schemas separate avoids forward-compatibility issues
 *     when one of the two histories evolves.
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  UploadBackend,
  UploadHistoryItem,
  UploadHistoryRecord,
  UploadProgress,
  UploadStatus
} from '../../shared/types';

export const UPLOAD_HISTORY_STORAGE_KEY = 'giftk.uploadHistory.v1';
export const UPLOAD_HISTORY_MAX_ENTRIES = 30;

function genId(): string {
  const r = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `up-${Date.now()}-${r}`;
}

function readAll(): UploadHistoryRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(UPLOAD_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: UploadHistoryRecord[] = [];
    for (const e of parsed) {
      if (!e || typeof e !== 'object') continue;
      const r = e as Partial<UploadHistoryRecord>;
      if (typeof r.id !== 'string' || typeof r.backend !== 'string' || !Array.isArray(r.items)) continue;
      out.push({
        id: r.id,
        createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
        backend: r.backend as UploadBackend,
        items: (r.items as UploadHistoryItem[]).filter(
          (it) => it && typeof it === 'object' && typeof it.jobId === 'string'
        )
      });
    }
    return out;
  } catch {
    return [];
  }
}

function writeAll(list: UploadHistoryRecord[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(UPLOAD_HISTORY_STORAGE_KEY, JSON.stringify(list));
  } catch {
    try { window.localStorage.removeItem(UPLOAD_HISTORY_STORAGE_KEY); } catch { /* swallow */ }
  }
}

export interface UseUploadHistoryApi {
  history: UploadHistoryRecord[];
  /** Push a brand-new record. Returns its id. */
  start(args: { backend: UploadBackend; items: UploadHistoryItem[] }): string;
  /** Fold an UploadProgress emit into a record. Idempotent across
   *  same-status emits; first terminal status wins. */
  applyProgress(recordId: string, p: UploadProgress): void;
  /** Drop a record. */
  remove(id: string): void;
  /** Wipe everything. */
  clear(): void;
}

/**
 * R-45 — Pure helper. Folds an UploadProgress emit into a record's
 * items list; preserves insertion order. Returns the SAME record object
 * when nothing meaningful changed (so React can skip the re-render).
 */
export function applyProgressToRecord(
  rec: UploadHistoryRecord,
  p: UploadProgress
): UploadHistoryRecord {
  const idx = rec.items.findIndex((it) => it.jobId === p.jobId);
  if (idx < 0) return rec;
  const prev = rec.items[idx];
  const TERMINAL: UploadStatus[] = ['done', 'failed', 'cancelled'];
  const nextStatus: UploadStatus =
    prev.status && TERMINAL.includes(prev.status) ? prev.status : p.status;
  // Only meaningful diff triggers a re-write.
  const sameStatus = prev.status === nextStatus;
  const sameUrl = (prev.url || '') === (p.url || '');
  const sameError = (prev.error || '') === (p.error || '');
  const sameMd = (prev.markdown || '') === (p.markdown || '');
  if (sameStatus && sameUrl && sameError && sameMd) {
    return rec;
  }
  const next: UploadHistoryItem = {
    ...prev,
    status: nextStatus,
    url: p.url || prev.url,
    markdown: p.markdown || prev.markdown,
    error: p.error || prev.error
  };
  const items = rec.items.slice();
  items[idx] = next;
  return { ...rec, items };
}

export function useUploadHistory(): UseUploadHistoryApi {
  const [history, setHistory] = useState<UploadHistoryRecord[]>(() => readAll());

  useEffect(() => {
    const t = setTimeout(() => writeAll(history), 250);
    return () => clearTimeout(t);
  }, [history]);

  const start = useCallback((args: { backend: UploadBackend; items: UploadHistoryItem[] }): string => {
    const id = genId();
    setHistory((prev) => {
      const next: UploadHistoryRecord[] = [
        { id, createdAt: Date.now(), backend: args.backend, items: args.items },
        ...prev
      ];
      return next.length > UPLOAD_HISTORY_MAX_ENTRIES
        ? next.slice(0, UPLOAD_HISTORY_MAX_ENTRIES)
        : next;
    });
    return id;
  }, []);

  const applyProgress = useCallback((recordId: string, p: UploadProgress): void => {
    setHistory((prev) => {
      const i = prev.findIndex((r) => r.id === recordId);
      if (i < 0) return prev;
      const updated = applyProgressToRecord(prev[i], p);
      if (updated === prev[i]) return prev;
      const next = prev.slice();
      next[i] = updated;
      return next;
    });
  }, []);

  const remove = useCallback((id: string): void => {
    setHistory((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const clear = useCallback((): void => {
    setHistory([]);
  }, []);

  return { history, start, applyProgress, remove, clear };
}

/** R-45 — Pretty backend label for UI display. */
export function backendLabel(b: UploadBackend): string {
  switch (b) {
    case 'customWeb': return '自定义 Web';
    case 'github': return 'GitHub';
    case 'qiniu': return '七牛云';
    case 'aliyunOss': return '阿里云 OSS';
    case 'tencentCos': return '腾讯云 COS';
    default: return b;
  }
}
