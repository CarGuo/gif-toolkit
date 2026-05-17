import React, { useEffect, useMemo, useState } from 'react';
import type { ProcessOptions } from '../../shared/types';

export interface ManualOptimizeRequest {
  maxBytes: number;
  fps: number;
  maxWidth: number;
}

interface Props {
  open: boolean;
  currentSizeMB: number;
  baseOptions: ProcessOptions;
  taskTitle?: string;
  warning?: string;
  onConfirm: (next: ManualOptimizeRequest) => void;
  onClose: () => void;
}

type PresetKey = 'harder' | 'size' | 'fps' | 'fidelity';

interface Preset {
  key: PresetKey;
  label: string;
  hint: string;
  build: (base: ProcessOptions, currentSizeMB: number) => ManualOptimizeRequest;
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

const PRESETS: Preset[] = [
  {
    key: 'harder',
    label: '更狠压',
    hint: '目标 -30% / fps -2 / 边长 ×0.85',
    build: (base, sizeMB) => ({
      maxBytes: Math.max(100 * 1024, Math.round(Math.min(base.maxBytes, sizeMB * 1024 * 1024) * 0.7)),
      fps: clampInt(base.fps - 2, 5, 60),
      maxWidth: clampInt(Math.round(base.maxWidth * 0.85), Math.max(64, base.minSize), 4096)
    })
  },
  {
    key: 'size',
    label: '优先尺寸',
    hint: '边长 ×0.75,fps 不变',
    build: (base, sizeMB) => ({
      maxBytes: Math.max(100 * 1024, Math.round(Math.min(base.maxBytes, sizeMB * 1024 * 1024) * 0.8)),
      fps: base.fps,
      maxWidth: clampInt(Math.round(base.maxWidth * 0.75), Math.max(64, base.minSize), 4096)
    })
  },
  {
    key: 'fps',
    label: '优先帧率',
    hint: 'fps -4,边长不变',
    build: (base, sizeMB) => ({
      maxBytes: Math.max(100 * 1024, Math.round(Math.min(base.maxBytes, sizeMB * 1024 * 1024) * 0.8)),
      fps: clampInt(base.fps - 4, 5, 60),
      maxWidth: base.maxWidth
    })
  },
  {
    key: 'fidelity',
    label: '近于原图',
    hint: '只降目标大小,画质优先',
    build: (base, sizeMB) => ({
      maxBytes: Math.max(100 * 1024, Math.round(Math.min(base.maxBytes, sizeMB * 1024 * 1024) * 0.9)),
      fps: base.fps,
      maxWidth: base.maxWidth
    })
  }
];

export const ManualOptimizeModal: React.FC<Props> = ({
  open,
  currentSizeMB,
  baseOptions,
  taskTitle,
  warning,
  onConfirm,
  onClose
}) => {
  const [activePreset, setActivePreset] = useState<PresetKey>('harder');
  const initial = useMemo(
    () => PRESETS[0].build(baseOptions, currentSizeMB),
    [baseOptions, currentSizeMB]
  );
  const [maxBytesMB, setMaxBytesMB] = useState<string>(
    (initial.maxBytes / (1024 * 1024)).toFixed(2)
  );
  const [fps, setFps] = useState<string>(String(initial.fps));
  const [maxWidth, setMaxWidth] = useState<string>(String(initial.maxWidth));

  useEffect(() => {
    if (!open) return;
    const p = PRESETS[0].build(baseOptions, currentSizeMB);
    setActivePreset('harder');
    setMaxBytesMB((p.maxBytes / (1024 * 1024)).toFixed(2));
    setFps(String(p.fps));
    setMaxWidth(String(p.maxWidth));
  }, [open, baseOptions, currentSizeMB]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const applyPreset = (key: PresetKey): void => {
    const p = PRESETS.find((x) => x.key === key);
    if (!p) return;
    const next = p.build(baseOptions, currentSizeMB);
    setActivePreset(key);
    setMaxBytesMB((next.maxBytes / (1024 * 1024)).toFixed(2));
    setFps(String(next.fps));
    setMaxWidth(String(next.maxWidth));
  };

  const handleRun = (): void => {
    const mb = Number(maxBytesMB);
    const f = Number(fps);
    const w = Number(maxWidth);
    if (!Number.isFinite(mb) || mb <= 0) return;
    if (!Number.isFinite(f) || f < 1) return;
    if (!Number.isFinite(w) || w < 64) return;
    onConfirm({
      maxBytes: Math.max(100 * 1024, Math.round(mb * 1024 * 1024)),
      fps: clampInt(f, 1, 60),
      maxWidth: clampInt(w, 64, 4096)
    });
  };

  return (
    <div className="modal-mask" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="manual-opt-modal" onClick={(e) => e.stopPropagation()}>
        <div className="manual-opt-header">
          <h3>手动二次优化</h3>
          <button className="manual-opt-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="manual-opt-body">
          {taskTitle ? <div className="manual-opt-title" title={taskTitle}>{taskTitle}</div> : null}
          <div className="manual-opt-meta">
            <span>当前大小</span>
            <strong>{currentSizeMB.toFixed(2)} MB</strong>
            {warning ? <span className="manual-opt-warn">⚠ {warning}</span> : null}
          </div>

          <div className="manual-opt-presets">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                className={`preset-chip${activePreset === p.key ? ' active' : ''}`}
                onClick={() => applyPreset(p.key)}
                title={p.hint}
              >
                <span className="preset-label">{p.label}</span>
                <span className="preset-hint">{p.hint}</span>
              </button>
            ))}
          </div>

          <div className="manual-opt-fields">
            <label>
              <span>目标大小 (MB)</span>
              <input
                type="number"
                min={0.1}
                step={0.1}
                value={maxBytesMB}
                onChange={(e) => setMaxBytesMB(e.target.value)}
              />
            </label>
            <label>
              <span>FPS</span>
              <input
                type="number"
                min={1}
                max={60}
                step={1}
                value={fps}
                onChange={(e) => setFps(e.target.value)}
              />
            </label>
            <label>
              <span>最长边 (px)</span>
              <input
                type="number"
                min={64}
                max={4096}
                step={1}
                value={maxWidth}
                onChange={(e) => setMaxWidth(e.target.value)}
              />
            </label>
          </div>
        </div>
        <div className="manual-opt-footer">
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={handleRun}>运行优化</button>
        </div>
      </div>
    </div>
  );
};
