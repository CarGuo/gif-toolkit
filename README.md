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

### 2.5 第三方播放器嵌入(R-09 / R-14)

| 现象 | 行为 |
|---|---|
| 页面里是 `<video src=*.mp4>` | 正常嗅出,可直接处理 |
| 页面里是 **YouTube / X / Bilibili / Vimeo / Twitch / Reddit / TikTok / Instagram / Dailymotion / Facebook** `<iframe>` | 列出来 + **嗅探完成后自动后台批量解析直链**(yt-dlp 已随包分发,开箱即用,见 §2.6);成功后卡片左下显绿色 `✓ 已解析` chip |
| 页面里是其他 `<iframe>` 播放器(Wistia / Brightcove / Streamable / TED 等) | 列出来 + 黄色徽章 "嵌入 · 无法直抓" + 禁用处理按钮 |
| 页面只有 base64 video data URL | 不抓(本地大流量,价值低) |

### 2.6 直链解析(开箱即用,yt-dlp 已随包分发)

> 详细见 [docs/embed-resolver.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/embed-resolver.md)。

为了让 YouTube / X / Bilibili 等 iframe 视频也能进入处理链路,引入 **基于 [yt-dlp](https://github.com/yt-dlp/yt-dlp)(Unlicense,纯开源,无需注册 / 付费 API)的 resolver**。

**bundled + 自动解析流程**(R-14):

1. App 打包时 `electron-builder.asarUnpack` 把 `node_modules/ytdlp-nodejs/bin/**` 镜像到 `app.asar.unpacked/`,**yt-dlp 二进制随 dmg/installer 一起分发**(平均 ~30 MB 包体增量,业界 Stacher / Cobalt 同类做法)
2. App 启动时**不弹任何**安装确认弹窗,titlebar **没有** `yt-dlp 已就绪 / 未装` 状态徽章 —— 完全开箱即用
3. 嗅探完成后 `App.tsx` `useEffect([result])` 自动批量调起 `resolveEmbed`,无需用户点按钮
4. 卡片右下短暂显示蓝色 `⏳ 解析中…` tag,5-15 秒后变绿色 `✓ 已解析 · 720p` chip,自动加入 `selected` 集合
5. 解析成功的 media 自动并入 processable 集合,后续走和普通 video 一样的下载 → ffmpeg → palette → gif → 压缩链路
6. 失败(网络抖动 / yt-dlp 上游拒绝 / 直链过期)时 embed 卡片**保留**,卡片右下变 `↻ 重试解析` 小按钮,用户单击重试,**永不卡死**

**已支持站点**:YouTube / X(Twitter) / Bilibili / Vimeo / Twitch / Reddit / TikTok / Instagram / Dailymotion / Facebook(yt-dlp 实际覆盖 1800+ 站,本仓 host 白名单做防御纵深)。

**已知限制**:

- **X/Twitter 部分推文**:yt-dlp 上游频繁拒绝(`No video could be found in this tweet`),需 cookies 才能解开,本仓暂不集成 cookies 上传 UI(隐私敏感)
- **直链过期**:YouTube ~6h、B 站 ~6h;长时间不操作再批处理会 403,单击 `↻ 重试解析` 即可
- **YouTube 1080p+ 多为 DASH/HLS 分片**,被 `pickBestFormat` 过滤,fallback 到 720p 以下 progressive mp4(GIF 主诉求是小尺寸,影响可忽略)
- **air-gapped 极端场景**:仅当 packaged binary 镜像被人为破坏 + 无网络兜底时才会触发失败兜底,生产环境基本不会出现

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
│   ├── troubleshooting.md
│   └── embed-resolver.md       # yt-dlp resolver 设计(随包分发 + 自动解析)/ e2e
├── harness/             ★ 工程级 Harness(规则 + 场景库 + checklist)
│   ├── run-harness.md
│   ├── rules/           # R-01..R-14 细化版
│   ├── scenarios/       # SC-01..SC-15 已沉淀的回归场景
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
npm test           # vitest 单元测试(R-16)
npm run build      # 编译 main + renderer
npm start          # 运行打包后的版本
npm run package:mac   # 打包成 dmg
npm run package:win   # 打包成 nsis
```

> **注意**:Mac 第一次跑可能要等 sharp 编译;Windows 上不需要 VS Build Tools(预编译二进制)。

---

## 4.1 测试与回归(R-16)

每一个新功能 / bug fix 都必须**随测试一起提交**(R-16),否则不允许合并。

```bash
npm test              # 一次性跑所有 vitest 单元测试
npm run test:watch    # 开发时监听
npm run test:coverage # 覆盖率(v8 provider,reporter=text+html)
```

| 文件 | 覆盖范围 |
|---|---|
| [tests/main/helpers.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/helpers.test.ts) | `isPrivateHost`(SSRF 名单)/ `safeName`(路径净化、Win 保留名、控制字符)/ `fileNameFor`(扩展名推断、batch 去重) |
| [tests/main/processor-utils.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/processor-utils.test.ts) | 压缩管线纯函数:`clampConcurrency` / `shortSideAfterCap` / `compressCacheKey` / `planPhase0` / `adaptiveStartLossy` / `extrapolateNextLossy`(线性外推 O2)/ `geometricShrinkLongestSide`(0.95 cap) |
| [tests/main/ffmpeg-pure.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/ffmpeg-pure.test.ts) | `parseRational`(`30000/1001` / `0/0` / 畸形输入容错) |
| [tests/renderer/TaskTable.test.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/tests/renderer/TaskTable.test.tsx) | 重试按钮启用条件 / 防双击 / 警告详情弹窗 / 复制到剪贴板 / 空状态 |

测试栈:[vitest 2.1.8](file:///Users/guoshuyu/workspace/gif-toolkit/vitest.config.ts) + happy-dom + @testing-library/react。
渲染端测试用 happy-dom,主进程测试用 node 环境(避免无谓启动开销);Electron API 通过 `vi.mock('electron', …)` 隔离,**测试不会真起 Electron 也不会调真实 ffmpeg/yt-dlp 二进制**。

详细规则见 [R-16](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-16-tests-required.md)。

---

## 5. 错误码 / 错误信息对照表

| 错误 | 何时出现 | 期望行为 |
|---|---|---|
| `AspectRatioConstraintError` | 输入是长条图(高宽比 ≥ 4)且 minSide 太大 | UI 弹错并标 `skipped`,不输出垃圾文件 |
| `gif saved (X.XX MB <= 2.0MB (best))` | Phase B 直接命中 softMaxBytes | OK,best target |
| `gif saved (X.XX MB <= 4.0MB (fallback))` | Phase C/D 命中 fallback | OK,degraded |
| `gif over 4.0MB, marking skipped` | 兜底也压不下去 | UI 标 skipped,不输出 |
| `[single] 已跳过(vimeo.com 嵌入,无法直接下载视频流)` | 用户点击了 iframe-embed 卡片的处理按钮(且未解析直链) | 静默跳过 + 写日志 |
| `YT_DLP_UNAVAILABLE` | resolver 触发但 4 级 fallback 全部 miss + 网络下载失败(air-gapped) | embed 卡片保留 + 显示 `↻ 重试解析` 小按钮 |
| `No video could be found in this tweet` | yt-dlp 上游对部分 X 推文拒绝 | embed 卡片保留,允许重试 |
| `busy` | 后台已有任务在跑 | 提示用户先取消或等待 |

---

## 6. 安全 & 隐私

- contextIsolation=true、nodeIntegration=false
- 仅暴露白名单 IPC `window.giftk.*`(见 [docs/ipc-contract.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/ipc-contract.md))
- 任何 URL 都只在本地处理,**不会上传到任何第三方服务器**
- `sniff:url` 通道拒绝 `file://`、`javascript:` 等非 http(s) 协议
- yt-dlp resolver:**二进制随安装包分发**(Unlicense 无合规风险),解析直链时仅透传白名单 header(User-Agent / Referer / Origin / Accept-* / Range / X-CSRF-Token / X-Requested-With),禁止 Authorization / Cookie / Set-Cookie / Host 沿用;log buffer 写入前 `redactUrls()` 脱敏 signed URL / token
- **npm 供应链卫生(R-15)**:`.npmrc` 启用 `min-release-age=7`(新版本满 7 天才进 lockfile,挡 npm 投毒 golden hour)+ `ignore-scripts=true`(子依赖 lifecycle hook 全禁,native rebuild 走 `package.json.postinstall` 显式 allowlist)+ `save-exact=true`(精确版本)+ `audit-signatures=true`(sigstore 校验);CI 必须 `npm ci` 而非 `npm install`;`npm run lockfile:lint` 校验所有 resolved 指向官方 npm。详见 [R-15](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-15-npm-supply-chain-hygiene.md)

---

## 7. 想给项目添加新功能?

请先读:

1. [AGENTS.md](file:///Users/guoshuyu/workspace/gif-toolkit/AGENTS.md) — 项目级硬规则 (R-01..R-16)
2. [harness/scenarios/](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/) — 已知问题与对应回归(SC-01..SC-15)
3. [harness/checklists/pr-checklist.md](file:///Users/guoshuyu/workspace/gif-toolkit/harness/checklists/pr-checklist.md) — 提交前自检

只有这样,你的改动才不会"修一个 bug 引出三个老 bug"。

---

## License

MIT
