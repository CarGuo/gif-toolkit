import React, { useEffect, useState } from 'react';
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

interface Props {
  value: ProcessOptions;
  onChange: (next: ProcessOptions) => void;
}

interface NumFieldProps {
  label: string;
  unit?: string;
  value: number | undefined;
  defaultValue?: number;
  min: number;
  max?: number;
  step?: number;
  hint?: string;
  onCommit: (n: number) => void;
}

const NumField: React.FC<NumFieldProps> = ({ label, unit, value, defaultValue, min, max, step, hint, onCommit }) => {
  // R-82: NumField MUST never display `min` as the apparent value just
  // because `value` is undefined — that misled users into thinking
  // lossyCeiling/colorsFloor defaulted to 2 when the real default is
  // 200/2. Always coerce undefined/NaN through `defaultValue ?? min`.
  const resolved = typeof value === 'number' && Number.isFinite(value)
    ? value
    : (typeof defaultValue === 'number' ? defaultValue : min);
  const [text, setText] = useState<string>(String(resolved));
  useEffect(() => {
    setText(String(resolved));
  }, [resolved]);
  return (
    <label>
      {label}{unit ? ` (${unit})` : ''}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const n = Number(text);
          if (!Number.isFinite(n)) {
            setText(String(resolved));
            return;
          }
          let v = n;
          if (typeof min === 'number') v = Math.max(min, v);
          if (typeof max === 'number') v = Math.min(max, v);
          onCommit(v);
          setText(String(v));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
};

export const OptionsForm: React.FC<Props> = ({ value, onChange }) => {
  const set = <K extends keyof ProcessOptions>(k: K, v: ProcessOptions[K]) => onChange({ ...value, [k]: v });
  const hardMB = Math.round((value.maxBytes / 1024 / 1024) * 100) / 100;
  const softMB = Math.round(((value.softMaxBytes ?? value.maxBytes) / 1024 / 1024) * 100) / 100;
  return (
    <div className="options">
      <NumField
        label="最佳目标"
        unit="MB"
        value={softMB}
        min={0.1}
        max={Math.max(0.2, hardMB)}
        step={0.1}
        onCommit={(n) => {
          const soft = Math.max(0.1, Math.min(hardMB, n));
          set('softMaxBytes', soft * 1024 * 1024);
        }}
      />
      <NumField
        label="降级上限"
        unit="MB"
        value={hardMB}
        min={Math.max(0.2, softMB)}
        max={200}
        step={0.5}
        onCommit={(n) => {
          const hard = Math.max(softMB, n);
          set('maxBytes', hard * 1024 * 1024);
        }}
      />
      <NumField
        label="最小尺寸"
        unit="px"
        value={value.minSize}
        min={64}
        max={4096}
        step={10}
        onCommit={(n) => set('minSize', Math.round(n))}
      />
      <NumField
        label="分段时长"
        unit="s"
        value={value.maxSegmentSec}
        min={1}
        max={120}
        step={1}
        onCommit={(n) => set('maxSegmentSec', Math.round(n))}
      />
      <NumField
        label="FPS"
        value={value.fps}
        min={1}
        max={60}
        step={1}
        onCommit={(n) => set('fps', Math.round(n))}
      />
      <NumField
        label="最长边上限"
        unit="px"
        value={value.maxWidth}
        min={Math.max(64, value.minSize)}
        max={4096}
        step={1}
        onCommit={(n) => set('maxWidth', Math.max(value.minSize, Math.round(n)))}
      />
      <NumField
        label="播放速度"
        unit="x"
        value={value.speed}
        min={0.25}
        max={8}
        step={0.25}
        onCommit={(n) => set('speed', n)}
      />
      <NumField
        label="并发任务数"
        value={value.concurrency ?? 3}
        min={1}
        max={8}
        step={1}
        onCommit={(n) => set('concurrency', Math.max(1, Math.min(8, Math.round(n))))}
      />
      {/* R-81 — 高级 gifsicle 旋钮。默认折叠,普通用户看到的是 8 个核心字段;
          需要精细控制画质 ↔ 体积平衡的用户可展开此抽屉:
            - lossy 上限   :  0..200,越小画质越好但体积越大,0 = 关闭 lossy
            - colors 下限  :  2..256,越大画质越好但体积越大,256 = 关闭调色板压缩
            - -O 级别      :  1/2/3,锁定 gifsicle 优化级别
            - dither       :  none / floyd-steinberg / ordered,调色板量化算法
          这 4 个值会作为 ceiling/floor/lock 喂进 compressLoop 的 adaptive 搜索 */}
      <details className="advanced-gif">
        <summary>高级 GIF 优化</summary>
        <div className="options advanced-gif-grid">
          <p className="advanced-gif-intro">
            压不下来或想保画质时再调,默认即可。
          </p>
          <NumField
            label="lossy 上限"
            value={value.lossyCeiling}
            defaultValue={DEFAULT_OPTIONS.lossyCeiling ?? GIF_LOSSY_MAX}
            min={0}
            max={GIF_LOSSY_MAX}
            step={5}
            hint="越大越省体积,画质越糙。常用 80–160。"
            onCommit={(n) => set('lossyCeiling', Math.max(0, Math.min(GIF_LOSSY_MAX, Math.round(n))))}
          />
          <NumField
            label="colors 下限"
            value={value.colorsFloor}
            defaultValue={DEFAULT_OPTIONS.colorsFloor ?? GIF_COLORS_MIN}
            min={GIF_COLORS_MIN}
            max={GIF_COLORS_MAX}
            step={2}
            hint="越小越省体积,色越少。常用 64–128。"
            onCommit={(n) => set('colorsFloor', Math.max(GIF_COLORS_MIN, Math.min(GIF_COLORS_MAX, Math.round(n))))}
          />
          <label>
            -O 级别
            <select
              value={String(value.optimizeLevel ?? DEFAULT_OPTIONS.optimizeLevel ?? 3)}
              onChange={(e) => {
                const lvl = Number(e.target.value) as GifOptimizeLevel;
                if ((GIF_OPTIMIZE_LEVELS as readonly number[]).includes(lvl)) set('optimizeLevel', lvl);
              }}
            >
              {GIF_OPTIMIZE_LEVELS.map((lvl) => (
                <option key={lvl} value={String(lvl)}>{`-O${lvl}`}</option>
              ))}
            </select>
            <span className="field-hint">压缩力度。-O3 最强(默认)。</span>
          </label>
          <label>
            dither
            <select
              value={value.dither ?? DEFAULT_OPTIONS.dither ?? 'floyd-steinberg'}
              onChange={(e) => {
                const d = e.target.value as GifDither;
                if ((GIF_DITHER_MODES as readonly string[]).includes(d)) set('dither', d);
              }}
            >
              {GIF_DITHER_MODES.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
            <span className="field-hint">削色后的过渡处理,默认即可。</span>
          </label>
        </div>
      </details>
    </div>
  );
};
