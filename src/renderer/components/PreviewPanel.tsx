import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ProcessOptions, SniffedMedia, PreviewResult } from '../../shared/types';
import { CropBox } from './CropBox';
import { Timeline } from './Timeline';

interface Props {
  media: SniffedMedia;
  options: ProcessOptions;
  onChangeOptions: (n: ProcessOptions) => void;
  onRequestPreview: () => void;
  previewing: boolean;
  preview: PreviewResult | null;
}

export const PreviewPanel: React.FC<Props> = ({
  media,
  options,
  onChangeOptions,
  onRequestPreview,
  previewing,
  preview
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [targetEl, setTargetEl] = useState<HTMLElement | null>(null);
  const [duration, setDuration] = useState(0);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaError, setMediaError] = useState<string | null>(null);

  const isGif = media.kind === 'gif';
  const isImage = media.kind === 'image';

  // R-22: derive a UI-only preview of the segments the processor will produce
  // for the current clip range. Mirrors enumerateSegments() in
  // processor-utils.ts (kept inline to avoid pulling main-process code into
  // the renderer bundle). Empty list when video metadata isn't loaded yet
  // or when the clip is shorter than maxSegmentSec (single-segment case
  // doesn't need user picking).
  const segmentPreviews = useMemo(() => {
    if (isGif || isImage) return [];
    if (duration <= 0) return [];
    const start = Math.max(0, Math.min(duration, options.startSec ?? 0));
    const end = Math.max(start, Math.min(duration, options.endSec ?? duration));
    const range = end - start;
    if (range <= 0) return [];
    const segLen = Math.max(1, options.maxSegmentSec);
    if (range <= segLen) return []; // single segment: no need to ask the user
    const segCount = Math.max(1, Math.ceil(range / segLen));
    const segActual = range / segCount;
    return Array.from({ length: segCount }, (_, i) => ({
      index: i,
      start: start + i * segActual,
      end: start + (i + 1) * segActual
    }));
  }, [isGif, isImage, duration, options.startSec, options.endSec, options.maxSegmentSec]);

  const effectiveSelected: Set<number> = useMemo(() => {
    if (segmentPreviews.length === 0) return new Set();
    if (options.selectedSegments && options.selectedSegments.length > 0) {
      return new Set(options.selectedSegments);
    }
    // No explicit selection but we have multiple segments → mirror App.tsx's
    // batch behaviour: default to segment #0 only. Users see #1 ticked here
    // and the "select all"/"clear" buttons let them lift this fast.
    return new Set([0]);
  }, [segmentPreviews.length, options.selectedSegments]);

  const toggleSegment = (idx: number) => {
    const next = new Set(effectiveSelected);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    const arr = Array.from(next).sort((a, b) => a - b);
    onChangeOptions({ ...options, selectedSegments: arr.length === 0 ? undefined : arr });
  };
  const selectAllSegments = () => {
    onChangeOptions({
      ...options,
      selectedSegments: segmentPreviews.map((s) => s.index)
    });
  };
  const selectFirstSegment = () => {
    onChangeOptions({ ...options, selectedSegments: [0] });
  };

  useEffect(() => {
    setCurrentTime(0);
    setDuration(0);
    setNaturalSize({ w: 0, h: 0 });
    setMediaError(null);
    setTargetEl(null);
    onChangeOptions({ ...options, cropRect: undefined, startSec: undefined, endSec: undefined, selectedSegments: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media.id]);

  return (
    <div>
      <h2 style={{ margin: '4px 0 12px', fontSize: 14 }}>预览 / 裁剪 · {media.kind.toUpperCase()}</h2>

      <div className="player-row">
        <div className="player">
          {isGif || isImage ? (
            <img
              ref={(el) => { setTargetEl(el); }}
              src={media.url}
              alt="preview"
              onLoad={(e) => {
                const t = e.currentTarget;
                setNaturalSize({ w: t.naturalWidth, h: t.naturalHeight });
              }}
              onError={() => setMediaError('图像加载失败(可能因为 CORS 或链接失效),不影响后台抓取')}
            />
          ) : (
            <video
              ref={(el) => { videoRef.current = el; setTargetEl(el); }}
              src={media.url}
              controls
              preload="metadata"
              onLoadedMetadata={(e) => {
                const t = e.currentTarget;
                setDuration(t.duration);
                setNaturalSize({ w: t.videoWidth, h: t.videoHeight });
                if (options.endSec === undefined) {
                  // R-22: for the clip range we now select the full duration so
                  // the segment checkboxes below can offer every slice. The
                  // default "only segment #0" behaviour is delivered through
                  // `selectedSegments=[0]` rather than truncating the range,
                  // so the user can tick more segments without first dragging
                  // the timeline.
                  const tooLong = t.duration > options.maxSegmentSec;
                  onChangeOptions({
                    ...options,
                    startSec: 0,
                    endSec: t.duration,
                    selectedSegments: tooLong
                      ? (options.selectedSegments ?? [0])
                      : options.selectedSegments
                  });
                }
              }}
              onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
              onError={() => setMediaError('视频加载失败(可能因为 CORS 或链接失效),不影响后台抓取')}
            />
          )}
          <div className="crop-overlay">
            {naturalSize.w > 0 ? (
              <CropBox
                naturalSize={naturalSize}
                targetEl={targetEl}
                value={options.cropRect}
                onChange={(rect) => onChangeOptions({ ...options, cropRect: rect })}
              />
            ) : null}
          </div>
        </div>

        <div style={{ minWidth: 220, color: 'var(--muted)', fontSize: 12 }}>
          <div><b style={{ color: 'var(--text)' }}>原始尺寸:</b> {naturalSize.w}×{naturalSize.h}</div>
          {duration > 0 && <div><b style={{ color: 'var(--text)' }}>视频时长:</b> {duration.toFixed(1)}s</div>}
          {options.cropRect ? (
            <div><b style={{ color: 'var(--text)' }}>裁剪区域:</b> {Math.round(options.cropRect.w)}×{Math.round(options.cropRect.h)}</div>
          ) : (
            <div>未裁剪 (可在画面上拖出选区)</div>
          )}
          {options.cropRect && (
            <button style={{ marginTop: 8 }} onClick={() => onChangeOptions({ ...options, cropRect: undefined })}>
              清除裁剪框
            </button>
          )}
          <div style={{ marginTop: 14 }}>
            <button onClick={onRequestPreview} disabled={previewing || isImage}>
              {previewing ? '生成预览中…' : '抽取关键帧'}
            </button>
          </div>
          {mediaError ? (
            <div className="notice danger" style={{ marginTop: 10 }}>{mediaError}</div>
          ) : null}
          {preview && preview.error ? (
            <div className="notice danger" style={{ marginTop: 10 }}>预览失败: {preview.error}</div>
          ) : null}
        </div>
      </div>

      {!isGif && !isImage && duration > 0 && (
        <Timeline
          duration={duration}
          start={options.startSec ?? 0}
          end={options.endSec ?? duration}
          maxSegmentSec={options.maxSegmentSec}
          currentTime={currentTime}
          onChange={(start, end) => onChangeOptions({ ...options, startSec: start, endSec: end })}
          onSeek={(t) => {
            if (videoRef.current) videoRef.current.currentTime = t;
          }}
        />
      )}

      {segmentPreviews.length > 0 && (
        <div className="segment-picker" style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
            <b style={{ fontSize: 12 }}>分段选择 (R-22)</b>
            <span style={{ color: 'var(--muted)', fontSize: 11 }}>
              已勾 {effectiveSelected.size} / {segmentPreviews.length} 段 · 默认仅第 1 段
            </span>
            <span style={{ flex: 1 }} />
            <button type="button" onClick={selectFirstSegment} style={{ fontSize: 11 }}>仅第 1 段</button>
            <button type="button" onClick={selectAllSegments} style={{ fontSize: 11 }}>全选</button>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {segmentPreviews.map((s) => {
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
                    onChange={() => toggleSegment(s.index)}
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
      )}

      {preview && preview.frames.length > 0 && (
        <div className="frames">
          {preview.frames.map((f) => (
            <div className="frame" key={f.index}>
              <img src={f.dataUrl} alt={`f${f.index}`} />
              {f.timeSec.toFixed(2)}s
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
