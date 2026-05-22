import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ToolboxKind, ToolboxOptimizeMethod, ToolboxParams, TaskProgress } from '../../shared/types';
import { TOOLBOX_INPUT_EXTENSIONS } from '../../shared/types';
import { defaultParamsFor, useToolbox } from './useToolbox';
import { CropBox, type CropRect } from './CropBox';
import { useToolboxLineage } from './useToolboxLineage';
import { ToolboxLineageModal } from './ToolboxLineageModal';

/**
 * R-35 / R-36 — ToolboxPanel.
 *
 * Layout (top→bottom):
 *   1. Tool tabs row — 4 chips switching ToolboxKind.
 *   2. Drop zone + 「选择文件」 button (dual track input).
 *   3. Two-column body:
 *        left  → queued jobs list (per-row status, progress bar, remove btn)
 *        right → params form (varies per kind)
 *   4. Footer — Start / Cancel / Clear; "Last output dir" link when present.
 *
 * R-36 deltas:
 *   - handlePickClick now surfaces dialog/IPC errors via inline notice
 *     instead of swallowing them; users were perceiving the silent catch
 *     as "the button is broken".
 *   - gif-optimize ParamForm exposes a `method` selector mirroring ezgif's
 *     Optimization-method offering (lossy / colors / drop frames / etc).
 *     Selecting a method dynamically reveals only the sub-fields that
 *     method actually consumes, avoiding noise.
 */

const KIND_OPTIONS: ReadonlyArray<{ kind: ToolboxKind; label: string; hint: string }> = [
  { kind: 'video-to-gif', label: 'Video → GIF', hint: '把视频转换为 GIF (调色板优化 + 二次压缩)' },
  { kind: 'video-to-webp', label: 'Video → WebP', hint: '把视频转换为动画 WebP (libwebp_anim)' },
  { kind: 'gif-resize', label: 'GIF Resize', hint: '保持比例缩放 GIF 宽度' },
  { kind: 'gif-optimize', label: 'GIF Optimize', hint: 'gifsicle 多种优化策略可选' },
  { kind: 'trim', label: 'Trim', hint: '裁剪 GIF / WebP 的时间区间(无损切片)' },
  { kind: 'speed', label: 'Speed', hint: '调整 GIF / WebP 播放速度,0.25× ~ 4×' },
  { kind: 'reverse', label: 'Reverse', hint: '将 GIF / WebP 倒放(从尾到头播放)' },
  { kind: 'rotate', label: 'Rotate', hint: '旋转 0/90/180/270° 并可叠加水平/垂直翻转' },
  { kind: 'crop', label: 'Crop', hint: '可视化框选裁剪区域(仅单文件)' },
  { kind: 'gif-webp-convert', label: 'GIF ↔ WebP', hint: 'GIF / 动画 WebP 互转' }
];

const OPTIMIZE_METHOD_OPTIONS: ReadonlyArray<{
  value: ToolboxOptimizeMethod;
  label: string;
  hint: string;
}> = [
  { value: 'lossy', label: 'Lossy GIF', hint: '有损压缩 (gifsicle --lossy)' },
  { value: 'color-reduction', label: 'Color reduction', hint: '减色压缩,blend-diversity 算法' },
  { value: 'color-dither', label: 'Color reduction + dither', hint: '减色 + 抖动,抹平色阶' },
  { value: 'drop-every-nth', label: 'Drop every Nth frame', hint: '隔帧抽样 (例如每 2 帧丢 1)' },
  { value: 'drop-duplicates', label: 'Drop duplicate frames', hint: '去重帧,只保留差异帧' },
  { value: 'optimize-transparency', label: 'Optimize transparency', hint: '透明优化 (web-safe colormap)' },
  { value: 'wechat-safe', label: 'WeChat-safe (公众号适配)', hint: '全帧重铸 + 自动降帧 ≤300 + 剥水印,绕开公众号「来源信息无法识别」' },
  { value: 'budget', label: 'Size budget (4-Phase)', hint: '指定目标体积,自动迭代压缩到 ≤ KB' }
];

function fmtPct(p?: number): string {
  if (typeof p !== 'number' || !Number.isFinite(p)) return '';
  return `${Math.round(Math.max(0, Math.min(100, p)))}%`;
}

/** R-39 — ezgif-style file size: 1.5MiB / 412KiB / 980B. We pick MiB as
 *  the base because that's what ezgif itself displays (it uses binary
 *  units, not decimal MB). */
function fmtSize(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)}MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GiB`;
}

/** R-39 — ezgif-style "00:00:08.40" length string. We always emit the
 *  HH:MM:SS.cc shape so meta lines line up regardless of duration. */
function fmtDuration(sec?: number): string {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return '';
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  const ssStr = ss.toFixed(2).padStart(5, '0');
  return `${hh.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')}:${ssStr}`;
}

/** R-39 — extension probe used by the meta string ("type: gif"). */
function fmtType(p: string): string {
  const dot = p.lastIndexOf('.');
  if (dot < 0) return '';
  return p.slice(dot + 1).toLowerCase();
}

/** R-39 — relative time string for history rows ("3 分钟前", "刚刚",
 *  "昨天 14:32"). Falls back to absolute timestamp for entries older
 *  than 7 days so the audit log never lies about "2 周前". */
function fmtAgo(ts: number): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '';
  const now = Date.now();
  const diff = Math.max(0, now - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return '刚刚';
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  const d = new Date(ts);
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** R-39 — short label for each ToolboxKind, used by history rows. */
const KIND_LABELS: Record<ToolboxKind, string> = {
  'video-to-gif': 'Video → GIF',
  'video-to-webp': 'Video → WebP',
  'gif-resize': 'GIF Resize',
  'gif-optimize': 'GIF Optimize',
  trim: 'Trim',
  speed: 'Speed',
  reverse: 'Reverse',
  rotate: 'Rotate',
  crop: 'Crop',
  'gif-webp-convert': 'GIF ↔ WebP'
};

function statusLabel(p?: TaskProgress): string {
  // R-67 — Status badge text is now strictly short (≤ 4 zh chars). The
  // long detail (e.g. `reverse (audio=mute)` for the reverse tool) is
  // surfaced via `statusDetail` below and rendered on its own line so
  // it can't push the fixed 160px badge column past its bounds. Pre
  // R-67 the badge held `执行中 · reverse (audio=mute)` and the right
  // half got clipped by `overflow: hidden` on the status cell.
  if (!p) return '排队中';
  switch (p.status) {
    case 'pending': return '排队中';
    case 'downloading':
    case 'probing':
    case 'segmenting':
    case 'converting':
    case 'compressing':
      return '执行中';
    case 'done': return '完成';
    case 'failed': return '失败';
    case 'cancelled': return '已取消';
    case 'skipped': return '已跳过';
    default: return p.status;
  }
}

/**
 * R-67 — Long secondary detail for the running / failed states. We
 * render this as a tiny line under the file name so the badge column
 * can stay narrow without ever clipping. Returns null for states that
 * have no useful sub-text (pending / done / cancelled / skipped).
 */
function statusDetail(p?: TaskProgress): string | null {
  if (!p) return null;
  switch (p.status) {
    case 'downloading':
    case 'probing':
    case 'segmenting':
    case 'converting':
    case 'compressing':
      return p.message || null;
    case 'failed':
      return p.error || null;
    default:
      return null;
  }
}

function statusBadgeClass(p?: TaskProgress): string {
  if (!p) return 'tb-badge tb-badge-pending';
  switch (p.status) {
    case 'done': return 'tb-badge tb-badge-done';
    case 'failed': return 'tb-badge tb-badge-failed';
    case 'cancelled': return 'tb-badge tb-badge-cancelled';
    case 'skipped': return 'tb-badge tb-badge-skipped';
    case 'pending': return 'tb-badge tb-badge-pending';
    default: return 'tb-badge tb-badge-running';
  }
}

interface NumFieldProps {
  label: string;
  value: number | undefined;
  onChange: (n: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  placeholder?: string;
}

function NumField({ label, value, onChange, min, max, step, hint, placeholder }: NumFieldProps): JSX.Element {
  return (
    <label className="tb-field">
      <span className="tb-field-label">{label}</span>
      <input
        type="number"
        className="tb-input"
        value={typeof value === 'number' && Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        step={step ?? 1}
        placeholder={placeholder}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === '') { onChange(undefined); return; }
          const n = Number(raw);
          if (!Number.isFinite(n)) { onChange(undefined); return; }
          onChange(n);
        }}
      />
      {hint ? <span className="tb-field-hint">{hint}</span> : null}
    </label>
  );
}

interface SelectFieldProps<T extends string> {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; hint?: string }>;
  onChange: (v: T) => void;
  hint?: string;
}

function SelectField<T extends string>({ label, value, options, onChange, hint }: SelectFieldProps<T>): JSX.Element {
  return (
    <label className="tb-field">
      <span className="tb-field-label">{label}</span>
      <select
        className="tb-input tb-select"
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value} title={opt.hint}>
            {opt.label}
          </option>
        ))}
      </select>
      {hint ? <span className="tb-field-hint">{hint}</span> : null}
    </label>
  );
}

interface CheckboxFieldProps {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}

/** R-37 — minimal boolean toggle, used by Rotate's flipH/flipV. Re-uses
 *  the `tb-field` container so spacing matches NumField/SelectField. */
function CheckboxField({ label, checked, onChange, hint }: CheckboxFieldProps): JSX.Element {
  return (
    <label className="tb-field tb-field-check">
      <span className="tb-field-label">
        <input
          type="checkbox"
          className="tb-check"
          checked={!!checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{label}</span>
      </span>
      {hint ? <span className="tb-field-hint">{hint}</span> : null}
    </label>
  );
}

/** R-38 — natural size + duration of the (single) preview job, used by
 *  Trim (NumField max bound + helper text) and Crop (CropBox needs source
 *  pixel dimensions to convert drag positions). null means "not yet
 *  probed" — render fallbacks treat this as "no info available". */
export interface MediaInfo {
  width: number;
  height: number;
  durationSec: number;
  /** Data URL for the first-frame preview (Crop only). May be empty
   *  while loading or when the probe failed. */
  previewDataUrl?: string;
}

/** R-38 — Crop sub-form. Lifted out of ParamForm so we can use refs +
 *  effects locally without polluting the bigger ParamForm switch. */
function CropForm({ params, setParams, mediaInfo }: {
  params: ToolboxParams;
  setParams: (p: ToolboxParams | ((prev: ToolboxParams) => ToolboxParams)) => void;
  mediaInfo: MediaInfo | null;
}): JSX.Element {
  const imgRef = useRef<HTMLImageElement | null>(null);
  // Re-render when the <img> element resolves so CropBox can compute its
  // bounding box (it reads imgRef.current's getBoundingClientRect).
  const [, force] = useState(0);
  useEffect(() => {
    const el = imgRef.current;
    if (!el) return;
    if (el.complete && el.naturalWidth > 0) { force((n) => n + 1); return; }
    const onLoad = () => force((n) => n + 1);
    el.addEventListener('load', onLoad);
    return () => el.removeEventListener('load', onLoad);
  }, [mediaInfo?.previewDataUrl]);

  const naturalSize = mediaInfo
    ? { w: mediaInfo.width, h: mediaInfo.height }
    : { w: 0, h: 0 };

  const cropRect: CropRect | undefined =
    typeof params.cropX === 'number' && typeof params.cropY === 'number' &&
    typeof params.cropW === 'number' && typeof params.cropH === 'number'
      ? { x: params.cropX, y: params.cropY, w: params.cropW, h: params.cropH }
      : undefined;

  const handleRectChange = useCallback((rect: CropRect | undefined) => {
    setParams((prev) => ({
      ...prev,
      cropX: rect?.x !== undefined ? Math.round(rect.x) : undefined,
      cropY: rect?.y !== undefined ? Math.round(rect.y) : undefined,
      cropW: rect?.w !== undefined ? Math.round(rect.w) : undefined,
      cropH: rect?.h !== undefined ? Math.round(rect.h) : undefined
    }));
  }, [setParams]);

  if (!mediaInfo || !mediaInfo.previewDataUrl) {
    return (
      <div className="tb-params">
        <div className="tb-info-row">
          {mediaInfo === null ? '请先添加一个文件以加载预览' : '正在生成预览…'}
        </div>
        <div className="tb-info-row tb-muted">仅支持单文件处理。</div>
      </div>
    );
  }

  return (
    <div className="tb-params tb-crop-pane">
      <div className="tb-info-row">
        原始尺寸 {mediaInfo.width}×{mediaInfo.height} · 在预览图上拖拽框选裁剪区域
      </div>
      <div
        className="tb-crop-canvas"
        style={{ position: 'relative', overflow: 'hidden', background: '#000' }}
      >
        <img
          ref={imgRef}
          src={mediaInfo.previewDataUrl}
          alt="crop-preview"
          style={{ display: 'block', maxWidth: '100%', height: 'auto', userSelect: 'none' }}
          draggable={false}
        />
        <CropBox
          naturalSize={naturalSize}
          targetEl={imgRef.current}
          value={cropRect}
          onChange={handleRectChange}
        />
      </div>
      <div className="tb-crop-fields">
        <NumField
          label="X"
          value={params.cropX}
          onChange={(v) => setParams((prev) => ({ ...prev, cropX: typeof v === 'number' ? Math.round(v) : undefined }))}
          min={0}
          max={mediaInfo.width}
        />
        <NumField
          label="Y"
          value={params.cropY}
          onChange={(v) => setParams((prev) => ({ ...prev, cropY: typeof v === 'number' ? Math.round(v) : undefined }))}
          min={0}
          max={mediaInfo.height}
        />
        <NumField
          label="W"
          value={params.cropW}
          onChange={(v) => setParams((prev) => ({ ...prev, cropW: typeof v === 'number' ? Math.round(v) : undefined }))}
          min={2}
          max={mediaInfo.width}
        />
        <NumField
          label="H"
          value={params.cropH}
          onChange={(v) => setParams((prev) => ({ ...prev, cropH: typeof v === 'number' ? Math.round(v) : undefined }))}
          min={2}
          max={mediaInfo.height}
        />
      </div>
      <div className="tb-info-row tb-muted">仅支持单文件处理;按 Esc 清除选区。</div>
    </div>
  );
}

function ParamForm({ kind, params, setParams, mediaInfo, onTargetFormatTouch }: {
  kind: ToolboxKind;
  params: ToolboxParams;
  setParams: (p: ToolboxParams | ((prev: ToolboxParams) => ToolboxParams)) => void;
  mediaInfo: MediaInfo | null;
  // R-43 — fires once when the user clicks either radio in the
  // gif-webp-convert form. Lets the parent disable the auto-flip
  // effect so the user's choice survives queue churn.
  onTargetFormatTouch?: () => void;
}): JSX.Element {
  const patch = useCallback((k: keyof ToolboxParams, v: number | undefined) => {
    setParams((prev) => ({ ...prev, [k]: v }));
  }, [setParams]);

  // R-37 — generic patcher used by Speed / Reverse / Rotate (boolean +
  // string + number params). Kept separate from `patch` to preserve the
  // narrower number-only type signature `patch` already has elsewhere.
  const patchAny = useCallback(<K extends keyof ToolboxParams>(k: K, v: ToolboxParams[K]) => {
    setParams((prev) => ({ ...prev, [k]: v }));
  }, [setParams]);

  const setMethod = useCallback((m: ToolboxOptimizeMethod) => {
    setParams((prev) => {
      // Reset only fields that don't apply to the new method, so the user
      // doesn't accidentally carry stale `dropEveryN=2` into a `lossy` run.
      const next: ToolboxParams = { ...prev, method: m };
      if (m === 'lossy') {
        next.lossy = prev.lossy ?? 80;
      }
      if (m === 'color-reduction' || m === 'color-dither') {
        next.colors = prev.colors ?? 128;
      }
      if (m === 'drop-every-nth') {
        next.dropEveryN = prev.dropEveryN ?? 2;
      }
      if (m === 'wechat-safe') {
        // wechat-safe reuses the lossy slider so the user has a knob
        // for "smaller vs cleaner". Default to 80 like the CLI script.
        next.lossy = prev.lossy ?? 80;
      }
      if (m === 'budget') {
        next.maxBytes = prev.maxBytes ?? 2 * 1024 * 1024;
      }
      return next;
    });
  }, [setParams]);

  if (kind === 'video-to-gif') {
    return (
      <div className="tb-params">
        <NumField label="FPS" value={params.fps} onChange={(v) => patch('fps', v)} min={1} max={60} hint="1–60" />
        <NumField label="宽度 (px)" value={params.width} onChange={(v) => patch('width', v)} min={16} max={4096} hint="保持比例,留空则不缩放" />
        <NumField label="开始 (秒)" value={params.startSec} onChange={(v) => patch('startSec', v)} min={0} step={0.1} placeholder="0" />
        <NumField label="结束 (秒)" value={params.endSec} onChange={(v) => patch('endSec', v)} min={0} step={0.1} placeholder="尾部" />
        <NumField label="目标体积 (KB)" value={params.maxBytes ? Math.round(params.maxBytes / 1024) : undefined}
          onChange={(v) => patch('maxBytes', v ? v * 1024 : undefined)} min={0} placeholder="不限" hint="开启后启用 4-Phase 压缩" />
      </div>
    );
  }
  if (kind === 'video-to-webp') {
    return (
      <div className="tb-params">
        <NumField label="FPS" value={params.fps} onChange={(v) => patch('fps', v)} min={1} max={60} />
        <NumField label="宽度 (px)" value={params.width} onChange={(v) => patch('width', v)} min={16} max={4096} hint="留空则不缩放" />
        <NumField label="质量 (0-100)" value={params.quality} onChange={(v) => patch('quality', v)} min={0} max={100} />
        <NumField label="循环 (0=无限)" value={params.loop} onChange={(v) => patch('loop', v)} min={0} />
        <NumField label="开始 (秒)" value={params.startSec} onChange={(v) => patch('startSec', v)} min={0} step={0.1} />
        <NumField label="结束 (秒)" value={params.endSec} onChange={(v) => patch('endSec', v)} min={0} step={0.1} />
      </div>
    );
  }
  if (kind === 'gif-resize') {
    return (
      <div className="tb-params">
        <NumField label="目标宽度 (px)" value={params.targetWidth} onChange={(v) => patch('targetWidth', v)} min={16} max={4096} hint="保持长宽比" />
      </div>
    );
  }
  if (kind === 'trim') {
    // R-38 — when probeMedia has succeeded we expose the actual source
    // duration so the user knows the upper bound for endSec. Without
    // mediaInfo the form gracefully degrades to free-form numeric inputs.
    const dur = mediaInfo?.durationSec;
    const durLabel = typeof dur === 'number' && dur > 0
      ? `原始时长 ${dur.toFixed(2)} 秒`
      : '请先添加文件以获取时长';
    return (
      <div className="tb-params">
        <div className="tb-info-row" data-testid="trim-duration-info">{durLabel}</div>
        <NumField
          label="开始 (秒)"
          value={params.startSec}
          onChange={(v) => patch('startSec', v)}
          min={0}
          max={typeof dur === 'number' && dur > 0 ? dur : undefined}
          step={0.1}
          placeholder="0"
          hint="留空 = 0"
        />
        <NumField
          label="结束 (秒)"
          value={params.endSec}
          onChange={(v) => patch('endSec', v)}
          min={0}
          max={typeof dur === 'number' && dur > 0 ? dur : undefined}
          step={0.1}
          placeholder={typeof dur === 'number' && dur > 0 ? dur.toFixed(2) : 'EOF'}
          hint={typeof dur === 'number' && dur > 0 ? `留空 = ${dur.toFixed(2)}s (文件末尾)` : '留空 = 文件末尾'}
        />
      </div>
    );
  }
  if (kind === 'speed') {
    // The picker exposes the "natural" speed presets that cover ~95% of
    // use cases. Users wanting a specific factor can still type it via
    // the NumField fallback below the select.
    const SPEED_OPTIONS = [
      { value: '0.25', label: '0.25× (slowest)' },
      { value: '0.5', label: '0.5×' },
      { value: '0.75', label: '0.75×' },
      { value: '1', label: '1× (no-op)' },
      { value: '1.25', label: '1.25×' },
      { value: '1.5', label: '1.5×' },
      { value: '2', label: '2×' },
      { value: '3', label: '3×' },
      { value: '4', label: '4× (fastest)' }
    ] as const;
    const cur = typeof params.speedFactor === 'number' ? params.speedFactor : 1;
    const closestPreset = SPEED_OPTIONS.reduce((best, opt) => {
      const v = Number(opt.value);
      return Math.abs(v - cur) < Math.abs(Number(best.value) - cur) ? opt : best;
    }, SPEED_OPTIONS[3]);
    return (
      <div className="tb-params">
        <SelectField<string>
          label="速度"
          value={closestPreset.value}
          options={SPEED_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          onChange={(v) => patchAny('speedFactor', Number(v))}
          hint="0.25× ~ 4×;音频自动 atempo 链"
        />
        <NumField
          label="自定义倍率"
          value={params.speedFactor}
          onChange={(v) => patch('speedFactor', v)}
          min={0.25}
          max={4}
          step={0.05}
          placeholder="1.0"
          hint="覆盖上方下拉,精确到 0.05"
        />
      </div>
    );
  }
  if (kind === 'reverse') {
    // R-41 — Reverse accepts .gif and .webp (animated). Both formats
    // have no audio track to worry about, so the params panel only
    // contains an info row describing the operation.
    return (
      <div className="tb-params">
        <div className="tb-info-row">将整段 GIF / WebP 倒放(从最后一帧播到第一帧)。</div>
      </div>
    );
  }
  if (kind === 'rotate') {
    const ROTATE_OPTIONS = [
      { value: '0', label: '0° (不旋转)' },
      { value: '90', label: '90° 顺时针' },
      { value: '180', label: '180°' },
      { value: '270', label: '270° (= 90° 逆时针)' }
    ] as const;
    const deg = typeof params.rotateDegrees === 'number' ? String(params.rotateDegrees) : '90';
    return (
      <div className="tb-params">
        <SelectField<string>
          label="旋转角度"
          value={deg}
          options={ROTATE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          onChange={(v) => patchAny('rotateDegrees', Number(v))}
        />
        <CheckboxField
          label="水平翻转 (flipH)"
          checked={!!params.flipH}
          onChange={(v) => patchAny('flipH', v)}
          hint="在旋转之后再翻转"
        />
        <CheckboxField
          label="垂直翻转 (flipV)"
          checked={!!params.flipV}
          onChange={(v) => patchAny('flipV', v)}
        />
      </div>
    );
  }
  if (kind === 'crop') {
    // R-38 — Crop renders the first-frame preview img inside a relative
    // container, then layers CropBox over it. The (x, y, w, h) the user
    // drags is in source-pixel coords (CropBox needs naturalSize to do
    // the screen ↔ natural transform); we mirror those numbers into
    // params so the start payload carries cropX/Y/W/H.
    return <CropForm params={params} setParams={setParams} mediaInfo={mediaInfo} />;
  }
  if (kind === 'gif-webp-convert') {
    // R-42 — GIF ↔ WebP convert: a single radio group that decides the
    // output container. Default flips to the *opposite* of the queue's
    // input extension (set by ToolboxPanel via an effect when the queue
    // first gains a row), so the user typically just hits Start. The
    // copy spells out "input → output" so there's no doubt about the
    // direction.
    const target: 'gif' | 'webp' = params.targetFormat === 'gif' ? 'gif' : 'webp';
    const handleRadio = (next: 'gif' | 'webp') => {
      onTargetFormatTouch?.();
      patchAny('targetFormat', next);
    };
    return (
      <div className="tb-params">
        <div className="tb-info-row">把 GIF 与动画 WebP 互转。已选文件会按下面选择的格式重新编码。</div>
        <div className="tb-row">
          <span id="gwc-target-label" className="tb-label">输出格式</span>
          <div className="tb-radio-group" role="radiogroup" aria-labelledby="gwc-target-label">
            <label className="tb-radio">
              <input
                type="radio"
                name="gwc-target"
                value="gif"
                checked={target === 'gif'}
                onChange={() => handleRadio('gif')}
              />
              <span>GIF (.gif)</span>
            </label>
            <label className="tb-radio">
              <input
                type="radio"
                name="gwc-target"
                value="webp"
                checked={target === 'webp'}
                onChange={() => handleRadio('webp')}
              />
              <span>WebP (.webp)</span>
            </label>
          </div>
        </div>
      </div>
    );
  }
  // gif-optimize — method picker drives which sub-fields render.
  const method: ToolboxOptimizeMethod = params.method ?? 'lossy';
  return (
    <div className="tb-params">
      <SelectField<ToolboxOptimizeMethod>
        label="Optimization method"
        value={method}
        options={OPTIMIZE_METHOD_OPTIONS}
        onChange={setMethod}
        hint="参考 ezgif 同名方法"
      />
      {method === 'lossy' ? (
        <NumField label="Lossy 强度 (0-200)" value={params.lossy} onChange={(v) => patch('lossy', v)} min={0} max={200} hint="80 是常用甜点" />
      ) : null}
      {method === 'wechat-safe' ? (
        <>
          <div className="tb-info-row">
            ① ffmpeg 全帧重铸(无 local CT / 无 application extension / 关闭 transdiff)
            <br />② gifsicle -O0 剥 extension/comment + lossy 重打包(不重引入 diff-frame)
            <br />③ 帧数 &gt; 300 时自动抽帧(95% 安全 margin)
          </div>
          <NumField label="Lossy 强度 (0-200)" value={params.lossy} onChange={(v) => patch('lossy', v)} min={0} max={200} hint="0=禁用 / 80=常用甜点;越高体积越小但伪影越明显" />
        </>
      ) : null}
      {method === 'color-reduction' || method === 'color-dither' ? (
        <NumField label="颜色数 (2-256)" value={params.colors} onChange={(v) => patch('colors', v)} min={2} max={256} hint="越低体积越小" />
      ) : null}
      {method === 'drop-every-nth' ? (
        <NumField label="每 N 帧丢 1 (2-10)" value={params.dropEveryN} onChange={(v) => patch('dropEveryN', v)} min={2} max={10} hint="例如 2 = 隔帧" />
      ) : null}
      {method === 'budget' ? (
        <>
          <NumField label="目标体积 (KB)" value={params.maxBytes ? Math.round(params.maxBytes / 1024) : undefined}
            onChange={(v) => patch('maxBytes', v ? v * 1024 : undefined)} min={50} placeholder="2048"
            hint="启动 4-Phase 自动压缩到 ≤ KB" />
          <NumField label="软阈值 (KB)" value={params.softMaxBytes ? Math.round(params.softMaxBytes / 1024) : undefined}
            onChange={(v) => patch('softMaxBytes', v ? v * 1024 : undefined)} min={50} placeholder="可选"
            hint="达到即提前停止" />
        </>
      ) : null}
    </div>
  );
}

/**
 * R-TB-CHAIN-V2.6 — small thumbnail tile for the toolbox history list.
 *
 * Default state: shows the static first-frame poster (driven by the
 * useFileThumbnail hook → `toolbox:firstFrame` IPC). On mouseenter we
 * swap to a live <img src=giftk-local://abs-path> which auto-plays for
 * animated GIF/WebP. mouseleave restores the static poster. For .mp4
 * we keep the poster static (rendering a video element on hover would
 * spawn a decoder for every row).
 *
 * Why hover-only animation:
 *   The history list often holds 14+ entries. Auto-playing every GIF
 *   on mount cost ~50-200MB of decoder memory and dropped frames on
 *   mid-tier laptops. Hover gives the user the "is this the right one
 *   I'm looking for" affordance without the per-row decode tax.
 */
function TbHistoryThumb({
  filePath,
  posterDataUrl
}: {
  filePath: string | null | undefined;
  posterDataUrl: string | null | undefined;
}): JSX.Element {
  const [hover, setHover] = useState(false);
  const lower = (filePath ?? '').toLowerCase();
  const isAnimated = lower.endsWith('.gif') || lower.endsWith('.webp');
  const liveUrl = useMemo(() => {
    // Inline path-to-giftk-local conversion — mirrors
    // ToolboxLineageModal.pathToLocalUrl. Kept inline to avoid an
    // import cycle (ToolboxLineageModal already imports from here).
    if (!filePath) return '';
    const sep = filePath.includes('\\') ? '\\' : '/';
    const parts = filePath.split(sep).map((seg) => encodeURIComponent(seg));
    const isWin = /^[a-zA-Z]:/.test(filePath);
    const joined = isWin ? '/' + parts.filter(Boolean).join('/') : parts.join('/');
    return `giftk-local://localhost${joined}`;
  }, [filePath]);

  const showLive = hover && isAnimated && !!liveUrl;
  const src = showLive ? liveUrl : (posterDataUrl ?? '');

  return (
    <div
      className="tb-history-thumb"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-hidden="true"
    >
      {src ? (
        <img src={src} alt="" loading="lazy" />
      ) : (
        <span className="tb-history-thumb-fallback">🎞️</span>
      )}
    </div>
  );
}

export function ToolboxPanel(): JSX.Element {
  const tb = useToolbox();
  // R-TB-CHAIN-V2 — progressive (one-step-at-a-time) chain. The hook
  // owns its own lineage state; the panel only renders the breadcrumb,
  // the chip menu, the per-kind ParamForm, and a single "继续 →" button.
  // The lineage is dormant (`nodes.length===0`) on a fresh panel mount;
  // entering chain mode is triggered by clicking 「继续处理 →」 on a
  // *done* history row, which seeds the lineage with that row's primary
  // output as the root node.
  const lineage = useToolboxLineage();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  // The lineage section keeps its own "draft" of the next kind + params
  // so the user can change their mind before clicking 「继续 →」 without
  // touching tb.kind / tb.params (which still drive the batch flow).
  const [lineageDraftKind, setLineageDraftKind] = useState<ToolboxKind | null>(null);
  const [lineageDraftParams, setLineageDraftParams] = useState<ToolboxParams>({});

  const accept = useMemo(() => TOOLBOX_INPUT_EXTENSIONS[tb.kind].join(','), [tb.kind]);
  const allowedExts = useMemo(
    () => new Set(TOOLBOX_INPUT_EXTENSIONS[tb.kind].map((e) => e.toLowerCase())),
    [tb.kind]
  );

  // R-38 / R-39 — probe + first-frame thumbnail per job. We cache by the
  // input path so reordering / removing rows doesn't re-trigger expensive
  // ffmpeg work. The map drives:
  //   • per-row thumbnail (img column in the queue list, R-39)
  //   • per-row file-info line (size · WxH · frames · duration, R-39)
  //   • Trim's "原始时长 X.XX 秒" hint (R-38)
  //   • Crop's preview canvas (R-38)
  // Thumbnails are skipped when only meta is needed; Crop forces one for
  // jobs[0] because the entire panel renders the canvas there.
  interface JobMedia extends MediaInfo {
    /** sizeBytes lifts straight from main's statSync output. */
    sizeBytes?: number;
    /** Frames per second. 0 when unknown / static GIF. */
    frameRate?: number;
    /** Total frames in the source. */
    nbFrames?: number;
    /** When true, a thumbnail fetch is in flight or has been requested. */
    hasThumbnail?: boolean;
  }
  const [jobMedia, setJobMedia] = useState<Record<string, JobMedia>>({});

  const previewPath = tb.jobs[0]?.inputPath ?? null;
  const queuePaths = useMemo(() => {
    // R-TB-CHAIN-V2 — also probe every lineage node path so the
    // breadcrumb's current-product preview (thumb + meta line) shares
    // the same jobMedia cache as the batch jobs queue. The probe loop
    // dedupes by path so a file in both contexts is fetched once.
    //
    // R-TB-CHAIN-V2.6 — additionally probe history-row preview paths
    // (output for done entries, input fallback otherwise) so the new
    // history list thumbnails populate without a second hook.
    const fromJobs = tb.jobs.map((j) => j.inputPath);
    const fromLineage = lineage.nodes.map((n) => n.path);
    const fromHistory: string[] = [];
    for (const h of tb.toolboxHistory) {
      const pick = h.status === 'done' && h.outputs[0] ? h.outputs[0] : h.inputPath;
      if (pick) fromHistory.push(pick);
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of [...fromJobs, ...fromLineage, ...fromHistory]) {
      if (!seen.has(p)) { seen.add(p); out.push(p); }
    }
    return out;
  }, [tb.jobs, lineage.nodes, tb.toolboxHistory]);

  // R-39 — probe + thumbnail every queued job (newest first). We process
  // sequentially to avoid spawning N ffmpeg children at once for a large
  // batch; each iteration short-circuits when the cache already has data.
  useEffect(() => {
    let cancelled = false;
    if (queuePaths.length === 0) return;
    const bridge = (typeof window !== 'undefined' ? window.giftk : undefined) as
      | (Window['giftk'] & {
          toolboxProbeMedia?: (p: string) => Promise<{
            width: number; height: number; durationSec: number; frameRate: number; nbFrames: number; sizeBytes: number;
          }>;
          toolboxFirstFrame?: (p: string) => Promise<{ dataUrl: string }>;
        })
      | undefined;
    if (!bridge || typeof bridge.toolboxProbeMedia !== 'function') return;

    (async () => {
      for (const p of queuePaths) {
        if (cancelled) return;
        const cached = jobMedia[p];
        const needsProbe = !cached || cached.width === 0;
        const needsThumb = !cached?.previewDataUrl && typeof bridge.toolboxFirstFrame === 'function';
        if (!needsProbe && !needsThumb) continue;
        try {
          let merged: JobMedia = cached ?? { width: 0, height: 0, durationSec: 0 };
          if (needsProbe) {
            const probed = await bridge.toolboxProbeMedia!(p);
            if (cancelled) return;
            merged = {
              ...merged,
              width: probed.width,
              height: probed.height,
              durationSec: probed.durationSec,
              frameRate: probed.frameRate,
              nbFrames: probed.nbFrames,
              sizeBytes: probed.sizeBytes
            };
            // Push partial state immediately so the meta line appears
            // before the (slower) thumbnail finishes rendering.
            setJobMedia((prev) => ({ ...prev, [p]: merged }));
          }
          if (needsThumb) {
            const ff = await bridge.toolboxFirstFrame!(p);
            if (cancelled) return;
            merged = { ...merged, previewDataUrl: ff?.dataUrl, hasThumbnail: true };
            setJobMedia((prev) => ({ ...prev, [p]: merged }));
          }
        } catch {
          // Best-effort; on failure we leave the row without meta/thumb
          // and the UI degrades to a basenames-only display.
        }
      }
    })();
    return () => { cancelled = true; };
    // jobMedia intentionally excluded — we read the latest via closure
    // and only want to re-run when the queue itself changes (or the
    // panel mounts). Including it would re-run on every cache write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queuePaths]);

  // mediaInfo for the form panel — picks the entry corresponding to
  // jobs[0]. ParamForm only cares about Trim's duration and Crop's
  // preview, both of which are driven by the first queued file.
  const mediaInfo: MediaInfo | null = previewPath ? (jobMedia[previewPath] ?? null) : null;

  // R-42 / R-43 — When the user is on the GIF ↔ WebP convert tool, default
  // `targetFormat` to the *opposite* of the queue head's extension. This
  // matches user intent ("I dropped a gif so I want a webp out, and vice
  // versa"). Two pieces of state guard the auto-flip:
  //
  //   1. `userTouchedTargetRef` — set to true the moment the user clicks
  //      either radio. Once the user has expressed a preference we never
  //      overwrite it again, even if the queue changes / kind switches.
  //   2. `previewPath` — we re-fire the auto-flip whenever the queue
  //      head changes (R-43 M-3: the original `[jobs.length]`-only
  //      dependency missed cases like "delete head, leave a different
  //      file" or "switch tabs into gif-webp-convert with an existing
  //      queue").
  //
  // Switching kinds away from `gif-webp-convert` and back resets the
  // touch flag so the new session starts fresh — a user picking the
  // tool in a new context shouldn't be permanently constrained by a
  // prior session's manual choice.
  const userTouchedTargetRef = useRef(false);
  const prevKindRef = useRef(tb.kind);
  useEffect(() => {
    if (prevKindRef.current !== tb.kind) {
      // Kind just changed — reset touch flag so the new session
      // gets a fresh auto-flip on first file.
      if (tb.kind === 'gif-webp-convert') userTouchedTargetRef.current = false;
      prevKindRef.current = tb.kind;
    }
    if (tb.kind !== 'gif-webp-convert') return;
    if (userTouchedTargetRef.current) return;
    if (!previewPath) return;
    const first = previewPath.toLowerCase();
    const desired: 'gif' | 'webp' = first.endsWith('.webp') ? 'gif' : 'webp';
    if (tb.params.targetFormat !== desired) {
      tb.setParams((prev) => ({ ...prev, targetFormat: desired }));
    }
    // tb.params / tb.setParams excluded by design — including them
    // would loop on the very setParams we just performed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewPath, tb.kind]);

  // R-38 — Crop kind enforces single-file processing in the renderer (the
  // backend sanitizer/processor are kind-agnostic, this is purely a UX
  // gate). Start is also blocked until a non-empty rect has been drawn.
  const cropBlocked = tb.kind === 'crop' && (
    tb.jobs.length !== 1 ||
    !mediaInfo ||
    typeof tb.params.cropX !== 'number' ||
    typeof tb.params.cropY !== 'number' ||
    typeof tb.params.cropW !== 'number' ||
    typeof tb.params.cropH !== 'number' ||
    (tb.params.cropW ?? 0) <= 0 ||
    (tb.params.cropH ?? 0) <= 0
  );

  const handlePickClick = useCallback(async () => {
    setPickError(null);
    // R-36 #2 — graceful capability check + DOM-input fallback. The most
    // common reason `toolboxPickFiles is not a function` shows up in dev
    // is a stale preload bundle from before this method existed; in
    // packaged builds it should always be present. We probe the bridge
    // and, when missing, fall back to the hidden <input type="file"> so
    // the user is never left with a dead button.
    const bridge = (typeof window !== 'undefined' ? window.giftk : undefined) as
      | (Window['giftk'] & { toolboxPickFiles?: unknown })
      | undefined;
    if (!bridge || typeof bridge.toolboxPickFiles !== 'function') {
      setPickError('preload 桥未刷新或缺失 toolboxPickFiles,已降级使用浏览器选择器(请重启应用以恢复原生对话框)');
      fileInputRef.current?.click();
      return;
    }
    try {
      const paths = await bridge.toolboxPickFiles(tb.kind);
      if (paths && paths.length) {
        tb.addJobsFromPaths(paths);
      }
    } catch (e) {
      // Surface IPC errors so the button no longer appears "broken".
      const msg = (e as Error)?.message || String(e);
      setPickError(`选择文件失败:${msg}`);
    }
  }, [tb]);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    // DOM-input fallback path — only used when preload bridge can't
    // be reached. Electron pre-32 exposes the absolute filesystem path
    // on File.path; on >=32 we fall back to the file name + warn.
    const fl = e.target.files;
    if (!fl || fl.length === 0) return;
    const out: string[] = [];
    for (let i = 0; i < fl.length; i += 1) {
      const f = fl[i] as unknown as { path?: string; name?: string };
      const p = typeof f.path === 'string' && f.path ? f.path : '';
      if (p) {
        const lower = p.toLowerCase();
        const dot = lower.lastIndexOf('.');
        if (dot >= 0 && allowedExts.has(lower.slice(dot))) out.push(p);
      }
    }
    if (out.length) tb.addJobsFromPaths(out);
    // Reset so picking the same file twice in a row still triggers change.
    e.target.value = '';
  }, [allowedExts, tb]);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const out: string[] = [];
    if (e.dataTransfer?.files) {
      for (let i = 0; i < e.dataTransfer.files.length; i += 1) {
        const f = e.dataTransfer.files[i];
        // Electron exposes the absolute path via `path` on File.
        const p = (f as unknown as { path?: string }).path;
        if (typeof p === 'string' && p) {
          const lower = p.toLowerCase();
          const dot = lower.lastIndexOf('.');
          if (dot >= 0 && allowedExts.has(lower.slice(dot))) out.push(p);
        }
      }
    }
    if (out.length) tb.addJobsFromPaths(out);
  }, [allowedExts, tb]);

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  const handleStart = useCallback(async () => {
    const r = await tb.start();
    if (!r.ok && r.error) {
      // eslint-disable-next-line no-alert
      window.alert(`启动失败:${r.error}`);
    }
  }, [tb]);

  const handleOpenOutputDir = useCallback(async () => {
    if (!tb.lastOutputDir || !window.giftk) return;
    try {
      await window.giftk.openOutputDir(tb.lastOutputDir);
    } catch { /* ignore */ }
  }, [tb.lastOutputDir]);

  // R-41 — Tab click handler. If switching to the new kind would drop
  // queued rows (e.g. .mp4 in queue, target kind is GIF/WebP-only), we
  // pop a native confirm() dialog so the user can either back out or
  // explicitly approve the wipe. Without this guard the previous build
  // would silently delete the queue, which felt destructive.
  const handleKindClick = useCallback((targetKind: ToolboxKind) => {
    if (targetKind === tb.kind) return;
    // R-43 M-5 — capture setKind's return value so any future
    // post-switch side-effects (focus/scroll/analytics) can be gated
    // on the user actually approving the confirm dialog.
    const ok = tb.setKind(targetKind, {
      confirm: (n) => {
        const allowed = TOOLBOX_INPUT_EXTENSIONS[targetKind].join(' / ');
        const msg = `切换到 ${KIND_LABELS[targetKind] ?? targetKind} 将清空 ${n} 个不兼容的已选文件(目标工具仅接受 ${allowed})。\n\n确认切换吗?`;
        return typeof window !== 'undefined' && typeof window.confirm === 'function'
          ? window.confirm(msg)
          : true;
      }
    });
    if (!ok) return;
  }, [tb]);

  // R-39 — Reveal a history entry's primary output in the OS file
  // manager. Errors (path missing, no longer in allowed-dir tree) are
  // surfaced via the same inline notice the picker uses, so the user
  // gets feedback without an alert dialog.
  const handleRevealHistory = useCallback(async (outputPath: string | undefined) => {
    setPickError(null);
    if (!outputPath) {
      setPickError('该历史记录没有输出文件路径(可能是失败/已取消的任务)');
      return;
    }
    const bridge = (typeof window !== 'undefined' ? window.giftk : undefined) as
      | (Window['giftk'] & { revealItem?: (p: string) => Promise<{ ok: boolean }> })
      | undefined;
    if (!bridge || typeof bridge.revealItem !== 'function') {
      setPickError('preload 桥未刷新或缺失 revealItem,请重启应用');
      return;
    }
    try {
      await bridge.revealItem(outputPath);
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      setPickError(`打开文件位置失败:${msg}`);
    }
  }, []);

  // R-TB-CHAIN-V2 — derived state for the lineage section.
  // `isLineageActive` is true once at least one node exists; lineage
  // operations (probe/seed/run) are otherwise no-ops.
  const isLineageActive = lineage.nodes.length > 0;
  const lineageFocus = lineage.focus;
  // R-TB-CHAIN-V2.6 — `lineageFocusMedia` is now resolved inline at
  // the ToolboxLineageModal call site; the inline `<section.tb-lineage>`
  // block that consumed it has been deleted.

  // Local dormancy override: lets the user dismiss the lineage section
  // even though the hook still has nodes (e.g. they want to start a
  // brand-new batch without losing the lineage history). Cleared the
  // moment they re-enter via handleEnterLineageFromHistory.
  const [lineageDormant, setLineageDormant] = useState(false);
  const showLineageSection = isLineageActive && !lineageDormant;

  // Whenever the focused node changes, default the draft kind to the
  // first compatible chip and seed the params with that kind's defaults.
  // This avoids the "click a chip and stare at empty form" friction —
  // the user always lands on a fillable form straight after focus.
  //
  // Issue R3 — depend on the focus *path* (a stable string) rather than
  // the `nextKindOptions` array reference. The array is recomputed via
  // useMemo([focus]) inside the hook, so a new identity arrives every
  // time the focus object changes — even when the underlying kinds
  // haven't. Without this, the effect re-runs on innocuous re-renders
  // and clobbers params the user typed into the ParamForm. Also stop
  // calling setLineageDraftParams from inside the setLineageDraftKind
  // updater (anti-pattern + double-invocation in StrictMode).
  const lineageFocusPath = lineageFocus?.path ?? null;
  useEffect(() => {
    if (!isLineageActive) {
      setLineageDraftKind(null);
      setLineageDraftParams({});
      return;
    }
    const opts = lineage.nextKindOptions;
    setLineageDraftKind((prev) => {
      if (prev && opts.includes(prev)) return prev;
      return opts[0] ?? null;
    });
    setLineageDraftParams((prevParams) => {
      const next = opts[0] ?? null;
      if (!next) return {};
      // Only re-seed defaults when the previously-selected kind became
      // invalid (i.e. the focus path's compatible kinds changed). When
      // prev kind survives, keep whatever the user already typed.
      const prevKind = lineageDraftKindRef.current;
      if (prevKind && opts.includes(prevKind)) return prevParams;
      return defaultParamsFor(next);
    });
    // intentional: focus path is the canonical signal; we read
    // nextKindOptions/lineageDraftKindRef lazily inside the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLineageActive, lineageFocusPath]);

  // Stable ref mirroring the latest draft kind so the focus-default
  // effect can compare against the previous kind without re-subscribing.
  const lineageDraftKindRef = useRef<ToolboxKind | null>(null);
  useEffect(() => { lineageDraftKindRef.current = lineageDraftKind; }, [lineageDraftKind]);

  // Issue R4 — exit-lineage epoch token. Each enter/exit cycle bumps
  // this; handleExitLineage captures the epoch before await and aborts
  // the post-await setLineageDormant(true) when a fresh enter has bumped
  // it (i.e. the user re-entered a different lineage during the await).
  const lineageExitEpochRef = useRef<number>(0);

  // R-TB-CHAIN-V2 — entry point #1: 「继续处理 →」 on a done history row.
  // Seeds the lineage with that row's primary output and clears any
  // prior dormancy flag so a previously-dismissed lineage re-enters.
  //
  // Issue R1 — if a step is still in-flight when the user enters from
  // history, cancel it first so we don't orphan the underlying chain.
  // (lineage.reset itself ALSO fires a cancel as a defensive net, but
  //  awaiting cancel here gives the IPC time to settle before we
  //  rewrite the focus.)
  const handleEnterLineageFromHistory = useCallback(async (entryOutput: string) => {
    if (!entryOutput) return;
    if (lineage.isRunning) {
      try { await lineage.cancel(); } catch { /* best-effort */ }
    }
    lineageExitEpochRef.current += 1;
    setLineageDormant(false);
    lineage.reset(entryOutput);
    setPickError(null);
  }, [lineage]);

  // Click a breadcrumb segment to jump back to that node. The hook
  // doesn't drop the abandoned tail until the next runNextStep — until
  // then the segments after the focus stay visible (greyed in CSS) so
  // the user can navigate forward again without having to re-run.
  const handleFocusLineageNode = useCallback((nodeId: string) => {
    lineage.focusNode(nodeId);
  }, [lineage]);

  // R-TB-CHAIN-V2.6 — `handleSelectLineageKind` is no longer needed at
  // the panel level; the lineage chip click handler now lives inside
  // ToolboxLineageModal which calls `setDraftKind` directly. We still
  // keep `setLineageDraftParams(defaultParamsFor(k))` semantics through
  // the focus-changed effect above (which seeds the first chip option).

  const handleExitLineage = useCallback(async () => {
    // Issue R4 — capture the epoch before awaiting cancel(). If the
    // user re-enters via "继续处理 →" during the await, that handler
    // bumps the epoch; on resume here we detect the mismatch and
    // bail out of setLineageDormant(true) so the freshly-entered
    // lineage stays visible.
    const epochAtEntry = lineageExitEpochRef.current;
    if (lineage.isRunning) {
      try { await lineage.cancel(); } catch { /* ignore */ }
    }
    if (lineageExitEpochRef.current !== epochAtEntry) return;
    lineageExitEpochRef.current += 1;
    setLineageDormant(true);
  }, [lineage]);

  // R-TB-CHAIN-V2 — crop in lineage mode reuses the batch CropForm,
  // which writes cropX/Y/W/H directly into our draftParams. The
  // "ready?" check now lives inside ToolboxLineageModal (which gates
  // its 「继续 →」 button); we no longer compute it at the panel
  // level since the inline lineage section is gone (V2.6).

  const handleRunLineageStep = useCallback(async () => {
    if (!lineageDraftKind) return;
    try {
      await lineage.runNextStep(lineageDraftKind, lineageDraftParams);
      // After success, the focus auto-advances to the new tail; the
      // default-on-focus effect picks a fresh chip + draft params.
    } catch {
      // Error already surfaced via lineage.error; the section renders it.
    }
  }, [lineage, lineageDraftKind, lineageDraftParams]);

  const handleRevealLineageOutput = useCallback(async (p: string) => {
    if (!p || !window.giftk?.revealItem) return;
    try { await window.giftk.revealItem(p); } catch { /* ignore */ }
  }, []);

  return (
    <div className="toolbox">
      <header className="tb-header">
        <div className="tb-tabs" role="tablist" aria-label="工具箱模式">
          {KIND_OPTIONS.map((opt) => (
            <button
              key={opt.kind}
              type="button"
              role="tab"
              aria-selected={tb.kind === opt.kind}
              className={`tb-chip${tb.kind === opt.kind ? ' is-active' : ''}`}
              title={opt.hint}
              onClick={() => handleKindClick(opt.kind)}
              disabled={tb.isRunning}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className="tb-subtitle">
          {KIND_OPTIONS.find((o) => o.kind === tb.kind)?.hint}
        </p>
      </header>

      <section
        className="tb-dropzone"
        onDrop={handleDrop}
        onDragOver={onDragOver}
        aria-label="拖拽文件到此处或点击选择文件"
      >
        <div className="tb-dropzone-icon" aria-hidden="true">📂</div>
        <div className="tb-dropzone-text">
          <strong>拖拽文件到此处</strong>
          <span>支持 {TOOLBOX_INPUT_EXTENSIONS[tb.kind].join(' / ')}</span>
        </div>
        <button type="button" className="tb-pick-btn" onClick={handlePickClick} disabled={tb.isRunning}>
          选择文件
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={accept}
          style={{ display: 'none' }}
          onChange={handleFileInputChange}
        />
      </section>

      {pickError ? (
        <div className="tb-notice tb-notice-error" role="alert">{pickError}</div>
      ) : null}

      <div className="tb-body">
        <div className="tb-jobs">
          <div className="tb-jobs-head">
            <span>{tb.jobs.length} 个文件</span>
            <button type="button" className="tb-link" onClick={tb.clearJobs} disabled={tb.isRunning || tb.jobs.length === 0}>
              清空
            </button>
          </div>
          {tb.jobs.length === 0 ? (
            <div className="tb-empty">
              <div className="tb-empty-art" aria-hidden="true">🗂️</div>
              <div className="tb-empty-title">暂无文件</div>
              <div className="tb-empty-hint">拖拽或点击「选择文件」加入待处理队列</div>
            </div>
          ) : (
            <ul className="tb-job-list">
              {tb.jobs.map((job) => {
                const p = tb.progress[job.id];
                const pct = p?.percent;
                const m = jobMedia[job.inputPath];
                // R-39 — ezgif-style meta: "File size: 2.11MiB · 398×500
                // · 84 frames · gif · 00:00:08.40". Each component is
                // omitted gracefully when probe data is missing so the
                // line never shows literal "undefined".
                const metaParts: string[] = [];
                if (m?.sizeBytes) metaParts.push(`File size: ${fmtSize(m.sizeBytes)}`);
                if (m?.width && m?.height) metaParts.push(`${m.width}×${m.height}`);
                if (m?.nbFrames) metaParts.push(`${m.nbFrames} frames`);
                metaParts.push(`type: ${fmtType(job.inputPath)}`);
                if (m?.durationSec) metaParts.push(`length: ${fmtDuration(m.durationSec)}`);
                return (
                  <li key={job.id} className={`tb-job-row${p?.status ? ` is-${p.status}` : ''}`}>
                    {/* R-39 — every queued row carries a thumbnail, including
                        pending ones, so the user can identify which clip is
                        which before processing starts. */}
                    <div className="tb-job-thumb" aria-hidden="true">
                      {m?.previewDataUrl ? (
                        <img src={m.previewDataUrl} alt="" loading="lazy" />
                      ) : (
                        <span className="tb-job-thumb-fallback">🎞️</span>
                      )}
                    </div>
                    <div className="tb-job-main">
                      <div className="tb-job-name" title={job.inputPath}>{job.displayName}</div>
                      <div className="tb-job-meta" title={metaParts.join(', ')}>
                        {metaParts.join(' · ')}
                      </div>
                      {/* R-67 — Long status detail (e.g. `reverse (audio=mute)`,
                          per-failure error string) lives here under the meta
                          line so the fixed-width status badge column never
                          clips. We hide this row entirely when the substep
                          carries no useful detail. */}
                      {statusDetail(p) ? (
                        <div className="tb-job-detail" title={statusDetail(p) ?? undefined}>
                          {statusDetail(p)}
                        </div>
                      ) : null}
                    </div>
                    <div className="tb-job-status">
                      <span className={statusBadgeClass(p)}>{statusLabel(p)}</span>
                    </div>
                    <div className="tb-job-bar">
                      <div className="tb-job-bar-fill" style={{ width: typeof pct === 'number' ? `${Math.max(0, Math.min(100, pct))}%` : '0%' }} />
                    </div>
                    <div className="tb-job-pct">{fmtPct(pct)}</div>
                    <button
                      type="button"
                      className="tb-job-remove"
                      title="移除"
                      onClick={() => tb.removeJob(job.id)}
                      disabled={tb.isRunning && p != null && p.status !== 'pending' && p.status !== 'done' && p.status !== 'failed' && p.status !== 'cancelled' && p.status !== 'skipped'}
                    >×</button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <aside className="tb-side">
          <div className="tb-side-head">参数</div>
          <ParamForm
            kind={tb.kind}
            params={tb.params}
            setParams={tb.setParams}
            mediaInfo={mediaInfo}
            onTargetFormatTouch={() => { userTouchedTargetRef.current = true; }}
          />
        </aside>
      </div>

      <footer className="tb-footer">
        <div className="tb-footer-left">
          {tb.lastOutputDir ? (
            <button type="button" className="tb-link" onClick={handleOpenOutputDir} title={tb.lastOutputDir}>
              打开输出目录
            </button>
          ) : null}
          {tb.kind === 'crop' && tb.jobs.length > 1 ? (
            <span className="tb-warn">Crop 仅支持单文件,请删除其余文件后再处理</span>
          ) : null}
          {tb.kind === 'crop' && tb.jobs.length === 1 && cropBlocked ? (
            <span className="tb-muted">请在预览图上拖拽以选择裁剪区域</span>
          ) : null}
        </div>
        <div className="tb-footer-right">
          <button type="button" className="btn" onClick={tb.cancel} disabled={!tb.isRunning}>取消</button>
          <button
            type="button"
            className="btn primary"
            onClick={handleStart}
            disabled={tb.isRunning || tb.jobs.length === 0 || cropBlocked}
          >
            {tb.isRunning ? '处理中…' : '开始'}
          </button>
        </div>
      </footer>

      {/* R-39 — History section. Sits below the footer (i.e. always
          visible at the very bottom of the panel) so completed runs are
          one click away. Each row is itself a button that triggers
          revealItem on the primary output. */}
      <section className="tb-history" aria-label="工具箱历史结果">
        <div className="tb-history-head">
          <span className="tb-history-title">历史结果 · {tb.toolboxHistory.length}</span>
          <button
            type="button"
            className="tb-link"
            onClick={tb.clearToolboxHistory}
            disabled={tb.toolboxHistory.length === 0}
          >
            清空历史
          </button>
        </div>
        {tb.toolboxHistory.length === 0 ? (
          <div className="tb-history-empty">完成的任务会自动出现在这里,点击行可在文件管理器中定位输出文件。</div>
        ) : (
          <ul className="tb-history-list">
            {tb.toolboxHistory.map((entry) => {
              const out = entry.outputs[0];
              const outName = out ? (/[^/\\]+$/.exec(out)?.[0] ?? out) : '';
              const canReveal = entry.status === 'done' && !!out;
              const previewPathForRow = canReveal ? out : entry.inputPath;
              const posterDataUrl = previewPathForRow ? jobMedia[previewPathForRow]?.previewDataUrl : undefined;
              return (
                <li
                  key={entry.id}
                  className={`tb-history-row tb-history-row-${entry.status}${canReveal ? ' is-clickable' : ''}`}
                >
                  {/* R-TB-CHAIN-V2.6 — thumbnail column. Static poster by
                      default, hover swaps to live giftk-local:// for
                      animated GIF/WebP so the user can preview the
                      result before deciding whether to "继续处理 →". */}
                  <TbHistoryThumb filePath={previewPathForRow} posterDataUrl={posterDataUrl} />
                  <button
                    type="button"
                    className="tb-history-main"
                    onClick={() => canReveal && handleRevealHistory(out)}
                    disabled={!canReveal}
                    title={canReveal ? `在文件管理器中显示 ${out}` : entry.error || '无可定位的输出文件'}
                  >
                    <div className="tb-history-line1">
                      <span className={statusBadgeClass({ status: entry.status } as TaskProgress)}>
                        {entry.status === 'done' ? '完成' : entry.status === 'failed' ? '失败' : entry.status === 'cancelled' ? '已取消' : '已跳过'}
                      </span>
                      <span className="tb-history-kind">{KIND_LABELS[entry.kind] ?? entry.kind}</span>
                      <span className="tb-history-time">{fmtAgo(entry.finishedAt)}</span>
                    </div>
                    <div className="tb-history-line2" title={entry.inputPath}>
                      <span className="tb-history-input">{entry.displayName}</span>
                      {outName ? (
                        <>
                          <span className="tb-history-arrow" aria-hidden="true">→</span>
                          <span className="tb-history-output">{outName}</span>
                        </>
                      ) : null}
                    </div>
                    {entry.status !== 'done' && entry.error ? (
                      <div className="tb-history-error">{entry.error}</div>
                    ) : null}
                  </button>
                  {/* R-TB-CHAIN-V2.6 — 「继续处理 →」 entry point.
                      Compact pill (no longer stretched vertically); aria
                      label keeps the long form for screen readers. */}
                  {canReveal ? (
                    <button
                      type="button"
                      className="tb-history-continue"
                      title={lineage.isRunning ? '当前链路有步骤进行中，请先取消或等待' : '基于此结果继续链式处理'}
                      aria-label="继续处理"
                      onClick={() => { void handleEnterLineageFromHistory(out); }}
                      disabled={lineage.isRunning}
                    >
                      <span className="tb-history-continue-label">继续</span>
                      <span className="tb-history-continue-arrow" aria-hidden="true">→</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="tb-history-remove"
                    title="从历史中移除"
                    onClick={() => tb.removeHistoryEntry(entry.id)}
                  >×</button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* R-TB-CHAIN-V2.6 — lineage runs as an overlay modal so the
          batch UI underneath stays mounted and interactive (just
          inert behind the mask). renderParamForm/renderCropForm are
          injected because the local form components live inside this
          file and aren't exported; passing render-functions avoids a
          file-wide refactor. */}
      <ToolboxLineageModal
        open={showLineageSection}
        lineage={lineage}
        draftKind={lineageDraftKind}
        setDraftKind={setLineageDraftKind}
        draftParams={lineageDraftParams}
        setDraftParams={setLineageDraftParams}
        focusMedia={lineageFocus ? (jobMedia[lineageFocus.path] ?? null) : null}
        renderParamForm={({ kind, params, setParams, mediaInfo }) => (
          <ParamForm kind={kind} params={params} setParams={setParams} mediaInfo={mediaInfo} />
        )}
        renderCropForm={({ params, setParams, mediaInfo }) => (
          <CropForm params={params} setParams={setParams} mediaInfo={mediaInfo} />
        )}
        onFocusNode={handleFocusLineageNode}
        onClose={() => { void handleExitLineage(); }}
        onRunStep={() => { void handleRunLineageStep(); }}
        onRevealFocus={(p) => { void handleRevealLineageOutput(p); }}
      />
    </div>
  );
}

export default ToolboxPanel;
