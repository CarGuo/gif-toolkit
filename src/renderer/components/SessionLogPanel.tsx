/**
 * Session log panel — extracted from HistoryDetailModal as a stand-
 * alone, reusable component (R-TB-LOG-V1.1).
 *
 * Renders the per-session operation trail (sniff → process → upload →
 * toolbox) pulled from the SQLite-backed `session_logs` family. The
 * panel is passive (no mutation IPC of its own beyond export); the
 * user can:
 *   - Click "📋 查看日志" to open a floating modal with the full log.
 *   - 导出 .log (per-line text) or .json (structured array) via a
 *     native save dialog. The file is materialised inside the main
 *     process; renderer only flips state on success.
 *   - Reload to re-read the session_logs table after live ops.
 *
 * Empty state: when `sessionId` is missing (legacy records pre-log
 * feature, or a toolbox chain that has not yet run) we still render
 * the trigger button but disable it — that surfaces the affordance
 * without breaking the layout.
 *
 * Reused by:
 *   - HistoryDetailModal (sniff/process/upload sessions)
 *   - ToolboxLineageModal (toolbox chain sessions, `tb:${chainId}`)
 */
import React, { useCallback, useEffect, useState } from 'react';
import type { SessionLogEntry } from '../../shared/types';
import { useSessionLogs } from './useSessionLogs';

const LEVEL_COLORS: Record<SessionLogEntry['level'], string> = {
  debug: 'var(--muted)',
  info: 'var(--text)',
  warn: '#d39c1f',
  error: '#d34b4b'
};

export interface SessionLogPanelProps {
  sessionId: string;
  /** Suggested filename base (page title or url). Falls back to sid. */
  suggestedName?: string;
}

export const SessionLogPanel: React.FC<SessionLogPanelProps> = ({ sessionId, suggestedName }) => {
  const { snapshot, loading, error, reload, exportLog } = useSessionLogs(sessionId);
  // R-X — `expanded` now opens a floating modal instead of inflating the
  // dock height. Same state, different presentation.
  const [expanded, setExpanded] = useState<boolean>(false);
  const [exporting, setExporting] = useState<'log' | 'json' | null>(null);

  const onExport = useCallback(async (format: 'log' | 'json') => {
    setExporting(format);
    try {
      await exportLog(format, suggestedName);
    } finally {
      setExporting(null);
    }
  }, [exportLog, suggestedName]);

  // R-X — close on ESC when modal is open.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  const entryCount = snapshot?.entries.length ?? 0;
  const outcome = snapshot?.outcome;

  return (
    <>
      {/* R-X — Compact toolbar group designed to be injected via the
          ProgressDock `headerExtras` slot. We deliberately drop the
          surrounding card / border / mt — the dock toolbar already
          provides the chrome, and a second framed strip below it was
          the very thing that made the modal look unlike the home
          page. Only the primary "查看日志" button + a tiny count
          chip stay visible inline; export buttons live inside the
          modal pop-up below.

          The wrapper span carries `marginLeft: auto` so this group is
          pushed to the far right of the dock toolbar (matching the
          home view's "📋 日志 ▸" button position). Without it the
          group would sit immediately after the title because the
          history detail does not also pass `logs/onToggleLogs` (which
          would otherwise have its own marginLeft-auto button to the
          right of headerExtras). */}
      <span
        style={{
          marginLeft: 'auto',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8
        }}
        data-testid="session-log-panel"
      >
        <button
          type="button"
          className="ghost"
          onClick={() => setExpanded(true)}
          disabled={!sessionId}
          title="在弹窗中查看完整 session 日志"
          data-testid="session-log-open"
        >
          📋 查看日志{entryCount > 0 ? ` (${entryCount})` : ''}
        </button>
        {error ? (
          <span style={{ fontSize: 12, color: '#d34b4b' }}>
            读取失败:{error}
          </span>
        ) : outcome ? (
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            {outcome}
          </span>
        ) : null}
      </span>
      {expanded ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Session 日志详情"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setExpanded(false);
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999
          }}
          data-testid="session-log-modal"
        >
          <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              width: 'min(960px, 92vw)',
              height: 'min(640px, 82vh)',
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 20px 60px rgba(0,0,0,0.5)'
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 12px',
                borderBottom: '1px solid var(--border)'
              }}
            >
              <strong style={{ fontSize: 13 }}>📋 Session 日志</strong>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                {loading ? '加载中…' : `${entryCount} 条`}
                {outcome ? ` · ${outcome}` : ''}
              </span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className="ghost"
                  disabled={!!exporting || !sessionId}
                  onClick={() => void onExport('log')}
                  title="导出为 .log 纯文本"
                >
                  {exporting === 'log' ? '导出中…' : '⬇ .log'}
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={!!exporting || !sessionId}
                  onClick={() => void onExport('json')}
                  title="导出为 .json 结构化数据"
                >
                  {exporting === 'json' ? '导出中…' : '⬇ .json'}
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void reload()}
                  disabled={loading}
                  title="重新读取"
                >
                  ↻
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setExpanded(false)}
                  title="关闭(ESC)"
                >
                  ✕
                </button>
              </div>
            </div>
            <div
              style={{
                flex: 1,
                overflow: 'auto',
                padding: 10,
                fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
                fontSize: 12,
                lineHeight: 1.5,
                background: 'var(--bg)'
              }}
              data-testid="session-log-entries"
            >
              {snapshot && snapshot.entries.length > 0 ? (
                snapshot.entries.map((e) => (
                  <div
                    key={`${e.sessionId}-${e.seq}`}
                    style={{ color: LEVEL_COLORS[e.level], whiteSpace: 'pre-wrap' }}
                  >
                    [{new Date(e.ts).toISOString()}]
                    {' '}[{e.level.toUpperCase()}]
                    {' '}[{e.stage}{e.substep ? '/' + e.substep : ''}]
                    {' '}{e.message}
                  </div>
                ))
              ) : (
                <div style={{ color: 'var(--muted)' }}>(暂无日志)</div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
};
