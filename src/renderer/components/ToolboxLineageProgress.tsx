import type { TaskProgress } from '../../shared/types';

/**
 * R-COMPRESS-V1 #4 follow-up — Lineage modal in-flight progress row.
 *
 * Carved out of ToolboxLineageModal.tsx so the modal stays under the
 * 600-line eslint cap. Visually mirrors the home-page TaskTable's
 * per-row progress block: status badge → bar → percent on row 1, then
 * a muted secondary line with message · substep · segment · elapsed
 * · current size on row 2. Self-contained: takes a TaskProgress (or
 * null) and renders nothing on its own — the modal decides when to
 * show it via the `lineage.isRunning` gate.
 *
 * Helpers are duplicated from ToolboxPanel.tsx + TaskTable.tsx
 * intentionally. Importing from ToolboxPanel.tsx would create a
 * circular dependency (ToolboxPanel renders the modal). Keeping the
 * vocabulary identical is enforced by code review, not module deps.
 */

function progressStatusLabel(p: TaskProgress | null): string {
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

function progressBadgeClass(p: TaskProgress | null): string {
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

function fmtTime(ms?: number): string {
  if (!ms || ms < 0) return '';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}

function progressMeta(p: TaskProgress | null): string {
  if (!p) return '';
  const parts: string[] = [];
  if (p.substep) parts.push(p.substep);
  if (p.stepIndex && p.totalSteps) parts.push(`${p.stepIndex}/${p.totalSteps}`);
  if (p.totalSegments && p.segmentIndex) parts.push(`段 ${p.segmentIndex}/${p.totalSegments}`);
  if (p.elapsedMs && p.elapsedMs > 1000) parts.push(fmtTime(p.elapsedMs));
  return parts.join(' · ');
}

export interface LineageProgressRowProps {
  /** Latest non-terminal progress event from the in-flight chain step.
   *  May be null briefly between `runNextStep` setting `isRunning=true`
   *  and the first progress emit reaching the renderer. */
  progress: TaskProgress | null;
}

export function LineageProgressRow({ progress }: LineageProgressRowProps): JSX.Element {
  const pct = Math.max(0, Math.min(100, Math.round(progress?.percent ?? 0)));
  const meta = progressMeta(progress);
  return (
    <div className="tb-lineage-progress" aria-live="polite" aria-label="处理进度">
      <div className="tb-lineage-progress-row">
        <span className={progressBadgeClass(progress)}>
          {progressStatusLabel(progress)}
        </span>
        <div className="tb-lineage-progress-bar-wrap">
          <div className="bar-wrap">
            <div className="bar" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <span className="tb-lineage-progress-percent">{pct}%</span>
      </div>
      <div className="tb-lineage-progress-detail">
        {progress?.message || progress?.status || '排队中'}
        {meta ? ` · ${meta}` : ''}
        {progress?.currentSizeMB ? ` · ${progress.currentSizeMB.toFixed(2)} MB` : ''}
      </div>
    </div>
  );
}

export default LineageProgressRow;
