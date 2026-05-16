import React, { useState } from 'react';
import type { SniffedMedia, TaskProgress } from '../../shared/types';

interface Props {
  items: SniffedMedia[];
  progress: Record<string, TaskProgress>;
}

function fileName(u: string): string {
  try {
    return new URL(u).pathname.split('/').pop() || u;
  } catch {
    return u;
  }
}

function fmtTime(ms?: number): string {
  if (!ms || ms < 0) return '';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}

function describe(p: TaskProgress): string {
  const parts: string[] = [];
  if (p.substep) parts.push(p.substep);
  if (p.stepIndex && p.totalSteps) parts.push(`${p.stepIndex}/${p.totalSteps}`);
  if (p.totalSegments && p.segmentIndex) parts.push(`段 ${p.segmentIndex}/${p.totalSegments}`);
  if (p.elapsedMs && p.elapsedMs > 1000) parts.push(fmtTime(p.elapsedMs));
  return parts.join(' · ');
}

interface DetailModalState {
  title: string;
  warning?: string;
  phaseFailures: string[];
  error?: string;
}

const WarningDetailModal: React.FC<{ s: DetailModalState; onClose: () => void }> = ({ s, onClose }) => {
  const text = [
    s.warning ? `Summary: ${s.warning}` : null,
    s.error ? `Error: ${s.error}` : null,
    s.phaseFailures.length > 0 ? `\nPhase failures (${s.phaseFailures.length}):\n  - ${s.phaseFailures.join('\n  - ')}` : null
  ].filter(Boolean).join('\n');
  const onCopy = (): void => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  };
  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
      }}
    >
      <div
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--panel, #1e1f24)', color: 'var(--text, #ddd)',
          border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8,
          padding: 16, maxWidth: 720, width: '90vw', maxHeight: '80vh',
          display: 'flex', flexDirection: 'column', gap: 10
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 600 }}>{s.title}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onCopy} style={{ fontSize: 12 }}>复制</button>
            <button onClick={onClose} style={{ fontSize: 12 }}>关闭</button>
          </div>
        </div>
        {s.warning ? (
          <div style={{ fontSize: 12, color: '#f0c674' }}>⚠ {s.warning}</div>
        ) : null}
        {s.error ? (
          <div style={{ fontSize: 12, color: '#ef5b6e' }}>✖ {s.error}</div>
        ) : null}
        {s.phaseFailures.length > 0 ? (
          <div style={{ overflow: 'auto', flex: 1 }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
              Phase failures ({s.phaseFailures.length}):
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, fontFamily: 'monospace', fontSize: 11, lineHeight: 1.6 }}>
              {s.phaseFailures.map((f, i) => (
                <li key={i} style={{ wordBreak: 'break-all' }}>{f}</li>
              ))}
            </ul>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>没有更多诊断信息。</div>
        )}
      </div>
    </div>
  );
};

export const TaskTable: React.FC<Props> = ({ items, progress }) => {
  const [detail, setDetail] = useState<DetailModalState | null>(null);
  const rows = items.filter((m) => progress[m.id]);
  if (rows.length === 0) {
    return (
      <div className="tasks">
        <div style={{ color: 'var(--muted)', padding: 8 }}>任务列表(开始批处理后这里会出现进度)</div>
      </div>
    );
  }
  return (
    <div className="tasks">
      {rows.map((m) => {
        const p = progress[m.id];
        const cls = ['done', 'failed', 'skipped', 'cancelled'].includes(p.status) ? p.status : '';
        const meta = describe(p);
        const hasFailures = (p.phaseFailures?.length ?? 0) > 0;
        const canOpenDetail = Boolean(p.warning || p.error || hasFailures);
        const openDetail = (): void => {
          setDetail({
            title: fileName(m.url),
            warning: p.warning,
            error: p.error,
            phaseFailures: p.phaseFailures ?? []
          });
        };
        return (
          <div className="task" key={m.id}>
            <div className="status">
              <span className={`badge ${m.kind}`}>{m.kind}</span>
            </div>
            <div>
              <div className="name" title={m.url}>{fileName(m.url)}</div>
              <div className="bar-wrap" style={{ marginTop: 4 }}>
                <div className="bar" style={{ width: `${Math.round(p.percent)}%` }} />
              </div>
              <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 2, lineHeight: 1.45 }}>
                {p.message || p.status}
                {meta ? ` · ${meta}` : ''}
                {p.error ? ` · ${p.error}` : ''}
              </div>
              {p.detail ? (
                <div style={{ color: 'var(--muted)', fontSize: 10, marginTop: 1, fontFamily: 'monospace', opacity: 0.75 }}>
                  {p.detail}
                </div>
              ) : null}
              {p.warning ? (
                <div
                  className="task-warn"
                  title={p.warning + (hasFailures ? '\n\n点击查看完整 phase 失败列表' : '')}
                  onClick={canOpenDetail ? openDetail : undefined}
                  style={canOpenDetail ? { cursor: 'pointer', textDecoration: 'underline dotted' } : undefined}
                >
                  ⚠ {p.warning}
                </div>
              ) : hasFailures ? (
                // No headline warning (success) but swallowed phase failures
                // exist — offer a discreet "查看诊断" link so power users can
                // still inspect what happened during compress.
                <div
                  className="task-warn"
                  onClick={openDetail}
                  style={{ cursor: 'pointer', opacity: 0.7, fontSize: 11, textDecoration: 'underline dotted' }}
                >
                  查看诊断 ({p.phaseFailures!.length})
                </div>
              ) : null}
            </div>
            <div className={`size`}>{p.currentSizeMB ? `${p.currentSizeMB.toFixed(2)} MB` : ''}</div>
            <div className={`status ${cls}`}>{p.status}</div>
          </div>
        );
      })}
      {detail ? <WarningDetailModal s={detail} onClose={() => setDetail(null)} /> : null}
    </div>
  );
};
