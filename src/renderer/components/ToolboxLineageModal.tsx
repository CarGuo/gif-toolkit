import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ToolboxKind, ToolboxParams } from '../../shared/types';
import type { LineageNode, UseToolboxLineageResult } from './useToolboxLineage';
import type { MediaInfo } from './ToolboxPanel';

/**
 * R-TB-CHAIN-V2.6 — ToolboxLineageModal.
 *
 * Why a dedicated modal:
 *   Earlier (V2.2-V2.5) the lineage UI was rendered inline as
 *   `<section class="tb-lineage">` directly under the dropzone, which
 *   visually competed with the always-present batch queue + history
 *   list on the same panel. Per user feedback ("二次处理的链路做成
 *   独立弹出框流程，结果预览自动播放") we lift the entire lineage UI —
 *   breadcrumb, current-node preview (with autoplay), next-step chips,
 *   ParamForm, CropForm, footer (取消 / 继续 →) — into a Modal that
 *   overlays the panel. ToolboxPanel main area now stays in batch mode
 *   regardless of lineage state.
 *
 * Autoplay strategy:
 *   - .gif / .webp animated → <img src=giftk-local://...> (browser auto
 *     decodes & loops static-image animations).
 *   - .mp4 / .mov / .webm  → <video muted autoplay loop playsInline>
 *     (Chromium policy allows muted autoplay without user gesture).
 *   - other (.jpg / .png) → <img>, static.
 *
 *   We deliberately do NOT pull thumbnail dataUrl here — the modal has
 *   the screen real estate for a real-size preview and we already have
 *   the giftk-local:// custom protocol registered (R-56) for serving
 *   absolute paths through Electron with the same CSP allowance as
 *   offline-imported assets.
 *
 * Lifecycle:
 *   - `open` is driven by ToolboxPanel's `lineageDormant` flag plus
 *     `lineage.nodes.length > 0`. ESC and the 关闭 button BOTH exit the
 *     lineage (await cancel + setLineageDormant(true)).
 *   - The modal does NOT own lineage state — that still lives in the
 *     `useToolboxLineage` hook returned to the panel. The modal is a
 *     pure projection over (lineage, draftKind, draftParams) so the
 *     panel can remount it freely without losing any state.
 */

// Keep KIND_LABELS / accept-extension knowledge in one place. We
// intentionally do NOT import from ToolboxPanel.tsx to avoid a
// circular dependency — labels are simple enough to redeclare.
const KIND_LABELS: Record<ToolboxKind, string> = {
  'video-to-gif': 'Video → GIF',
  'video-to-webp': 'Video → WebP',
  'gif-resize': 'GIF Resize',
  'gif-optimize': 'GIF Optimize',
  trim: 'Trim',
  speed: 'Speed',
  reverse: 'Reverse',
  rotate: 'Rotate',
  crop: 'Crop',
  'gif-webp-convert': 'GIF ↔ WebP'
};

// Custom protocol mirror of `src/main/offlineImport.ts#toGiftkLocalUrl`.
// Renderer-side helper because the path-to-URL mapping is symmetric and
// adding a preload bridge for one shape would be overkill.
export function pathToLocalUrl(absPath: string): string {
  if (!absPath) return '';
  // Normalise path separators per platform; encode each segment so
  // characters like `?`, `#`, spaces, Chinese names survive the URL
  // round-trip cleanly. Win32: prepend `/` after the host.
  const sep = absPath.includes('\\') ? '\\' : '/';
  const parts = absPath.split(sep).map((seg) => encodeURIComponent(seg));
  const isWin = /^[a-zA-Z]:/.test(absPath);
  const joined = isWin ? '/' + parts.filter(Boolean).join('/') : parts.join('/');
  return `giftk-local://localhost${joined}`;
}

function detectKind(p: string | null | undefined): 'gif' | 'webp' | 'video' | 'image' | 'other' {
  if (!p) return 'other';
  const lower = p.toLowerCase();
  if (lower.endsWith('.gif')) return 'gif';
  if (lower.endsWith('.webp')) return 'webp';
  if (/\.(mp4|mov|webm|mkv|m4v)$/.test(lower)) return 'video';
  if (/\.(png|jpe?g|bmp)$/.test(lower)) return 'image';
  return 'other';
}

/**
 * Auto-playing preview of the current focus node.
 * GIF/animated WebP via <img>, video via muted autoplay loop.
 */
function FocusPreview({ path }: { path: string | null | undefined }): JSX.Element {
  const kind = detectKind(path);
  const url = path ? pathToLocalUrl(path) : '';
  if (!url) {
    return <div className="tb-lineage-preview-empty" aria-hidden="true">🎞️</div>;
  }
  if (kind === 'video') {
    return (
      <video
        className="tb-lineage-preview-media"
        src={url}
        muted
        autoPlay
        loop
        playsInline
        preload="auto"
      />
    );
  }
  // gif / webp / image — all served via <img>; animated formats loop
  // natively in the browser.
  return (
    <img
      className="tb-lineage-preview-media"
      src={url}
      alt=""
      loading="eager"
    />
  );
}

export interface ToolboxLineageModalProps {
  /** Whether the modal is currently visible. */
  open: boolean;
  /** Lineage hook return — read-only projection (we don't mutate). */
  lineage: UseToolboxLineageResult;
  /** Draft kind for the next step (controlled by the panel). */
  draftKind: ToolboxKind | null;
  /** Setter mirroring the panel's local state. */
  setDraftKind: (k: ToolboxKind | null) => void;
  /** Draft params for the next step (controlled by the panel). */
  draftParams: ToolboxParams;
  /** Setter mirroring the panel's local state. */
  setDraftParams: (p: ToolboxParams | ((prev: ToolboxParams) => ToolboxParams)) => void;
  /** Probed media info for the current focus path, if any. */
  focusMedia: MediaInfo | null;
  /** ParamForm renderer injected by the panel (lives in ToolboxPanel.tsx). */
  renderParamForm: (args: {
    kind: ToolboxKind;
    params: ToolboxParams;
    setParams: (p: ToolboxParams | ((prev: ToolboxParams) => ToolboxParams)) => void;
    mediaInfo: MediaInfo | null;
  }) => JSX.Element;
  /** CropForm renderer (also lives in ToolboxPanel.tsx). */
  renderCropForm: (args: {
    params: ToolboxParams;
    setParams: (p: ToolboxParams | ((prev: ToolboxParams) => ToolboxParams)) => void;
    mediaInfo: MediaInfo | null;
  }) => JSX.Element;
  /** Click a breadcrumb segment → focus that node. */
  onFocusNode: (nodeId: string) => void;
  /** Click 关闭 / ESC / mask → exit lineage (with cancel-await). */
  onClose: () => void;
  /** Run the next step with current draft kind+params. */
  onRunStep: () => void | Promise<void>;
  /** Reveal the focus node's file in OS file manager. */
  onRevealFocus: (p: string) => void;
}

/**
 * Lineage modal. Visible only when `open` is true.
 * Renders the entire chain UI: breadcrumb, current preview (autoplay),
 * next-step chips, param form, crop form, footer (取消/继续 →).
 */
export function ToolboxLineageModal(props: ToolboxLineageModalProps): JSX.Element | null {
  const {
    open,
    lineage,
    draftKind,
    setDraftKind,
    draftParams,
    setDraftParams,
    focusMedia,
    renderParamForm,
    renderCropForm,
    onFocusNode,
    onClose,
    onRunStep,
    onRevealFocus
  } = props;

  // ESC closes; identical pattern to PreviewModal's keydown handler.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Click on the dimmed background closes the modal; clicking inside
  // the modal box does NOT bubble (handled via stopPropagation below).
  const onMaskClick = useCallback(() => { onClose(); }, [onClose]);

  const focus = lineage.focus;
  const focusPath = focus?.path ?? null;
  const focusName = useMemo(() => {
    if (!focusPath) return '';
    return /[^/\\]+$/.exec(focusPath)?.[0] ?? focusPath;
  }, [focusPath]);

  const cropBlocked = draftKind === 'crop' && (
    typeof draftParams.cropX !== 'number' ||
    typeof draftParams.cropY !== 'number' ||
    typeof draftParams.cropW !== 'number' ||
    typeof draftParams.cropH !== 'number' ||
    (draftParams.cropW ?? 0) <= 0 ||
    (draftParams.cropH ?? 0) <= 0
  );

  const handleSelectKind = useCallback((k: ToolboxKind) => {
    setDraftKind(k);
  }, [setDraftKind]);

  const [running, setRunning] = useState(false);
  const handleRun = useCallback(async () => {
    if (running) return;
    setRunning(true);
    try {
      await onRunStep();
    } finally {
      setRunning(false);
    }
  }, [onRunStep, running]);

  if (!open) return null;

  return (
    <div className="modal-mask tb-lineage-mask" onClick={onMaskClick}>
      <div
        className="modal tb-lineage-modal"
        role="dialog"
        aria-modal="true"
        aria-label="链式处理"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span className="badge accent">链式处理</span>
          <span className="modal-title-text" title={focusPath ?? ''}>{focusName || '—'}</span>
          <span className="modal-esc-hint">ESC</span>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="关闭"
          >×</button>
        </div>

        <div className="modal-body tb-lineage-body">
          <section className="tb-lineage-stage">
            <ol className="tb-lineage-breadcrumb" aria-label="链路面包屑">
              {lineage.nodes.map((n: LineageNode, i: number) => {
                const isFocus = i === lineage.focusIndex;
                const isAfterFocus = i > lineage.focusIndex;
                const label = n.kind ? (KIND_LABELS[n.kind] ?? n.kind) : '原始输入';
                return (
                  <li
                    key={n.nodeId}
                    className={`tb-lineage-crumb${isFocus ? ' is-focus' : ''}${isAfterFocus ? ' is-abandoned' : ''}`}
                  >
                    <button
                      type="button"
                      className="tb-lineage-crumb-btn"
                      onClick={() => onFocusNode(n.nodeId)}
                      title={n.path}
                      aria-current={isFocus ? 'step' : undefined}
                    >
                      {label}
                    </button>
                    {i < lineage.nodes.length - 1 ? (
                      <span className="tb-lineage-sep" aria-hidden="true">→</span>
                    ) : null}
                  </li>
                );
              })}
            </ol>

            <div className="tb-lineage-preview" aria-label="当前产物预览">
              <FocusPreview path={focusPath} />
            </div>

            {focus ? (
              <div className="tb-lineage-meta-row">
                <div className="tb-lineage-name" title={focusPath ?? ''}>{focusName}</div>
                <div className="tb-lineage-meta-line">
                  {(() => {
                    const parts: string[] = [];
                    if (focusMedia?.width && focusMedia?.height) parts.push(`${focusMedia.width}×${focusMedia.height}`);
                    if (focusMedia?.durationSec) parts.push(`${focusMedia.durationSec.toFixed(2)}s`);
                    return parts.join(' · ');
                  })()}
                </div>
                <button
                  type="button"
                  className="tb-link"
                  onClick={() => onRevealFocus(focus.path)}
                >
                  在文件管理器中显示
                </button>
              </div>
            ) : null}
          </section>

          <aside className="tb-lineage-side">
            <div className="tb-lineage-side-head">下一步</div>
            <div className="tb-lineage-chips" role="tablist" aria-label="下一步操作">
              {lineage.nextKindOptions.length === 0 ? (
                <span className="tb-muted">当前产物没有可用的后续工具(链路终点)</span>
              ) : null}
              {lineage.nextKindOptions.map((k) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={draftKind === k}
                  className={`tb-chip${draftKind === k ? ' is-active' : ''}`}
                  onClick={() => handleSelectKind(k)}
                  disabled={lineage.isRunning}
                >
                  {KIND_LABELS[k] ?? k}
                </button>
              ))}
            </div>

            {draftKind && draftKind !== 'crop' ? (
              <div className="tb-lineage-form">
                {renderParamForm({
                  kind: draftKind,
                  params: draftParams,
                  setParams: setDraftParams,
                  mediaInfo: focusMedia
                })}
              </div>
            ) : null}

            {draftKind === 'crop' && focus ? (
              <div className="tb-lineage-cropbox">
                {renderCropForm({
                  params: draftParams,
                  setParams: setDraftParams,
                  mediaInfo: focusMedia
                })}
              </div>
            ) : null}

            {lineage.error ? (
              <div className="tb-notice tb-notice-error" role="alert">{lineage.error}</div>
            ) : null}
          </aside>
        </div>

        <footer className="modal-footer tb-lineage-footer">
          <div className="modal-footer-left">
            <button
              type="button"
              className="tb-link"
              onClick={onClose}
            >
              退出链路
            </button>
          </div>
          <div className="modal-footer-right">
            <button
              type="button"
              className="btn"
              onClick={() => { void lineage.cancel(); }}
              disabled={!lineage.isRunning}
            >
              取消
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => { void handleRun(); }}
              disabled={!draftKind || lineage.isRunning || cropBlocked}
            >
              {lineage.isRunning ? '处理中…' : '继续 →'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

export default ToolboxLineageModal;
