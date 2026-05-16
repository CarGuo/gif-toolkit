# docs/architecture.md

> 三段式 Electron:**Renderer(只渲染) → Preload(白名单桥) → Main(所有重活)**。
> 配套规则:[AGENTS.md R-01 / R-10 / R-11](file:///Users/guoshuyu/workspace/gif-toolkit/AGENTS.md)。

---

## 1. 进程拓扑

```
┌──────────────────────────────────────────────────────────────────┐
│                       Main Process (Node)                        │
│                                                                  │
│  ┌────────────┐   ┌────────────┐   ┌────────────────────────┐    │
│  │ index.ts   │ ─►│ sniffer.ts │ ─►│ downloader.ts          │    │
│  │ IPC 路由 + │   │ axios +    │   │ axios stream → tmp     │    │
│  │ 窗口生命周期│   │ cheerio    │   └────────────────────────┘    │
│  └────────────┘   └────────────┘                                 │
│         │                                                        │
│         │            ┌────────────┐   ┌────────────────────────┐ │
│         └───────────►│processor.ts│ ─►│ ffmpeg.ts              │ │
│                      │ pqueue +   │   │ ffmpeg + sharp +       │ │
│                      │ Phase A-D  │   │ gifsicle               │ │
│                      └────────────┘   └────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
                          ▲                  │
                  IPC handle / on            │ on('process:progress')
                          │                  ▼
┌──────────────────────────────────────────────────────────────────┐
│                  Preload (contextBridge 白名单)                   │
│                window.giftk = { sniff, preview, ... }             │
└──────────────────────────────────────────────────────────────────┘
                          ▲                  │
                          │                  ▼
┌──────────────────────────────────────────────────────────────────┐
│                   Renderer (React + Vite)                        │
│   App.tsx · MediaGrid · OptionsForm · PreviewModal · TaskTable   │
└──────────────────────────────────────────────────────────────────┘
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

```
URL ─► sniff:url ─► sniffPage ─► SniffedMedia[] ─► setItems
                                           │
                                           ▼
                                  自动勾选(排除 image / iframe-embed)
                                           │
                                           ▼
                              用户点 ▶ 开始批处理
                                           │
                                           ▼
                          start:batch ─► PQueue(concurrency) ─► processOne
                                                                   │
                            ┌──────────────────────────────────────┘
                            ▼
              Phase A → Phase B → Phase C → Phase D
                            │
                            ▼
                process:progress ─► Renderer TaskTable 实时更新
```
