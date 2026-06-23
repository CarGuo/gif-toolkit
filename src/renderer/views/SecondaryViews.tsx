/**
 * R-70 (Step 10 phase 2) — SecondaryViews host: history / toolbox / uploads.
 *
 * The home view (URL bar / sniff list / progress dock) is the heavyweight
 * branch and stays inline in App.tsx for now (its prop surface is huge).
 * The other three view modes (history, toolbox, uploads) are tiny — each
 * is a single panel wrapped in <div className="body body-XXX">. Lifting
 * them into one host removes 20+ lines of conditional JSX from App.tsx
 * and gives them a co-located file for future per-view tweaks.
 */
import React from 'react';
import { HistoryPanel } from '../components/HistoryPanel';
import { ToolboxPanel } from '../components/ToolboxPanel';
import type { ToolboxPanelProps } from '../components/ToolboxPanel';
import { UploadHistoryPanel } from '../components/UploadHistoryPanel';
import { RecorderPanel } from '../components/RecorderPanel';
import type { HistoryRecord } from '../components/useHistory';
import type { ToolboxKind, ToolboxParams, UploadHistoryRecord } from '../../shared/types';

export type SecondaryViewKind = 'history' | 'toolbox' | 'uploads' | 'recorder';

export interface SecondaryViewsProps {
  view: SecondaryViewKind;
  history: HistoryRecord[];
  setHistoryDetail: (rec: HistoryRecord) => void;
  onOpenHistoryDir: (dir: string) => void;
  removeHistory: (id: string) => void;
  clearHistory: () => void;
  isHistoryLoading: boolean;
  uploadHistory: UploadHistoryRecord[];
  removeUploadHistory: (id: string) => void;
  clearUploadHistory: () => void;
  isUploadHistoryLoading: boolean;
  /** R-COMPRESS-V1 — switch the secondary view to a different tab. Used
   *  by the sniff history → upload history jump action so a click on
   *  the「☁ 上传 N」pill of a sniff card lands the user on the uploads
   *  tab with the matching batch already opened in UploadResultModal. */
  setView: (v: SecondaryViewKind) => void;
  /** R-COMPRESS-V1 — open a specific upload-history batch in the
   *  UploadResultModal owned by ModalsHost. Caller is App.tsx where
   *  the modal state lives. */
  setUploadResult: (batchId: string) => void;
  /** R-COMPRESS-V1 #5 — when a 「推荐预设」chip is clicked on a sniff
   *  history card, App.tsx packs the (rec, preset) into a synthetic
   *  prop and switches the view to 'toolbox'. We forward this prop
   *  to <ToolboxPanel/> which seeds itself via tb.applyPreset on
   *  every key change. Null means "no preset pending". */
  pendingPreset?: ToolboxPanelProps['pendingPreset'];
  /** R-COMPRESS-V1 #5 — handler invoked when the user clicks any
   *  preset chip on a sniff history card. App.tsx wires this to:
   *    1) compute first-done-output-path,
   *    2) setView('toolbox'),
   *    3) setPendingPreset({ key, inputPath, kind, params }).
   *  Optional so legacy tests rendering SecondaryViews without it
   *  still type-check. */
  onApplyPreset?: (
    rec: HistoryRecord,
    preset: { kind: ToolboxKind; params: ToolboxParams }
  ) => void;
}

export const SecondaryViews: React.FC<SecondaryViewsProps> = ({
  view, history, setHistoryDetail, onOpenHistoryDir,
  removeHistory, clearHistory, isHistoryLoading,
  uploadHistory, removeUploadHistory, clearUploadHistory, isUploadHistoryLoading,
  setView, setUploadResult, pendingPreset, onApplyPreset
}) => {
  // R-COMPRESS-V1 — the user reported that sniff-history cards already
  // show a「☁ 上传 N」status pill but had no way to jump to the actual
  // upload batch. We mirror the reverse-lookup ModalsHost uses for the
  // detail modal's same button: collect the urls of done uploads on
  // this record, then walk the (createdAt-desc) uploadHistory and
  // return the first batch whose items intersect that url set. The
  // panel only invokes this when the pill is clickable (i.e. the
  // record has at least one done upload), so a falsy `matched` here
  // means the upload batch was deleted out from under us — we simply
  // no-op rather than navigate to a dead state.
  const onJumpToUploadHistory = React.useCallback((rec: HistoryRecord): void => {
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
    setView('uploads');
    setUploadResult(matched.id);
  }, [uploadHistory, setView, setUploadResult]);

  if (view === 'history') {
    return (
      <div className="body body-history" role="region" aria-label="history">
        <HistoryPanel
          history={history}
          onOpenDetail={(rec) => setHistoryDetail(rec)}
          onOpenOutputDir={onOpenHistoryDir}
          onRemove={removeHistory}
          onClear={clearHistory}
          isLoading={isHistoryLoading}
          onJumpToUploadHistory={onJumpToUploadHistory}
          onApplyPreset={onApplyPreset}
        />
      </div>
    );
  }
  if (view === 'toolbox') {
    return (
      <div className="body body-toolbox" role="region" aria-label="toolbox">
        <ToolboxPanel pendingPreset={pendingPreset} />
      </div>
    );
  }
  if (view === 'recorder') {
    return (
      <div className="body body-recorder" role="region" aria-label="recorder">
        <RecorderPanel />
      </div>
    );
  }
  return (
    <div className="body body-uploads" role="region" aria-label="uploads">
      <UploadHistoryPanel
        history={uploadHistory}
        onRemove={removeUploadHistory}
        onClear={clearUploadHistory}
        isLoading={isUploadHistoryLoading}
      />
    </div>
  );
};
