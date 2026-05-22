import React from 'react';
import type {
  ChainStepDraft,
  TaskProgress,
  ToolboxKind,
  ToolboxOptimizeMethod,
  ToolboxParams
} from '../../shared/types';

export interface ChainStepRowProps {
  index: number;
  total: number;
  draft: ChainStepDraft;
  progress: TaskProgress | undefined;
  isRunning: boolean;
  kindOptions: ReadonlyArray<{ kind: ToolboxKind; label: string }>;
  onKindChange: (kind: ToolboxKind) => void;
  onParamsChange: (params: ToolboxParams) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

const STATIC_HINT_KINDS: ReadonlySet<ToolboxKind> = new Set<ToolboxKind>([
  'trim',
  'speed',
  'reverse',
  'rotate',
  'gif-webp-convert',
  'video-to-gif',
  'video-to-webp'
]);

const OPTIMIZE_METHOD_CHOICES: ReadonlyArray<{
  value: ToolboxOptimizeMethod;
  label: string;
}> = [
  { value: 'lossy', label: 'Lossy' },
  { value: 'wechat-safe', label: 'WeChat-safe' },
  { value: 'drop-duplicates', label: 'Drop duplicates' }
];

const rowStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: 8,
  border: '1px solid var(--border, #2a2d33)',
  borderRadius: 4,
  background: 'var(--surface-2, #1a1c20)'
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap'
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600
};

const hintStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--muted, #8a8f97)'
};

const progressStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 11
};

const badgeStyle: React.CSSProperties = {
  padding: '1px 6px',
  borderRadius: 3,
  background: 'var(--accent-bg, #1f3a52)',
  border: '1px solid var(--accent, #4aa3ff)'
};

export const ChainStepRow: React.FC<ChainStepRowProps> = ({
  index,
  total,
  draft,
  progress,
  isRunning,
  kindOptions,
  onKindChange,
  onParamsChange,
  onRemove,
  onMoveUp,
  onMoveDown
}) => {
  const disableUp = isRunning || index === 0;
  const disableDown = isRunning || index === total - 1;

  const handleKindChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onKindChange(e.target.value as ToolboxKind);
  };

  const handleTargetWidthChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = Number(e.target.value);
    onParamsChange({
      ...draft.params,
      targetWidth: Number.isFinite(raw) && raw > 0 ? raw : undefined
    });
  };

  const handleMethodChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onParamsChange({
      ...draft.params,
      method: e.target.value as ToolboxOptimizeMethod
    });
  };

  const handleLossyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = Number(e.target.value);
    onParamsChange({
      ...draft.params,
      lossy: Number.isFinite(raw) && raw >= 0 ? raw : undefined
    });
  };

  const renderEditor = () => {
    if (draft.kind === 'gif-resize') {
      return (
        <label style={hintStyle}>
          <span style={{ marginRight: 6 }}>targetWidth</span>
          <input
            type="number"
            min={64}
            value={draft.params.targetWidth ?? ''}
            onChange={handleTargetWidthChange}
            disabled={isRunning}
            aria-label="targetWidth"
            style={{ width: 96 }}
          />
        </label>
      );
    }
    if (draft.kind === 'gif-optimize') {
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label style={hintStyle}>
            <span style={{ marginRight: 6 }}>method</span>
            <select
              value={draft.params.method ?? 'lossy'}
              onChange={handleMethodChange}
              disabled={isRunning}
              aria-label="method"
            >
              {OPTIMIZE_METHOD_CHOICES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          {draft.params.method === 'lossy' ? (
            <label style={hintStyle}>
              <span style={{ marginRight: 6 }}>lossy</span>
              <input
                type="number"
                min={0}
                max={200}
                value={draft.params.lossy ?? ''}
                onChange={handleLossyChange}
                disabled={isRunning}
                aria-label="lossy"
                style={{ width: 80 }}
              />
            </label>
          ) : null}
        </div>
      );
    }
    if (draft.kind === 'crop') {
      return <div style={hintStyle}>运行到此步时会暂停并弹出选区编辑窗</div>;
    }
    if (STATIC_HINT_KINDS.has(draft.kind)) {
      return <div style={hintStyle}>默认参数运行（暂不支持 chain 内编辑细参数）</div>;
    }
    return null;
  };

  return (
    <div className="tb-chain-row" style={rowStyle}>
      <div className="tb-chain-row-header" style={headerStyle}>
        <span style={labelStyle}>{`Step ${index + 1}`}</span>
        <select
          value={draft.kind}
          onChange={handleKindChange}
          disabled={isRunning}
          aria-label={`step-${index + 1}-kind`}
        >
          {kindOptions.map((opt) => (
            <option key={opt.kind} value={opt.kind}>
              {opt.label}
            </option>
          ))}
        </select>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onMoveUp}
          disabled={disableUp}
          aria-label={`step-${index + 1}-move-up`}
        >
          ↑
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={disableDown}
          aria-label={`step-${index + 1}-move-down`}
        >
          ↓
        </button>
        <button
          type="button"
          onClick={onRemove}
          disabled={isRunning}
          aria-label={`step-${index + 1}-remove`}
        >
          删除
        </button>
      </div>
      <div className="tb-chain-row-body">{renderEditor()}</div>
      {progress ? (
        <div className="tb-chain-row-progress" style={progressStyle}>
          <span style={badgeStyle}>{progress.status}</span>
          <span>{`${Math.round(Math.max(0, Math.min(100, progress.percent)))}%`}</span>
        </div>
      ) : null}
    </div>
  );
};
