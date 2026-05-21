import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProcessOptions, SniffedMedia, PreviewResult } from '../../shared/types';
import { CropBox } from './CropBox';
import { Timeline } from './Timeline';
import { SegmentPicker, buildSegmentPreviews } from './SegmentPicker';

type Tab = 'crop' | 'frames';

/**
 * P1.2 — fields that are ONLY meaningful for the currently-previewed media
 * and must NOT be written back to the home-page global ProcessOptions. Crop
 * boxes are inherently per-image; start/end seconds and the segment-pick
 * array only make sense relative to a single video's duration. Anything else
 * (fps / speed / maxSegmentSec / minSize / maxWidth) IS shared across the
 * whole batch and continues to flow through `onChangeOptions`.
 *
 * R-22 — `selectedSegments` joined this set so the PreviewModal can let the
 * user check segments for long videos *without* writing the picks back to
 * the global options (which the next batch run would inherit). The home
 * view's batch path still derives its own per-media [0] default in
 * onProcessOne when no explicit picks come through.
 */
export type PreviewOverride = Pick<
  ProcessOptions,
  'cropRect' | 'startSec' | 'endSec' | 'selectedSegments'
>;

interface Props {
  media: SniffedMedia;
  /**
   * The home-page global options. Read-only from the preview's perspective for
   * the per-media fields (cropRect / startSec / endSec); writeable for the
   * batch-shared fields (fps / speed / maxSegmentSec / minSize / maxWidth).
   */
  baseOptions: ProcessOptions;
  /**
   * Per-media overrides scoped to this preview session. Mutating these does
   * NOT touch the global options the next batch run will use.
   */
  previewOverride: PreviewOverride;
  onChangeOverride: (n: PreviewOverride) => void;
  /**
   * Used ONLY for batch-shared fields edited in the Frames tab (fps, speed,
   * maxSegmentSec, minSize, maxWidth). Per-media crop / time edits go through
   * `onChangeOverride` instead.
   */
  onChangeOptions: (n: ProcessOptions) => void;
  onRequestPreview: () => void;
  previewing: boolean;
  preview: PreviewResult | null;
  onClose: () => void;
  onProcessOne?: (media: SniffedMedia, override?: PreviewOverride) => Promise<void> | void;
  processOneDisabled?: boolean;
  processOneLabel?: string;
}

function fmtBytes(n?: number): string {
  if (!n || n <= 0) return '';
  const mb = n / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(2)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

function fileName(u: string): string {
  try {
    const p = new URL(u).pathname;
    return p.split('/').pop() || u;
  } catch {
    return u;
  }
}

export const PreviewModal: React.FC<Props> = ({
  media,
  baseOptions,
  previewOverride,
  onChangeOverride,
  onChangeOptions,
  onRequestPreview,
  previewing,
  preview,
  onClose,
  onProcessOne,
  processOneDisabled,
  processOneLabel
}) => {
  const [tab, setTab] = useState<Tab>('crop');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [targetEl, setTargetEl] = useState<HTMLElement | null>(null);
  const [duration, setDuration] = useState(0);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Effective options the preview UI reads from. Per-media fields come from
  // the local override; everything else (fps, speed, maxSegmentSec, …) still
  // reflects the global batch options. Writes for cropRect / startSec / endSec
  // route to `onChangeOverride`, never to `onChangeOptions` (P1.2).
  const options: ProcessOptions = useMemo(
    () => ({ ...baseOptions, ...previewOverride }),
    [baseOptions, previewOverride]
  );

  const isGif = media.kind === 'gif';
  const isImage = media.kind === 'image';
  const isVideo = !isGif && !isImage;

  // R-25 (#1): the bare <video preload="metadata"> shows a *blank* black
  // box from modal open until onLoadedMetadata fires — on slow networks
  // this is several seconds of "did anything happen?". We surface an
  // explicit loading overlay so the user knows the player is fetching the
  // first frame / metadata. The overlay vanishes the moment the media
  // resolves a non-zero natural size or errors out.
  const mediaLoading = !mediaError && naturalSize.w === 0;
  const loadingLabel = isVideo
    ? '正在加载视频元数据 / 首帧…'
    : isGif
      ? '正在加载 GIF…'
      : '正在加载图像…';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    setCurrentTime(0);
    setDuration(0);
    setNaturalSize({ w: 0, h: 0 });
    setMediaError(null);
    setTargetEl(null);
    setCopied(false);
    setTab('crop');
    // P1.2 — only clear the LOCAL override when switching media; never touch
    // the home-page global options here.
    // R-22 — clear selectedSegments too so the next media starts from the
    // "no picks yet" state and re-derives its own default (single-segment
    // for short videos, [0] auto-pick for long ones).
    onChangeOverride({
      cropRect: undefined,
      startSec: undefined,
      endSec: undefined,
      selectedSegments: undefined
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media.id]);

  useEffect(() => {
    if ((isGif || isImage) && tab === 'frames') setTab('crop');
  }, [isGif, isImage, tab]);

  const onMaskClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  const copyUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(media.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }, [media.url]);

  const onCancelCrop = useCallback(() => {
    onChangeOverride({ ...previewOverride, cropRect: undefined });
  }, [previewOverride, onChangeOverride]);

  const onResetTimeline = useCallback(() => {
    if (isVideo && duration > 0) {
      // R-22 — reset puts us back to the "full range, default segment pick"
      // state. For long videos the default is `[0]` (only the first
      // maxSegmentSec window) — matching what onLoadedMetadata seeded; for
      // short videos `selectedSegments` stays undefined (single segment, no
      // picker shown).
      const isLong = duration > baseOptions.maxSegmentSec;
      onChangeOverride({
        ...previewOverride,
        startSec: 0,
        endSec: duration,
        selectedSegments: isLong ? [0] : undefined
      });
    } else {
      onChangeOverride({
        ...previewOverride,
        startSec: undefined,
        endSec: undefined,
        selectedSegments: undefined
      });
    }
  }, [previewOverride, onChangeOverride, isVideo, duration, baseOptions.maxSegmentSec]);

  const onClickProcessOne = useCallback(() => {
    if (!onProcessOne || processOneDisabled) return;
    void onProcessOne(media, previewOverride);
  }, [onProcessOne, processOneDisabled, media, previewOverride]);

  const showFrames = tab === 'frames' && isVideo;

  const sizeText = naturalSize.w > 0 ? `${naturalSize.w}×${naturalSize.h}` : (
    media.width && media.height ? `${media.width}×${media.height}` : '-'
  );

  return (
    <div className="modal-mask" onClick={onMaskClick}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-header">
          <span className={`badge ${media.kind}`}>{media.kind}</span>
          <span className="modal-title-text" title={media.url}>{fileName(media.url)}</span>
          <span className="modal-header-spacer" />
          <span className="modal-esc-hint">Esc 关闭</span>
          <button className="modal-close" onClick={onClose} aria-label="关闭">×</button>
        </div>

        <div className="modal-tabs">
          <button
            className={`modal-tab ${tab === 'crop' ? 'active' : ''}`}
            onClick={() => setTab('crop')}
          >
            ① 预览 / 裁剪
          </button>
          <button
            className={`modal-tab ${tab === 'frames' ? 'active' : ''}`}
            onClick={() => !isImage && !isGif && setTab('frames')}
            disabled={isImage || isGif}
            title={isImage || isGif ? '抽帧仅支持视频' : ''}
          >
            ② 抽帧 / 速度
          </button>
        </div>

        <div className="modal-body">
          <div className="modal-stage">
            <div className="modal-player">
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
                    // P1.2 — auto-populate the local override (NOT the global
                    // options) so the timeline UI starts with a sane window.
                    // The global options stay pristine, which means closing
                    // the modal without "单独处理本项" leaves the next batch
                    // run unaffected.
                    //
                    // R-22 — KEY FIX: previously we wrote
                    //   endSec = min(maxSegmentSec, duration)
                    // which silently clipped long videos to the first window
                    // and made the segment picker useless (the resulting
                    // [start,end] range only ever covered ONE segment). Now
                    // we keep the full [0..duration] range and instead express
                    // "only process the first segment by default" via
                    // selectedSegments=[0]. The user can then tick more
                    // segments in the SegmentPicker, or click 全选 to do all.
                    if (previewOverride.endSec === undefined) {
                      const isLong = t.duration > baseOptions.maxSegmentSec;
                      onChangeOverride({
                        ...previewOverride,
                        startSec: 0,
                        endSec: t.duration,
                        selectedSegments: isLong ? [0] : undefined
                      });
                    }
                  }}
                  onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                  onError={() => setMediaError('视频加载失败(可能因为 CORS 或链接失效),不影响后台抓取')}
                />
              )}
              {mediaLoading ? (
                <div
                  className="modal-player-loading"
                  role="status"
                  aria-live="polite"
                  aria-label="media-loading"
                >
                  <div className="modal-player-spinner" aria-hidden />
                  <div className="modal-player-loading-label">{loadingLabel}</div>
                  <div className="modal-player-loading-hint">
                    远端视频首帧拉取中,慢的话再等几秒;失败会显示具体原因。
                  </div>
                </div>
              ) : null}
              {tab === 'crop' && naturalSize.w > 0 ? (
                <div className="crop-overlay">
                  <CropBox
                    naturalSize={naturalSize}
                    targetEl={targetEl}
                    value={options.cropRect}
                    onChange={(rect) => onChangeOverride({ ...previewOverride, cropRect: rect })}
                  />
                </div>
              ) : null}
            </div>
          </div>

          <aside className="modal-side">
            {tab === 'crop' ? (
              <CropPane
                media={media}
                options={options}
                previewOverride={previewOverride}
                onChangeOverride={onChangeOverride}
                duration={duration}
                naturalSize={naturalSize}
                currentTime={currentTime}
                videoRef={videoRef}
                isVideo={isVideo}
                sizeText={sizeText}
                onCopyUrl={copyUrl}
                copied={copied}
              />
            ) : (
              <FramesPane
                media={media}
                options={options}
                onChangeOptions={onChangeOptions}
                onRequestPreview={onRequestPreview}
                previewing={previewing}
                preview={preview}
                disabled={!isVideo}
                sizeText={sizeText}
                onCopyUrl={copyUrl}
                copied={copied}
              />
            )}

            {(isImage || isGif) && tab === 'frames' ? (
              <div className="notice danger" style={{ marginTop: 10 }}>抽帧仅支持视频</div>
            ) : null}
            {mediaError ? (
              <div className="notice danger" style={{ marginTop: 10 }}>{mediaError}</div>
            ) : null}
            {!showFrames && preview && preview.error ? (
              <div className="notice danger" style={{ marginTop: 10 }}>预览失败: {preview.error}</div>
            ) : null}
          </aside>
        </div>

        <div className="modal-footer">
          <div className="modal-footer-left">
            <button onClick={copyUrl} title={media.url}>
              {copied ? '已复制' : '复制 URL'}
            </button>
            <button onClick={onCancelCrop} disabled={!options.cropRect}>取消裁剪</button>
            <button onClick={onResetTimeline} disabled={!isVideo}>重置时间轴</button>
          </div>
          <div className="modal-footer-right">
            <button onClick={onClose}>关闭</button>
            {onProcessOne ? (
              <button
                className="primary"
                onClick={onClickProcessOne}
                disabled={!!processOneDisabled}
                title={
                  media.requiresExternalDownload
                    ? `视频由 ${media.embedHost || '第三方'} 嵌入(如 Vimeo / YouTube),无法直接抓取视频流。请到原页面获取 .mp4 直链后再回来嗅探。`
                    : processOneDisabled
                      ? '该项正在处理中…'
                      : '仅处理本项'
                }
              >
                {media.requiresExternalDownload
                  ? `${media.embedHost || '第三方'} 嵌入 · 无法直抓`
                  : processOneLabel || '▶ 单独处理本项'}
              </button>
            ) : null}
          </div>
        </div>

        <div className="modal-meta-info" aria-hidden style={{ display: 'none' }}>
          {fmtBytes(media.sizeBytes)}
        </div>
      </div>
    </div>
  );
};

interface CropPaneProps {
  media: SniffedMedia;
  options: ProcessOptions;
  previewOverride: PreviewOverride;
  onChangeOverride: (n: PreviewOverride) => void;
  duration: number;
  naturalSize: { w: number; h: number };
  currentTime: number;
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  isVideo: boolean;
  sizeText: string;
  onCopyUrl: () => void;
  copied: boolean;
}

const CropPane: React.FC<CropPaneProps> = ({
  media,
  options,
  previewOverride,
  onChangeOverride,
  duration,
  naturalSize,
  currentTime,
  videoRef,
  isVideo,
  sizeText,
  onCopyUrl,
  copied
}) => {
  return (
    <div className="modal-pane">
      <h3 className="modal-pane-title">媒体信息</h3>
      <InfoList
        media={media}
        sizeText={sizeText}
        duration={duration}
        cropRect={options.cropRect}
        onCopyUrl={onCopyUrl}
        copied={copied}
      />

      <h3 className="modal-pane-title" style={{ marginTop: 16 }}>裁剪</h3>
      <div className="info-block">
        {options.cropRect ? (
          <div>
            <b>区域:</b> {Math.round(options.cropRect.w)}×{Math.round(options.cropRect.h)} @
            ({Math.round(options.cropRect.x)}, {Math.round(options.cropRect.y)})
          </div>
        ) : (
          <div className="muted">未裁剪 — 在画面上拖出选区</div>
        )}
      </div>

      {isVideo && duration > 0 ? (
        <>
          <h3 className="modal-pane-title" style={{ marginTop: 16 }}>时间轴</h3>
          <Timeline
            duration={duration}
            start={options.startSec ?? 0}
            end={options.endSec ?? duration}
            maxSegmentSec={options.maxSegmentSec}
            currentTime={currentTime}
            onChange={(start, end) =>
              onChangeOverride({ ...previewOverride, startSec: start, endSec: end })
            }
            onSeek={(t) => {
              if (videoRef.current) videoRef.current.currentTime = t;
            }}
          />
          <SegmentPickerSection
            duration={duration}
            startSec={options.startSec ?? 0}
            endSec={options.endSec ?? duration}
            maxSegmentSec={options.maxSegmentSec}
            selectedSegments={previewOverride.selectedSegments}
            onChange={(picks) =>
              onChangeOverride({
                ...previewOverride,
                selectedSegments: picks.length > 0 ? picks : undefined
              })
            }
          />
        </>
      ) : null}

      <div aria-hidden style={{ display: 'none' }}>{naturalSize.w}</div>
    </div>
  );
};

/**
 * R-22 — Segment-picker bridge for PreviewModal.
 *
 * `SegmentPicker` itself is a presentational component; it doesn't slice
 * the timeline. We wrap it here so the modal can pass [startSec, endSec]
 * pairs straight through and let `buildSegmentPreviews` compute the chip
 * list. When the resulting list is empty (range ≤ maxSegmentSec — i.e.
 * single-segment videos) we render nothing so the pane stays clean.
 *
 * This component is the missing UI that used to live in PreviewPanel
 * (which App.tsx no longer mounts). Centralising it here keeps the
 * "single source of segment selection" inside the modal that actually
 * fires onProcessOne.
 */
interface SegmentPickerSectionProps {
  duration: number;
  startSec: number;
  endSec: number;
  maxSegmentSec: number;
  selectedSegments: number[] | undefined;
  onChange: (picks: number[]) => void;
}

const SegmentPickerSection: React.FC<SegmentPickerSectionProps> = ({
  duration,
  startSec,
  endSec,
  maxSegmentSec,
  selectedSegments,
  onChange
}) => {
  const segments = useMemo(
    () => buildSegmentPreviews(startSec, endSec, maxSegmentSec),
    [startSec, endSec, maxSegmentSec]
  );
  if (duration <= 0 || segments.length === 0) return null;
  return (
    <SegmentPicker
      segments={segments}
      selectedSegments={selectedSegments}
      onChange={(next) => onChange(next ?? [])}
      title="分段选择"
      hint={`长视频(${duration.toFixed(1)}s)被切成 ${segments.length} 段,默认仅处理第 1 段;勾选可处理多段`}
    />
  );
};

interface FramesPaneProps {
  media: SniffedMedia;
  options: ProcessOptions;
  onChangeOptions: (n: ProcessOptions) => void;
  onRequestPreview: () => void;
  previewing: boolean;
  preview: PreviewResult | null;
  disabled: boolean;
  sizeText: string;
  onCopyUrl: () => void;
  copied: boolean;
}

const FramesPane: React.FC<FramesPaneProps> = ({
  media,
  options,
  onChangeOptions,
  onRequestPreview,
  previewing,
  preview,
  disabled,
  sizeText,
  onCopyUrl,
  copied
}) => {
  const set = useCallback(
    <K extends keyof ProcessOptions>(k: K, v: ProcessOptions[K]) =>
      onChangeOptions({ ...options, [k]: v }),
    [options, onChangeOptions]
  );

  return (
    <div className="modal-pane">
      <h3 className="modal-pane-title">媒体信息</h3>
      <InfoList
        media={media}
        sizeText={sizeText}
        duration={0}
        cropRect={options.cropRect}
        onCopyUrl={onCopyUrl}
        copied={copied}
      />

      <h3 className="modal-pane-title" style={{ marginTop: 16 }}>本媒体参数</h3>
      <div className="modal-options">
        <NumLabel label="FPS" value={options.fps} min={1} max={60} step={1}
          onCommit={(n) => set('fps', Math.round(n))} disabled={disabled} />
        <NumLabel label="速度 (x)" value={options.speed} min={0.25} max={8} step={0.25}
          onCommit={(n) => set('speed', n)} disabled={disabled} />
        <NumLabel label="分段时长 (s)" value={options.maxSegmentSec} min={1} max={120} step={1}
          onCommit={(n) => set('maxSegmentSec', Math.round(n))} disabled={disabled} />
        <NumLabel label="最小尺寸 (px)" value={options.minSize} min={64} max={4096} step={10}
          onCommit={(n) => set('minSize', Math.round(n))} disabled={disabled} />
        <NumLabel label="最大宽度 (px)" value={options.maxWidth}
          min={Math.max(64, options.minSize)} max={4096} step={1}
          onCommit={(n) => set('maxWidth', Math.max(options.minSize, Math.round(n)))}
          disabled={disabled} />
      </div>

      <div style={{ marginTop: 12 }}>
        <button
          className="primary"
          onClick={onRequestPreview}
          disabled={previewing || disabled}
          title={disabled ? '抽帧仅支持视频' : ''}
        >
          {previewing ? '生成预览中…' : '抽取关键帧'}
        </button>
      </div>

      {preview && preview.error ? (
        <div className="notice danger" style={{ marginTop: 10 }}>预览失败: {preview.error}</div>
      ) : null}

      {preview && preview.frames.length > 0 ? (
        <div className="frames">
          {preview.frames.map((f) => (
            <div className="frame" key={f.index}>
              <img src={f.dataUrl} alt={`f${f.index}`} />
              {f.timeSec.toFixed(2)}s
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

interface InfoListProps {
  media: SniffedMedia;
  sizeText: string;
  duration: number;
  cropRect?: ProcessOptions['cropRect'];
  onCopyUrl: () => void;
  copied: boolean;
}

const InfoList: React.FC<InfoListProps> = ({ media, sizeText, duration, cropRect, onCopyUrl, copied }) => {
  const dur = duration > 0 ? `${duration.toFixed(1)}s`
    : (media.durationSec ? `${media.durationSec.toFixed(1)}s` : '-');
  return (
    <div className="info-block">
      <div className="info-row"><span>类型</span><b><span className={`badge ${media.kind}`}>{media.kind}</span></b></div>
      <div className="info-row"><span>原始尺寸</span><b>{sizeText}</b></div>
      <div className="info-row"><span>时长</span><b>{dur}</b></div>
      <div className="info-row"><span>MIME</span><b>{media.mime || '-'}</b></div>
      <div className="info-row"><span>文件大小</span><b>{fmtBytes(media.sizeBytes) || '-'}</b></div>
      {cropRect ? (
        <div className="info-row">
          <span>裁剪</span>
          <b>{Math.round(cropRect.w)}×{Math.round(cropRect.h)} @ ({Math.round(cropRect.x)}, {Math.round(cropRect.y)})</b>
        </div>
      ) : null}
      <div className="info-row info-url">
        <span>URL</span>
        <span className="url-cell" title={media.url}>{media.url}</span>
      </div>
      <div style={{ marginTop: 6 }}>
        <button onClick={onCopyUrl}>{copied ? '已复制' : '复制 URL'}</button>
      </div>
    </div>
  );
};

interface NumLabelProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (n: number) => void;
  disabled?: boolean;
}

const NumLabel: React.FC<NumLabelProps> = ({ label, value, min, max, step, onCommit, disabled }) => {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  const commit = () => {
    const n = Number(text);
    if (!Number.isFinite(n)) {
      setText(String(value));
      return;
    }
    let v = n;
    if (typeof min === 'number') v = Math.max(min, v);
    if (typeof max === 'number') v = Math.min(max, v);
    onCommit(v);
    setText(String(v));
  };
  const id = useMemo(() => `num-${label}-${Math.random().toString(36).slice(2, 8)}`, [label]);
  return (
    <label htmlFor={id}>
      {label}
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
    </label>
  );
};
