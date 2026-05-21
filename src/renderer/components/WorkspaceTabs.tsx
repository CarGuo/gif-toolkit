/**
 * WorkspaceTabs — Chrome-style horizontal tab strip rendered immediately
 * below the title bar. Each tab represents one `Workspace` (one sniff
 * session) from useWorkspaces.
 *
 * Why a separate component?
 * -------------------------
 * Keeping the tab strip out of App.tsx means
 *   1. App.tsx (already 3000+ lines) doesn't grow,
 *   2. tabs can be unit-tested in isolation, and
 *   3. visual styling is contained behind a small surface.
 *
 * The component is intentionally PRESENTATIONAL: it doesn't talk to
 * useWorkspaces directly. App.tsx wires the actions in (`onSwitch`,
 * `onClose`, `onNewTab`) and is responsible for the close-confirm
 * dialog when a tab has inflight tasks. Doing the confirm here would
 * couple the component to window.confirm and make tests brittle.
 *
 * The "busy" indicator is rendered as a small pulsing dot inside the
 * tab; it's purely visual feedback, the close-confirm logic still
 * lives in App.tsx.
 */
import React from 'react';
import type { Workspace } from './useWorkspaces';
import { workspaceLabel } from './useWorkspaces';

interface WorkspaceTabsProps {
  workspaces: Workspace[];
  activeId: string;
  /** Returns true if the given workspace has inflight tasks. */
  isBusy: (w: Workspace) => boolean;
  onSwitch: (id: string) => void;
  /**
   * Called when user clicks the × on a tab. Caller is responsible for
   * confirming the close (e.g. window.confirm if isBusy).
   */
  onClose: (id: string) => void;
  /**
   * Optional: if provided, render a "+" button at the end of the tab
   * strip. Per product decision (2026-05-21), the home page no longer
   * passes this — workspaces are exclusively created by claimForSniff()
   * when the user hits the 嗅探 button. Closed workspaces remain
   * recoverable through 历史 panel. Tests / future surfaces may still
   * pass it; keeping the prop avoids a breaking API change.
   */
  onNewTab?: () => void;
}

export const WorkspaceTabs: React.FC<WorkspaceTabsProps> = ({
  workspaces,
  activeId,
  isBusy,
  onSwitch,
  onClose,
  onNewTab
}) => {
  return (
    <div className="ws-tabs" role="tablist" aria-label="工作区标签">
      <div className="ws-tabs-strip">
        {workspaces.map((w) => {
          const active = w.id === activeId;
          const busy = isBusy(w);
          const label = workspaceLabel(w);
          const fullTitle = w.result?.title || w.url || '新工作区';
          return (
            <div
              key={w.id}
              role="tab"
              aria-selected={active}
              className={`ws-tab${active ? ' active' : ''}${busy ? ' busy' : ''}`}
              title={fullTitle}
              onClick={() => {
                if (!active) onSwitch(w.id);
              }}
              onAuxClick={(e) => {
                // Middle-click closes, mirroring browser convention.
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(w.id);
                }
              }}
            >
              {busy ? (
                <span
                  className="ws-tab-busy-dot"
                  aria-label="处理中"
                  title="该工作区有任务进行中"
                />
              ) : null}
              <span className="ws-tab-label">{label}</span>
              {workspaces.length > 1 ? (
                <button
                  type="button"
                  className="ws-tab-close"
                  aria-label="关闭工作区"
                  title="关闭工作区"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(w.id);
                  }}
                >
                  ×
                </button>
              ) : null}
            </div>
          );
        })}
        {onNewTab ? (
          <button
            type="button"
            className="ws-tab-new"
            title="新建工作区"
            aria-label="新建工作区"
            onClick={onNewTab}
          >
            +
          </button>
        ) : null}
      </div>
    </div>
  );
};
