# R-80 — Move local history from `localStorage` to SQLite

> Status: **PLANNED** — not yet started. R-79b shipped only the
> renderer-side schema-migration *framework* ([storageSchema.ts](../src/renderer/components/storageSchema.ts))
> and version constants on every history hook. The actual SQLite
> backing store and the IPC-based replacement of `localStorage` is the
> work tracked here.

## Why a separate round

R-79b's user feedback was "把本地历史挪进数据库,顺便做个迁移升级机制"。
迁移这一步影响面巨大(主进程新依赖 + IPC 全套新增 + 4 个 hook 重写 + 469 测试一大半要重做),所以本次 R-79b 只先把**渲染层 schema 版本契约**搭起来(让未来的 v2/v3 升级有路可走),SQLite 这个一次性"换底"动作单独开一个 R-80 推。

## What lives in `localStorage` today (R-79b 落定的 4 个 envelope key)

每个 key 现在都被新的 [`readVersionedStorage`](../src/renderer/components/storageSchema.ts) helper 包了一层 `{ version, payload }` 信封;遗留的 bare-array 值会被自动当成 v0,然后顺着 migrators 数组往前 lift。当前所有四个 key 都是 v1 + 空 migrators,因为存量数据*就是* v1 的形状。

| Key | Version const | Hook | Records |
| --- | --- | --- | --- |
| `giftk.history.v1` | `HISTORY_SCHEMA_VERSION = 1` | [useHistory](../src/renderer/components/useHistory.ts) | 处理批次会话 |
| `giftk.uploadHistory.v1` | `UPLOAD_HISTORY_SCHEMA_VERSION = 1` | [useUploadHistory](../src/renderer/components/useUploadHistory.ts) | 上传记录(扁平倒序) |
| `giftk.sniffHistory.v1` | `SNIFF_HISTORY_SCHEMA_VERSION = 1` | [useSniffHistory](../src/renderer/components/useSniffHistory.ts) | 嗅探过的 URL LRU |
| `giftk.toolbox.history.v1` | `TOOLBOX_HISTORY_SCHEMA_VERSION = 1` | [useToolbox](../src/renderer/components/useToolbox.ts) | 工具箱已完成任务 |

偏好 key (`giftk.logsVisible` / `giftk.bottomPanelHeight` / `giftk.dismissedCaps` / `giftk.histDetailLogsVisible` 等) 不在迁移范围内 —— 它们是单值布尔/数字,SQLite 的开销不划算,继续放 localStorage。

## Target architecture

```
+----------------------------------+
| Renderer (4 hooks)               |
|   useHistory / useUploadHistory  |
|   useSniffHistory / useToolbox   |
+----------------+-----------------+
                 | window.api.db.* (preload-exposed IPC)
                 v
+----------------------------------+
| Main process                     |
|   src/main/db/index.ts           |
|     ├─ open(better-sqlite3)      |
|     ├─ migrations runner         |
|     └─ table-scoped repos        |
+----------------+-----------------+
                 | better-sqlite3 (sync, native)
                 v
        userData/giftk-history.db
```

### Schema (DDL, DRAFT)

```sql
-- Schema version metadata; one row, updated by migrations runner.
CREATE TABLE IF NOT EXISTS schema_meta (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);
INSERT OR IGNORE INTO schema_meta(k, v) VALUES ('history', 1);
INSERT OR IGNORE INTO schema_meta(k, v) VALUES ('upload_history', 1);
INSERT OR IGNORE INTO schema_meta(k, v) VALUES ('sniff_history', 1);
INSERT OR IGNORE INTO schema_meta(k, v) VALUES ('toolbox_history', 1);

-- Processing-history sessions. The current localStorage shape is a
-- nested record-of-records, but we flatten it: `history` rows are the
-- batch session, `history_jobs` rows are the per-task entries within.
CREATE TABLE IF NOT EXISTS history (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  page_url TEXT,
  page_title TEXT,
  source_kind TEXT,
  -- bag-of-extra fields (sniffMeta etc.) carried as opaque JSON; we
  -- *do not* introduce dedicated columns for things the UI only ever
  -- displays as-is, this keeps R-80 a 1:1 lift-and-shift.
  meta_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS history_created_idx ON history(created_at DESC);

CREATE TABLE IF NOT EXISTS history_jobs (
  id TEXT PRIMARY KEY,
  history_id TEXT NOT NULL REFERENCES history(id) ON DELETE CASCADE,
  job_kind TEXT,
  status TEXT,
  progress_pct INTEGER,
  output_path TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}',
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS history_jobs_hid_idx ON history_jobs(history_id);

-- Upload history is already flat in the renderer model.
CREATE TABLE IF NOT EXISTS upload_history (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  backend TEXT NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS upload_history_created_idx ON upload_history(created_at DESC);

CREATE TABLE IF NOT EXISTS upload_history_items (
  job_id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES upload_history(id) ON DELETE CASCADE,
  status TEXT,
  url TEXT,
  markdown TEXT,
  error TEXT,
  file_hash TEXT,
  reused INTEGER,
  percent INTEGER,
  output_path TEXT,
  display_name TEXT
);
CREATE INDEX IF NOT EXISTS upload_history_items_rid_idx ON upload_history_items(record_id);
CREATE INDEX IF NOT EXISTS upload_history_items_hash_idx ON upload_history_items(file_hash);

-- Sniff history is small; one row per URL.
CREATE TABLE IF NOT EXISTS sniff_history (
  url TEXT PRIMARY KEY,
  title TEXT,
  ts INTEGER NOT NULL,
  item_count INTEGER
);
CREATE INDEX IF NOT EXISTS sniff_history_ts_idx ON sniff_history(ts DESC);

-- Toolbox completed jobs.
CREATE TABLE IF NOT EXISTS toolbox_history (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  input_path TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  finished_at INTEGER NOT NULL,
  outputs_json TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS toolbox_history_finished_idx ON toolbox_history(finished_at DESC);
```

### IPC contract (DRAFT)

```ts
// src/preload/index.ts (additions)
contextBridge.exposeInMainWorld('api', {
  // ...existing channels
  db: {
    history: {
      readAll: () => ipcRenderer.invoke('db:history:readAll'),
      upsert: (rec: HistoryRecord) => ipcRenderer.invoke('db:history:upsert', rec),
      patchJob: (historyId: string, jobId: string, patch: Partial<HistoryJob>) =>
        ipcRenderer.invoke('db:history:patchJob', historyId, jobId, patch),
      remove: (id: string) => ipcRenderer.invoke('db:history:remove', id),
      clear: () => ipcRenderer.invoke('db:history:clear')
    },
    uploadHistory: { /* same shape */ },
    sniffHistory: { /* same shape */ },
    toolboxHistory: { /* same shape */ }
  }
});
```

注意:hook 现在是同步 `useState(() => readAll())` 初始化的 —— 切到 IPC 后必须改为异步首读 + loading 标志(或在主进程 ready 之前先用空数组兜底然后异步 hydrate)。需要在 hook 的 contract 上扩个 `isLoading: boolean`,UI 侧 (HistoryPanel / UploadHistoryPanel / ToolboxPanel) 都要兼容。

### One-shot localStorage → SQLite import

启动时主进程拿到 db 句柄之后,通过新的 `db:bootstrap-import` 渠道询问 renderer:
1. renderer 读 4 个 `localStorage` key 的原始 JSON 字符串(直接绕过现有 hook,避免重复防御解析)
2. 通过 IPC 把 raw blob 全部交给主进程
3. 主进程在事务里跑 4 个 `INSERT OR IGNORE`(以主键去重,二次启动幂等)
4. 主进程返回成功之后,renderer 把 4 个 localStorage key 删掉

该路径只在表为空 *并且* localStorage 有数据时跑 —— 这样不会在用户后续清空了表又重启时重新塞回旧数据。

### Native dependency

- `better-sqlite3`(同步 API,Electron 主进程 best-fit;async sqlite 在主进程没好处)
- 必须 `electron-rebuild` —— 在 `package.json` 的 `postinstall` 里跑,CI release 流水线 [release.yml](../.github/workflows/release.yml) 也得加这一步
- 三平台预编译产物的 supply chain 检查走现行 R-15 流程

### Tests

- `tests/renderer/useHistory.test.ts` 等 4 个 hook 测试目前 mock `window.localStorage`。R-80 之后要改成 mock `window.api.db.*`(我们已经在其它 IPC 调用里有这一惯例,可参考 sniffer 测试)。这是规模最大的一块改动。
- 新增 `tests/main/db/migrations.test.ts`:验证 fresh install / 已有 schema_meta v1 / 未来 v2 升级路径都能正确跑迁移
- 新增 `tests/main/db/repos.test.ts`:每个表的 CRUD 单元测试

### Migration path beyond v1

`schema_meta(k, v)` 让我们以后能像 renderer 端 storageSchema 一样,按表逐版本 bump:
- 加列 → 跑 `ALTER TABLE ... ADD COLUMN ...; UPDATE schema_meta SET v=2 WHERE k='history'`
- 改列语义 → 跑 backfill SELECT/UPDATE
- migrations runner 在 db 打开时按表循环 v→v+1 地推到 currentVersion,失败立刻回滚整个事务

### Out-of-scope for R-80

- 跨设备同步(用户没要求,也没合适后端)
- 全文检索(几千条历史用 LIKE 已够)
- 偏好 key 迁移到 SQLite(不划算)

## Next-up todo seed for R-80 implementation

1. 装依赖 `npm i better-sqlite3` + 校验三平台 prebuilt
2. 落 [src/main/db/index.ts](../src/main/db/index.ts) + [src/main/db/migrations/](../src/main/db/migrations/)(初始 schema 即上面 DDL)
3. 主进程 IPC handler + preload 白名单扩(R-11 受影响,要更新)
4. 4 个 hook 改为 IPC 调用 + `isLoading` 字段
5. 一次性 import bootstrap
6. 测试改造 + 新测试
7. CI release 流水线加 electron-rebuild 步骤
8. 文档:把 [ipc-contract.md](./ipc-contract.md) 加上 `db:*` 渠道家族
