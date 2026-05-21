import React from 'react';
import type { ProcessOptions } from '../../shared/types';
import { OptionsForm } from '../components/OptionsForm';

/**
 * OptionsSection — Step 10 阶段 5 抽出（HomeView 左下「处理参数」区段）。
 *
 * 整段对应原 [App.tsx](../App.tsx) L1261-L1300:
 *   - <h2>处理参数</h2>
 *   - <OptionsForm />（fps / maxWidth / maxBytes / colors / 高级开关）
 *   - 嗅探取消 + system-chrome 完成嗅探 + lastBatchDir 子目录提示
 *
 * R-50 后这块不再渲染主 Start 按钮 — 那个迁移到 [StartBatchFab.tsx](./StartBatchFab.tsx)。
 *
 * 抽离原则：byte-equivalent — class 名、内联 style、aria 字段、注释
 * 全部 1:1 保留，避免回归测试漂移。
 */
export interface OptionsSectionProps {
  options: ProcessOptions;
  setOptions: (o: ProcessOptions) => void;
  sniffing: boolean;
  lastBatchDir: string | null;
  activeSniffMode: 'embed' | 'system-chrome' | 'ytdlp-direct' | 'offline' | null;
  onCancel: () => void | Promise<void>;
  onFinalizeSystemChromeSniff: () => void | Promise<void>;
}

export const OptionsSection: React.FC<OptionsSectionProps> = ({
  options,
  setOptions,
  sniffing,
  lastBatchDir,
  activeSniffMode,
  onCancel,
  onFinalizeSystemChromeSniff
}) => {
  return (
    <div className="section fixed left-bottom section-workspace-options" data-scope="workspace">
      <h2>
        处理参数
        <span className="section-scope-chip" aria-label="此区域跟随当前工作区">当前工作区</span>
      </h2>
      <OptionsForm value={options} onChange={setOptions} />
      {/* R-50 — 旧的内嵌「▶ 开始批处理 / ▶ 追加排队」按钮已迁移到
          位于视口右下角的悬浮 FAB(见下方 .fab-start-batch)。FAB
          完整继承了原按钮的所有判断逻辑:idle vs running、
          processable.length vs appendable.length、disabled 条件、
          title 文案。这里只保留嗅探取消入口与「已输出到子目录」
          提示,因为它们与批处理按钮无关。 */}
      {(sniffing || lastBatchDir) ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          {sniffing ? (
            <button onClick={onCancel} title="取消嗅探">取消嗅探</button>
          ) : null}
          {/* R-55 Fix #2 — Always-visible escape hatch for the
              real-Chrome path. The user can hit this even before
              the 60% banner shows up if they navigate quickly,
              and we still get the captured media because the
              finalize signal runs the synchronous DOM scan
              before tearing down. We deliberately do NOT gate
              this on percent >= 60 to keep the affordance
              discoverable. */}
          {sniffing && activeSniffMode === 'system-chrome' ? (
            <button
              className="primary"
              onClick={onFinalizeSystemChromeSniff}
              title="立即结束嗅探并返回到目前已抓到的媒体(无需关闭 Chrome 整个进程)"
              style={{ background: '#2aaa77', color: '#fff' }}
            >
              ✓ 完成嗅探
            </button>
          ) : null}
          {lastBatchDir ? (
            <span style={{ color: 'var(--muted)', fontSize: 11, marginLeft: 'auto' }}>
              已输出到子目录
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
