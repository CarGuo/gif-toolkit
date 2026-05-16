import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ProcessOptions, SniffedMedia, PreviewResult } from '../../shared/types';
import { CropBox } from './CropBox';
import { Timeline } from './Timeline';
import { SegmentPicker, buildSegmentPreviews } from './SegmentPicker';

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
    const start = options.startSec ?? 0;
    const end = options.endSec ?? duration;
    return buildSegmentPreviews(start, end, options.maxSegmentSec);
  }, [isGif, isImage, duration, options.startSec, options.endSec, options.maxSegmentSec]);

  const setSelectedSegments = (next: number[] | undefined) => {
    onChangeOptions({ ...options, selectedSegments: next });
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
        <SegmentPicker
          segments={segmentPreviews}
          selectedSegments={options.selectedSegments}
          onChange={setSelectedSegments}
          videoUrl={media.kind === 'video' ? media.url : undefined}
        />
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
