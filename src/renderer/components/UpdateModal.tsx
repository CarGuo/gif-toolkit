/**
 * R-UPDATE — Update notification modal.
 *
 * Surfaces a single [UpdateCheckResult](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types/update.ts)
 * coming from the main-process [checkLatestRelease](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/updater.ts)
 * (either a manual "关于/更新" tap or the silent 5s startup probe).
 *
 * Three render branches keyed off the result shape:
 *
 *   1. **loading** — `result === null` while the IPC roundtrip is in
 *      flight on a manual recheck. Renders a tiny skeleton so the
 *      modal opens instantly instead of waiting for the network.
 *
 *   2. **error** — `result.error !== null`. Network blip, GitHub rate
 *      limit, or an unparseable response. We surface the raw error
 *      text (it's already user-facing) plus a "重新检查" button so
 *      the user can retry without dismissing the modal.
 *
 *   3. **info / hasUpdate** — `result.error === null`. Show current vs
 *      latest, the release name + publish date, and the changelog
 *      body in a scrollable region. The primary CTA is "下载最新版"
 *      (only enabled when `hasUpdate && htmlUrl`); when already on
 *      the latest version we render a friendly "已是最新版" empty
 *      state instead of hiding the modal — the user explicitly
 *      asked, they deserve confirmation.
 *
 * The modal reuses the existing `.modal-mask` / `.modal` / `.modal-header`
 * / `.modal-close` styles in [styles.css](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/styles.css#L1069-L1141)
 * so we don't fork yet another visual identity.
 *
 * Backdrop click closes (the modal is purely informational; nothing
 * destructive can be in flight while it's open). ESC also closes via
 * the document-level keydown listener.
 */
import React, { useCallback, useEffect } from 'react';
import type { UpdateCheckResult } from '../../shared/types';

interface Props {
  /** True when the modal is visible. Parent owns this flag. */
  open: boolean;
  /** Latest probe result. `null` means a recheck is in flight. */
  result: UpdateCheckResult | null;
  /** Whether a manual recheck is currently being awaited. */
  loading: boolean;
  /** User tapped "重新检查" — parent should re-issue the IPC call. */
  onRecheck: () => void;
  /** Close the modal. */
  onClose: () => void;
}

function formatPublishedAt(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function UpdateModal({ open, result, loading, onRecheck, onClose }: Props): JSX.Element | null {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const onDownload = useCallback(async (url: string) => {
    try {
      await window.giftk.updater.openExternal(url);
    } catch (e) {
      console.error('[UpdateModal] openExternal failed:', e);
    }
  }, []);

  if (!open) return null;

  return (
    <div
      className="modal-mask"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="检查更新"
    >
      <div className="modal" style={{ maxWidth: 560, width: '90%' }}>
        <div className="modal-header">
          <span className="badge gif" aria-hidden>更新</span>
          <span className="modal-title-text">检查更新</span>
          <span className="modal-header-spacer" />
          <span className="modal-esc-hint">ESC 关闭</span>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </div>

        <div className="modal-body" style={{ padding: 16 }}>
          {loading || !result ? (
            <div style={{ opacity: 0.8, lineHeight: 1.7 }}>
              正在向 GitHub 查询最新版本…
            </div>
          ) : result.error ? (
            <div>
              <div style={{ marginBottom: 8 }}>
                <strong>当前版本：</strong>v{result.current}
              </div>
              <div style={{
                color: '#e07a7a',
                background: 'rgba(224, 122, 122, 0.08)',
                padding: 12,
                borderRadius: 6,
                marginBottom: 12,
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}>
                检查失败：{result.error}
              </div>
              <div style={{ opacity: 0.7, fontSize: 12 }}>
                请确认网络可访问 api.github.com，或稍后再试。
              </div>
            </div>
          ) : (
            <div>
              <div style={{ marginBottom: 8 }}>
                <strong>当前版本：</strong>v{result.current}
              </div>
              <div style={{ marginBottom: 8 }}>
                <strong>最新版本：</strong>
                {result.latest ? `v${result.latest}` : '未知'}
                {result.hasUpdate ? (
                  <span style={{
                    marginLeft: 8,
                    color: '#5fb878',
                    fontWeight: 600,
                  }}>
                    有可用更新
                  </span>
                ) : (
                  <span style={{ marginLeft: 8, opacity: 0.7 }}>
                    （已是最新版）
                  </span>
                )}
              </div>
              {result.releaseName ? (
                <div style={{ marginBottom: 6, opacity: 0.85 }}>
                  <strong>发布：</strong>{result.releaseName}
                </div>
              ) : null}
              {result.publishedAt ? (
                <div style={{ marginBottom: 12, opacity: 0.7, fontSize: 12 }}>
                  发布时间：{formatPublishedAt(result.publishedAt)}
                  {result.cached ? '（缓存）' : ''}
                </div>
              ) : null}
              {result.body ? (
                <div style={{
                  background: 'rgba(255, 255, 255, 0.04)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: 6,
                  padding: 12,
                  maxHeight: 240,
                  overflowY: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontSize: 12,
                  lineHeight: 1.7,
                }}>
                  {result.body}
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div className="modal-footer" style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 8,
          padding: '12px 16px',
          borderTop: '1px solid rgba(255, 255, 255, 0.08)',
        }}>
          <button type="button" onClick={onRecheck} disabled={loading}>
            {loading ? '检查中…' : '重新检查'}
          </button>
          {result && result.hasUpdate && result.htmlUrl ? (
            <button
              type="button"
              className="primary"
              onClick={() => onDownload(result.htmlUrl as string)}
            >
              下载最新版
            </button>
          ) : null}
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
