/**
 * useUploadDispatch — extracts the `dispatchUpload` callback that
 * previously lived inline in App.tsx (lines 1573-1705 of the original
 * blob).
 *
 * Why this hook exists
 * --------------------
 * The dispatch path is a small but dense piece of logic with several
 * tightly-coupled invariants:
 *
 *   1. Three renderer-owned routing tables MUST be populated BEFORE the
 *      `uploadStart` IPC roundtrip resolves, otherwise hash-cache hits
 *      that emit `done` synchronously inside `runBatch` (main side)
 *      land in `onUploadProgress` with no recId mapping and silently
 *      drop. This is the P1 (#4) race window the inline code was
 *      written to close.
 *
 *   2. The placeholder `UploadHistoryItem[]` we hand to
 *      `startUploadRecord` MUST already carry the deterministic
 *      `${recId}-${i}` jobIds, otherwise the first progress emit can't
 *      patch the right row.
 *
 *   3. On dispatch failure (catch branch) we MUST roll back the three
 *      tables we eagerly populated above so a failed dispatch doesn't
 *      leak entries that never receive a terminal event.
 *
 *   4. `setUploadResult(recId)` MUST fire on the success branch
 *      immediately, NOT after every job settles — the modal renders
 *      live progress driven by `record.items`.
 *
 * Pulling all of this into a hook lets the renderer test the contract
 * without spinning up the entire App tree, and keeps the App.tsx call
 * site to a single line.
 *
 * Why "deps" instead of owning everything
 * ---------------------------------------
 * `dispatchUpload` is intrinsically coupled to App-level state that is
 * either owned by other hooks (`history` from useHistory,
 * `startUploadRecord` from useUploadHistory) or to refs that the
 * IPC-listener side of App.tsx also reads from (the three routing
 * tables + `uploadInflightRef`). Owning them here would force a
 * re-architecture of the IPC listener too. Instead the hook accepts a
 * `UploadDispatchDeps` bag — a small set of values/setters/refs the
 * consumer (App.tsx) wires through. That keeps the hook portable and
 * trivially mockable in tests.
 *
 * useCallback deps list
 * ---------------------
 * The deps list is intentionally kept identical to the original inline
 * callback: `[uploadConfigs, startUploadRecord, history]`. Everything
 * else read inside the callback is either a ref (stable identity) or a
 * setter (stable identity) — passing them through deps would force
 * unnecessary re-creations.
 */
import { useCallback } from 'react';
import type {
  SniffedMedia,
  UploadBackend,
  UploadConfigs,
  UploadHistoryItem,
  UploadStartPayload,
  UploadStartResult
} from '../../shared/types';
import { isUploadConfigured } from './useUploadHistory';
import type { HistoryRecord } from './useHistory';

/**
 * Minimal slice of the preload API surface this hook depends on.
 * Declared structurally so tests can pass a `vi.fn()` without
 * reaching for the full GifToolkitApi shape.
 */
export interface UploadDispatchGiftkApi {
  uploadStart?: (payload: UploadStartPayload) => Promise<UploadStartResult>;
}

export interface UploadDispatchDeps {
  /** The preload bridge (or `undefined` if running outside Electron). */
  giftk: UploadDispatchGiftkApi | undefined;
  /** Persisted upload backend configs; null until first hydration. */
  uploadConfigs: UploadConfigs | null;
  /** Processing history (used to look up sessionId for log pinning). */
  history: HistoryRecord[];
  /**
   * Reserves a fresh upload-history record id and seeds it with the
   * given placeholder items. Returns the recId.
   */
  startUploadRecord: (args: { backend: UploadBackend; items: UploadHistoryItem[] }) => string;
  /**
   * Mutable ref to the active processing-history record id. Used as
   * the default `sniffRecId` when the caller doesn't pass one.
   */
  activeHistoryIdRef: { current: string | null };
  /** jobId → recordId routing table (renderer-owned). */
  uploadJobToRecordRef: { current: Map<string, string> };
  /** jobId → { sniffRecId, filePath } target table (renderer-owned). */
  uploadJobToTargetRef: { current: Map<string, { sniffRecId?: string; filePath: string }> };
  /** recordId → remaining-non-terminal in-flight counter. */
  uploadInflightRef: { current: Map<string, number> };
  /** Append to the rolling renderer log buffer (capped at 300). */
  setLogs: React.Dispatch<React.SetStateAction<string[]>>;
  /** Open the upload-result modal pinned to the given recordId. */
  setUploadResult: React.Dispatch<React.SetStateAction<string | null>>;
  /** Open the upload-settings modal (used when configs incomplete). */
  setUploadSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

export interface UseUploadDispatchApi {
  dispatchUpload: (
    plan: Array<{ media: SniffedMedia; filePath: string }>,
    opts?: { sniffRecId?: string | null }
  ) => Promise<void>;
}

export function useUploadDispatch(deps: UploadDispatchDeps): UseUploadDispatchApi {
  const {
    giftk,
    uploadConfigs,
    history,
    startUploadRecord,
    activeHistoryIdRef,
    uploadJobToRecordRef,
    uploadJobToTargetRef,
    uploadInflightRef,
    setLogs,
    setUploadResult,
    setUploadSettingsOpen
  } = deps;

  const dispatchUpload = useCallback(async (
    plan: Array<{ media: SniffedMedia; filePath: string }>,
    opts?: { sniffRecId?: string | null }
  ): Promise<void> => {
    if (!giftk || typeof giftk.uploadStart !== 'function') return;
    if (plan.length === 0) {
      setLogs((prev) => [...prev, `[upload] 没有可上传的产物(需要 done 状态且至少有一个输出)`].slice(-300));
      return;
    }
    if (!isUploadConfigured(uploadConfigs)) {
      // R-54 — Conservative configured-check: "configs object exists"
      // is no longer sufficient. We open the settings modal so the
      // user can fill in the missing fields immediately.
      setLogs((prev) => [
        ...prev,
        `[upload] 当前图床尚未配置完整,先去「📤 上传设置」里填好对应后端再来`
      ].slice(-300));
      setUploadSettingsOpen(true);
      return;
    }
    const sniffRecId = opts?.sniffRecId ?? activeHistoryIdRef.current ?? undefined;
    const backend = uploadConfigs!.active;
    // P1 (#4) FIX — race between fire-and-forget `runBatch` (main side) and
    // renderer-owned `jobId → record` mapping. Previously we created items
    // with `jobId: ''`, called `await uploadStart(...)`, then populated the
    // three routing maps + items[i].jobId from the result. Hash-cache hits
    // can emit `done` synchronously inside runBatch BEFORE await resolves,
    // which means `onUploadProgress(p)` finds no recId in
    // uploadJobToRecordRef and returns silently — the upload modal stays
    // stuck on "pending" forever and the upload history / sniff history
    // never see the URL.
    //
    // Fix: jobIds were already deterministic (`${recId}-${i}` was being
    // sent to main and echoed back unchanged via UploadStartResult). We
    // now mint them up-front, write all three maps + the in-flight counter
    // BEFORE the IPC call, and seed each UploadHistoryItem with its real
    // jobId so the first emit lands on the correct row regardless of
    // ordering.
    const jobIds = plan.map((_, i) => `${i}`);
    // Build placeholder record items with the deterministic jobId so the
    // upload-history record can be located by jobId from the very first
    // progress emit.
    const items: UploadHistoryItem[] = plan.map((entry, i) => ({
      jobId: jobIds[i],
      backend,
      fileName: entry.filePath.split(/[\\/]/).pop() || entry.filePath,
      filePath: entry.filePath,
      status: 'pending'
    }));
    // Reserve the record id NOW so onUploadProgress can route emits.
    const recId = startUploadRecord({ backend, items });
    // Promote jobIds to fully-qualified `${recId}-${i}` strings to match
    // what we send to main (and what main echoes back). This must happen
    // AFTER startUploadRecord assigns recId; we then patch each item's
    // jobId in place so the freshly-created record has the final IDs.
    const fullJobIds = jobIds.map((suffix) => `${recId}-${suffix}`);
    items.forEach((it, i) => { it.jobId = fullJobIds[i]; });
    // Pre-populate the routing tables BEFORE the IPC roundtrip. Even if
    // runBatch fires `done` synchronously on the next tick (hash-cache
    // hit), `onUploadProgress` will already see the recId and the
    // sniff-history target, and `uploadInflightRef` is correctly seeded
    // so the central modal opens when the in-flight counter hits zero.
    uploadInflightRef.current.set(recId, fullJobIds.length);
    fullJobIds.forEach((jobId, i) => {
      uploadJobToRecordRef.current.set(jobId, recId);
      uploadJobToTargetRef.current.set(jobId, {
        sniffRecId,
        filePath: plan[i].filePath
      });
    });
    try {
      const payload: UploadStartPayload = {
        jobs: plan.map((entry, i) => ({
          id: fullJobIds[i],
          filePath: entry.filePath,
          remoteName: entry.filePath.split(/[\\/]/).pop() || undefined,
          // R-54 — echoed back on every UploadProgress emit.
          recordId: sniffRecId
        })),
        // Pin the originating sniff session so upload entries land in
        // the same .log/.json export as their preceding stages.
        sessionId: sniffRecId
          ? history.find((h) => h.id === sniffRecId)?.sessionId
          : undefined
      };
      const r = await giftk.uploadStart(payload);
      if (!r.ok) throw new Error('uploadStart failed');
      // Defensive: in the (extremely unlikely) case main re-mints jobIds
      // instead of echoing ours back, reconcile by remapping the routing
      // tables. The contract today is "main returns the same ids", so
      // this branch should never trigger — kept as a safety net.
      const echoed = r.jobIds;
      const mismatch = echoed.length !== fullJobIds.length
        || echoed.some((id, i) => id !== fullJobIds[i]);
      if (mismatch) {
        for (const id of fullJobIds) {
          uploadJobToRecordRef.current.delete(id);
          uploadJobToTargetRef.current.delete(id);
        }
        uploadInflightRef.current.set(recId, echoed.length);
        echoed.forEach((jobId, i) => {
          uploadJobToRecordRef.current.set(jobId, recId);
          uploadJobToTargetRef.current.set(jobId, {
            sniffRecId,
            filePath: plan[i].filePath
          });
        });
        items.forEach((it, i) => { it.jobId = echoed[i] ?? it.jobId; });
      }
      setLogs((prev) => [...prev, `[upload] 已派发 ${echoed.length} 个上传任务`].slice(-300));
      // R-73 — Open the upload progress modal IMMEDIATELY on dispatch,
      // not after every job settles. The modal is the same component
      // we used to pop on completion; UploadResultModal renders the
      // per-row live status list driven by `record.items`, so it
      // animates as `applyUploadProgress` folds streaming events. The
      // terminal-modal-open path in the IPC listener still fires when
      // the in-flight counter hits zero — it's now a no-op (the modal
      // is already showing the same record id) but the call is kept
      // for the edge case where the user manually closed the modal
      // mid-upload and we want to surface the final summary.
      setUploadResult(recId);
    } catch (e) {
      setLogs((prev) => [...prev, `[upload] 派发失败: ${(e as Error).message}`].slice(-300));
      // Roll back the routing tables we eagerly populated above so a
      // failed dispatch doesn't leak entries that never get terminal
      // events from main.
      for (const id of fullJobIds) {
        uploadJobToRecordRef.current.delete(id);
        uploadJobToTargetRef.current.delete(id);
      }
      uploadInflightRef.current.delete(recId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadConfigs, startUploadRecord, history]);

  return { dispatchUpload };
}
