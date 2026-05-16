import React, { useMemo } from 'react';

export interface SegmentPreview {
  index: number;
  start: number;
  end: number;
}

interface Props {
  segments: SegmentPreview[];
  selectedSegments: number[] | undefined;
  onChange: (next: number[] | undefined) => void;
  title?: string;
  hint?: string;
  compact?: boolean;
}

export function buildSegmentPreviews(
  startSec: number,
  endSec: number,
  maxSegmentSec: number
): SegmentPreview[] {
  const start = Math.max(0, startSec);
  const end = Math.max(start, endSec);
  const range = end - start;
  if (range <= 0) return [];
  const segLen = Math.max(1, maxSegmentSec);
  if (range <= segLen) return [];
  const segCount = Math.max(1, Math.ceil(range / segLen));
  const segActual = range / segCount;
  return Array.from({ length: segCount }, (_, i) => ({
    index: i,
    start: start + i * segActual,
    end: start + (i + 1) * segActual
  }));
}

export const SegmentPicker: React.FC<Props> = ({
  segments,
  selectedSegments,
  onChange,
  title = '分段选择 (R-22)',
  hint,
  compact = false
}) => {
  const effectiveSelected: Set<number> = useMemo(() => {
    if (segments.length === 0) return new Set();
    if (selectedSegments && selectedSegments.length > 0) {
      return new Set(selectedSegments);
    }
    return new Set([0]);
  }, [segments.length, selectedSegments]);

  if (segments.length === 0) return null;

  const toggle = (idx: number) => {
    const next = new Set(effectiveSelected);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    const arr = Array.from(next).sort((a, b) => a - b);
    onChange(arr.length === 0 ? undefined : arr);
  };
  const selectAll = () => onChange(segments.map((s) => s.index));
  const selectFirst = () => onChange([0]);

  return (
    <div className="segment-picker" style={{ marginTop: compact ? 4 : 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 12 }}>{title}</b>
        <span style={{ color: 'var(--muted)', fontSize: 11 }}>
          {hint ?? `已勾 ${effectiveSelected.size} / ${segments.length} 段 · 默认仅第 1 段`}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={selectFirst} style={{ fontSize: 11 }}>仅第 1 段</button>
        <button type="button" onClick={selectAll} style={{ fontSize: 11 }}>全选</button>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {segments.map((s) => {
          const checked = effectiveSelected.has(s.index);
          return (
            <label
              key={s.index}
              className={`segment-chip${checked ? ' active' : ''}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 8px',
                borderRadius: 4,
                background: checked ? 'var(--accent-bg, #1f3a52)' : 'var(--surface-2, #1a1c20)',
                border: `1px solid ${checked ? 'var(--accent, #4aa3ff)' : 'var(--border, #2a2d33)'}`,
                cursor: 'pointer',
                fontSize: 12
              }}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(s.index)}
                aria-label={`segment ${s.index + 1}`}
              />
              <span>#{s.index + 1}</span>
              <span style={{ color: 'var(--muted)' }}>
                {s.start.toFixed(1)}–{s.end.toFixed(1)}s
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
};
