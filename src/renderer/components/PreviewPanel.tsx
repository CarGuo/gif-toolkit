import React, { useEffect, useRef, useState } from 'react';
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

  useEffect(() => {
    setCurrentTime(0);
    setDuration(0);
    setNaturalSize({ w: 0, h: 0 });
    setMediaError(null);
    setTargetEl(null);
    onChangeOptions({ ...options, cropRect: undefined, startSec: undefined, endSec: undefined });
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
                  onChangeOptions({ ...options, startSec: 0, endSec: Math.min(options.maxSegmentSec, t.duration) });
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
