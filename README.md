# Gif Toolkit

> 一个本地跨平台(macOS / Windows)Electron 桌面 App,完整复刻并增强了 [ezgif.com](https://ezgif.com/) 的核心链路。

**输入文章 URL → 嗅探页面里的所有 video / gif → 选择 → 预览(裁剪框 + 时间轴 + 帧列表) → 批量转 GIF → 双层目标自适应压缩(best 2MB / fallback 4MB) → 落到本地子目录。**

> 协作 / 二次开发请先读 [AGENTS.md](file:///Users/guoshuyu/workspace/gif-toolkit/AGENTS.md) 与 [harness/](file:///Users/guoshuyu/workspace/gif-toolkit/harness/) — 那里有项目级 Harness 规则和回归场景库。

---

## 1. 技术栈

| 层 | 技术 |
|---|---|
| 框架 | Electron 31 + React 18 + TypeScript 5 + Vite 5 |
| 抓取 | axios + cheerio(主进程,绕开 CORS / cookie) |
| 视频 | ffmpeg-static / ffprobe-static(palette 两遍 + Lanczos + Bayer) |
| GIF 优化 | gifsicle@5.3.0(lossy / colors / optimize) |
| GIF 缩放 | sharp@0.33(支持 animated GIF) |
| 队列 | p-queue@6(默认 concurrency=3,可配置 1..8) |

> Renderer 端只渲染 UI;所有下载、解析、转码、压缩都在主进程,直接调本地二进制,不受浏览器 CORS / 内存限制影响。

---

## 2. 核心能力

### 2.1 URL 嗅探(7 条规则,通用,无 host 白名单)

1. `<video>` + `<source>` 标签(含 lazy/data-src)
2. `<img>` 后缀 `.gif`
3. `og:video` / `twitter:player:stream` meta
4. `<a href>` 后缀匹配
5. JSON-LD `VideoObject`
6. **`<iframe>` 已知播放器白名单**(Vimeo / YouTube / youtube-nocookie / Bilibili / Dailymotion / Wistia / Brightcove / Streamable / TED / Twitter video)— 这类标记 `requiresExternalDownload: true`,**仅识别不下载**(Vimeo/YouTube 用 MSE/HLS,无现成 .mp4 直链)
7. 全文正则兜底:`/(https?:\/\/[^\s"'<>()]+\.(?:mp4|webm|gif))/gi`

详细规则见 [docs/sniffer-rules.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/sniffer-rules.md)。

### 2.2 预览 / 裁剪 / 帧抽取

- GIF / 图片 → `<img>`;视频 → `<video controls>`
- ffmpeg 抽 6 张时间轴关键帧
- 在画面上拖拽生成自然分辨率的 cropRect,转 GIF 时通过 `crop=W:H:X:Y` 滤镜处理
- 时间轴可拖动起止把手 + 整体平移 + 点击 seek

### 2.3 双层目标自适应压缩(R-04 / R-05 / R-06)

详细见 [docs/compression-pipeline.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/compression-pipeline.md)。一句话:

```
Phase A  resize-first       (长边 ≤ maxSide,短边 ≥ minSide,做不到 → AspectRatioConstraintError 早 fail)
Phase B  adaptive lossy     (二分搜索,起点根据 currentSize/softTarget 自适应,目标 softMaxBytes=2MB)
Phase C  几何缩边            (longSideFloor 守护,保证短边 ≥ minSide)
Phase D  兜底               (finalSide=longSideFloor,目标 maxBytes=4MB)
```

性能:相比之前的 245 次穷举,现在平均 **~12 次 gifsicle 调用** 就能落到目标。

### 2.4 批处理

- p-queue concurrency=3(可配置 1..8)
- 渲染端实时收 `process:progress` IPC,带 `substep / detail / elapsedMs / stepIndex / totalSteps`
- 单段最长 15s,超过自动分段(part1 / part2 …)

### 2.5 第三方播放器嵌入(R-09)

| 现象 | 行为 |
|---|---|
| 页面里是 `<video src=*.mp4>` | 正常嗅出,可直接处理 |
| 页面里是 Vimeo / YouTube `<iframe>` | 列出来 + 标黄色徽章 "vimeo.com 嵌入 · 无法直抓" + 禁用处理按钮 + 提示用户去原页面取 .mp4 直链 |
| 页面只有 base64 video data URL | 不抓(本地大流量,价值低) |

---

## 3. 目录结构

```
gif-toolkit/
├── AGENTS.md            ★ 协作者必读
├── README.md            ← 你正在看的
├── docs/                ★ 工程文档
│   ├── architecture.md
│   ├── sniffer-rules.md
│   ├── compression-pipeline.md
│   ├── ipc-contract.md
│   └── troubleshooting.md
├── harness/             ★ 工程级 Harness(规则 + 场景库 + checklist)
│   ├── run-harness.md
│   ├── rules/           # R-01..R-12 细化版
│   ├── scenarios/       # SC-01..SC-06 已沉淀的回归场景
│   ├── checklists/
│   └── regression/      # 回归 fixtures(URL / mhtml / 期望输出)
├── src/
│   ├── main/            # Electron 主进程
│   │   ├── index.ts        # 入口、窗口、IPC 路由
│   │   ├── binaries.ts     # ffmpeg/ffprobe/gifsicle 路径解析(asar.unpacked)
│   │   ├── sniffer.ts      # URL 媒体嗅探(7 条规则)
│   │   ├── downloader.ts   # 流式下载
│   │   ├── ffmpeg.ts       # palette 两遍 + sharp 缩放 + gifsicle 优化
│   │   ├── processor.ts    # 任务调度 + 四阶段压缩 + AspectRatioConstraintError
│   │   └── logger.ts
│   ├── preload/index.ts    # contextBridge: window.giftk.*
│   ├── renderer/
│   │   ├── App.tsx, main.tsx, styles.css, global.d.ts
│   │   └── components/
│   │       ├── MediaGrid.tsx, MediaList.tsx
│   │       ├── OptionsForm.tsx
│   │       ├── PreviewModal.tsx, PreviewPanel.tsx
│   │       ├── CropBox.tsx, Timeline.tsx
│   │       ├── TaskTable.tsx, LogBox.tsx, ErrorBoundary.tsx
│   └── shared/types.ts     # 主/渲共享类型(SniffedMedia / ProcessOptions / TaskProgress …)
├── tsconfig.{main,renderer}.json
├── vite.config.ts
└── package.json
```

---

## 4. 运行

```bash
cd gif-toolkit
npm install        # 自动下载 ffmpeg-static / gifsicle / sharp 二进制
npm run dev        # 开发(主+渲热更)
npm run typecheck  # 主+渲分别 tsc --noEmit
npm run lint       # eslint 0 warning
npm run build      # 编译 main + renderer
npm start          # 运行打包后的版本
npm run package:mac   # 打包成 dmg
npm run package:win   # 打包成 nsis
```

> **注意**:Mac 第一次跑可能要等 sharp 编译;Windows 上不需要 VS Build Tools(预编译二进制)。

---

## 5. 错误码 / 错误信息对照表

| 错误 | 何时出现 | 期望行为 |
|---|---|---|
| `AspectRatioConstraintError` | 输入是长条图(高宽比 ≥ 4)且 minSide 太大 | UI 弹错并标 `skipped`,不输出垃圾文件 |
| `gif saved (X.XX MB <= 2.0MB (best))` | Phase B 直接命中 softMaxBytes | OK,best target |
| `gif saved (X.XX MB <= 4.0MB (fallback))` | Phase C/D 命中 fallback | OK,degraded |
| `gif over 4.0MB, marking skipped` | 兜底也压不下去 | UI 标 skipped,不输出 |
| `[single] 已跳过(vimeo.com 嵌入,无法直接下载视频流)` | 用户点击了 iframe-embed 卡片的处理按钮 | 静默跳过 + 写日志 |
| `busy` | 后台已有任务在跑 | 提示用户先取消或等待 |

---

## 6. 安全 & 隐私

- contextIsolation=true、nodeIntegration=false
- 仅暴露白名单 IPC `window.giftk.*`(见 [docs/ipc-contract.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/ipc-contract.md))
- 任何 URL 都只在本地处理,**不会上传到任何第三方服务器**
- `sniff:url` 通道拒绝 `file://`、`javascript:` 等非 http(s) 协议

---

## 7. 想给项目添加新功能?

请先读:

1. [AGENTS.md](file:///Users/guoshuyu/workspace/gif-toolkit/AGENTS.md) — 12 条项目级硬规则 (R-01..R-12)
2. [harness/scenarios/](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/) — 已知问题与对应回归
3. [harness/checklists/pr-checklist.md](file:///Users/guoshuyu/workspace/gif-toolkit/harness/checklists/pr-checklist.md) — 提交前自检

只有这样,你的改动才不会"修一个 bug 引出三个老 bug"。

---

## License

MIT
