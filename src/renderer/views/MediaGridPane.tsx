import React from 'react';
import type { SniffedMedia, TaskProgress } from '../../shared/types';
import { MediaGrid } from '../components/MediaGrid';
import { ProgressDock } from '../components/ProgressDock';

/**
 * MediaGridPane — Step 10 阶段 4 抽出（HomeView 右半屏）。
 *
 * 整段对应原 App.tsx L1305-L1407 `<div className="right">…</div>` 区块：
 *   - grid-pane（已选媒体网格 + 标题栏 4 个动作按钮：打开目录 / ⚡强制
 *     全部失败 / ⚡上传所有产物 / 📤上传设置）
 *   - right-resize-handle（拖拽 + 双击重置 --bottom-h）
 *   - ProgressDock（处理进度 / 日志切换 / cancel 批处理）
 *
 * 抽离原则：byte-equivalent — class 名、内联 style、aria 字段、注释、
 * 间距全部 1:1 保留，避免回归测试漂移。所有数据 / 行为通过 props
 * 注入，无内部 state。这与 [SniffSection.tsx](./SniffSection.tsx) 同款。
 */
export interface MediaGridPaneProps {
  // 网格数据
  items: SniffedMedia[];
  selected: Set<string>;
  toggleSelected: (id: string) => void;
  openCard: (id: string) => void;
  // 单卡处理
  onProcessOneById: (id: string) => void;
  isProcessingOne: (id: string) => boolean;
  // embed 解析重试
  onResolveEmbedById: (id: string) => void;
  isResolving: (id: string) => boolean;
  resolveErrorMap: Record<string, string>;
  // 标题栏：打开目录
  onOpenOutput: () => void | Promise<void>;
  lastBatchDir: string | null;
  outputDir: string | null;
  // 标题栏：⚡ 强制全部失败项
  onForceAllowAllFailed: () => void | Promise<void>;
  forceAllowFailedCount: number;
  forceAllowAllTitle: string;
  // 标题栏：⚡ 上传所有产物
  onUploadAll: () => void | Promise<void>;
  uploadAllReady: boolean;
  uploadAllTitle: string;
  uploadAllStats: { doneCount: number; total: number };
  // 标题栏：📤 上传设置
  setUploadSettingsOpen: (open: boolean) => void;
  // resize handle
  onBottomResizeStart: (e: React.MouseEvent<HTMLDivElement>) => void;
  resetBottomH: () => void;
  // ProgressDock
  isHomeBatchProcessing: boolean;
  progress: Record<string, TaskProgress>;
  onProcessOne: (m: SniffedMedia) => void | Promise<void>;
  forceAllowOne: (m: SniffedMedia) => void | Promise<void>;
  onManualOptimize: (m: SniffedMedia, p: TaskProgress) => void | Promise<void>;
  onCancelOne: (m: SniffedMedia) => void | Promise<void>;
  onUploadOne: (m: SniffedMedia, p: TaskProgress) => void | Promise<void>;
  logs: string[];
  logsVisible: boolean;
  toggleLogs: () => void;
  onCancel: () => void | Promise<void>;
  /**
   * Optional workspace tabs strip rendered inside .right at the very
   * top, above .grid-pane. Per 2026-05-21 product decision, the tabs
   * live with "已选媒体 + 处理进度" so switching tabs visibly swaps
   * the entire right column (selected media + per-task progress)
   * together. The left column (sniff/options) follows via activeWs
   * data binding. Pass null/undefined to render nothing here.
   */
  tabs?: React.ReactNode;
}

export const MediaGridPane: React.FC<MediaGridPaneProps> = ({
  items,
  selected,
  toggleSelected,
  openCard,
  onProcessOneById,
  isProcessingOne,
  onResolveEmbedById,
  isResolving,
  resolveErrorMap,
  onOpenOutput,
  lastBatchDir,
  outputDir,
  onForceAllowAllFailed,
  forceAllowFailedCount,
  forceAllowAllTitle,
  onUploadAll,
  uploadAllReady,
  uploadAllTitle,
  uploadAllStats,
  setUploadSettingsOpen,
  onBottomResizeStart,
  resetBottomH,
  isHomeBatchProcessing,
  progress,
  onProcessOne,
  forceAllowOne,
  onManualOptimize,
  onCancelOne,
  onUploadOne,
  logs,
  logsVisible,
  toggleLogs,
  onCancel,
  tabs
}) => {
  return (
    <div className="right">
      {tabs}
      <div className="grid-pane">
        <div className="grid-header">
          <h2>已选媒体 {items.length > 0 ? `(${items.length})` : ''}</h2>
          <span className="grid-tip">单击卡片打开大图预览 · 勾选后参与批处理</span>
          {/* R-30 #1 — moved here from the title bar. Disabled
              until at least one batch (or a manually-picked
              outputDir) exists, so the affordance is honest. */}
          <button
            type="button"
            className="grid-open-dir"
            onClick={onOpenOutput}
            disabled={!(lastBatchDir || outputDir)}
            title={
              lastBatchDir
                ? '在文件管理器中打开本次批处理的输出子目录'
                : '尚未产出任何文件;先点击 ▶ 处理 / 全部处理 后再来'
            }
          >
            {lastBatchDir ? '打开本次目录' : '打开目录'}
          </button>
          {/* R-83 — 产物级批量动作,从底部 ProgressDock toolbar
              上移到这里。 ProgressDock 现在专注于「单条任务进度」,
              这三个按钮关心的是「全部输出已完成后干嘛」,放在媒体
              网格的标题栏更靠近用户的注意力轨迹。 */}
          <button
            className="ghost grid-force-all"
            onClick={() => void onForceAllowAllFailed()}
            data-tooltip={forceAllowAllTitle}
            disabled={forceAllowFailedCount === 0}
            aria-disabled={forceAllowFailedCount === 0}
            style={{ marginLeft: 8 }}
          >
            ⚠️ 强制全部失败项{forceAllowFailedCount > 0 ? ` (${forceAllowFailedCount})` : ''}
          </button>
          <button
            className="ghost grid-upload-all"
            onClick={() => void onUploadAll()}
            title={uploadAllTitle}
            disabled={!uploadAllReady}
            aria-disabled={!uploadAllReady}
            style={{ marginLeft: 8 }}
          >
            ⚡ 上传所有产物{items.length > 0 ? ` (${uploadAllStats.doneCount}/${uploadAllStats.total})` : ''}
          </button>
          <button
            className="ghost"
            onClick={() => setUploadSettingsOpen(true)}
            title="配置图床后端(自定义 Web / GitHub / 七牛 / 阿里云 OSS / 腾讯 COS)"
            style={{ marginLeft: 4 }}
          >
            📤 上传设置
          </button>
        </div>
        <div className="grid-scroll">
          <MediaGrid
            items={items}
            selected={selected}
            onToggle={toggleSelected}
            onOpen={openCard}
            onProcessOne={onProcessOneById}
            isProcessing={isProcessingOne}
            onRetryResolve={onResolveEmbedById}
            isResolving={isResolving}
            resolveErrorMap={resolveErrorMap}
          />
        </div>
      </div>
      {/* Right-bottom processing region. The handle keeps the old
          persisted --bottom-h sizing behavior, but the dock no
          longer sits inside the operation sidebar. */}
      <div
        className="right-resize-handle"
        onMouseDown={onBottomResizeStart}
        onDoubleClick={resetBottomH}
        title="拖动调节高度,双击恢复默认"
        role="separator"
        aria-orientation="horizontal"
      />
      <ProgressDock
        title={isHomeBatchProcessing ? '处理进度(运行中)' : '处理进度'}
        items={items}
        progress={progress}
        onRetry={(m) => onProcessOne(m)}
        onForceAllow={forceAllowOne}
        onManualOptimize={onManualOptimize}
        onCancelOne={onCancelOne}
        onUploadOne={onUploadOne}
        logs={logs}
        logsVisible={logsVisible}
        onToggleLogs={toggleLogs}
        headerExtras={isHomeBatchProcessing ? (
          <button
            className="ghost"
            onClick={onCancel}
            title="取消当前批处理与未开始的排队任务"
            style={{ marginLeft: 8 }}
          >
            ✕ 取消批处理
          </button>
        ) : null}
      />
    </div>
  );
};
