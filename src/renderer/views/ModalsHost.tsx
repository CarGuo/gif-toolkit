/**
 * R-70 (Step 10 phase 1) — App.tsx file-level decomposition.
 *
 * ModalsHost owns the rendering of all top-level modals that App.tsx used
 * to inline at the bottom of its JSX tree:
 *   - PreviewModal (per-media preview + 单独处理)
 *   - BatchSegmentModal (segment picker before batch)
 *   - HistoryDetailModal (sniff history detail)
 *   - ManualOptimizeModal (R-33 secondary tightening)
 *   - UploadSettingsModal (R-54 image-host config)
 *   - UploadResultModal (R-54 upload result detail)
 *   - Toaster (R-62 cross-platform capability toasts)
 *
 * Why split:
 *   App.tsx grew to 2098 LoC and the user (rightly) asked why it is
 *   not composed of multiple per-feature tsx files. The bottom 100+
 *   lines of App.tsx were a flat sequence of conditional <SomeModal />
 *   blocks — they are a perfect candidate to lift into a single host
 *   component because:
 *     - each modal's open/close state already lives in App-level
 *       useState (manualOpt, batchModal, …)
 *     - they share zero local state with each other
 *     - they only consume App-level handlers + setters
 *
 * Why props (not context):
 *   App.tsx is the single composition root for these handlers; Context
 *   would add indirection without payoff. The props list is wide but
 *   each prop is genuinely needed at this layer — collapsing them
 *   into a "modalState" object would just rename the contract.
 */
import React from 'react';
import type {
  TaskProgress,
  SniffedMedia,
  PreviewResult,
  UploadConfigs
} from '../../shared/types';
import { PreviewModal, type PreviewOverride } from '../components/PreviewModal';
import { BatchSegmentModal, type BatchSegmentEntry } from '../components/BatchSegmentModal';
import { HistoryDetailModal } from '../components/HistoryDetailModal';
import { ManualOptimizeModal, type ManualOptimizeRequest } from '../components/ManualOptimizeModal';
import { UploadSettingsModal } from '../components/UploadSettingsModal';
import { UploadResultModal } from '../components/UploadResultModal';
import { Toaster } from '../components/Toast';
import { isUploadConfigured } from '../components/useUploadHistory';
import type { HistoryRecord } from '../components/useHistory';

export interface ModalsHostProps {
  // PreviewModal slice
  activeMedia: SniffedMedia | null;
  options: Parameters<typeof PreviewModal>[0]['baseOptions'];
  previewOverride: PreviewOverride;
  setPreviewOverride: React.Dispatch<React.SetStateAction<PreviewOverride>>;
  setOptions: Parameters<typeof PreviewModal>[0]['onChangeOptions'];
  onPreview: Parameters<typeof PreviewModal>[0]['onRequestPreview'];
  previewing: boolean;
  preview: PreviewResult | null;
  closeModal: () => void;
  onProcessOne: (m: SniffedMedia, ov?: PreviewOverride) => void;
  isProcessingOne: (id: string) => boolean;

  // BatchSegmentModal slice
  batchModal: { entries: BatchSegmentEntry[]; list: SniffedMedia[]; mode: 'fresh' | 'append' } | null;
  setBatchModal: React.Dispatch<React.SetStateAction<{ entries: BatchSegmentEntry[]; list: SniffedMedia[]; mode: 'fresh' | 'append' } | null>>;
  setLogs: React.Dispatch<React.SetStateAction<string[]>>;
  dispatchBatch: (perId: Record<string, number[]>, list?: SniffedMedia[]) => Promise<void>;

  // HistoryDetailModal slice
  historyDetail: HistoryRecord | null;
  setHistoryDetail: React.Dispatch<React.SetStateAction<HistoryRecord | null>>;
  history: HistoryRecord[];
  progress: Record<string, TaskProgress>;
  onReprocessFromHistory: Parameters<typeof HistoryDetailModal>[0]['onProcessOneFromRecord'];
  onBatchFromRecord: Parameters<typeof HistoryDetailModal>[0]['onBatchFromRecord'];
  onCancel: () => void;
  onOpenHistoryDir: (dir: string) => void;
  logs: string[];
  taskRecordMapRef: React.MutableRefObject<Map<string, string>>;
  dispatchUpload: (
    plan: Array<{ media: SniffedMedia; filePath: string }>,
    opts?: { sniffRecId?: string | null }
  ) => Promise<void>;
  uploadConfigs: UploadConfigs | null;

  // ManualOptimizeModal slice
  manualOpt: { media: SniffedMedia; progress: TaskProgress; gifPath: string } | null;
  setManualOpt: React.Dispatch<React.SetStateAction<{ media: SniffedMedia; progress: TaskProgress; gifPath: string } | null>>;
  onManualOptimizeConfirm: (req: ManualOptimizeRequest) => void;

  // Upload modals slice
  uploadSettingsOpen: boolean;
  setUploadSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onSaveUploadSettings: Parameters<typeof UploadSettingsModal>[0]['onSave'];
  uploadResult: string | null;
  setUploadResult: React.Dispatch<React.SetStateAction<string | null>>;
  uploadHistory: Parameters<typeof UploadResultModal>[0]['record'][];
  /**
   * R-WS-90 P5h — switch the main tab. Used by HistoryDetailModal's
   * 「📤 在上传历史中查看本批」 button to jump from sniff history detail
   * to the matching upload-history batch in the global Uploads tab.
   */
  setView: React.Dispatch<React.SetStateAction<'home' | 'history' | 'toolbox' | 'uploads'>>;

  // Toaster
  toasterHandleSetter: Parameters<typeof Toaster>[0]['registerHandle'];
}

export const ModalsHost: React.FC<ModalsHostProps> = (props) => {
  const {
    activeMedia, options, previewOverride, setPreviewOverride, setOptions,
    onPreview, previewing, preview, closeModal, onProcessOne, isProcessingOne,
    batchModal, setBatchModal, setLogs, dispatchBatch,
    historyDetail, setHistoryDetail, history, progress,
    onReprocessFromHistory, onBatchFromRecord, onCancel, onOpenHistoryDir,
    logs, taskRecordMapRef, dispatchUpload, uploadConfigs,
    manualOpt, setManualOpt, onManualOptimizeConfirm,
    uploadSettingsOpen, setUploadSettingsOpen, onSaveUploadSettings,
    uploadResult, setUploadResult, uploadHistory,
    setView,
    toasterHandleSetter
  } = props;

  return (
    <>
      {activeMedia ? (
        <PreviewModal
          media={activeMedia}
          baseOptions={options}
          previewOverride={previewOverride}
          onChangeOverride={setPreviewOverride}
          onChangeOptions={setOptions}
          onRequestPreview={onPreview}
          previewing={previewing}
          preview={preview}
          onClose={closeModal}
          onProcessOne={(m, ov) => onProcessOne(m, ov)}
          processOneDisabled={isProcessingOne(activeMedia.id) || activeMedia.kind === 'image' || (!!activeMedia.requiresExternalDownload && !activeMedia.resolved)}
        />
      ) : null}

      {batchModal ? (
        <BatchSegmentModal
          entries={batchModal.entries}
          maxSegmentSec={options.maxSegmentSec}
          onCancel={() => setBatchModal(null)}
          onConfirm={(perId) => {
            // R-43.2 — 'append' 模式只把 modal 创建时的 list 子集
            // 推到队列;'fresh' 模式沿用旧行为(传 null,dispatchBatch
            // 内部会用 processable 全集)。
            const snapshotList = batchModal.list;
            const mode = batchModal.mode;
            setBatchModal(null);
            if (mode === 'append') {
              setLogs((prev) => [...prev, `[batch] 追加 ${snapshotList.length} 个任务到当前队列`].slice(-300));
              void dispatchBatch(perId, snapshotList);
            } else {
              void dispatchBatch(perId);
            }
          }}
        />
      ) : null}

      {historyDetail ? (
        <HistoryDetailModal
          // Re-derive from the live history array on every render so
          // progress events (taskStatus / outputsByTaskId / outputDir
          // patches via patchHistory) are reflected in the modal —
          // otherwise we'd show the snapshot taken at openDetail time.
          rec={history.find((r) => r.id === historyDetail.id) ?? historyDetail}
          progress={progress}
          isProcessing={isProcessingOne}
          onProcessOneFromRecord={onReprocessFromHistory}
          onBatchFromRecord={onBatchFromRecord}
          onCancel={onCancel}
          onOpenOutputDir={onOpenHistoryDir}
          onClose={() => setHistoryDetail(null)}
          logs={logs}
          // R-29 (P0-C): forward the live task→record binding so the
          // modal can filter same-id collisions out of its TaskTable.
          taskRecordMap={taskRecordMapRef.current}
          // R-54 — let the modal dispatch uploads pinned to its own
          // record so the upload outcomes are folded back into
          // rec.uploadsByOutputPath.
          onUploadFromRecord={(rec, plan) => void dispatchUpload(plan, { sniffRecId: rec.id })}
          isUploadConfigured={isUploadConfigured(uploadConfigs)}
          // R-WS-90 P5h — UploadHistoryRecord schema 没有 sniffRecId 字段,
          // 所以这里通过远端 url 集合反查最新批次:
          //   rec.uploadsByOutputPath[*].url ∩ uploadHistory[*].items[*].url ≠ ∅
          // uploadHistory 已按 createdAt 倒序;遇到第一条命中即跳转 +
          // 切到 uploads tab + 关闭当前 detail modal。
          onJumpToUploadHistory={(rec) => {
            const ups = rec.uploadsByOutputPath || {};
            const targetUrls = new Set<string>();
            for (const fp of Object.keys(ups)) {
              const u = ups[fp];
              if (u && u.status === 'done' && u.url) targetUrls.add(u.url);
            }
            if (targetUrls.size === 0) return;
            const matched = uploadHistory.find((batch) =>
              batch.items.some((it) => !!it.url && targetUrls.has(it.url))
            );
            if (!matched) return;
            setHistoryDetail(null);
            setView('uploads');
            setUploadResult(matched.id);
          }}
        />
      ) : null}

      <ManualOptimizeModal
        open={!!manualOpt}
        currentSizeMB={manualOpt?.progress.currentSizeMB ?? 0}
        currentWidth={manualOpt?.media.resolved?.width ?? manualOpt?.media.width}
        currentHeight={manualOpt?.media.resolved?.height ?? manualOpt?.media.height}
        baseOptions={options}
        taskTitle={manualOpt ? (() => {
          try {
            return new URL(manualOpt.media.url).pathname.split('/').pop() || manualOpt.media.url;
          } catch {
            return manualOpt.media.url;
          }
        })() : undefined}
        warning={manualOpt?.progress.warning}
        onConfirm={onManualOptimizeConfirm}
        onClose={() => setManualOpt(null)}
      />

      {uploadSettingsOpen && uploadConfigs ? (
        <UploadSettingsModal
          initial={uploadConfigs}
          onClose={() => setUploadSettingsOpen(false)}
          onSave={onSaveUploadSettings}
        />
      ) : null}

      {uploadResult ? (() => {
        const rec = uploadHistory.find((r) => r.id === uploadResult);
        if (!rec) return null;
        return <UploadResultModal record={rec} onClose={() => setUploadResult(null)} />;
      })() : null}

      {/* R-62 — Cross-platform capability toaster. Always mounted;
          renders nothing until at least one toast is pushed. */}
      <Toaster registerHandle={toasterHandleSetter} />
    </>
  );
};
