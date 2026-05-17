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
  UploadConfigs,
  UploadHistoryItem,
  UploadHistoryRecord,
  UploadProgress,
  UploadStatus
} from '../../shared/types';

export const UPLOAD_HISTORY_STORAGE_KEY = 'giftk.uploadHistory.v1';
// R-54 — Per the user's product feedback we now保存 ALL upload history
// (no LRU cap) and let the panel paginate. The previous 30-entry hard
// cap silently lost long-tail records when a user batch-uploaded ~30
// files and then forgot the link two months later. This constant is
// retained as a soft "page size" advisory only — readAll/writeAll do
// NOT enforce it, the panel uses it as the default page size instead.
export const UPLOAD_HISTORY_PAGE_SIZE = 20;
/** @deprecated R-54 — use {@link UPLOAD_HISTORY_PAGE_SIZE} for paging. */
export const UPLOAD_HISTORY_MAX_ENTRIES = Number.POSITIVE_INFINITY;

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
  // R-54 — fileHash + reused are sticky once set so a later
  // `uploading` emit that omits them doesn't blank out a `done`
  // record's hash.
  const nextHash = prev.fileHash || p.fileHash;
  const nextReused = prev.reused ?? p.reused;
  const sameHash = (prev.fileHash || '') === (nextHash || '');
  const sameReused = (prev.reused ?? false) === (nextReused ?? false);
  if (sameStatus && sameUrl && sameError && sameMd && sameHash && sameReused) {
    return rec;
  }
  const next: UploadHistoryItem = {
    ...prev,
    status: nextStatus,
    url: p.url || prev.url,
    markdown: p.markdown || prev.markdown,
    error: p.error || prev.error,
    fileHash: nextHash,
    reused: nextReused
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
      // R-54 — keep ALL upload history. Past 30-cap LRU lost long-tail
      // links the user wanted weeks/months later. Paging in the panel
      // makes the unbounded list usable.
      return [
        { id, createdAt: Date.now(), backend: args.backend, items: args.items },
        ...prev
      ];
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

/**
 * R-54 — Pure helper:does the given UploadConfigs object describe a
 * fully usable backend?Returns `false` when the active backend has
 * not been filled in (e.g. user opened the app for the first time
 * and has not visited 「📤 上传设置」 yet).
 *
 * The check is intentionally conservative: we only verify the bare
 * minimum fields the corresponding `dispatchUpload` backend needs to
 * sign / route the request. Full validation (token still valid,
 * bucket exists, …) is the job of「📤 上传设置」-> 测试连接 and is
 * not duplicated here.
 *
 * Returning `false` is what makes the upload buttons (「⚡ 上传所有
 * 产物」 / per-row 📤) light up as disabled with a tooltip telling
 * the user to open the settings modal first.
 */
export function isUploadConfigured(c: UploadConfigs | null | undefined): boolean {
  if (!c) return false;
  switch (c.active) {
    case 'customWeb':
      return !!(c.customWeb && typeof c.customWeb.url === 'string' && /^https?:\/\//i.test(c.customWeb.url));
    case 'github':
      return !!(c.github && c.github.token && c.github.repo);
    case 'qiniu':
      return !!(c.qiniu && c.qiniu.accessKey && c.qiniu.secretKey && c.qiniu.bucket && c.qiniu.domain);
    case 'aliyunOss':
      return !!(c.aliyunOss && c.aliyunOss.accessKeyId && c.aliyunOss.accessKeySecret && c.aliyunOss.bucket && c.aliyunOss.region);
    case 'tencentCos':
      return !!(c.tencentCos && c.tencentCos.secretId && c.tencentCos.secretKey && c.tencentCos.bucket && c.tencentCos.region);
    default:
      return false;
  }
}

/**
 * R-54 — Hash dedup lookup. Walk the entire upload history newest →
 * oldest and return the first item whose sha256 fileHash matches AND
 * whose previous upload finished successfully (status === 'done',
 * url present). The caller can then decide to skip the actual
 * upload and reuse the previous remote URL — saves bandwidth + time
 * and (for backends that bill per request) money.
 *
 * IMPORTANT: we deliberately do not narrow by backend or filename.
 * The same bytes uploaded to 七牛 6 months ago should still短-circuit
 * a 上传 request to GitHub today, because the *remote URL is still
 * valid* — we hand it back as-is. If the user wants the file fresh
 * on a *different* backend they can re-pick the backend in 上传
 * 设置 and the dedup will only fire when there's already a record
 * matching that backend, OR they can simply delete the prior history
 * row and the next upload will run normally.
 *
 * Note: ignored if the prior record's backend is different — the URL
 * may still be live, but pretending the upload happened on the
 * "active" backend would corrupt the new record's analytics. We
 * therefore filter by backend first; users wanting cross-backend
 * dedup can pick the matching backend in settings to surface it.
 */
export function findUploadByHash(
  history: UploadHistoryRecord[],
  hash: string,
  backend: UploadBackend
): { url: string; markdown?: string; backend: UploadBackend; fileName: string; recordId: string; jobId: string } | null {
  if (!hash) return null;
  for (const rec of history) {
    if (rec.backend !== backend) continue;
    for (const it of rec.items) {
      if (it.status !== 'done' || !it.url) continue;
      if (it.fileHash === hash) {
        return {
          url: it.url,
          markdown: it.markdown,
          backend: rec.backend,
          fileName: it.fileName,
          recordId: rec.id,
          jobId: it.jobId
        };
      }
    }
  }
  return null;
}

/** R-54 — Stable pagination slicer used by the panel. Exported so it
 *  can be unit-tested without spinning up React. */
export function paginateHistory<T>(list: T[], page: number, pageSize: number): { rows: T[]; pageCount: number; safePage: number } {
  const total = list.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.max(1, Math.min(page, pageCount));
  const start = (safePage - 1) * pageSize;
  return { rows: list.slice(start, start + pageSize), pageCount, safePage };
}
