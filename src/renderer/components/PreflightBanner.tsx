import React from 'react';
import type { BatchSizeGuardEntry } from './BatchSizeGuardModal';

/**
 * R-74 — Inline pre-flight banner that sits above the TaskTable while
 * the batch dispatch pipeline is in either of two pre-dispatch phases:
 *
 *   `probing`         — main is ffprobing every URL in the batch in
 *                        parallel (concurrency 3). Banner shows the
 *                        progress bar `done / total` so the user can
 *                        tell something is happening; this is the
 *                        "评估阶段也可以在进度里显示出来" requirement.
 *
 *   `awaiting-confirm` — probing finished and at least one task is
 *                        flagged as `will-fail` (longest > maxSide AND
 *                        projected short < minSide). Banner now shows
 *                        the count of offending items + three primary
 *                        actions: 「批量强制允许 K 项」 / 「跳过这些项」 /
 *                        「取消整批」. This is the "在处理进度栏目提供
 *                        一个按键" requirement — note it's an inline
 *                        button, NOT a modal, because the user
 *                        explicitly didn't want a modal in R-74.
 *
 * The component is purely presentational: all state lives on App.tsx,
 * and the parent is responsible for unmounting the banner once the
 * batch is dispatched or cancelled. Keeping this stateless means the
 * banner re-mounts cleanly on subsequent batches without stale local
 * state.
 *
 * Accessibility: the wrapping `<section>` carries `role="status"` so
 * screen readers announce phase transitions; primary action buttons
 * are real `<button>` elements (no div onClick anti-pattern).
 *
 * Styling note: this component uses inline styles to match the
 * BatchSizeGuardModal pattern (project doesn't use a CSS class for
 * one-off panels). Colours come from the `--muted` / `--accent`
 * design tokens already used elsewhere; we provide hard-coded
 * fallbacks so the banner remains legible if the token is missing.
 */
export interface PreflightBannerProps {
  /** Probing phase only. `null` outside probing. */
  probing: { total: number; done: number } | null;
  /** Awaiting-confirm phase only. `null` while still probing. */
  awaiting: {
    total: number;
    willFail: BatchSizeGuardEntry[];
    /** How many tasks couldn't be probed. They will pass through to
     *  the runtime guard — banner shows the count for transparency. */
    unknownCount: number;
    onForceAllowAll: () => void;
    onSkipAll: () => void;
  } | null;
  onCancel: () => void;
}

const cardBase: React.CSSProperties = {
  padding: '12px 14px',
  borderRadius: 8,
  border: '1px solid var(--border, #2c2c2c)',
  background: 'var(--surface, #1a1a1a)',
  color: 'var(--fg, #eee)',
  fontSize: 13,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  marginBottom: 8
};

const probingCardStyle: React.CSSProperties = {
  ...cardBase,
  borderColor: 'var(--accent, #4c8bf5)'
};

const warnCardStyle: React.CSSProperties = {
  ...cardBase,
  borderColor: 'var(--warn, #d97706)',
  background: 'var(--warn-bg, rgba(217, 119, 6, 0.08))'
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap'
};

const titleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600
};

const hintStyle: React.CSSProperties = {
  color: 'var(--muted, #aaa)',
  fontSize: 12
};

const barOuterStyle: React.CSSProperties = {
  width: '100%',
  height: 6,
  background: 'var(--track, #2c2c2c)',
  borderRadius: 3,
  overflow: 'hidden'
};

const barFillStyle: React.CSSProperties = {
  height: '100%',
  background: 'var(--accent, #4c8bf5)',
  transition: 'width 120ms linear'
};

const listStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: 18,
  fontSize: 12,
  color: 'var(--muted, #bbb)',
  lineHeight: 1.6
};

const actionsStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  marginTop: 4,
  flexWrap: 'wrap'
};

const btnBase: React.CSSProperties = {
  fontSize: 13,
  padding: '6px 12px',
  borderRadius: 6,
  cursor: 'pointer',
  border: '1px solid var(--border, #2c2c2c)',
  background: 'var(--surface-2, #222)',
  color: 'var(--fg, #eee)'
};

const btnPrimaryStyle: React.CSSProperties = {
  ...btnBase,
  background: 'var(--accent, #4c8bf5)',
  borderColor: 'var(--accent, #4c8bf5)',
  color: '#fff',
  fontWeight: 600
};

export function PreflightBanner(props: PreflightBannerProps): React.ReactElement | null {
  const { probing, awaiting, onCancel } = props;
  if (!probing && !awaiting) return null;

  if (probing) {
    const pct = probing.total > 0
      ? Math.min(100, Math.round((probing.done / probing.total) * 100))
      : 0;
    return (
      <section style={probingCardStyle} role="status" aria-live="polite">
        <div style={rowStyle}>
          <span aria-hidden="true">📐</span>
          <strong style={titleStyle}>
            尺寸预检中 {probing.done} / {probing.total}
          </strong>
          <span style={hintStyle}>
            (派发前正在批量探测每个媒体的实际尺寸,完成后才开始处理)
          </span>
          <span style={{ flex: 1 }} />
          <button type="button" style={btnBase} onClick={onCancel}>
            取消整批
          </button>
        </div>
        <div
          style={barOuterStyle}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div style={{ ...barFillStyle, width: `${pct}%` }} />
        </div>
      </section>
    );
  }

  // awaiting !== null past this point.
  const a = awaiting!;
  const k = a.willFail.length;
  const sampleNames = a.willFail.slice(0, 5).map((e) => {
    const m = e.media;
    const t = m.url || m.pageUrl || m.id;
    return `• ${t} ${e.origW}×${e.origH} → 短边 ${e.shortSideAtMax}px (< ${e.minSide}px)`;
  });
  const restCount = Math.max(0, k - sampleNames.length);

  return (
    <section style={warnCardStyle} role="status" aria-live="polite">
      <div style={rowStyle}>
        <span aria-hidden="true">⚠️</span>
        <strong style={titleStyle}>
          尺寸预检发现 {k} 项不达标 / 共 {a.total} 项
        </strong>
        {a.unknownCount > 0 ? (
          <span style={hintStyle}>
            (另有 {a.unknownCount} 项无法预检,将由运行时再判定)
          </span>
        ) : null}
      </div>
      <ul style={listStyle}>
        {sampleNames.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
        {restCount > 0 ? (
          <li style={{ color: 'var(--muted, #888)' }}>…以及其余 {restCount} 项</li>
        ) : null}
      </ul>
      <div style={actionsStyle}>
        <button type="button" style={btnPrimaryStyle} onClick={a.onForceAllowAll}>
          批量强制允许 {k} 项
        </button>
        <button type="button" style={btnBase} onClick={a.onSkipAll}>
          跳过这 {k} 项
        </button>
        <button type="button" style={btnBase} onClick={onCancel}>
          取消整批
        </button>
      </div>
    </section>
  );
}
