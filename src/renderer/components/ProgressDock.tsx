import React, { useCallback } from 'react';
import type { SniffedMedia, TaskProgress } from '../../shared/types';
import { TaskTable } from './TaskTable';
import { LogBox } from './LogBox';

/**
 * R-83 — Reusable progress dock.
 *
 * 1. Both home view AND HistoryDetailModal used to render their own
 *    near-identical "处理进度 toolbar + TaskTable + (optional Uploads)
 *    + (optional LogBox)" stack with subtly different markup that drifted
 *    over time. ProgressDock unifies the two so a layout / UX tweak
 *    (this round: move the dock from the bottom-of-screen drawer into
 *    the left sidebar so it stops covering the input column) lives in
 *    exactly one place.
 *
 * 2. The dock owns nothing stateful itself — heights, log visibility,
 *    upload statuses are still owned by the host (App.tsx /
 *    HistoryDetailModal). The component only composes presentation.
 *
 * 3. Slots:
 *    - `headerExtras`: rendered to the right of the "处理进度" title;
 *      home uses this to put the「✕ 取消批处理」action right next to
 *      the title because it's tightly coupled to the running batch.
 *    - `uploadsSlot`: HistoryDetailModal injects its <UploadsSection/>
 *      here so per-record uploads stay grouped with the per-record
 *      task table.
 *    - `logToggle` is a tiny convenience: pass `logs` + `logsVisible`
 *      + `onToggleLogs`; we render the toggle button + auto-mount
 *      <LogBox/> when expanded.
 *
 * 4. The dock does NOT render the resize handle. Its host decides
 *    where the splitter goes (home: sidebar internal splitter so the
 *    user can shrink the dock; modal: fixed flex-basis = no splitter).
 */
export interface ProgressDockProps {
  title: string;
  items: SniffedMedia[];
  progress: Record<string, TaskProgress>;
  onRetry?: (media: SniffedMedia) => void | Promise<void>;
  onForceAllow?: (media: SniffedMedia) => void | Promise<void>;
  onManualOptimize?: (media: SniffedMedia, p: TaskProgress) => void | Promise<void>;
  onCancelOne?: (media: SniffedMedia) => void | Promise<void>;
  onUploadOne?: (media: SniffedMedia, progress: TaskProgress) => void | Promise<void>;
  /** Buttons / status text rendered to the right of the dock title. */
  headerExtras?: React.ReactNode;
  /** Optional uploads strip (HistoryDetailModal). */
  uploadsSlot?: React.ReactNode;
  /** When set, dock renders 📋 日志(N) toggle + <LogBox /> when on. */
  logs?: string[];
  logsVisible?: boolean;
  onToggleLogs?: () => void;
  /** Tag the className root so hosts can target with extra CSS. */
  className?: string;
}

export const ProgressDock: React.FC<ProgressDockProps> = ({
  title,
  items,
  progress,
  onRetry,
  onForceAllow,
  onManualOptimize,
  onCancelOne,
  onUploadOne,
  headerExtras,
  uploadsSlot,
  logs,
  logsVisible,
  onToggleLogs,
  className,
}) => {
  const showLogToggle = Array.isArray(logs) && typeof onToggleLogs === 'function';
  const handleToggleLogs = useCallback(() => {
    if (onToggleLogs) onToggleLogs();
  }, [onToggleLogs]);
  return (
    <div
      className={
        'progress-dock' +
        (logsVisible ? '' : ' progress-dock-no-logs') +
        (className ? ` ${className}` : '')
      }
    >
      <div className="progress-dock-toolbar">
        <span className="progress-dock-title">{title}</span>
        {headerExtras}
        {showLogToggle ? (
          <button
            type="button"
            className="ghost"
            onClick={handleToggleLogs}
            aria-pressed={!!logsVisible}
            title={logsVisible ? '隐藏日志面板' : '展开日志面板'}
            style={{ marginLeft: 'auto' }}
          >
            📋 日志{logs && logs.length > 0 ? ` (${logs.length})` : ''}
            {logsVisible ? ' ▾' : ' ▸'}
          </button>
        ) : null}
      </div>
      <TaskTable
        items={items}
        progress={progress}
        onRetry={onRetry}
        onForceAllow={onForceAllow}
        onManualOptimize={onManualOptimize}
        onCancelOne={onCancelOne}
        onUploadOne={onUploadOne}
      />
      {uploadsSlot}
      {showLogToggle && logsVisible ? <LogBox lines={logs ?? []} /> : null}
    </div>
  );
};
