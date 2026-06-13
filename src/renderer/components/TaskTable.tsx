import React, { useState } from 'react';
import type { SniffedMedia, TaskProgress } from '../../shared/types';
import { Thumb } from './MediaGrid';

interface Props {
  items: SniffedMedia[];
  progress: Record<string, TaskProgress>;
  /**
   * Optional retry hook. When supplied, failed / cancelled tasks render a
   * "重试" button that re-enqueues the same media via the host's processing
   * pipeline. Kept optional so the component still works in read-only views
   * (e.g. tests, screenshots) where retry is meaningless.
   */
  onRetry?: (media: SniffedMedia) => void | Promise<void>;
  /**
   * R-26 — when supplied, failed tasks whose `errorCode` flags a SPEC
   * violation (currently only `ASPECT_RATIO_OUT_OF_RANGE`) render a
   * "强制允许" button instead of "重试". Re-enqueues the same media with
   * `forceAllowSmallSide=true` for THIS task only. Distinct from onRetry
   * because the action is semantically different — runtime failures want a
   * blind retry, spec failures want an explicit override.
   */
  onForceAllow?: (media: SniffedMedia) => void | Promise<void>;
  /**
   * R-33 — when supplied, "未达标" rows (status==='done' AND
   * (warning includes 'exceeds hard target' OR 'did not reach soft target'))
   * render a "手动优化" button. The host opens ManualOptimizeModal and
   * dispatches a re-optimize task using the existing output gif as input.
   * Skipped when not provided so the button stays out of read-only views.
   */
  onManualOptimize?: (media: SniffedMedia, progress: TaskProgress) => void;
  /**
   * R-43.2 — per-row cancellation. When supplied, every non-terminal
   * task (pending / probing / converting / compressing / etc.) gets
   * a "✕" button on the right that aborts JUST that task without
   * touching its siblings. Optional so read-only views (history,
   * tests, screenshots) keep working.
   */
  onCancelOne?: (media: SniffedMedia) => void | Promise<void>;
  /**
   * R-45 — per-row upload. When supplied, "done" rows that have at
   * least one output path render an "📤 上传" button which kicks off
   * an upload job for THAT output via the active backend.
   */
  onUploadOne?: (media: SniffedMedia, progress: TaskProgress) => void | Promise<void>;
  /**
   * R-TB-OPEN-FROM-PROGRESS — per-row "open in toolbox". When supplied,
   * "done" rows that have at least one output path render a "🛠 工具箱"
   * button. Clicking it asks the host to switch to the Toolbox tab and
   * preload the produced file (typically the GIF) as a single-job queue
   * with a sensible default kind (e.g. gif-resize for *.gif). The host
   * is responsible for picking the kind and calling tb.applyPreset via
   * the existing pendingPreset bridge.
   */
  onOpenInToolbox?: (media: SniffedMedia, progress: TaskProgress) => void;
}

function fileName(u: string): string {
  try {
    return new URL(u).pathname.split('/').pop() || u;
  } catch {
    return u;
  }
}

function fmtTime(ms?: number): string {
  if (!ms || ms < 0) return '';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}

function describe(p: TaskProgress): string {
  const parts: string[] = [];
  if (p.substep) parts.push(p.substep);
  if (p.stepIndex && p.totalSteps) parts.push(`${p.stepIndex}/${p.totalSteps}`);
  if (p.totalSegments && p.segmentIndex) parts.push(`段 ${p.segmentIndex}/${p.totalSegments}`);
  if (p.elapsedMs && p.elapsedMs > 1000) parts.push(fmtTime(p.elapsedMs));
  return parts.join(' · ');
}

/**
 * R-33 — true when a "done" row's warning text indicates the compress loop
 * could not meet the user's target. Two phrases are emitted by processor.ts:
 *   - "exceeds hard target …"  (result.given === true)
 *   - "did not reach soft target …" (over softMaxBytes but at-or-below maxBytes)
 * Either case is a candidate for manual re-optimization.
 *
 * R-79 — the manual re-optimize fast path in processor.ts now emits the
 * SAME two phrases when the re-run still cannot meet the target. That
 * is intentional: as long as the result is over-target the user wants
 * to keep tightening parameters and try again. Reaching the soft target
 * still leaves `warning === undefined` so the button auto-disappears.
 *
 * Exported so tests + the App-level "isUnderTargetDone" helper share the same
 * predicate; flipping the warning string on the main side requires updating
 * exactly one place.
 */
export function isUnderTargetDone(p: TaskProgress): boolean {
  if (p.status !== 'done') return false;
  const w = p.warning;
  if (!w) return false;
  // R-69 — 三种 warning 都意味着 "成品超过 hard target":
  //   - "exceeds hard target ...MB at min ...px"  : single-pass 路径 (image / video 一段过)
  //   - "did not reach soft target ...MB; saved at ...MB" : 软目标没达成
  //   - "seg N final X.XXMB exceeds Y.YMB target" : 多段 video 路径 (processor.ts L1780)
  // 之前的 predicate 漏了第三种 → 视频跑出超标产物时按钮不出现, 这是产品 bug.
  return (
    w.includes('exceeds hard target') ||
    w.includes('did not reach soft target') ||
    /seg\s+\d+\s+final\s+[\d.]+MB\s+exceeds\s+[\d.]+MB\s+target/.test(w)
  );
}

interface DetailModalState {
  title: string;
  warning?: string;
  phaseFailures: string[];
  error?: string;
}

const WarningDetailModal: React.FC<{ s: DetailModalState; onClose: () => void }> = ({ s, onClose }) => {
  const text = [
    s.warning ? `Summary: ${s.warning}` : null,
    s.error ? `Error: ${s.error}` : null,
    s.phaseFailures.length > 0 ? `\nPhase failures (${s.phaseFailures.length}):\n  - ${s.phaseFailures.join('\n  - ')}` : null
  ].filter(Boolean).join('\n');
  const onCopy = (): void => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  };
  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
      }}
    >
      <div
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--panel, #1e1f24)', color: 'var(--text, #ddd)',
          border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8,
          padding: 16, maxWidth: 720, width: '90vw', maxHeight: '80vh',
          display: 'flex', flexDirection: 'column', gap: 10
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 600 }}>{s.title}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onCopy} style={{ fontSize: 12 }}>复制</button>
            <button onClick={onClose} style={{ fontSize: 12 }}>关闭</button>
          </div>
        </div>
        {s.warning ? (
          <div style={{ fontSize: 12, color: '#f0c674' }}>⚠ {s.warning}</div>
        ) : null}
        {s.error ? (
          <div style={{ fontSize: 12, color: '#ef5b6e' }}>✖ {s.error}</div>
        ) : null}
        {s.phaseFailures.length > 0 ? (
          <div style={{ overflow: 'auto', flex: 1 }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
              Phase failures ({s.phaseFailures.length}):
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, fontFamily: 'monospace', fontSize: 11, lineHeight: 1.6 }}>
              {s.phaseFailures.map((f, i) => (
                <li key={i} style={{ wordBreak: 'break-all' }}>{f}</li>
              ))}
            </ul>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>没有更多诊断信息。</div>
        )}
      </div>
    </div>
  );
};

export const TaskTable: React.FC<Props> = ({ items, progress, onRetry, onForceAllow, onManualOptimize, onCancelOne, onUploadOne, onOpenInToolbox }) => {
  const [detail, setDetail] = useState<DetailModalState | null>(null);
  // Track which task IDs are currently mid-retry so we can disable the button
  // until a fresh progress event arrives. Without this, double-clicks would
  // enqueue the same media twice while the IPC round-trip is in flight.
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  // R-43.2 — IDs that the user has clicked "✕" on. Disables the button
  // until main emits a terminal status, preventing double-clicks while
  // the IPC round-trip is in flight.
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const rows = items.filter((m) => progress[m.id]);
  if (rows.length === 0) {
    return (
      <div className="tasks">
        <div style={{ color: 'var(--muted)', padding: 8 }}>任务列表(开始批处理后这里会出现进度)</div>
      </div>
    );
  }
  return (
    <div className="tasks">
      {rows.map((m) => {
        const p = progress[m.id];
        const cls = ['done', 'failed', 'skipped', 'cancelled'].includes(p.status) ? p.status : '';
        const meta = describe(p);
        const hasFailures = (p.phaseFailures?.length ?? 0) > 0;
        const canOpenDetail = Boolean(p.warning || p.error || hasFailures);
        const openDetail = (): void => {
          setDetail({
            title: fileName(m.url),
            warning: p.warning,
            error: p.error,
            phaseFailures: p.phaseFailures ?? []
          });
        };
        return (
          <div className="task" key={m.id}>
            {/* R-PROG-THUMB-V1 — small live thumbnail per row so the
                user can identify which clip the progress bar belongs
                to. Reuses the home-grid <Thumb /> so animated GIFs
                actually animate (it returns a giftk-local:// playable
                URL when the main process has cached the source). */}
            <div className="task-thumb" aria-hidden="true">
              <Thumb media={m} />
            </div>
            <div className="status">
              <span className={`badge ${m.kind}`}>{m.kind}</span>
            </div>
            <div>
              <div className="name" title={m.url}>{fileName(m.url)}</div>
              <div className="bar-wrap" style={{ marginTop: 4 }}>
                <div className="bar" style={{ width: `${Math.round(p.percent)}%` }} />
              </div>
              <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 2, lineHeight: 1.45 }}>
                {p.message || p.status}
                {meta ? ` · ${meta}` : ''}
                {p.error ? ` · ${p.error}` : ''}
              </div>
              {p.detail ? (
                <div style={{ color: 'var(--muted)', fontSize: 10, marginTop: 1, fontFamily: 'monospace', opacity: 0.75 }}>
                  {p.detail}
                </div>
              ) : null}
              {p.warning ? (
                <div
                  className="task-warn"
                  title={p.warning + (hasFailures ? '\n\n点击查看完整 phase 失败列表' : '')}
                  onClick={canOpenDetail ? openDetail : undefined}
                  style={canOpenDetail ? { cursor: 'pointer', textDecoration: 'underline dotted' } : undefined}
                >
                  ⚠ {p.warning}
                </div>
              ) : hasFailures ? (
                // No headline warning (success) but swallowed phase failures
                // exist — offer a discreet "查看诊断" link so power users can
                // still inspect what happened during compress.
                <div
                  className="task-warn"
                  onClick={openDetail}
                  style={{ cursor: 'pointer', opacity: 0.7, fontSize: 11, textDecoration: 'underline dotted' }}
                >
                  查看诊断 ({p.phaseFailures!.length})
                </div>
              ) : null}
            </div>
            <div className={`size`}>
              {p.currentSizeMB ? `${p.currentSizeMB.toFixed(2)} MB` : ''}
              {(() => {
                // R-SIZE-REGRESSION-REVERT-V1 — reverted (main auto-
                // copied input as output) takes priority over the raw
                // ratio>1.05 branch. Ratio will be ~1.0 in that case
                // so without this check the user sees no signal that
                // the step was effectively a no-op.
                const reverted =
                  p.sizeRegression?.reverted === true ||
                  p.substep === 'size-regression-reverted';
                if (reverted) {
                  return (
                    <span
                      className="size-regression-reverted"
                      data-testid="task-size-regression-reverted"
                      title="这一步未能减小体积,已自动复制原图作为输出"
                      style={{
                        marginLeft: 4,
                        cursor: 'help',
                        color: '#b45309',
                        background: '#fef3c7',
                        border: '1px solid #fcd34d',
                        borderRadius: 4,
                        padding: '0 6px',
                        fontSize: 11,
                        fontWeight: 600
                      }}
                    >
                      自动回退
                    </span>
                  );
                }
                if (p.sizeRegression) {
                  return (
                    <span
                      className="size-regression-warn"
                      data-testid="task-size-regression-warn"
                      title={`体积反向增加 ${(((p.sizeRegression.ratio) - 1) * 100).toFixed(1)}%（${(p.sizeRegression.beforeBytes / 1024 / 1024).toFixed(2)} MB → ${(p.sizeRegression.afterBytes / 1024 / 1024).toFixed(2)} MB）— 原文件可能已高度优化，原文件仍保留`}
                      style={{ marginLeft: 4, cursor: 'help' }}
                    >
                      ⚠️
                    </span>
                  );
                }
                return null;
              })()}
            </div>
            <div className={`status ${cls}`}>
              <span>{p.status}</span>
              {/* R-43.2 — per-row cancel. Visible only while the task is
                  in a non-terminal state. We use the same set of statuses
                  the home view uses to compute "isHomeBatchProcessing" so
                  the button disappears the instant main emits a terminal
                  event (cancelled / done / failed / skipped). */}
              {onCancelOne && p.status !== 'done' && p.status !== 'failed' && p.status !== 'skipped' && p.status !== 'cancelled' ? (
                <button
                  type="button"
                  className="retry-btn cancel-btn"
                  disabled={cancelling.has(m.id)}
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (cancelling.has(m.id)) return;
                    setCancelling((prev) => {
                      const n = new Set(prev);
                      n.add(m.id);
                      return n;
                    });
                    try {
                      await onCancelOne(m);
                    } finally {
                      // Clear after a short window — the next progress
                      // event (cancelled) will already have hidden the
                      // button via the status guard above; this is just
                      // belt-and-braces in case main never emits.
                      window.setTimeout(() => {
                        setCancelling((prev) => {
                          const n = new Set(prev);
                          n.delete(m.id);
                          return n;
                        });
                      }, 1500);
                    }
                  }}
                  title="取消该任务(不影响其他正在处理的任务)"
                  aria-label="取消任务"
                  style={{
                    marginLeft: 8, fontSize: 11, padding: '2px 8px',
                    cursor: cancelling.has(m.id) ? 'wait' : 'pointer',
                    opacity: cancelling.has(m.id) ? 0.5 : 1
                  }}
                >
                  {cancelling.has(m.id) ? '取消中…' : '✕ 取消'}
                </button>
              ) : null}
              {isUnderTargetDone(p) && onManualOptimize ? (
                <button
                  type="button"
                  className="retry-btn manual-opt-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onManualOptimize(m, p);
                  }}
                  title="未达到目标大小,点击进行手动二次优化"
                  style={{
                    marginLeft: 8, fontSize: 11, padding: '2px 8px'
                  }}
                >
                  手动优化
                </button>
              ) : null}
              {onUploadOne && p.status === 'done' && (p.outputs?.length ?? 0) > 0 ? (
                <button
                  type="button"
                  className="retry-btn upload-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    void onUploadOne(m, p);
                  }}
                  title="上传该产物到当前默认图床"
                  style={{ marginLeft: 8, fontSize: 11, padding: '2px 8px' }}
                >
                  📤 上传
                </button>
              ) : null}
              {/* R-TB-OPEN-FROM-PROGRESS — 把已成功产物直接送进工具箱
                  做二次处理(resize/optimize/trim/...)。仅在 done 且
                  至少有一个产物时显示;扩展名兼容性由 host 侧
                  (App.tsx#onOpenInToolbox) 决定。 */}
              {onOpenInToolbox && p.status === 'done' && (p.outputs?.length ?? 0) > 0 ? (
                <button
                  type="button"
                  className="retry-btn toolbox-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenInToolbox(m, p);
                  }}
                  title="把该产物送入工具箱继续处理(resize / 压缩 / 裁剪 / 加速 ...)"
                  aria-label="在工具箱中打开"
                  style={{ marginLeft: 8, fontSize: 11, padding: '2px 8px' }}
                >
                  🛠 工具箱
                </button>
              ) : null}
              {(() => {
                if (p.status !== 'failed' && p.status !== 'cancelled') return null;
                // R-26 — spec failures get a single "强制允许" button.
                // Runtime / network / transcode failures keep the original
                // "重试" button. We never show both at once: a spec
                // violation re-tried verbatim would just fail the same way.
                const isSpecFailure = p.errorCode === 'ASPECT_RATIO_OUT_OF_RANGE';
                // Critical: when the failure is a SPEC failure but the host
                // forgot to wire onForceAllow, render nothing rather than
                // falling back to the "重试" button. Re-running with the
                // exact same options would fail identically and re-create
                // the original UX bug R-26 was meant to fix.
                if (isSpecFailure && !onForceAllow) return null;
                if (isSpecFailure && onForceAllow) {
                  const meta = p.errorMeta;
                  const tip = meta && meta.origW && meta.origH
                    ? `规格不符:${meta.origW}×${meta.origH} 在 longest≤${meta.maxSide ?? '?'} 时短边只剩 ${meta.shortSideAtMax ?? '?'}px(< minSize ${meta.minSide ?? '?'}px)。点击「强制允许」会绕过该限制重跑这一项。`
                    : '该任务因尺寸规格不符被拒。点击「强制允许」会忽略 minSize 限制重跑这一项,不影响其他任务的默认设置。';
                  return (
                    <button
                      type="button"
                      className="retry-btn force-allow-btn"
                      disabled={retrying.has(m.id)}
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (retrying.has(m.id)) return;
                        setRetrying((prev) => {
                          const n = new Set(prev);
                          n.add(m.id);
                          return n;
                        });
                        try {
                          await onForceAllow(m);
                        } finally {
                          window.setTimeout(() => {
                            setRetrying((prev) => {
                              const n = new Set(prev);
                              n.delete(m.id);
                              return n;
                            });
                          }, 1500);
                        }
                      }}
                      title={tip}
                      aria-label="强制允许"
                      style={{
                        marginLeft: 8, fontSize: 11, padding: '2px 8px',
                        cursor: retrying.has(m.id) ? 'wait' : 'pointer',
                        opacity: retrying.has(m.id) ? 0.5 : 1
                      }}
                    >
                      {retrying.has(m.id) ? '处理中…' : '强制允许'}
                    </button>
                  );
                }
                if (!onRetry) return null;
                return (
                  <button
                    type="button"
                    className="retry-btn"
                    disabled={retrying.has(m.id)}
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (retrying.has(m.id)) return;
                      setRetrying((prev) => {
                        const n = new Set(prev);
                        n.add(m.id);
                        return n;
                      });
                      try {
                        await onRetry(m);
                      } finally {
                        // Clear the local "retrying" flag shortly after kicking
                        // off; the next progress event will replace the row
                        // status anyway, but a short window prevents accidental
                        // double-fires while the IPC promise resolves.
                        window.setTimeout(() => {
                          setRetrying((prev) => {
                            const n = new Set(prev);
                            n.delete(m.id);
                            return n;
                          });
                        }, 1500);
                      }
                    }}
                    title="重新处理这个任务"
                    style={{
                      marginLeft: 8, fontSize: 11, padding: '2px 8px',
                      cursor: retrying.has(m.id) ? 'wait' : 'pointer',
                      opacity: retrying.has(m.id) ? 0.5 : 1
                    }}
                  >
                    {retrying.has(m.id) ? '重试中…' : '重试'}
                  </button>
                );
              })()}
            </div>
          </div>
        );
      })}
      {detail ? <WarningDetailModal s={detail} onClose={() => setDetail(null)} /> : null}
    </div>
  );
};
