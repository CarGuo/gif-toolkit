/**
 * R-80 — Main-process IPC bindings for the SQLite-backed history
 * stores. Renderer talks to these via `window.giftk.db.*` (see
 * [src/preload/index.ts](../../preload/index.ts)).
 *
 * Channel layout
 * --------------
 *   db:history:readAll        → HistoryRow[]
 *   db:history:upsert         (rec) → void
 *   db:history:remove         (id)  → void
 *   db:history:clear          ()    → void
 *   db:uploadHistory:readAll  → UploadHistoryRow[]
 *   db:uploadHistory:upsert   (rec) → void
 *   db:uploadHistory:remove   (id)  → void
 *   db:uploadHistory:clear    ()    → void
 *   db:sniffHistory:readAll   → SniffHistoryRow[]
 *   db:sniffHistory:upsert    (entry) → void
 *   db:sniffHistory:remove    (url) → void
 *   db:sniffHistory:clear     ()    → void
 *   db:toolboxHistory:readAll → ToolboxHistoryRow[]
 *   db:toolboxHistory:upsert  (entry) → void
 *   db:toolboxHistory:remove  (id) → void
 *   db:toolboxHistory:clear   ()    → void
 *   db:bootstrapImport        (BootstrapImportInput) → BootstrapImportResult
 *
 * The repos themselves are synchronous (better-sqlite3 hallmark);
 * the IPC handlers are declared `async` only because that's what
 * `ipcMain.handle` expects. There's no awaitable I/O inside.
 */

import { ipcMain } from 'electron';
import { openDb } from './index';
import {
  bootstrapImport,
  type BootstrapImportInput
} from './bootstrapImport';
import {
  createHistoryRepo,
  type HistoryRow
} from './repos/historyRepo';
import {
  createUploadHistoryRepo,
  type UploadHistoryRow
} from './repos/uploadHistoryRepo';
import {
  createSniffHistoryRepo,
  type SniffHistoryRow
} from './repos/sniffHistoryRepo';
import {
  createToolboxHistoryRepo,
  type ToolboxHistoryRow
} from './repos/toolboxHistoryRepo';

/** Tag used by the lazy repo accessors. */
type RepoCache = {
  history?: ReturnType<typeof createHistoryRepo>;
  uploadHistory?: ReturnType<typeof createUploadHistoryRepo>;
  sniffHistory?: ReturnType<typeof createSniffHistoryRepo>;
  toolboxHistory?: ReturnType<typeof createToolboxHistoryRepo>;
};

const cache: RepoCache = {};

/**
 * Lazy repo factories — we only construct the prepared statements
 * on first use of each family so a session that never opens (e.g.)
 * the toolbox panel doesn't pay the parse cost for those statements.
 */
function getHistory() {
  return cache.history ?? (cache.history = createHistoryRepo(openDb()));
}
function getUploadHistory() {
  return cache.uploadHistory ?? (cache.uploadHistory = createUploadHistoryRepo(openDb()));
}
function getSniffHistory() {
  return cache.sniffHistory ?? (cache.sniffHistory = createSniffHistoryRepo(openDb()));
}
function getToolboxHistory() {
  return cache.toolboxHistory ?? (cache.toolboxHistory = createToolboxHistoryRepo(openDb()));
}

/**
 * R-80 hardening — wrap each handler so a thrown SQL error is logged
 * with full context on the main side (otherwise it surfaces only as
 * an opaque rejected IPC promise on the renderer, which the hook
 * `.catch()` swallows). We DO re-throw so the renderer's existing
 * promise contract (rejected → optimistic-update divergence handled
 * upstream by hook `.catch` or toast) still works.
 */
function safeHandle<TArgs extends unknown[], TResult>(
  channel: string,
  fn: (...args: TArgs) => TResult | Promise<TResult>
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs): Promise<TResult> => {
    try {
      return await fn(...args);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[dbIpc:${channel}] handler failed:`,
        err instanceof Error ? err.message : String(err),
        err instanceof Error && err.stack ? `\n${err.stack}` : ''
      );
      throw err;
    }
  };
}

/**
 * Register every `db:*` channel. Must be called inside `app.whenReady`
 * after `openDb()` so the prepared statements have a live handle.
 */
export function registerDbIpc(): void {
  // history
  ipcMain.handle('db:history:readAll', safeHandle('history:readAll', async () => getHistory().readAll()));
  ipcMain.handle('db:history:upsert', safeHandle('history:upsert', async (_e, rec: HistoryRow) => {
    getHistory().upsert(rec);
  }));
  ipcMain.handle('db:history:remove', safeHandle('history:remove', async (_e, id: string) => {
    getHistory().remove(id);
  }));
  ipcMain.handle('db:history:clear', safeHandle('history:clear', async () => {
    getHistory().clear();
  }));

  // upload history
  ipcMain.handle('db:uploadHistory:readAll', safeHandle('uploadHistory:readAll', async () => getUploadHistory().readAll()));
  ipcMain.handle('db:uploadHistory:upsert', safeHandle('uploadHistory:upsert', async (_e, rec: UploadHistoryRow) => {
    getUploadHistory().upsert(rec);
  }));
  ipcMain.handle('db:uploadHistory:remove', safeHandle('uploadHistory:remove', async (_e, id: string) => {
    getUploadHistory().remove(id);
  }));
  ipcMain.handle('db:uploadHistory:clear', safeHandle('uploadHistory:clear', async () => {
    getUploadHistory().clear();
  }));

  // sniff history
  ipcMain.handle('db:sniffHistory:readAll', safeHandle('sniffHistory:readAll', async () => getSniffHistory().readAll()));
  ipcMain.handle('db:sniffHistory:upsert', safeHandle('sniffHistory:upsert', async (_e, entry: SniffHistoryRow) => {
    getSniffHistory().upsert(entry);
  }));
  ipcMain.handle('db:sniffHistory:remove', safeHandle('sniffHistory:remove', async (_e, url: string) => {
    getSniffHistory().remove(url);
  }));
  ipcMain.handle('db:sniffHistory:clear', safeHandle('sniffHistory:clear', async () => {
    getSniffHistory().clear();
  }));

  // toolbox history
  ipcMain.handle('db:toolboxHistory:readAll', safeHandle('toolboxHistory:readAll', async () => getToolboxHistory().readAll()));
  ipcMain.handle('db:toolboxHistory:upsert', safeHandle('toolboxHistory:upsert', async (_e, entry: ToolboxHistoryRow) => {
    getToolboxHistory().upsert(entry);
  }));
  ipcMain.handle('db:toolboxHistory:remove', safeHandle('toolboxHistory:remove', async (_e, id: string) => {
    getToolboxHistory().remove(id);
  }));
  ipcMain.handle('db:toolboxHistory:clear', safeHandle('toolboxHistory:clear', async () => {
    getToolboxHistory().clear();
  }));

  // bootstrap import
  ipcMain.handle(
    'db:bootstrapImport',
    safeHandle('bootstrapImport', async (_e, payload: BootstrapImportInput) =>
      bootstrapImport(openDb(), payload ?? {})
    )
  );
}

/** Test helper — wipes the lazy repo cache so a fresh `openDb()` gets
 *  fresh prepared statements. Tests use this between `closeDb()` /
 *  `openDb({filename: ':memory:'})` cycles. */
export function _resetDbIpcCacheForTests(): void {
  cache.history = undefined;
  cache.uploadHistory = undefined;
  cache.sniffHistory = undefined;
  cache.toolboxHistory = undefined;
}
