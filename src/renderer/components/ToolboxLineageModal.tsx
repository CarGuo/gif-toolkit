import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ToolboxKind, ToolboxParams } from '../../shared/types';
import type { LineageNode, UseToolboxLineageResult } from './useToolboxLineage';
import type { MediaInfo } from './ToolboxPanel';
import { LineageProgressRow } from './ToolboxLineageProgress';

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
 *
 * R-TB-CHAIN-V2.7 — error-handling: track `errored` via onError, fall
 * back to the panel-provided posterDataUrl, and finally to an explicit
 * "预览不可用" message so failures never look like a "黑屏 bug".
 *
 * R-COMPRESS-V1 #4 — When `trialPath` is set, FocusPreview renders the
 * trial-run output (a 0.5s tmp clip under `os.tmpdir()/giftk-trial-*`)
 * instead of the focus node's path. Parent owns trialPath lifecycle.
 */
function FocusPreview({
  path,
  posterDataUrl,
  trialPath
}: {
  path: string | null | undefined;
  posterDataUrl?: string | null;
  trialPath?: string | null;
}): JSX.Element {
  // Trial output (when present) takes precedence over focus path so
  // the user sees the would-be next-step output, not the input.
  const renderPath = trialPath || path || null;
  const kind = detectKind(renderPath);
  const url = renderPath ? pathToLocalUrl(renderPath) : '';
  const [errored, setErrored] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => { setErrored(false); }, [url]);
  // R-COMPRESS-V1 #4 follow-up — focus-change between video nodes
  // reuses the same <video> DOM element; setting `src` alone leaves
  // Chromium on the previous decoder. Explicitly call load()+play()
  // to restart playback. play() rejection is silenced — element is
  // muted+autoplay+playsInline so only transient decoder issues fail.
  useEffect(() => {
    if (kind !== 'video') return;
    const el = videoRef.current;
    if (!el) return;
    try {
      el.load();
      const promise = el.play();
      if (promise && typeof promise.catch === 'function') {
        promise.catch(() => { /* autoplay race — ignore */ });
      }
    } catch {
      /* DOM not ready / element gone — ignore */
    }
  }, [url, kind]);
  if (!url) {
    return <div className="tb-lineage-preview-empty" aria-hidden="true">🎞️</div>;
  }
  if (errored) {
    if (posterDataUrl) {
      return (
        <img
          key={`poster-${posterDataUrl.length}`}
          className="tb-lineage-preview-media"
          src={posterDataUrl}
          alt="预览静态首帧"
          loading="eager"
        />
      );
    }
    return (
      <div className="tb-lineage-preview-error" role="status">
        <div className="tb-lineage-preview-error-icon" aria-hidden="true">⚠️</div>
        <div className="tb-lineage-preview-error-text">预览不可用</div>
        <div className="tb-lineage-preview-error-hint">文件可能已被移动或删除</div>
      </div>
    );
  }
  if (kind === 'video') {
    return (
      <video
        // key={url} forces React to remount the <video> element when
        // the focus moves to a different file; combined with the
        // imperative load()+play() in the effect above this guarantees
        // the new src actually starts playing instead of staying paused
        // on the previous decoder's last frame.
        key={url}
        ref={videoRef}
        className="tb-lineage-preview-media"
        src={url}
        muted
        autoPlay
        loop
        playsInline
        preload="auto"
        onError={() => setErrored(true)}
      />
    );
  }
  // gif / webp / image — all served via <img>; animated formats loop
  // natively in the browser. The key={url} forces a fresh DOM node on
  // every focus change — this is the canonical workaround for the
  // Chromium quirk where reusing an <img> element to load the same or
  // a different GIF leaves the animation paused on the last decoded
  // frame (a behaviour we observed when the user navigates the lineage
  // breadcrumb and the current preview "freezes"). Remounting forces
  // the renderer to re-run the GIF decoder from frame 0 with full
  // animation enabled.
  return (
    <img
      key={url}
      className="tb-lineage-preview-media"
      src={url}
      alt=""
      loading="eager"
      onError={() => setErrored(true)}
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
  /** First-frame poster (data URL) for the focus path, if cached by the
   *  panel. Used as a fallback when the live giftk-local:// render
   *  fails (e.g. file moved). Optional — without it the FocusPreview
   *  falls through to an explicit "预览不可用" message. */
  focusPosterDataUrl?: string | null;
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
    focusPosterDataUrl,
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

  // R-COMPRESS-V1 #4 — Trial-run state.
  // `trialOutput` is the most recent { outputPath, tmpRoot } returned by
  // `window.giftk.toolbox.trialRun`. When non-null, FocusPreview swaps
  // its src to outputPath so the user sees the would-be next-step
  // result; tmpRoot is what we hand to `trialCleanup` on tear-down.
  const [trialOutput, setTrialOutput] = useState<{ outputPath: string; tmpRoot: string } | null>(null);
  const [trialRunning, setTrialRunning] = useState(false);
  const [trialError, setTrialError] = useState<string | null>(null);
  // Stable ref so cleanup paths can read the latest tmpRoot without
  // capturing it in stale closures.
  const trialOutputRef = useRef(trialOutput);
  useEffect(() => { trialOutputRef.current = trialOutput; }, [trialOutput]);

  // Best-effort tmp dir cleanup. Awaiting the IPC is intentionally
  // optional — the daily R-87 sweep reaps any leak whose prefix matches
  // `giftk-trial-` so we never block the UI on a slow disk.
  const cleanupTrial = useCallback((tmpRoot: string | null | undefined): void => {
    if (!tmpRoot) return;
    try {
      const w = window as unknown as {
        giftk?: { toolbox?: { trialCleanup?: (p: string) => Promise<unknown> } };
      };
      void w.giftk?.toolbox?.trialCleanup?.(tmpRoot);
    } catch {
      /* ignore — bridge may be missing in tests */
    }
  }, []);

  const handleTrial = useCallback(async (): Promise<void> => {
    if (!draftKind || !focus) return;
    if (trialRunning) return;
    if (cropBlocked) return;
    // Clear the previous trial artifact (if any) before launching a new
    // run so the user never accidentally sees stale output during the
    // network-of-IPC round trip.
    const prev = trialOutputRef.current;
    setTrialOutput(null);
    setTrialError(null);
    setTrialRunning(true);
    cleanupTrial(prev?.tmpRoot);
    try {
      const w = window as unknown as {
        giftk?: {
          toolbox?: {
            trialRun?: (req: {
              kind: ToolboxKind;
              params: ToolboxParams;
              inputPath: string;
            }) => Promise<{ ok: boolean; outputPath: string; tmpRoot: string }>;
          };
        };
      };
      const fn = w.giftk?.toolbox?.trialRun;
      if (!fn) throw new Error('trialRun bridge missing');
      const result = await fn({ kind: draftKind, params: draftParams, inputPath: focus.path });
      if (!result.ok || !result.outputPath || !result.tmpRoot) {
        throw new Error('trialRun: invalid response');
      }
      setTrialOutput({ outputPath: result.outputPath, tmpRoot: result.tmpRoot });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setTrialError(msg);
    } finally {
      setTrialRunning(false);
    }
  }, [draftKind, draftParams, focus, trialRunning, cropBlocked, cleanupTrial]);

  // Reset the trial preview whenever the focus node changes — the
  // existing artifact was produced from a different input and would
  // mislead the user.
  useEffect(() => {
    const prev = trialOutputRef.current;
    if (!prev) return;
    setTrialOutput(null);
    setTrialError(null);
    cleanupTrial(prev.tmpRoot);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPath, cleanupTrial]);

  // Modal close (open=false) and unmount: rm the lingering trial dir.
  useEffect(() => {
    if (open) return;
    const prev = trialOutputRef.current;
    if (!prev) return;
    setTrialOutput(null);
    setTrialError(null);
    cleanupTrial(prev.tmpRoot);
  }, [open, cleanupTrial]);
  useEffect(() => {
    return () => {
      const prev = trialOutputRef.current;
      if (prev) cleanupTrial(prev.tmpRoot);
    };
  }, [cleanupTrial]);

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
              <FocusPreview
                path={focusPath}
                posterDataUrl={focusPosterDataUrl}
                trialPath={trialOutput?.outputPath ?? null}
              />
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
            {trialError ? (
              <div className="tb-notice tb-notice-error" role="alert">试跑失败：{trialError}</div>
            ) : null}
          </aside>
        </div>

        {/* R-COMPRESS-V1 #4 follow-up — Progress row, full-width
            between modal-body and footer. Visible whenever a step is
            in flight; cleared automatically on done/failed/cancelled
            via the hook's currentProgress lifecycle. See
            ToolboxLineageProgress.tsx for the badge/bar/detail markup. */}
        {lineage.isRunning ? (
          <LineageProgressRow progress={lineage.currentProgress} />
        ) : null}

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
            {/* R-COMPRESS-V1 #4 — Trial-run button. Sits next to the
                primary "继续 →" so the user can sanity-check what the
                next step will produce on a 0.5s clip BEFORE committing
                the full pipeline (which can take seconds-to-minutes on
                large videos and pollutes history on retry). The button
                is disabled under the same conditions as primary run
                (no kind / lineage running / crop incomplete) plus its
                own `trialRunning` mutex. */}
            <button
              type="button"
              className="btn"
              onClick={() => { void handleTrial(); }}
              disabled={!draftKind || lineage.isRunning || cropBlocked || trialRunning}
              title="用当前参数处理前 0.5 秒，用于快速预览效果（不入历史）"
            >
              {trialRunning ? '试跑中…' : '试跑 0.5s'}
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
