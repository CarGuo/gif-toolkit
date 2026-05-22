/**
 * R-70 (Step 10 phase 2) — TopBar component lifted out of App.tsx.
 *
 * The "titlebar" used to be ~70 lines of inline JSX in App.tsx (brand
 * heading + 4 view-switch tabs + output-dir picker). It owns no state
 * of its own — everything is wired through props back to App-level
 * setters. Lifting it gives the App composition root one less concrete
 * piece of layout to think about.
 *
 * The visual shell (className, structure) is reproduced 1:1 so styles
 * (titlebar / brand / tabs / spacer / actions) keep applying without
 * any CSS migration. The "open output dir" button is a typed prop
 * because shortDir is App-local; we forward the *already shortened*
 * label here.
 */
import React from 'react';

export type AppView = 'home' | 'history' | 'toolbox' | 'uploads';

export interface TopBarProps {
  view: AppView;
  setView: (v: AppView) => void;
  reloadHistory: () => void;
  historyCount: number;
  uploadHistoryCount: number;
  outputDirLabel: string;
  /* R-WS-90 P5e — full path moved off the visible label (now just
     "根目录") and into a hover tooltip; carry it as a typed prop so
     the picker button can still expose the absolute path on demand. */
  outputDirTitle?: string;
  onPickDir: () => void;
  /**
   * R-WS-90 P5i — 「根目录」按钮过去 click 即弹文件选择器,与历史里
   * 行级「打开目录」语义不一致(用户期望:点根目录 = 直接在资源管理
   * 器里打开当前已设的根目录,而不是再选一次)。这里拆成两个按钮:
   *   - onOpenCurrentDir:在系统文件管理器里打开当前 baseOutputDir
   *     (仅当 baseOutputDir 已设时启用)
   *   - onPickDir:小一号的修改按钮,弹文件选择器换目录
   * 当 baseOutputDir 尚未设置时(空文案 "选择输出目录")依旧只显示
   * 一个按钮,click 即弹选择器。
   */
  onOpenCurrentDir?: () => void;
  hasBaseOutputDir?: boolean;
  /**
   * R-UPDATE — 「关于/更新」按钮回调。点击后由 App 层负责调
   * `window.giftk.updater.checkForUpdates(true)` 并打开 UpdateModal。
   * 设计上把按钮放在 `.actions` 最左侧（root-dir 按钮之前），托盘
   * 菜单 / About 面板各走自己的入口；这里是主窗口可见入口。
   */
  onCheckForUpdates?: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  view, setView, reloadHistory, historyCount, uploadHistoryCount,
  outputDirLabel, outputDirTitle, onPickDir,
  onOpenCurrentDir, hasBaseOutputDir, onCheckForUpdates
}) => {
  return (
    <div className="titlebar">
      <div className="brand" aria-label="Gif Toolkit">
        <span className="brand-logo" aria-hidden="true">
          <img src="./icon.png" alt="" />
        </span>
        <h1>Gif Toolkit · 网页媒体抓取 · 转换 · 上传</h1>
      </div>
      <div className="tabs">
        <button
          type="button"
          className={`tab-btn ${view === 'home' ? 'active' : ''}`}
          onClick={() => setView('home')}
          aria-pressed={view === 'home'}
        >
          主页
        </button>
        <button
          type="button"
          className={`tab-btn ${view === 'history' ? 'active' : ''}`}
          onClick={() => {
            // R-34 — every click on the history tab forces a fresh
            // resync from localStorage. This handles two cases:
            //   1. in-flight progress that the 250ms debounce in
            //      useHistory hasn't yet flushed — without this we
            //      could show counts that are 1-2 emits behind the
            //      home view's TaskTable;
            //   2. external mutations (another renderer / window).
            // Calling reload unconditionally (not gated on
            // view !== 'history') makes "click again to refresh" a
            // first-class affordance: if the user wants to re-poll
            // the latest data while already on the history tab they
            // just click 历史 again.
            reloadHistory();
            setView('history');
          }}
          aria-pressed={view === 'history'}
        >
          历史 {historyCount > 0 ? `(${historyCount})` : ''}
        </button>
        <button
          type="button"
          className={`tab-btn ${view === 'toolbox' ? 'active' : ''}`}
          onClick={() => setView('toolbox')}
          aria-pressed={view === 'toolbox'}
        >
          工具箱
        </button>
        <button
          type="button"
          className={`tab-btn ${view === 'uploads' ? 'active' : ''}`}
          onClick={() => setView('uploads')}
          aria-pressed={view === 'uploads'}
          title="查看上传到图床的历史"
        >
          上传历史 {uploadHistoryCount > 0 ? `(${uploadHistoryCount})` : ''}
        </button>
      </div>
      <div className="spacer" />
      <div className="actions">
        {onCheckForUpdates ? (
          <button
            type="button"
            className="ghost"
            onClick={onCheckForUpdates}
            title="检查更新"
            aria-label="检查更新"
            style={{ padding: '0 10px' }}
          >
            ⬆ 关于/更新
          </button>
        ) : null}
        {hasBaseOutputDir && onOpenCurrentDir ? (
          <>
            {/* R-WS-90 P5i — 主按钮 = 在文件管理器里打开当前根目录;
                修改按钮拆出来变成右侧小铅笔 chip,避免误触换目录。 */}
            <button
              type="button"
              onClick={onOpenCurrentDir}
              title={outputDirTitle}
              aria-label={`打开 ${outputDirLabel}`}
            >
              📂 {outputDirLabel}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={onPickDir}
              title="修改输出根目录"
              aria-label="修改输出根目录"
              data-tooltip="修改输出根目录"
              style={{ padding: '0 8px' }}
            >
              ✎
            </button>
          </>
        ) : (
          <button onClick={onPickDir} title={outputDirTitle} aria-label={outputDirTitle ?? outputDirLabel}>
            {outputDirLabel}
          </button>
        )}
        {/* R-30 #1 — the per-batch "打开目录" button used to live
            here in the global title bar. With the history tab in
            place that placement was confusing (looked like a
            global "open the active history's dir" while it was
            actually only ever the latest *home* batch). It now
            moves into the home view's grid-header below so it's
            co-located with the media list it produced; history
            records each carry their own per-row 打开目录. */}
      </div>
    </div>
  );
};
