/**
 * R-80 — One-time importer that pulls the four legacy localStorage
 * blobs into SQLite the first time the user runs an R-80+ build.
 *
 * Flow:
 *   1. Renderer reads its four localStorage keys (raw JSON strings)
 *      on boot.
 *   2. Renderer sends the four strings to the main process via
 *      `db:bootstrapImport`.
 *   3. Main process passes them here. We parse defensively, run a
 *      single transaction with INSERT OR IGNORE, and report back the
 *      number of rows inserted per family.
 *   4. On a successful (no-throw) return, the renderer deletes the
 *      four localStorage keys, so a subsequent boot sees them empty
 *      and skips this whole flow.
 *
 * The renderer-side payloads come through as the R-79b envelope
 * `{ version: number, payload: T[] }` OR a legacy bare-array
 * `T[]`. We accept both shapes (mirroring `readVersionedStorage`)
 * so users on every prior build can migrate cleanly.
 *
 * Idempotency: INSERT OR IGNORE means a partial-import recovery is
 * safe — if the renderer crashed before deleting the localStorage
 * keys, the next boot re-attempts and the already-imported rows are
 * silently skipped.
 */

import type Database from 'better-sqlite3';
import {
  createHistoryRepo,
  type HistoryRow
} from './repos/historyRepo';
import {
  createUploadHistoryRepo,
  type UploadHistoryRow,
  type UploadHistoryItemRow
} from './repos/uploadHistoryRepo';
import {
  createSniffHistoryRepo,
  type SniffHistoryRow
} from './repos/sniffHistoryRepo';
import {
  createToolboxHistoryRepo,
  type ToolboxHistoryRow
} from './repos/toolboxHistoryRepo';

export interface BootstrapImportInput {
  history?: string | null;
  uploadHistory?: string | null;
  sniffHistory?: string | null;
  toolboxHistory?: string | null;
}

export interface BootstrapImportResult {
  history: number;
  uploadHistory: number;
  sniffHistory: number;
  toolboxHistory: number;
}

/**
 * Decode the R-79b envelope or a legacy bare-array. Returns an
 * empty array on any parse error — bootstrap imports must NEVER
 * throw because the consequence is the user losing access to their
 * history.
 */
function decodePayload(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) return parsed;
  if (
    parsed &&
    typeof parsed === 'object' &&
    'payload' in parsed &&
    Array.isArray((parsed as { payload: unknown }).payload)
  ) {
    return (parsed as { payload: unknown[] }).payload;
  }
  return [];
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function coerceHistory(arr: unknown[]): HistoryRow[] {
  const out: HistoryRow[] = [];
  for (const item of arr) {
    const obj = asObject(item);
    if (!obj) continue;
    const id = asString(obj.id);
    const createdAt = asNumber(obj.createdAt);
    if (!id || createdAt == null) continue;
    const items = Array.isArray(obj.items) ? (obj.items as unknown[]) : [];
    const rec: HistoryRow = {
      id,
      createdAt,
      pageUrl: asString(obj.pageUrl) ?? '',
      items,
      options: obj.options ?? {},
      outputsByTaskId: asObject(obj.outputsByTaskId) ?? {},
      taskStatus: asObject(obj.taskStatus) ?? {}
    };
    const title = asString(obj.title);
    if (title) rec.title = title;
    const outputDir = asString(obj.outputDir);
    if (outputDir) rec.outputDir = outputDir;
    const uploads = asObject(obj.uploadsByOutputPath);
    if (uploads) rec.uploadsByOutputPath = uploads;
    out.push(rec);
  }
  return out;
}

function coerceUploadHistory(arr: unknown[]): UploadHistoryRow[] {
  const out: UploadHistoryRow[] = [];
  for (const item of arr) {
    const obj = asObject(item);
    if (!obj) continue;
    const id = asString(obj.id);
    const createdAt = asNumber(obj.createdAt);
    const backend = asString(obj.backend);
    if (!id || createdAt == null || !backend) continue;
    const itemsRaw = Array.isArray(obj.items) ? (obj.items as unknown[]) : [];
    const items: UploadHistoryItemRow[] = [];
    for (const it of itemsRaw) {
      const o = asObject(it);
      if (!o) continue;
      const jobId = asString(o.jobId);
      if (!jobId) continue;
      const row: UploadHistoryItemRow = {
        jobId,
        filePath: asString(o.filePath) ?? '',
        fileName: asString(o.fileName) ?? '',
        status: asString(o.status) ?? 'pending'
      };
      const url = asString(o.url);
      if (url) row.url = url;
      const md = asString(o.markdown);
      if (md) row.markdown = md;
      const err = asString(o.error);
      if (err) row.error = err;
      const bt = asNumber(o.bytesTotal);
      if (bt != null) row.bytesTotal = bt;
      const pct = asNumber(o.percent);
      if (pct != null) row.percent = pct;
      const fh = asString(o.fileHash);
      if (fh) row.fileHash = fh;
      if (typeof o.reused === 'boolean') row.reused = o.reused;
      items.push(row);
    }
    out.push({ id, createdAt, backend, items });
  }
  return out;
}

function coerceSniffHistory(arr: unknown[]): SniffHistoryRow[] {
  const out: SniffHistoryRow[] = [];
  for (const item of arr) {
    const obj = asObject(item);
    if (!obj) continue;
    const url = asString(obj.url);
    const ts = asNumber(obj.ts);
    if (!url || ts == null) continue;
    const row: SniffHistoryRow = { url, ts };
    const title = asString(obj.title);
    if (title) row.title = title;
    const ic = asNumber(obj.itemCount);
    if (ic != null) row.itemCount = ic;
    out.push(row);
  }
  return out;
}

function coerceToolboxHistory(arr: unknown[]): ToolboxHistoryRow[] {
  const out: ToolboxHistoryRow[] = [];
  const validStatus = new Set(['done', 'failed', 'cancelled', 'skipped']);
  for (const item of arr) {
    const obj = asObject(item);
    if (!obj) continue;
    const id = asString(obj.id);
    const kind = asString(obj.kind);
    const inputPath = asString(obj.inputPath);
    const displayName = asString(obj.displayName);
    const status = asString(obj.status);
    const finishedAt = asNumber(obj.finishedAt);
    if (!id || !kind || !inputPath || !displayName || !status || finishedAt == null) continue;
    if (!validStatus.has(status)) continue;
    const outputs = Array.isArray(obj.outputs)
      ? (obj.outputs as unknown[]).filter((s): s is string => typeof s === 'string')
      : [];
    const row: ToolboxHistoryRow = {
      id,
      kind,
      inputPath,
      displayName,
      outputs,
      params: obj.params ?? {},
      status: status as ToolboxHistoryRow['status'],
      finishedAt
    };
    const err = asString(obj.error);
    if (err) row.error = err;
    out.push(row);
  }
  return out;
}

/**
 * Run all four imports inside a single transaction so a mid-flight
 * crash leaves the DB in a coherent state. The renderer only deletes
 * its localStorage keys on a successful (resolved) IPC return.
 */
export function bootstrapImport(
  db: Database.Database,
  input: BootstrapImportInput
): BootstrapImportResult {
  const historyRepo = createHistoryRepo(db);
  const uploadRepo = createUploadHistoryRepo(db);
  const sniffRepo = createSniffHistoryRepo(db);
  const toolboxRepo = createToolboxHistoryRepo(db);

  const histRows = coerceHistory(decodePayload(input.history));
  const upRows = coerceUploadHistory(decodePayload(input.uploadHistory));
  const sniffRows = coerceSniffHistory(decodePayload(input.sniffHistory));
  const tbRows = coerceToolboxHistory(decodePayload(input.toolboxHistory));

  let result: BootstrapImportResult = {
    history: 0,
    uploadHistory: 0,
    sniffHistory: 0,
    toolboxHistory: 0
  };
  const txn = db.transaction(() => {
    result = {
      history: historyRepo.insertManyRaw(histRows),
      uploadHistory: uploadRepo.insertManyRaw(upRows),
      sniffHistory: sniffRepo.insertManyRaw(sniffRows),
      toolboxHistory: toolboxRepo.insertManyRaw(tbRows)
    };
  });
  txn();
  return result;
}
