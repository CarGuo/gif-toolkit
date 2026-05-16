import React from 'react';
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

export const TaskTable: React.FC<Props> = ({ items, progress }) => {
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
                <div className="task-warn" title={p.warning}>
                  ⚠ {p.warning}
                </div>
              ) : null}
            </div>
            <div className={`size`}>{p.currentSizeMB ? `${p.currentSizeMB.toFixed(2)} MB` : ''}</div>
            <div className={`status ${cls}`}>{p.status}</div>
          </div>
        );
      })}
    </div>
  );
};
