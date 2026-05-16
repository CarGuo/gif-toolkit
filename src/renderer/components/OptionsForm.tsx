import React, { useEffect, useState } from 'react';
import type { ProcessOptions } from '../../shared/types';

interface Props {
  value: ProcessOptions;
  onChange: (next: ProcessOptions) => void;
}

interface NumFieldProps {
  label: string;
  unit?: string;
  value: number;
  min: number;
  max?: number;
  step?: number;
  onCommit: (n: number) => void;
}

const NumField: React.FC<NumFieldProps> = ({ label, unit, value, min, max, step, onCommit }) => {
  const [text, setText] = useState<string>(String(value));
  useEffect(() => {
    setText(String(value));
  }, [value]);
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
            setText(String(value));
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
    </div>
  );
};
