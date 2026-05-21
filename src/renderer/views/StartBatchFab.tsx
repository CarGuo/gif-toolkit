import React from 'react';
import type { SniffedMedia } from '../../shared/types';

/**
 * StartBatchFab — Step 10 阶段 5 抽出（HomeView 右下角悬浮 Start 按钮）。
 *
 * 整段对应原 [App.tsx](../App.tsx) L1356-L1398 的 IIFE。R-50 把旧的
 * 内嵌「▶ 开始批处理 / ▶ 追加排队」按钮迁出到这个位于视口右下角
 * 的 position:fixed FAB，原因：底部 ProgressDock + 进度区会盖住
 * 内嵌按钮，FAB 永远可点。
 *
 * 完整继承原按钮的所有判断逻辑:
 *   - idle vs running 走 isHomeBatchProcessing
 *   - 计数源: idle = processable.length / running = appendable.length
 *   - idleSuffix: 选中数 ≠ processable 时附加 ` / 共选 M`
 *   - disabled: count === 0
 *   - title 文案完全 1:1 对齐
 *
 * 抽离原则：byte-equivalent — 类名、aria-label、disabled 计算、文案
 * 全部 1:1 保留，确保 SUITE E / I / J / L / M / N / O 等所有依赖
 * `.fab-start-batch` 选择器的 e2e 测试零漂移。
 */
export interface StartBatchFabProps {
  isHomeBatchProcessing: boolean;
  processable: SniffedMedia[];
  appendable: SniffedMedia[];
  selected: Set<string>;
  onStart: () => void | Promise<void>;
  onAppend: () => void | Promise<void>;
}

export const StartBatchFab: React.FC<StartBatchFabProps> = ({
  isHomeBatchProcessing,
  processable,
  appendable,
  selected,
  onStart,
  onAppend
}) => {
  const running = isHomeBatchProcessing;
  const count = running ? appendable.length : processable.length;
  const disabled = count === 0;
  const idleSuffix =
    !running && selected.size !== processable.length
      ? ` / 共选 ${selected.size}`
      : '';
  const label = running
    ? `▶ 追加排队 (${count})`
    : `▶ 开始批处理 (${count}${idleSuffix})`;
  const title = running
    ? (count === 0
        ? '当前没有新选中的可处理项可追加;勾选更多卡片后会启用'
        : `把 ${count} 个新选中的任务追加到当前队列`)
    : (count === 0
        ? '请先在右侧勾选 video / gif'
        : '开始批处理');
  return (
    <button
      type="button"
      className="fab-start-batch"
      onClick={running ? onAppend : onStart}
      disabled={disabled}
      title={title}
      aria-label={label}
    >
      {label}
    </button>
  );
};
