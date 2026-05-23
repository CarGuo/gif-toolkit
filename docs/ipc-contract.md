# docs/ipc-contract.md

> ⚠️ **本文档可能滞后于源码** — 自 R-WS / R-LINEAGE / R-SNIFF-OVERLAY / R-COVERAGE 以来 IPC 通道已扩展多轮,本文档**不再逐项跟随**。
> **权威来源以源码为准**:
> - 调用面契约:[src/preload/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/index.ts) + [src/renderer/global.d.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/global.d.ts)
> - 主端 handler 注册:[src/main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts)
> - 共享类型:[src/shared/types/](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types)
>
> 本文保留作为 IPC 设计意图与历史不变量的索引(R-10 / R-11 / R-26 等),具体方法签名以 preload/global.d.ts 为准。

> 主进程暴露的所有 IPC 通道 + Renderer 上 `window.giftk.*` 的全表。
> 源代码:[src/preload/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/index.ts) / [src/renderer/global.d.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/global.d.ts) / [src/main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts)。
> 关联规则:[R-10](file:///Users/guoshuyu/workspace/gif-toolkit/AGENTS.md) / [R-11](file:///Users/guoshuyu/workspace/gif-toolkit/AGENTS.md)。

---

## 1. 调用方向(handle vs on)

| 方向 | API | 示例 |
|---|---|---|
| Renderer → Main(请求/响应) | `ipcMain.handle` + `ipcRenderer.invoke` | `await window.giftk.sniff(url)` |
| Main → Renderer(推送) | `webContents.send` + `ipcRenderer.on` | `process:progress` |

---

## 2. 全部通道

### 2.1 嗅探

| 通道 | 入参 | 出参 | 注意 |
|---|---|---|---|
| `sniff:url` | `url: string` | `SniffResult` | 只接受 http/https,**拒绝 file:// / javascript: / data:** |
| `sniff:cancel` | — | `void` | 取消正在进行的嗅探 |

### 2.2 预览 / 缩略图

| 通道 | 入参 | 出参 |
|---|---|---|
| `media:preview` | `media: SniffedMedia, opts: ProcessOptions` | `PreviewResult`(含帧 URL 数组) |
| `media:thumbnail` | `media: SniffedMedia` | `ThumbnailResult` |

### 2.3 处理 / 批处理

| 通道 | 入参 | 出参 |
|---|---|---|
| `process:start` | `{ tasks: ProcessTask[], pageTitle?: string }` | `BatchStartResult` |
| `process:cancelAll` | — | `void` |
| `app:pickDir` | — | `string \| null` |
| `app:openDir` | `dirPath: string` | `void` |
| `app:defaultDir` | — | `string` |
| `app:logBuffer` | — | `string[]`(最近 500 行内存日志) |

### 2.4 推送(Main → Renderer)

| 事件 | 载荷 | 频率 |
|---|---|---|
| `process:progress` | `TaskProgress` | 每个 substep / 每秒~ |
| `sniff:progress` | `SniffProgress` | 每 200ms~ |
| `app:log` | `string` | 主进程日志 |

### 2.5 历史持久化(R-80, SQLite)

> 详见 [docs/R-80-SQLITE-NOTES.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/R-80-SQLITE-NOTES.md)。
> Renderer 通过 `window.giftk.db.{history|uploadHistory|sniffHistory|toolboxHistory}.*`。

| 通道 | 入参 | 出参 |
|---|---|---|
| `db:history:readAll` | — | `HistoryRecord[]` |
| `db:history:upsert` | `rec: HistoryRecord` | `void` |
| `db:history:remove` | `id: string` | `void` |
| `db:history:clear` | — | `void` |
| `db:uploadHistory:readAll` | — | `UploadHistoryRecord[]` |
| `db:uploadHistory:upsert` | `rec: UploadHistoryRecord` | `void` |
| `db:uploadHistory:remove` | `id: string` | `void` |
| `db:uploadHistory:clear` | — | `void` |
| `db:sniffHistory:readAll` | — | `SniffHistoryEntry[]` |
| `db:sniffHistory:upsert` | `rec: SniffHistoryEntry` | `void` |
| `db:sniffHistory:remove` | `url: string` | `void` |
| `db:sniffHistory:clear` | — | `void` |
| `db:toolboxHistory:readAll` | — | `ToolboxHistoryEntry[]` |
| `db:toolboxHistory:upsert` | `rec: ToolboxHistoryEntry` | `void` |
| `db:toolboxHistory:remove` | `id: string` | `void` |
| `db:toolboxHistory:clear` | — | `void` |
| `db:bootstrapImport` | `payload: { history?, uploadHistory?, sniffHistory?, toolboxHistory? }` | `{ history, uploadHistory, sniffHistory, toolboxHistory }` 计数 |

> Bootstrap import 是 R-80 Commit B 启动期一次性把 renderer 的旧 localStorage 喂给主进程入库的渠道,事务化,接受信封 (`{version,exportedAt,records}`) 或 bare-array 两种 raw 形态。每行单独 try/catch,坏行 drop 不影响整批。

---

## 3. TaskProgress 字段(R-08)

```ts
interface TaskProgress {
  taskId: string;
  state: 'queued' | 'running' | 'done' | 'error' | 'skipped';
  percent?: number; // 总进度
  message?: string; // 简短状态
  substep?: string; // * 例如 "Phase B / lossy=80"
  detail?: string; // * 例如 "1.78MB / target 2MB"
  stepIndex?: number; // * 当前是第几步
  totalSteps?: number; // * 总共几步(估算)
  elapsedMs?: number; // * 该任务已耗时
  error?: string; // 错误时的人类可读信息
  outputPath?: string; // 完成时的本地文件路径
}
```

加 * 的字段是 R-08 强制要求,不能为了省事省略。

---

## 4. 加新 IPC 通道的 Step-by-step

1. 在 [src/main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) `ipcMain.handle('your:channel', ...)` 注册 handler
2. 在 [src/preload/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/index.ts) 的 `contextBridge.exposeInMainWorld('giftk', { ... })` 里加方法
3. 在 [src/renderer/global.d.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/global.d.ts) 加 TS 类型
4. 在本文档的"全部通道"表里加一行
5. typecheck + lint + build 三连

> 漏掉第 2 或第 3 步是最常见的灯笼 bug:开发期 Vite HMR 看着没问题,**生产构建后 `window.giftk.foo` 就是 undefined**。
