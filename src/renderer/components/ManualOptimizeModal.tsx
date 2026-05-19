import React, { useEffect, useMemo, useState } from 'react';
import type { ProcessOptions } from '../../shared/types';
import {
  GIF_OPTIMIZE_LEVELS,
  GIF_DITHER_MODES,
  GIF_LOSSY_MAX,
  GIF_COLORS_MIN,
  GIF_COLORS_MAX,
  DEFAULT_OPTIONS,
  type GifOptimizeLevel,
  type GifDither,
} from '../../shared/types/process';

/**
 * R-79 — Full ProcessOptions surface for "再压一次".
 *
 * The original R-33A request shape exposed only three knobs (maxBytes,
 * fps, maxWidth). The R-79 product brief expands this so the user can
 * tune *every* parameter the compress loop actually consumes — not just
 * the geometry. New optional fields:
 *
 *   - `softMaxBytes`: lets the user push the "best-effort" target lower
 *     without having to relax `maxBytes`, which is the real lever for
 *     gifsicle's lossy/colors search to actually shrink further.
 *   - `minSize`: the long-side floor that protects geometry. Loosening
 *     this is sometimes the only way to fit a stubborn long video into
 *     a tight maxBytes; tightening it protects detail.
 *   - `speed`: playback-speed override. For long screen-recording GIFs
 *     a 1.25–1.5x speedup is often the cheapest way to halve filesize.
 *
 * `App.tsx#onProcessOne` reads each field via `typeof === 'number'`
 * before applying, so omitting a field == "leave the form's current
 * options value untouched for THIS task". Nothing is persisted globally.
 */
export interface ManualOptimizeRequest {
  /** Hard ceiling in bytes; renderer converts MB → bytes before dispatch. */
  maxBytes: number;
  /** Effective output FPS for the gifsicle / sharp loop. */
  fps: number;
  /** Long-side cap in pixels. */
  maxWidth: number;
  /** R-79 — soft target in bytes (optional override). */
  softMaxBytes?: number;
  /** R-79 — long-side floor (optional override). */
  minSize?: number;
  /** R-79 — playback speed multiplier (optional override). */
  speed?: number;
  /** R-81 — gifsicle --lossy=N ceiling (0..200). */
  lossyCeiling?: number;
  /** R-81 — gifsicle --colors=N floor (2..256). */
  colorsFloor?: number;
  /** R-81 — gifsicle -O level lock (1..3). */
  optimizeLevel?: GifOptimizeLevel;
  /** R-81 — gifsicle dither lock when palette<256. */
  dither?: GifDither;
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

function clampNum(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

const PRESETS: Preset[] = [
  {
    key: 'harder',
    label: '更狠压',
    hint: '目标 -30% / fps -2 / 边长 ×0.85 / lossy=160 colors=64',
    build: (base, sizeMB) => ({
      maxBytes: Math.max(100 * 1024, Math.round(Math.min(base.maxBytes, sizeMB * 1024 * 1024) * 0.7)),
      fps: clampInt(base.fps - 2, 5, 60),
      maxWidth: clampInt(Math.round(base.maxWidth * 0.85), Math.max(64, base.minSize), 4096),
      // R-81 — "更狠压" 真的去动 lossy / colors。lossy=160 是 gifsicle 公认
      // "明显能看出来,但还能接受" 的拐点;colors=64 是体积/质量平衡线。
      lossyCeiling: 160,
      colorsFloor: 64,
    }),
  },
  {
    key: 'size',
    label: '优先尺寸',
    hint: '边长 ×0.75,fps 不变,lossy 用全局值',
    build: (base, sizeMB) => ({
      maxBytes: Math.max(100 * 1024, Math.round(Math.min(base.maxBytes, sizeMB * 1024 * 1024) * 0.8)),
      fps: base.fps,
      maxWidth: clampInt(Math.round(base.maxWidth * 0.75), Math.max(64, base.minSize), 4096),
      // R-81 — 让 adaptive 搜索自由发挥(不锁 lossy/colors);用户专注让边长缩。
    }),
  },
  {
    key: 'fps',
    label: '优先帧率',
    hint: 'fps -4,边长不变,lossy 用全局值',
    build: (base, sizeMB) => ({
      maxBytes: Math.max(100 * 1024, Math.round(Math.min(base.maxBytes, sizeMB * 1024 * 1024) * 0.8)),
      fps: clampInt(base.fps - 4, 5, 60),
      maxWidth: base.maxWidth,
      // R-81 — 不锁 lossy/colors,让 adaptive 自己来。用户用减帧抢体积。
    }),
  },
  {
    key: 'fidelity',
    label: '近于原图',
    hint: '只降目标大小,lossy=20 colors=256(最高画质)',
    build: (base, sizeMB) => ({
      maxBytes: Math.max(100 * 1024, Math.round(Math.min(base.maxBytes, sizeMB * 1024 * 1024) * 0.9)),
      fps: base.fps,
      maxWidth: base.maxWidth,
      // R-81 — 把 lossy 上限压到 20(gifsicle 几乎无察觉)、colors 锁满 256
      // (完全禁用调色板压缩)。adaptive 搜索仍会动,但每一步都局限于
      // "高画质" 子空间,体积一般只能勉强降到目标 0.9 倍。
      lossyCeiling: 20,
      colorsFloor: 256,
    }),
  },
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
  // Hard / soft caps in MB so the user types human-friendly numbers.
  const [maxBytesMB, setMaxBytesMB] = useState<string>(
    (initial.maxBytes / (1024 * 1024)).toFixed(2)
  );
  const [softMaxBytesMB, setSoftMaxBytesMB] = useState<string>(
    (baseOptions.softMaxBytes / (1024 * 1024)).toFixed(2)
  );
  const [fps, setFps] = useState<string>(String(initial.fps));
  const [maxWidth, setMaxWidth] = useState<string>(String(initial.maxWidth));
  const [minSize, setMinSize] = useState<string>(String(baseOptions.minSize));
  const [speed, setSpeed] = useState<string>(String(baseOptions.speed));
  // R-81 — 4 gifsicle knobs. Default to whatever the live OptionsForm
  // already holds; presets that *do* lock lossy/colors will overwrite
  // these on click via applyPreset(); presets that don't will leave the
  // user's hand-edits intact (mirrors softMaxBytes/minSize/speed policy).
  // R-82 — fall back through DEFAULT_OPTIONS first (so the user sees the
  // canonical default 200 / 2 / 3 / floyd-steinberg if baseOptions is
  // missing them) before bottoming out on the type-level GIF_* bounds.
  const [lossyCeiling, setLossyCeiling] = useState<string>(
    String(baseOptions.lossyCeiling ?? DEFAULT_OPTIONS.lossyCeiling ?? GIF_LOSSY_MAX)
  );
  const [colorsFloor, setColorsFloor] = useState<string>(
    String(baseOptions.colorsFloor ?? DEFAULT_OPTIONS.colorsFloor ?? GIF_COLORS_MIN)
  );
  const [optimizeLevel, setOptimizeLevel] = useState<GifOptimizeLevel>(
    baseOptions.optimizeLevel ?? DEFAULT_OPTIONS.optimizeLevel ?? 3
  );
  const [dither, setDither] = useState<GifDither>(
    baseOptions.dither ?? DEFAULT_OPTIONS.dither ?? 'floyd-steinberg'
  );

  useEffect(() => {
    if (!open) return;
    const p = PRESETS[0].build(baseOptions, currentSizeMB);
    setActivePreset('harder');
    setMaxBytesMB((p.maxBytes / (1024 * 1024)).toFixed(2));
    // R-79: presets only fill the three "shape" knobs they were
    // designed for. softMaxBytes / minSize / speed reset to whatever
    // the live OptionsForm currently holds — clicking a preset is
    // not supposed to silently overwrite knobs the preset didn't ask
    // about. The user can still hand-edit any of them below.
    setSoftMaxBytesMB((baseOptions.softMaxBytes / (1024 * 1024)).toFixed(2));
    setFps(String(p.fps));
    setMaxWidth(String(p.maxWidth));
    setMinSize(String(baseOptions.minSize));
    setSpeed(String(baseOptions.speed));
    // R-81 — same selective rule: if the preset names lossy/colors, use
    // it; otherwise fall back to the live OptionsForm value. -O level
    // and dither are NOT preset-driven (no semantic gain in flipping
    // them per preset) — they always follow baseOptions on open.
    setLossyCeiling(String(p.lossyCeiling ?? baseOptions.lossyCeiling ?? DEFAULT_OPTIONS.lossyCeiling ?? GIF_LOSSY_MAX));
    setColorsFloor(String(p.colorsFloor ?? baseOptions.colorsFloor ?? DEFAULT_OPTIONS.colorsFloor ?? GIF_COLORS_MIN));
    setOptimizeLevel(baseOptions.optimizeLevel ?? DEFAULT_OPTIONS.optimizeLevel ?? 3);
    setDither(baseOptions.dither ?? DEFAULT_OPTIONS.dither ?? 'floyd-steinberg');
  }, [open, baseOptions, currentSizeMB]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
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
    // softMaxBytes / minSize / speed left as-is so the user keeps any
    // hand-edits they already made when toggling between presets.
    // R-81 — for lossy/colors we follow the preset's intent: a preset
    // that explicitly names them overwrites; one that doesn't leaves
    // any hand-edit alone. -O level / dither are never touched by
    // presets at all (those are advanced-axis knobs).
    if (typeof next.lossyCeiling === 'number') setLossyCeiling(String(next.lossyCeiling));
    if (typeof next.colorsFloor === 'number') setColorsFloor(String(next.colorsFloor));
  };

  const handleRun = (): void => {
    const mb = Number(maxBytesMB);
    const softMb = Number(softMaxBytesMB);
    const f = Number(fps);
    const w = Number(maxWidth);
    const ms = Number(minSize);
    const sp = Number(speed);
    if (!Number.isFinite(mb) || mb <= 0) return;
    if (!Number.isFinite(f) || f < 1) return;
    if (!Number.isFinite(w) || w < 64) return;
    // softMaxBytes must stay <= maxBytes; if the user typed a larger
    // soft cap we silently clamp at confirm time rather than blocking
    // the dispatch — the renderer's onProcessOne already applies the
    // same invariant defensively but doing it here keeps the value
    // we send aligned with what the user sees.
    const maxBytesOut = Math.max(100 * 1024, Math.round(mb * 1024 * 1024));
    const req: ManualOptimizeRequest = {
      maxBytes: maxBytesOut,
      fps: clampInt(f, 1, 60),
      maxWidth: clampInt(w, 64, 4096)
    };
    if (Number.isFinite(softMb) && softMb > 0) {
      const softCap = Math.min(maxBytesOut, Math.round(softMb * 1024 * 1024));
      req.softMaxBytes = Math.max(100 * 1024, softCap);
    }
    if (Number.isFinite(ms) && ms >= 64) {
      req.minSize = clampInt(ms, 64, 4096);
    }
    if (Number.isFinite(sp) && sp > 0) {
      req.speed = clampNum(sp, 0.25, 4);
    }
    // R-81 — gifsicle knobs. Each one is independently optional;
    // omission means "leave the form's current options.* untouched
    // for THIS task" (matches the rest of the modal's contract).
    const lc = Number(lossyCeiling);
    if (Number.isFinite(lc)) {
      req.lossyCeiling = clampInt(lc, 0, GIF_LOSSY_MAX);
    }
    const cf = Number(colorsFloor);
    if (Number.isFinite(cf)) {
      req.colorsFloor = clampInt(cf, GIF_COLORS_MIN, GIF_COLORS_MAX);
    }
    if ((GIF_OPTIMIZE_LEVELS as readonly number[]).includes(optimizeLevel)) {
      req.optimizeLevel = optimizeLevel;
    }
    if ((GIF_DITHER_MODES as readonly string[]).includes(dither)) {
      req.dither = dither;
    }
    onConfirm(req);
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
              <span>软目标 (MB)</span>
              <input
                type="number"
                min={0.1}
                step={0.1}
                value={softMaxBytesMB}
                onChange={(e) => setSoftMaxBytesMB(e.target.value)}
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
            <label>
              <span>最小尺寸 (px)</span>
              <input
                type="number"
                min={64}
                max={4096}
                step={1}
                value={minSize}
                onChange={(e) => setMinSize(e.target.value)}
              />
            </label>
            <label>
              <span>速度 (×)</span>
              <input
                type="number"
                min={0.25}
                max={4}
                step={0.05}
                value={speed}
                onChange={(e) => setSpeed(e.target.value)}
              />
            </label>
            {/* R-81 — gifsicle 4 knobs surfaced into 手动二次优化。
                lossy/colors 是 ceiling/floor (compressLoop adaptive 搜索的边界);
                -O / dither 是每一次 gifsicle invocation 的 lock。 */}
            <label>
              <span>lossy 上限 (0-200)</span>
              <input
                type="number"
                min={0}
                max={GIF_LOSSY_MAX}
                step={5}
                value={lossyCeiling}
                onChange={(e) => setLossyCeiling(e.target.value)}
              />
            </label>
            <label>
              <span>colors 下限 (2-256)</span>
              <input
                type="number"
                min={GIF_COLORS_MIN}
                max={GIF_COLORS_MAX}
                step={2}
                value={colorsFloor}
                onChange={(e) => setColorsFloor(e.target.value)}
              />
            </label>
            <label>
              <span>-O 级别</span>
              <select
                value={String(optimizeLevel)}
                onChange={(e) => {
                  const lvl = Number(e.target.value) as GifOptimizeLevel;
                  if ((GIF_OPTIMIZE_LEVELS as readonly number[]).includes(lvl)) setOptimizeLevel(lvl);
                }}
              >
                {GIF_OPTIMIZE_LEVELS.map((lvl) => (
                  <option key={lvl} value={String(lvl)}>{`-O${lvl}`}</option>
                ))}
              </select>
            </label>
            <label>
              <span>dither</span>
              <select
                value={dither}
                onChange={(e) => {
                  const d = e.target.value as GifDither;
                  if ((GIF_DITHER_MODES as readonly string[]).includes(d)) setDither(d);
                }}
              >
                {GIF_DITHER_MODES.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
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
