import React, { useCallback } from 'react';
import type { SniffedMedia, TaskProgress } from '../../shared/types';
import { TaskTable } from './TaskTable';

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
      {showLogToggle && logsVisible ? (
        <LogOverlay
          lines={logs ?? []}
          onClose={handleToggleLogs}
        />
      ) : null}
    </div>
  );
};

/**
 * R-X — Floating log viewer.
 *
 * Previously the LogBox was rendered INLINE underneath the task table.
 * That meant turning logs on (especially during heavy ytdlp probes
 * where 10+ lines stream in fast) squeezed every other dock element.
 * Users complained the input column / media grid got pushed offscreen.
 *
 * This overlay is anchored to the viewport via `position: fixed`,
 * sits above all other panels, supports ESC to close, and never
 * touches the dock's own height. The toggle button in the toolbar
 * still owns open/close state — we just stopped letting the logs
 * eat the dock's flex-basis.
 */
interface LogOverlayProps {
  lines: string[];
  onClose: () => void;
}

const LogOverlay: React.FC<LogOverlayProps> = ({ lines, onClose }) => {
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const followRef = React.useRef<boolean>(true);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (followRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    followRef.current = distance < 50;
  };

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
    } catch {
      /* clipboard may be unavailable in some contexts; ignore */
    }
  }, [lines]);

  /**
   * Trigger a browser download of the in-memory lines array. We
   * intentionally don't go through the filesystem IPC: the home
   * dock log is just a renderer-side LogStream string buffer (no
   * sessionId binding, unlike the history-detail SessionLogPanel).
   * `.log` keeps the raw text + a tiny header with timestamp + total
   * count so an external triage tool can grep it. `.json` wraps the
   * same lines plus a generation timestamp, which is what we'll
   * eventually mirror to a session-bound shape once ProgressDock is
   * threaded with a sessionId.
   */
  const onDownload = useCallback(
    (kind: 'log' | 'json') => {
      const ts = new Date();
      const stamp = ts
        .toISOString()
        .replace(/[:.]/g, '-')
        .replace('T', '_')
        .slice(0, 19);
      let body: string;
      let mime: string;
      let ext: string;
      if (kind === 'json') {
        body = JSON.stringify(
          { exportedAt: ts.toISOString(), count: lines.length, lines },
          null,
          2
        );
        mime = 'application/json;charset=utf-8';
        ext = 'json';
      } else {
        const header = `# gif-toolkit log\n# exportedAt=${ts.toISOString()}\n# count=${lines.length}\n`;
        body = header + lines.join('\n') + '\n';
        mime = 'text/plain;charset=utf-8';
        ext = 'log';
      }
      const blob = new Blob([body], { type: mime });
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = `gif-toolkit-${stamp}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke on next tick so Safari/Chromium have time to start
      // the download before the URL becomes invalid.
      setTimeout(() => URL.revokeObjectURL(href), 0);
    },
    [lines]
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="处理日志"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 'min(880px, 92vw)',
          height: 'min(560px, 80vh)',
          background: 'var(--panel, #1a1d22)',
          border: '1px solid var(--border, #2a2f37)',
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
            borderBottom: '1px solid var(--border, #2a2f37)'
          }}
        >
          <strong style={{ fontSize: 13 }}>📋 处理日志</strong>
          <span style={{ fontSize: 12, color: 'var(--muted, #9aa0aa)' }}>
            {lines.length > 0 ? `${lines.length} 行` : '暂无输出'}
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button
              type="button"
              className="ghost"
              onClick={() => void onCopy()}
              disabled={lines.length === 0}
              title="复制全部到剪贴板"
            >
              复制
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => onDownload('log')}
              disabled={lines.length === 0}
              title="导出为 .log 纯文本"
            >
              ⬇ .log
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => onDownload('json')}
              disabled={lines.length === 0}
              title="导出为 .json 结构化数据"
            >
              ⬇ .json
            </button>
            <button
              type="button"
              className="ghost"
              onClick={onClose}
              title="关闭日志(ESC)"
            >
              ✕
            </button>
          </div>
        </div>
        <div
          ref={scrollRef}
          onScroll={onScroll}
          style={{
            flex: 1,
            overflow: 'auto',
            padding: 10,
            fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
            fontSize: 11,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            background: 'var(--bg, #111418)',
            color: 'var(--text, #ddd)'
          }}
        >
          {lines.length === 0 ? '日志输出 …' : lines.join('\n')}
        </div>
      </div>
    </div>
  );
};
