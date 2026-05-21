# docs/architecture.md

> 三段式 Electron:**Renderer(只渲染) → Preload(白名单桥) → Main(所有重活)**。
> 配套规则:[AGENTS.md R-01 / R-10 / R-11](file:///Users/guoshuyu/workspace/gif-toolkit/AGENTS.md)。
> 配套规格:[project_rules.md §7](file:///Users/guoshuyu/workspace/gif-toolkit/project_rules.md) 「何时不该拆 / processor.ts 真实业务复杂度豁免」。

> **图片是 [scripts/render-mermaid.mjs](file:///Users/guoshuyu/workspace/gif-toolkit/scripts/render-mermaid.mjs) 把本文中 mermaid 块渲染出来的，源始终以本文 mermaid 为准；改完源运行 `npm run docs:render` 重新出图。**

---

## 1. 进程拓扑

![进程拓扑](./images/architecture-1-topology.png)

```mermaid
flowchart TB
  subgraph R["Renderer (React + Vite, sandboxed)"]
    APP["App.tsx (顶层状态)"]
    MG["MediaGrid"]
    OF["OptionsForm"]
    TT["TaskTable"]
    PM["PreviewModal"]
    APP --- MG
    APP --- OF
    APP --- TT
    APP --- PM
  end

  subgraph P["Preload (contextBridge 白名单)"]
    GIFTK["window.giftk = { sniff, startBatch, cancelTask, ... }"]
  end

  subgraph M["Main Process (Node)"]
    IDX["index.ts<br/>IPC 路由 + 窗口生命周期 + sanitizeOptions"]
    SNF["sniffer.ts<br/>axios + cheerio + 7 条规则"]
    DLD["downloader.ts<br/>axios stream → tmp + Range"]
    PRC["processor.ts<br/>PQueue + Phase A-D + R-43.2 cancel"]
    FFM["ffmpeg.ts<br/>palette × 2 + sharp + gifsicle"]
    BIN["binaries.ts<br/>asar.unpacked 路径解析"]
    LOG["logger.ts<br/>结构化日志 → userData"]
    DB["db/*<br/>better-sqlite3 嗅探/产物历史"]

    IDX --> SNF
    IDX --> PRC
    PRC --> DLD
    PRC --> FFM
    FFM -.读路径.-> BIN
    PRC --> LOG
    PRC --> DB
  end

  R -- "IPC: invoke(handle)" --> P
  P -- "ipcRenderer.invoke" --> M
  M -- "webContents.send('process:progress')" --> P
  P -- "on(channel, cb)" --> R

  classDef rendererStyle fill:#e3f2fd,stroke:#1976d2;
  classDef preloadStyle fill:#fff3e0,stroke:#ef6c00;
  classDef mainStyle fill:#e8f5e9,stroke:#2e7d32;
  class R,APP,MG,OF,TT,PM rendererStyle;
  class P,GIFTK preloadStyle;
  class M,IDX,SNF,DLD,PRC,FFM,BIN,LOG,DB mainStyle;
```

---

## 2. 不变量(Invariants)

| 不变量 | 违反后果 |
|---|---|
| Renderer 不直接调 `child_process` / `fs` | Electron 安全基线塌方 |
| 共享类型只放 [src/shared/types.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types.ts) | 主/渲两边 schema 漂移,运行期才发现 |
| 二进制路径只通过 [src/main/binaries.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/binaries.ts) | 打包后 ffmpeg 找不到 |
| `sniff:url` 拒绝 `file://` / `javascript:` | 任意文件读 + XSS 风险 |
| Preload 暴露的方法必须 + global.d.ts 一起改 | 生产构建 `window.giftk.foo` undefined |
| [processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) 不强行拆模块（≈ 2626 行豁免） | 见 [project_rules.md §7](file:///Users/guoshuyu/workspace/gif-toolkit/project_rules.md) — 真实业务复杂度，不是设计债 |

---

## 3. 主进程文件分工

| 文件 | 职责 | 关键 export |
|---|---|---|
| [index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) | 应用入口、`BrowserWindow`、注册 IPC handlers、`sanitizeOptions` | `app.whenReady` |
| [binaries.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/binaries.ts) | 解析 ffmpeg/ffprobe/gifsicle 路径(asar.unpacked 修正) | `getFFmpegPath / getGifsiclePath` |
| [sniffer.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/sniffer.ts) | 7 条嗅探规则 + dedupKey + matchEmbedProvider | `sniffPage` |
| [downloader.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/downloader.ts) | 流式下载 + Range + Content-Length | `downloadToTmp` |
| [ffmpeg.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/ffmpeg.ts) | palette 两遍 + sharp 缩放 + gifsicle 优化 | `videoToGif / gifResize / gifOptimize` |
| [processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) | 任务调度(pqueue) + Phase A-D 压缩 + AspectRatioConstraintError | `processOne / startBatch` |
| [processor-utils.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor-utils.ts) | 纯函数：clampConcurrency / shortSideAfterCap / compressCacheKey / chooseCompressionTargetMB / ACCEPT_TOL 等可单测的常量与算法 | 见 [tests/main/processor-utils.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/processor-utils.test.ts) |
| [logger.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/logger.ts) | 结构化日志(写到 userData) | `logger` |

---

## 4. Renderer 主要组件

| 组件 | 职责 |
|---|---|
| [App.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/App.tsx) | 顶层状态(items / selected / progress / processingOne) + 启动批处理 + 单条处理 |
| [MediaGrid.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/MediaGrid.tsx) | 网格预览 + 卡片"处理此项" + iframe-embed 黄色徽章 |
| [PreviewModal.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/PreviewModal.tsx) | 大图弹窗 + 裁剪/时间轴/帧 tab |
| [OptionsForm.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/OptionsForm.tsx) | 最佳目标/降级上限/最长边/并发 输入,soft↔hard 互相 clamp |
| [TaskTable.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/TaskTable.tsx) | 进度行(substep / detail / elapsedMs / 阶段名) |

---

## 5. 数据流(端到端)

![端到端数据流](./images/architecture-2-dataflow.png)

```mermaid
flowchart TD
  U["用户输入 URL"] --> S1["sniff:url IPC"]
  S1 --> S2["sniffer.sniffPage()"]
  S2 --> S3{"嗅探模式"}
  S3 -- "URL only" --> S4a["axios + cheerio"]
  S3 -- "WebView" --> S4b["BrowserView 注入"]
  S3 -- "Real Chrome" --> S4c["chrome-remote-interface"]
  S3 -- "yt-dlp" --> S4d["ytdlp-nodejs --dump-json"]
  S4a --> S5["SniffedMedia[]"]
  S4b --> S5
  S4c --> S5
  S4d --> S5
  S5 --> S6["setItems + 自动勾选<br/>(排除 image/iframe-embed)"]
  S6 --> U2["用户调参 + 点 ▶ 开始批处理"]
  U2 --> B1["start:batch IPC<br/>(tasks, pageTitle, sessionId)"]
  B1 --> B2["PQueue(concurrency 1-8)"]
  B2 --> B3["processOne (R-43.2 cancel-aware)"]
  B3 --> P0["Phase 0 estimate"]
  P0 --> PA["Phase A resize"]
  PA --> PB["Phase B adaptive lossy<br/>(binary search)"]
  PB --> PC["Phase C geometric shrink"]
  PC --> PD["Phase D aggressive"]
  PD --> EM["emit process:progress"]
  EM --> R1["Renderer TaskTable 实时更新"]
  PD --> DB[("SQLite history")]

  classDef phase fill:#fff3e0,stroke:#e65100;
  class P0,PA,PB,PC,PD phase;
```

---

## 6. IPC 调用链 — `start:batch` 序列

![start:batch 序列](./images/architecture-3-sequence.png)

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant R as Renderer (App.tsx)
  participant P as Preload (giftk)
  participant M as Main (index.ts)
  participant Q as PQueue (processor.ts)
  participant W as Worker (processOne)
  participant FS as Disk + ffmpeg/gifsicle

  U->>R: 点击"▶ 开始批处理"
  R->>P: window.giftk.startBatch(tasks, title, sessionId)
  P->>M: ipcRenderer.invoke('start:batch', ...)
  M->>M: sanitizeOptions(tasks)
  M->>Q: queue.add(processOne) × N
  loop 每个 task
    Q->>W: processOne(task, abort)
    W->>FS: ffmpeg palette pass1
    FS-->>W: stderr 进度
    W-->>M: emit process:progress (substep=ffmpeg)
    M-->>P: webContents.send
    P-->>R: window.giftk.onProgress(cb)
    W->>FS: ffmpeg palette pass2 → out.gif
    W->>W: compressLoop (Phase A-D)
    W-->>M: emit process:progress (substep=compress)
    W-->>M: emit process:progress (status=done|skipped)
  end
  Q-->>M: queue idle
  M-->>P: 'process:progress' (final)
  P-->>R: TaskTable 全行 done

  Note over U,R: 用户中途按"取消"
  U->>R: cancelTask(taskId)
  R->>P: window.giftk.cancelTask(taskId)
  P->>M: ipcRenderer.invoke('cancel:task', taskId)
  M->>W: taskAborts.get(taskId).abort() (R-43.2)
  W-->>M: throws CancelledError
  W-->>M: emit process:progress (status=cancelled)
```

---

## 7. 4-Phase 压缩状态机

![4-Phase 状态机](./images/architecture-4-phases.png)

```mermaid
stateDiagram-v2
  [*] --> Phase0: enter compressLoop
  Phase0 --> PhaseA: estimate hits softMaxBytes?
  Phase0 --> Done: orig ≤ softMaxBytes × EARLY_FAST_RATIO
  PhaseA --> PhaseB: maxWidth applied, still > softMaxBytes
  PhaseA --> Done: hit softMaxBytes ± ACCEPT_TOL
  PhaseB --> PhaseB: bisect lossy 0..200
  PhaseB --> Done: hit softMaxBytes ± ACCEPT_TOL
  PhaseB --> PhaseC: lossy 200 still > softMaxBytes
  PhaseC --> PhaseC: shrink longest side × 0.85, guard shortSideFloor
  PhaseC --> Done: hit softMaxBytes
  PhaseC --> PhaseD: shortSideFloor reached, still > softMaxBytes
  PhaseD --> Done: hit maxBytes (hard target, R-79 warning)
  PhaseD --> Skipped: still > maxBytes after lossy=200 + minSize
  Done --> [*]
  Skipped --> [*]: never output a超规格 file

  note right of Phase0
    EARLY_FAST_RATIO / ACCEPT_TOL / SHRINK_FIRST_RATIO
    定义在 src/main/processor-utils.ts
    (单测 tests/main/processor-utils.test.ts)
  end note
```
