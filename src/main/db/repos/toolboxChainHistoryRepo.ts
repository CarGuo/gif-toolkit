/**
 * R-TB-CHAIN — Repo for `toolbox_chain_history`. One row per chain
 * run; the per-step audit trail is serialised into `steps_json`.
 *
 * Design parallels [toolboxHistoryRepo.ts](./toolboxHistoryRepo.ts) so
 * the renderer history panel can reuse the same load/clear flow.
 * Independent table per the "独立 SQLite 表" decision: chain rows
 * share no columns with batch toolbox jobs (no kind, multi-output,
 * shared output_dir).
 */

import type Database from 'better-sqlite3';
import type {
  ToolboxChainHistoryEntry,
  ToolboxChainHistoryStep,
  ToolboxChainStatus
} from '../../../shared/types';

interface DbRow {
  id: string;
  input_path: string;
  display_name: string;
  status: string;
  error: string | null;
  output_dir: string;
  finished_at: number;
  steps_json: string;
}

function parseJsonOrDefault<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    const v = JSON.parse(s);
    return v === null ? fallback : (v as T);
  } catch {
    return fallback;
  }
}

const VALID_CHAIN_STATUS: ReadonlySet<string> = new Set<ToolboxChainStatus>([
  'done',
  'failed',
  'cancelled'
]);
const VALID_STEP_STATUS: ReadonlySet<string> = new Set<ToolboxChainHistoryStep['status']>([
  'done',
  'failed',
  'cancelled',
  'skipped'
]);

/**
 * Defensive coercion: rows may have been written by an older or
 * tampered build. Anything that doesn't match the runtime contract is
 * dropped (returns null) so the renderer never sees invalid status
 * tokens. Each step is sanitised independently so a single bad step
 * doesn't void the whole chain audit.
 */
function rowToEntry(r: DbRow): ToolboxChainHistoryEntry | null {
  if (!VALID_CHAIN_STATUS.has(r.status)) return null;
  const rawSteps = parseJsonOrDefault<unknown>(r.steps_json, []);
  if (!Array.isArray(rawSteps)) return null;
  const steps: ToolboxChainHistoryStep[] = [];
  for (const s of rawSteps) {
    if (!s || typeof s !== 'object') continue;
    const obj = s as Record<string, unknown>;
    const kind = typeof obj.kind === 'string' ? obj.kind : '';
    const status = typeof obj.status === 'string' ? obj.status : '';
    if (!kind || !VALID_STEP_STATUS.has(status)) continue;
    const outputs = Array.isArray(obj.outputs)
      ? obj.outputs.filter((o): o is string => typeof o === 'string')
      : [];
    const params = (obj.params && typeof obj.params === 'object' ? obj.params : {}) as ToolboxChainHistoryStep['params'];
    const step: ToolboxChainHistoryStep = {
      kind: kind as ToolboxChainHistoryStep['kind'],
      params,
      status: status as ToolboxChainHistoryStep['status'],
      outputs
    };
    if (typeof obj.error === 'string' && obj.error) step.error = obj.error;
    steps.push(step);
  }
  const entry: ToolboxChainHistoryEntry = {
    id: r.id,
    inputPath: r.input_path,
    displayName: r.display_name,
    status: r.status as ToolboxChainStatus,
    steps,
    outputDir: r.output_dir,
    finishedAt: r.finished_at
  };
  if (r.error != null) entry.error = r.error;
  return entry;
}

export interface ToolboxChainHistoryRepo {
  readAll(): ToolboxChainHistoryEntry[];
  upsert(entry: ToolboxChainHistoryEntry): void;
  remove(id: string): void;
  clear(): void;
}

export function createToolboxChainHistoryRepo(db: Database.Database): ToolboxChainHistoryRepo {
  const selectAll = db.prepare<[], DbRow>(
    'SELECT id, input_path, display_name, status, error, output_dir, finished_at, steps_json FROM toolbox_chain_history ORDER BY finished_at DESC'
  );
  const upsertStmt = db.prepare(
    `INSERT INTO toolbox_chain_history (id, input_path, display_name, status, error, output_dir, finished_at, steps_json)
     VALUES (@id, @input_path, @display_name, @status, @error, @output_dir, @finished_at, @steps_json)
     ON CONFLICT(id) DO UPDATE SET
       input_path = excluded.input_path,
       display_name = excluded.display_name,
       status = excluded.status,
       error = excluded.error,
       output_dir = excluded.output_dir,
       finished_at = excluded.finished_at,
       steps_json = excluded.steps_json`
  );
  const removeStmt = db.prepare('DELETE FROM toolbox_chain_history WHERE id = ?');
  const clearStmt = db.prepare('DELETE FROM toolbox_chain_history');

  function entryToParams(e: ToolboxChainHistoryEntry): Record<string, string | number | null> {
    return {
      id: e.id,
      input_path: e.inputPath,
      display_name: e.displayName,
      status: e.status,
      error: e.error ?? null,
      output_dir: e.outputDir,
      finished_at: e.finishedAt,
      steps_json: JSON.stringify(Array.isArray(e.steps) ? e.steps : [])
    };
  }

  return {
    readAll() {
      const out: ToolboxChainHistoryEntry[] = [];
      for (const r of selectAll.all()) {
        const e = rowToEntry(r);
        if (e) out.push(e);
      }
      return out;
    },
    upsert(entry) {
      upsertStmt.run(entryToParams(entry));
    },
    remove(id) {
      removeStmt.run(id);
    },
    clear() {
      clearStmt.run();
    }
  };
}
