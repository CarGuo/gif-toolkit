import React, { useEffect, useRef, useState } from 'react';
import { CropBox, type CropRect } from './CropBox';
import type { ToolboxParams } from '../../shared/types';

export interface CropPauseModalProps {
  /** Non-null = modal open. */
  awaiting: {
    stepIndex: number;
    totalSteps: number;
    stepId: string;
    previousOutput: string | undefined;
  } | null;
  /** Called when user clicks "继续" with a non-empty rect. The patch contains
   *  rounded-int cropX/cropY/cropW/cropH. The parent should forward this
   *  to useToolboxChain.resume(). */
  onResume: (patch: Partial<ToolboxParams>) => Promise<void> | void;
  /** Called when user clicks "取消链路" — parent should call useToolboxChain.cancel(). */
  onCancel: () => Promise<void> | void;
}

const IMG_EXTS = ['.gif', '.webp', '.png', '.jpg', '.jpeg'];
const VIDEO_EXTS = ['.mp4', '.webm'];

function pickKind(path: string): 'img' | 'video' {
  const lower = path.toLowerCase();
  if (VIDEO_EXTS.some((e) => lower.endsWith(e))) return 'video';
  if (IMG_EXTS.some((e) => lower.endsWith(e))) return 'img';
  return 'img';
}

function toFileUrl(path: string): string {
  if (path.startsWith('file://') || path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  return `file://${path}`;
}

const backdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.5)',
  zIndex: 1000,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center'
};

const panelStyle: React.CSSProperties = {
  background: '#fff',
  maxWidth: 720,
  width: '90%',
  padding: 16,
  borderRadius: 6,
  boxSizing: 'border-box'
};

const previewWrapStyle: React.CSSProperties = {
  position: 'relative',
  display: 'inline-block',
  maxWidth: '100%'
};

const previewMediaStyle: React.CSSProperties = {
  display: 'block',
  maxWidth: '100%',
  height: 'auto'
};

const footerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  marginTop: 12
};

const mutedStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#666',
  wordBreak: 'break-all',
  marginTop: 4
};

export const CropPauseModal: React.FC<CropPauseModalProps> = ({ awaiting, onResume, onCancel }) => {
  const [rect, setRect] = useState<CropRect | undefined>(undefined);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [targetEl, setTargetEl] = useState<HTMLElement | null>(null);
  const mediaRef = useRef<HTMLImageElement | HTMLVideoElement | null>(null);

  useEffect(() => {
    setRect(undefined);
    setNaturalSize({ w: 0, h: 0 });
    setTargetEl(null);
  }, [awaiting?.stepId]);

  if (!awaiting) return null;

  const previousOutput = awaiting.previousOutput;
  const kind = previousOutput ? pickKind(previousOutput) : 'img';
  const src = previousOutput ? toFileUrl(previousOutput) : '';

  const setMediaRef = (el: HTMLImageElement | HTMLVideoElement | null): void => {
    mediaRef.current = el;
    setTargetEl(el);
  };

  const onImgLoad: React.ReactEventHandler<HTMLImageElement> = (ev) => {
    const img = ev.currentTarget;
    setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
  };

  const onVideoMeta: React.ReactEventHandler<HTMLVideoElement> = (ev) => {
    const v = ev.currentTarget;
    setNaturalSize({ w: v.videoWidth, h: v.videoHeight });
  };

  const canResume = !!rect && rect.w > 0 && rect.h > 0;

  const handleResume = (): void => {
    if (!rect) return;
    void onResume({
      cropX: Math.round(rect.x),
      cropY: Math.round(rect.y),
      cropW: Math.round(rect.w),
      cropH: Math.round(rect.h)
    });
  };

  const handleCancel = (): void => {
    void onCancel();
  };

  return (
    <div style={backdropStyle} role="dialog" aria-modal="true">
      <div style={panelStyle}>
        <h3 style={{ margin: 0 }}>
          {`Step ${awaiting.stepIndex} / ${awaiting.totalSteps} — 选择裁剪区域`}
        </h3>
        {previousOutput && <div style={mutedStyle}>{previousOutput}</div>}
        <div style={{ marginTop: 12 }}>
          <div style={previewWrapStyle}>
            {previousOutput && kind === 'img' && (
              <img
                ref={setMediaRef}
                src={src}
                onLoad={onImgLoad}
                style={previewMediaStyle}
                alt="preview"
              />
            )}
            {previousOutput && kind === 'video' && (
              <video
                ref={setMediaRef}
                src={src}
                onLoadedMetadata={onVideoMeta}
                style={previewMediaStyle}
                autoPlay
                muted
                loop
              />
            )}
            <CropBox
              naturalSize={naturalSize}
              targetEl={targetEl}
              value={rect}
              onChange={setRect}
            />
          </div>
        </div>
        <div style={footerStyle}>
          <button type="button" onClick={handleCancel}>
            取消链路
          </button>
          <button type="button" onClick={handleResume} disabled={!canResume}>
            {`继续 (Step ${awaiting.stepIndex + 1})`}
          </button>
        </div>
      </div>
    </div>
  );
};
