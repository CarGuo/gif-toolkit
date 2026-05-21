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
import { UploadHistoryPanel } from '../components/UploadHistoryPanel';
import type { HistoryRecord } from '../components/useHistory';
import type { UploadHistoryRecord } from '../../shared/types';

export type SecondaryViewKind = 'history' | 'toolbox' | 'uploads';

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
}

export const SecondaryViews: React.FC<SecondaryViewsProps> = ({
  view, history, setHistoryDetail, onOpenHistoryDir,
  removeHistory, clearHistory, isHistoryLoading,
  uploadHistory, removeUploadHistory, clearUploadHistory, isUploadHistoryLoading
}) => {
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
        />
      </div>
    );
  }
  if (view === 'toolbox') {
    return (
      <div className="body body-toolbox" role="region" aria-label="toolbox">
        <ToolboxPanel />
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
