import React, { useState } from 'react';
import type { SniffedMedia } from '../../shared/types';
import { SegmentPicker, buildSegmentPreviews } from './SegmentPicker';

export interface BatchSegmentEntry {
  media: SniffedMedia;
  durationSec: number;
}

interface Props {
  entries: BatchSegmentEntry[];
  maxSegmentSec: number;
  onConfirm: (selectionByMediaId: Record<string, number[]>) => void;
  onCancel: () => void;
}

/**
 * R-23: when the user clicks "▶ 批处理" with any video that exceeds
 * `maxSegmentSec`, surface a modal that lists each long video with its own
 * SegmentPicker so the user can opt into more than the default first slice
 * BEFORE jobs are dispatched. Short / single-segment videos are filtered
 * out of `entries` upstream so this modal never opens for trivial cases.
 *
 * Initial selection per video defaults to `[0]` (matches the auto-truncate
 * behaviour from R-22 so cancelling the modal also yields the same result).
 */
export const BatchSegmentModal: React.FC<Props> = ({
  entries,
  maxSegmentSec,
  onConfirm,
  onCancel
}) => {
  const [selection, setSelection] = useState<Record<string, number[]>>(() => {
    const init: Record<string, number[]> = {};
    for (const e of entries) init[e.media.id] = [0];
    return init;
  });

  const setOne = (id: string, next: number[] | undefined) => {
    setSelection((prev) => ({ ...prev, [id]: next && next.length > 0 ? next : [0] }));
  };

  const totalSelected = Object.values(selection).reduce((acc, arr) => acc + arr.length, 0);

  return (
    <div
      role="dialog"
      aria-label="batch-segment-modal"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        style={{
          background: 'var(--surface, #1f2228)',
          color: 'var(--text, #eee)',
          padding: 18,
          borderRadius: 8,
          maxWidth: 720,
          width: '90%',
          maxHeight: '80vh',
          overflowY: 'auto',
          boxShadow: '0 10px 30px rgba(0,0,0,0.4)'
        }}
      >
        <h3 style={{ marginTop: 0, fontSize: 15 }}>
          请选择要处理的视频片段 (R-23)
        </h3>
        <div style={{ color: 'var(--muted, #aaa)', fontSize: 12, marginBottom: 12 }}>
          有 {entries.length} 个视频时长超过 {maxSegmentSec}s,默认仅处理第 1 段。
          需要更多片段请在下方勾选 · 已勾共 {totalSelected} 段
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {entries.map((e) => {
            const segs = buildSegmentPreviews(0, e.durationSec, maxSegmentSec);
            const title = e.media.resolved?.title || e.media.url;
            const short = title.length > 60 ? title.slice(0, 57) + '…' : title;
            return (
              <div
                key={e.media.id}
                style={{
                  border: '1px solid var(--border, #2a2d33)',
                  borderRadius: 6,
                  padding: 10
                }}
              >
                <div style={{ fontSize: 12, marginBottom: 6 }}>
                  <b>{e.media.kind.toUpperCase()}</b>
                  <span style={{ color: 'var(--muted)', marginLeft: 6 }}>
                    {e.durationSec.toFixed(1)}s · {segs.length} 段
                  </span>
                  <div style={{ color: 'var(--muted)', fontSize: 11, wordBreak: 'break-all' }}>
                    {short}
                  </div>
                </div>
                <SegmentPicker
                  segments={segs}
                  selectedSegments={selection[e.media.id]}
                  onChange={(next) => setOne(e.media.id, next)}
                  title=""
                  hint={`已勾 ${(selection[e.media.id] ?? [0]).length} / ${segs.length}`}
                  compact
                />
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" onClick={onCancel}>取消</button>
          <button type="button" onClick={() => onConfirm(selection)} style={{ fontWeight: 600 }}>
            开始处理 ({totalSelected} 段)
          </button>
        </div>
      </div>
    </div>
  );
};
