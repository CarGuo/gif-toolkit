# Gif Toolkit

> **本地跨平台(macOS / Windows)桌面 App** —— 一键嗅探、批量下载页面里的 GIF 与视频,**视频自动转 GIF**,再叠加一套自适应压缩管线,把成品压到 **公众号 / 知乎 / 微博 / Slack / Discord** 等平台单文件大小硬限内。
>
> **解决一个真实痛点**:平台普遍要求 GIF ≤ 5MB(公众号 ≤ 10MB,Slack ≤ 5MB,微博 ≤ 5MB),手工导出/裁剪反复试边长、帧率、调色板的过程枯燥又低效。Gif Toolkit 把"嗅 → 抓 → 转 → 压 → 落盘"整条链路自动化,让你**喂一个文章 URL 进去,拿一组刚好达标的 GIF 出来**。

---

## ✨ 功能亮点

### 1. 一行 URL,批量收割页面所有 GIF / 视频
- **七类嗅探规则**:`<video>` / `<img.gif>` / `og:video` / `<a href>` / JSON-LD / `<iframe>` 播放器(YouTube · X · Bilibili · Vimeo · TikTok · Instagram · Facebook · Reddit · Dailymotion · Twitch …)/ 全文正则兜底,**无 host 白名单,通用方案**
- **iframe 嵌入自动解直链**:嗅探完即静默后台调起 [yt-dlp](https://github.com/yt-dlp/yt-dlp)(已随包分发,**Unlicense,开箱即用,零额外配置**),YouTube / 推特 / B 站等 1800+ 站点的视频也能进流水线
- 卡片式 UI 一眼看全:缩略图 / 时长 / 体积 / 解析状态(`⏳ 解析中` / `✓ 已解析 720p` / `↻ 重试`),失败永不卡死

### 1b. 四档嗅探链路(R-44 → R-53) + 离线导入兜底(R-55)
> 详见 [docs/sniffer-cascade.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/sniffer-cascade.md)。

针对不同站点的反爬强度,工具栏的「网页嗅探」是一个 **split-button**:左侧主按钮跑你上次选的方式,右侧 ▾ 弹出菜单可在三种 webview 模式间切换;另外纯 URL 嗅探作为最快路径默认始终可用:

| 档位 | 触发方式 | 适用场景 | 关键技术 |
|---|---|---|---|
| ⚡ 纯 URL 嗅探 | 输入框 → `开始嗅探` | 普通博客 / 新闻页 / 直链页 | axios + cheerio,主进程 7 类规则,无 webview |
| 🌐 嵌入式嗅探(快) | split-button 左 / 菜单 ① | 需要登录 / 交互 / OAuth 但 TLS 不严的站 | `WebContentsView` + `webRequest` + DOM 扫描(R-44 / R-47 / R-49 / R-50) |
| 🚀 真 Chrome 嗅探(过 Cloudflare) | split-button 左 / 菜单 ② | OpenAI / Medium / Patreon 等 Cloudflare TLS-JA3/JA4 严防站 | 启动用户本机 Chrome / Edge / Brave + CDP `chrome-remote-interface`,**真实浏览器握手过 Turnstile**(R-51) |
| ⚡ yt-dlp 直接抓 | split-button 左 / 菜单 ③ | YouTube / X / B 站 / TikTok 等 1900+ 已识别视频站 | 不开任何浏览器,URL → `yt-dlp --dump-single-json`,主进程一次过(R-52) |
| 📂 离线导入 | URL 栏右侧按钮 / 拖拽 | 网站完全打不开 / 已经手动存到本地 | `.mhtml` / `.html + _files/` / 单文件,RFC 2557 解析 + 本地相对路径解析(R-55 Fix #3) |

工程要点:
- **统一 single-flight**(R-53 Fix #2):四档共享 `currentSniffCtrl: AbortController`,切换任意一档会先 `abort()` 上一次,孤儿 webview / Chrome 子进程都会被强制收回。
- **AbortSignal 真透传**(R-53 Fix #1):取消时不再只关 UI;yt-dlp 子进程走 SIGTERM → 1 s SIGKILL 兜底,真 Chrome 收到 abort 会清掉 `SingletonLock` / `SingletonCookie` / `SingletonSocket`,下次启动同 profile 不会被锁。
- **真 Chrome 协作 finalize**(R-55 Fix #2):本机已开 Chrome 时,新 spawn 实例会瞬间合并到既有进程,关一个 tab 不会触发 `child.exit`,导致进度卡 60% 永远不结束。新增「✓ 完成嗅探」按钮 + `finalizeSignal: AbortSignal`(独立于 cancel 信号),让用户随时把当前已抓到的资源拿回 app,并配橙色脉冲 banner 强提示「在等你」而非卡死。
- **入口安全**(R-53 Fix #4):每档入口前先过 `ensurePublicHttp(url)`(协议 + IP/host 白名单,挡 SSRF / 私有网段);主进程 `sanitizeMedia(media)` 只接受 [src/shared/headers.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/headers.ts) 单一真源里声明的 `SNIFFED_MEDIA_SOURCES`,非法 source 直接 `throw`。
- **错误分类**(R-53 Fix #6):yt-dlp 失败被分到 `not-installed / aborted / login-wall / rate-limit / unsupported / network / generic` 6 档,UI 给的是中文人话提示,而不是甩一行 stderr。
- **a11y 菜单**(R-53 Fix #3):split menu 用 `role="menuitemradio"` + `aria-checked` + ArrowUp/Down/Home/End 键盘导航 + Esc 关闭 + 点击外部关闭 + 打开时焦点跳到当前选中项;窄 URL 栏下自适应宽度 + 智能左右翻转(R-55 Fix #1)。
- **离线导入**(R-55 Fix #3):支持 `.mhtml` 多 part 解析(把每个 part 落到 `os.tmpdir()` 后改写主 html 引用)、`.html + _files/` 完整目录、单图/单视频/单 GIF 直接合成 `SniffedMedia`;`resolveOfflineRef` 拒绝 `../` 与绝对系统路径,只在 baseDir 子树内开放;支持点按钮选 + 直接拖文件入窗。



### 2. 视频 → GIF 全自动,**长视频也能搞定**
- ffmpeg `palettegen + paletteuse`(两遍)+ Lanczos 缩放 + Bayer 抖动 —— 出片质量对得起公众号封面
- **长视频默认只截第 1 段**(`maxSegmentSec` 可调,默认 20s),避免一不小心炸出几十段;**多段勾选 UI** 让你按需选取 0-20s / 20-40s / … 任意段
- 时间轴 6 张关键帧速览,拖把手 / 整体平移 / 点击 seek;原画面上自由拖拽 cropRect,导出走 `crop=W:H:X:Y` 滤镜
- 单条视频可以一键拆出多段 GIF(part1 / part2 / …),每段独立压缩

### 3. 双层目标自适应压缩管线
> 详见 [docs/compression-pipeline.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/compression-pipeline.md)。

```
Phase A  resize-first      长边 ≤ maxWidth,短边 ≥ minSize(不达标 → 早 fail,可手动 forceAllowSmallSide 跳过)
Phase B  adaptive lossy    二分搜索 lossy,起点按 currentSize/softTarget 自适应,目标 softMaxBytes(默认 2MB)
Phase C  几何缩边           longSideFloor 守护短边 ≥ minSize,逐步降分辨率
Phase D  兜底              finalSide=longSideFloor,目标 maxBytes(默认 4MB);仍超就标 skipped 不输出垃圾
```

性能数字:相比传统 245 次穷举,**平均 ~12 次 gifsicle 调用就能落到目标**。
平台预设:公众号 / 知乎 / 微博 都给了 [DEFAULT_OPTIONS](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types.ts) 友好默认值,基本一键直出。

### 4. 多种参数任你调,精确匹配各平台限制
| 参数 | 说明 | 典型平台限制 |
|---|---|---|
| `maxBytes` (硬上限) | Phase D 兜底目标 | 公众号 ≤ 10MB,Slack/微博 ≤ 5MB |
| `softMaxBytes` (best) | Phase B 优先目标 | 公众号社交流首选 ≤ 2MB |
| `maxWidth` | 长边硬上限 | 默认 720,适合手机端 retina |
| `minSize` | 短边下限 | 防止压成"细长条" |
| `fps` | 帧率 | 默认 12,平衡观感 / 体积 |
| `colors` | 调色板色数 | 32 / 64 / 128 / 256 |
| `lossy` | gifsicle lossy 级别 | 自适应,无需手填 |
| `concurrency` | 并发任务数 | 默认 3,可 1..8 |
| `maxSegmentSec` | 长视频段长 | 默认 20s |
| `forceAllowSmallSide` | 跳过 minSize 检查 | 强行接受小图(R-26) |

### 5. 历史任务管理(R-27)
- **每次嗅探自动落一条历史**(localStorage 持久化,30 条上限,超出 LRU 淘汰),App 重启后照样能"打开目录"看老成品
- 历史详情展开:URL / 标题 / 输出目录(可一键打开文件管理器)/ 当时的参数 / 媒体清单 / 每条的状态徽章 / 产物文件列表
- **逐条重跑**:用历史里的参数重新处理某条媒体(参数失误 / 想换个 fps 重导出)
- **一致的删除确认**:`删除此条` / `清空历史` 都走 `window.confirm`,不会误删
- **写盘节流**:进度事件高频时也不卡 UI(250ms debounce + quota fallback)

### 6. 第三方播放器嵌入兜底
- yt-dlp **随安装包分发**(`electron-builder.asarUnpack` 镜像,~30 MB 增量),**完全离线可用**
- log buffer `redactUrls()` 脱敏 signed URL / token,日志贴出来不会泄密
- 直链失效(YouTube ~6h / B 站 ~6h)单击 `↻ 重试解析` 即可,永不卡死
- 已知限制:X(Twitter)部分推文需 cookies,本仓暂不集成 cookies 上传 UI(隐私敏感);YouTube 1080p+ 多为 DASH/HLS 分片,自动 fallback 到 720p progressive mp4(GIF 主诉求是小尺寸,影响可忽略)

### 7. 主流程任务表 + 实时日志
- TaskTable 实时显示每个 task 的 status / percent / substep / detail / elapsedMs / stepIndex/totalSteps
- LogBox 显示主进程的全部 ffmpeg / gifsicle / yt-dlp 输出,300 行环形 buffer
- 失败的 task 一键 `重试` 或 `强制允许小尺寸`,**不需要从头再嗅一遍**
- 底栏可拖拽调高/调低,持久化用户偏好

### 8. 上传到图床 + 嗅探历史关联(R-45 / R-46 / R-54)
- 五种图床后端:**自定义 Web** / **GitHub Contents API** / **七牛 Kodo** / **阿里云 OSS** / **腾讯云 COS**,token / secret 全部 `••••••` 脱敏 + masked-merge,**永远不进日志**
- 「⚡ 上传所有产物」按钮 **R-54 严控**:
  - 必须每个嗅探产物都跑到 `done` 才允许批量上传(label 实时显示 `(已完成/总)`,disabled 时鼠标悬停给中文 tooltip)
  - **未配置任何可用图床时点击会弹设置引导**:`isUploadConfigured(uploadConfigs)` 校验 active 后端的全部必填字段([useUploadHistory.ts#L208-L224](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/useUploadHistory.ts#L208-L224))
- **文件 hash 去重**(R-54):主进程 `runOneJob` 上传前先 `sha256(bytes)` 查 `<userData>/upload-hash-cache.json`,30 天 TTL 内同 backend 的同 hash 命中则**复用上次远程 URL,不发请求**(emit `done` w/ `reused=true`),复用项在 UI 上有 `♻️ 复用` 徽章([uploader/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/uploader/index.ts))
- **上传历史全保存 + 翻页**(R-54):`giftk.uploadHistory.v1` 取消 30 条 LRU 上限改全量持久化,`UploadHistoryPanel` 加分页 nav(默认 20/页 + 跳转输入)([UploadHistoryPanel.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/UploadHistoryPanel.tsx))
- **嗅探历史 ↔ 上传记录联动**(R-54):每次上传透传 `recordId`,完成态时 `mergeUploadIntoRecord` 把 `{ url, markdown, status, backend, fileHash, reused, uploadedAt }` 折回到嗅探 `HistoryRecord.uploadsByOutputPath`,在 `HistoryDetailModal` 里多了 「📤 上传记录」 区块,可以「复制 url」「复制 md」「重传」「一键上传未传产物」([HistoryDetailModal.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/HistoryDetailModal.tsx))

---

## 🚀 快速开始

```bash
git clone <this-repo>
cd gif-toolkit
npm install            # 自动下载 ffmpeg-static / gifsicle / sharp / yt-dlp 二进制
npm run dev            # 开发模式(主+渲热更)

npm run typecheck      # 主+渲分别 tsc --noEmit
npm run lint           # eslint 0 warning
npm test               # vitest 单元测试(150 用例,覆盖压缩管线 / sniffer / UI)
npm run build          # 编译 main + renderer
npm start              # 跑生产构建
npm run package:mac    # 打包 dmg
npm run package:win    # 打包 nsis
```

> Mac 第一次跑可能要等 sharp 预编译;Windows 上不需要 VS Build Tools(预编译二进制)。

---

## 🎨 应用图标 / Logo

应用统一使用 [build/icon.ico](file:///Users/guoshuyu/workspace/gif-toolkit/build/icon.ico) 作为各平台的 logo 来源,覆盖三处:

| 位置 | 配置 | 文件 |
|---|---|---|
| Electron 打包(mac / win / linux) | [package.json](file:///Users/guoshuyu/workspace/gif-toolkit/package.json) `build.mac.icon` / `build.win.icon` / `build.linux.icon` | [build/icon.ico](file:///Users/guoshuyu/workspace/gif-toolkit/build/icon.ico) |
| 应用窗口 icon(任务栏 / Dock) | [src/main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) `new BrowserWindow({ icon })` | 优先读 `build/icon.ico`,运行时找不到时安静兜底 |
| 网页 favicon(开发模式标签页) | [src/renderer/index.html](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/index.html) `<link rel="icon">` | [src/renderer/public/icon.ico](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/public/icon.ico) |

> 想换 logo:把新文件覆盖以上两处的 `icon.ico` 即可,Electron Builder / Vite 都会自动拾起;mac 想要更高分辨率的菜单栏图标可以另存一份 `build/icon.icns`,放在同一目录会被自动优先识别。

---

## 🧱 技术栈

| 层 | 技术 |
|---|---|
| 框架 | Electron 31 + React 18 + TypeScript 5 + Vite 5 |
| 抓取 | axios + cheerio(主进程,绕开 CORS / cookie) |
| 视频 | ffmpeg-static / ffprobe-static(palette 两遍 + Lanczos + Bayer) |
| GIF 优化 | gifsicle@5.3.0(lossy / colors / optimize) |
| GIF 缩放 | sharp@0.33(支持 animated GIF) |
| 直链解析 | yt-dlp(随包分发 / Unlicense) |
| 队列 | p-queue@6(默认 concurrency=3,可配置 1..8) |
| 测试 | vitest 2.1.8 + happy-dom + @testing-library/react |

> Renderer 端只渲染 UI;**所有下载、解析、转码、压缩都在主进程**,直接调本地二进制,不受浏览器 CORS / 内存限制影响。

---

## 📁 目录结构

```
gif-toolkit/
├── AGENTS.md            ★ 协作者必读(R-01..R-27 硬规则)
├── README.md            ← 你正在看的
├── docs/                ★ 工程文档
│   ├── architecture.md
│   ├── sniffer-rules.md
│   ├── compression-pipeline.md
│   ├── ipc-contract.md
│   ├── troubleshooting.md
│   └── embed-resolver.md
├── harness/             ★ 工程级 Harness(规则 + 场景库 + checklist)
│   ├── run-harness.md
│   ├── rules/           # R-01..R-27 规则细化
│   ├── scenarios/       # SC-01..SC-15 已沉淀回归场景
│   ├── checklists/
│   └── regression/      # 回归 fixtures(URL / mhtml / 期望输出)
├── src/
│   ├── main/            # Electron 主进程
│   │   ├── index.ts        # 入口、窗口、IPC 路由
│   │   ├── binaries.ts     # ffmpeg/ffprobe/gifsicle/yt-dlp 路径解析
│   │   ├── sniffer.ts      # URL 媒体嗅探(7 类规则)
│   │   ├── downloader.ts   # 流式下载
│   │   ├── ffmpeg.ts       # palette 两遍 + sharp 缩放 + gifsicle 优化
│   │   ├── processor.ts    # 任务调度 + 四阶段压缩 + AspectRatioConstraintError
│   │   ├── resolver.ts     # yt-dlp 直链解析
│   │   └── logger.ts
│   ├── preload/index.ts    # contextBridge: window.giftk.*
│   ├── renderer/
│   │   ├── App.tsx, main.tsx, styles.css, global.d.ts
│   │   └── components/
│   │       ├── MediaGrid.tsx, MediaList.tsx, OptionsForm.tsx
│   │       ├── PreviewModal.tsx, PreviewPanel.tsx, BatchSegmentModal.tsx
│   │       ├── CropBox.tsx, Timeline.tsx, SegmentPicker.tsx
│   │       ├── TaskTable.tsx, LogBox.tsx, ErrorBoundary.tsx
│   │       ├── HistoryPanel.tsx, useHistory.ts   # R-27
│   └── shared/types.ts
├── tests/               # vitest(150 用例)
├── tsconfig.{main,renderer}.json
├── vite.config.ts
└── package.json
```

---

## ⚠️ 错误码 / 错误信息对照表

| 错误 | 何时出现 | 期望行为 |
|---|---|---|
| `AspectRatioConstraintError` | 输入是长条图(高宽比 ≥ 4)且 minSize 太大 | UI 弹错并标 `skipped`,不输出垃圾文件;可点 `强制允许` 跳过 |
| `gif saved (X.XX MB <= 2.0MB (best))` | Phase B 命中 softMaxBytes | OK,best target |
| `gif saved (X.XX MB <= 4.0MB (fallback))` | Phase C/D 命中 fallback | OK,degraded |
| `gif over 4.0MB, marking skipped` | 兜底也压不下去 | UI 标 skipped,不输出 |
| `[single] 已跳过(vimeo.com 嵌入,未解析直链)` | 用户点击 iframe-embed 卡片但 yt-dlp 还没解开 | 静默跳过 + 写日志 |
| `YT_DLP_UNAVAILABLE` | resolver 触发但本地二进制不可用 + 网络下载失败 | embed 卡片保留 + `↻ 重试解析` |
| `No video could be found in this tweet` | yt-dlp 上游拒绝部分 X 推文 | embed 卡片保留,允许重试 |
| `busy` | 后台已有任务在跑 | 提示先取消或等待 |

---

## 🔒 安全 & 隐私

- `contextIsolation=true`、`nodeIntegration=false`
- 仅暴露白名单 IPC `window.giftk.*`(见 [docs/ipc-contract.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/ipc-contract.md))
- 任何 URL 都只在本地处理,**不会上传到任何第三方服务器**
- `sniff:url` 通道拒绝 `file://` / `javascript:` 等非 http(s) 协议
- 输出目录注册做了 SSRF 与路径越权防护;**历史目录注册 handler 包了最外层 try/catch**,即使 `process.cwd()` 在 corner case 下抛错也不会让整个历史面板瘫痪
- yt-dlp resolver 解析直链时仅透传白名单 header(User-Agent / Referer / Origin / Accept-* / Range / X-CSRF-Token / X-Requested-With),**禁止 Authorization / Cookie / Set-Cookie / Host 沿用**;log buffer 写入前 `redactUrls()` 脱敏 signed URL / token
- **npm 供应链卫生(R-15)**:`.npmrc` 启用 `min-release-age=7` + `ignore-scripts=true` + `save-exact=true` + `audit-signatures=true`;CI 必须 `npm ci`;`npm run lockfile:lint` 校验所有 resolved 指向官方 npm。详见 [R-15](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-15-npm-supply-chain-hygiene.md)

---

## 🧪 测试 & 回归(R-16)

每一个新功能 / bug fix 都必须**随测试一起提交**(R-16),否则不允许合并。

```bash
npm test              # 跑所有 vitest(150 用例)
npm run test:watch    # 开发监听
npm run test:coverage # v8 coverage,reporter=text+html
```

| 文件 | 覆盖范围 |
|---|---|
| [tests/main/helpers.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/helpers.test.ts) | `isPrivateHost` / `safeName` / `fileNameFor` |
| [tests/main/processor-utils.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/processor-utils.test.ts) | 压缩管线纯函数:`clampConcurrency` / `shortSideAfterCap` / `compressCacheKey` / `planPhase0` / `adaptiveStartLossy` / `extrapolateNextLossy` / `geometricShrinkLongestSide` |
| [tests/main/ffmpeg-pure.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/ffmpeg-pure.test.ts) | `parseRational` 容错 |
| [tests/renderer/TaskTable.test.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/tests/renderer/TaskTable.test.tsx) | 重试启用条件 / 防双击 / 警告弹窗 / 复制剪贴板 / 空状态 |
| [tests/renderer/HistoryPanel.test.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/tests/renderer/HistoryPanel.test.tsx) | R-27:展开折叠 / 打开目录 / 重跑禁用条件 / 单条/全部 删除 confirm |
| [tests/renderer/useHistory.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/renderer/useHistory.test.ts) | 持久化 / 30 条 LRU / 状态机不退化 / 终态间不互覆盖 / 损坏值容错 |
| [tests/renderer/BatchSegmentModal.test.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/tests/renderer/BatchSegmentModal.test.tsx) | 长视频分段勾选模态框 |
| [tests/renderer/SegmentPicker.test.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/tests/renderer/SegmentPicker.test.tsx) | 分段缩略图 / 选择交互 |

测试栈:**vitest 2.1.8 + happy-dom + @testing-library/react**。
渲染端测试用 happy-dom,主进程测试用 node 环境;Electron API 通过 `vi.mock('electron', …)` 隔离,**测试不会真起 Electron 也不会调真实 ffmpeg/yt-dlp 二进制**。

详细规则见 [R-16](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-16-tests-required.md)。

---

## 🤝 想给项目添加新功能?

请先读:

1. [AGENTS.md](file:///Users/guoshuyu/workspace/gif-toolkit/AGENTS.md) — 项目级硬规则(R-01..R-27)
2. [harness/scenarios/](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/) — 已知问题与对应回归(SC-01..SC-15)
3. [harness/checklists/pr-checklist.md](file:///Users/guoshuyu/workspace/gif-toolkit/harness/checklists/pr-checklist.md) — 提交前自检

只有这样,你的改动才不会"修一个 bug 引出三个老 bug"。

---

## 致谢

- [ezgif.com](https://ezgif.com/) — 原始功能与交互参考
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — 直链解析事实标准(Unlicense)
- [ffmpeg](https://ffmpeg.org/) / [gifsicle](https://www.lcdf.org/gifsicle/) / [sharp](https://sharp.pixelplumbing.com/) — 视频/GIF 处理三大支柱

---

## License

MIT
