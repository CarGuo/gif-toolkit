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
| 共享类型只放 [src/shared/types/](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types) | 主/渲两边 schema 漂移,运行期才发现 |
| 二进制路径只通过 [src/main/binaries.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/binaries.ts) | 打包后 ffmpeg 找不到 |
| `sniff:url` 拒绝 `file://` / `javascript:` | 任意文件读 + XSS 风险 |
| Preload 暴露的方法必须 + global.d.ts 一起改 | 生产构建 `window.giftk.foo` undefined |
| [processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) 不强行拆模块（≈ 3200 行豁免） | 见 [project_rules.md §7](file:///Users/guoshuyu/workspace/gif-toolkit/project_rules.md) — 真实业务复杂度，不是设计债 |

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

---

## 8. 跨平台 App Icon 资产链路

dock / taskbar / launcher 上 App 图标看起来比别人大,根因在于其它 App 都遵循 Apple HIG 的 **824 / 1024 安全区**:1024 画布里只有中心 824×824 正方形是有像素的,四周 100px 透明 padding;系统会按 padding 把图标在 dock 等位置缩放对齐。直接用 1024 全铺的 PNG 当 icon,等同于"别人 824 我 1024",视觉上自然偏大。

[scripts/normalize-app-icon.mjs](file:///Users/guoshuyu/workspace/gif-toolkit/scripts/normalize-app-icon.mjs) 是这条修正的唯一入口:

![跨平台 logo 资产链路](./images/architecture-5-icons.png)

```mermaid
flowchart LR
  Src["src/renderer/public/icon-source.png<br/>(原画 PNG, 任意尺寸)"] --> N["normalize-app-icon.mjs"]

  N --> S1["resize → 824 × 824 (sharp lanczos)"]
  S1 --> S2["squircle 圆角 SVG mask<br/>radius = 185 (Apple HIG)"]
  S2 --> S3["1024 透明画布 + offset 100 居中<br/>4 角 alpha=0 / 中心 alpha=255"]
  S3 --> Master["build/icon.png (1024×1024 master)"]

  Master --> M1["sharp 多档位 → build/icons/<br/>{16,32,48,64,128,256,512,1024}.png<br/>(Linux + electron-builder Linux icon dir)"]
  Master --> M2["build/icon.iconset/* (10 档含 @2x)<br/>iconutil → build/icon.icns<br/>(macOS dmg/zip)"]
  Master --> M3["手工 ICO 头部组装<br/>{16,24,32,48,64,128,256} PNG → build/icon.ico<br/>(Windows nsis)"]
  Master --> M4["复制 → src/renderer/public/icon.png<br/>(in-app DOM 渲染)"]

  M1 --> EB["electron-builder<br/>linux.icon = 'build/icons'"]
  M2 --> EB2["electron-builder<br/>mac.icon = 'build/icon.icns'"]
  M3 --> EB3["electron-builder<br/>win.icon = 'build/icon.ico'"]

  classDef src fill:#fff3e0,stroke:#e65100;
  classDef pkg fill:#e8f5e9,stroke:#2e7d32;
  class Src src;
  class EB,EB2,EB3 pkg;
```

零新增 npm 依赖:复用已经在 dependencies 里的 sharp、macOS 自带的 iconutil、纯 Node fs 手工拼 ICO 头(ICONDIR 6 字节 + ICONDIRENTRY 16 字节 × n + PNG 数据)。

---

## 9. 并发与取消传播

[processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) 用 [p-queue](https://github.com/sindresorhus/p-queue) 做并发,默认 concurrency=3(R-07 上限 8)。每个 task 在调度时分到一对 `(taskId, AbortController)`,存进 `taskAborts: Map<string, AbortController>`,signal 沿三层往下贯穿:

![并发与取消传播](./images/architecture-6-cancel.png)

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant R as Renderer
  participant M as Main IPC
  participant Q as PQueue (concurrency=3)
  participant W as Worker (processOne)
  participant FFM as ffmpeg / gifsicle child_process

  U->>R: startBatch(tasks)
  R->>M: invoke('start:batch')
  M->>Q: queue.add × N (each carries AbortController)
  par 3 tasks running concurrently
    Q->>W: processOne(taskA, signalA)
    Q->>W: processOne(taskB, signalB)
    Q->>W: processOne(taskC, signalC)
  end
  W->>FFM: spawn ffmpeg, pass { signal }
  Note over W,FFM: child_process 收到 signal,abort 时自动 SIGTERM

  U->>R: cancelTask(taskB)
  R->>M: invoke('cancel:task', taskB)
  M->>M: taskAborts.get(taskB)?.abort()
  M-->>W: signalB fired
  W->>FFM: SIGTERM 已发出
  W-->>M: throw CancelledError
  M-->>R: emit progress(taskB, status=cancelled)
  Note over Q,W: A / C 仍在跑,不受 B 取消影响
```

关键不变量:
- 一个 task 的 abort 只杀**它自己的** ffmpeg/gifsicle 子进程,**不影响**同 batch 其它并发 task(R-43.2)
- queue 跑空后 `taskAborts` 清空,防止内存泄漏
- 渲染端收到 `status=cancelled` 直接打 chip,不再期望后续 progress(R-26)

