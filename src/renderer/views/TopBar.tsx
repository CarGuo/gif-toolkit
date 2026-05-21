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
  onPickDir: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  view, setView, reloadHistory, historyCount, uploadHistoryCount,
  outputDirLabel, onPickDir
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
        <button onClick={onPickDir}>{outputDirLabel}</button>
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
