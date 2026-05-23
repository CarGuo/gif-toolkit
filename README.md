<p align="center">
  <img src="./build/icon.png" alt="Gif Toolkit logo" width="160" />
</p>

<h1 align="center">Gif Toolkit</h1>

<p align="center">
  <b>一个本地、跨平台、不上传任何数据的桌面工具,把"网页媒体抓回来 → 剪 → 转 GIF / WebP → 压到平台限额 → 拿 Markdown 链接"这件事,做成几次点击。</b>
</p>

<p align="center">
  <a href="./README.en.md">English</a> · <b>简体中文</b>
  <br/><br/>
  <img alt="platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-1f6feb">
  <img alt="electron" src="https://img.shields.io/badge/Electron-31-2b3137">
  <img alt="react" src="https://img.shields.io/badge/React-18-149eca">
  <img alt="typescript" src="https://img.shields.io/badge/TypeScript-5-3178c6">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-2ea44f">
</p>

---

## 这是什么

写公众号 / 写技术博客 / 在 Slack & Discord 发动图,迟早要面对同一个问题:**平台都有自己一套硬限**(公众号 ≤ 10 MB 而且帧数还要 ≤ 300、微博 ≤ 5 MB、Discord ≤ 8 MB、Slack ≤ 5 MB……),手动反复试边长、帧率、调色板,既无聊又出不来稳定结果。

Gif Toolkit 把整条链路自动化:

- 给一个文章 URL,**自动嗅探**里面所有 GIF / 视频 / 嵌入式播放器(Bilibili / YouTube / X / TikTok / Instagram 等);
- **视频转 GIF / WebP** 用两遍调色板 + Lanczos 缩放 + Bayer 抖动,质量稳得住;
- **四阶段自适应压缩**保证最终体积刚好落在你设的"软目标 / 硬目标"之间,绝不输出超规格的垃圾文件;
- 一键上传到自建图床 / GitHub / 七牛 / OSS / COS,**自动生成 Markdown 链接**直接复制到文章里。

整个过程全部在本地跑,**离线可用,无登录,不发任何数据到第三方服务器**。

---

## 三段你大概率遇到过的痛

### 1. 视频转 GIF 总是要么糊要么超大

`ffmpeg -i x.mp4 out.gif` 出来的东西,要么字看不清,要么 30 MB,微信公众号根本传不上。手动调 `palettegen / paletteuse / lossy` 几次就放弃了。

> Gif Toolkit 默认就给你**两遍调色板 + lossy 二分搜索**,目标是"刚好命中你设的体积"。命中了就停,没命中再几何缩边,再不行就标 `skipped`,**绝不偷偷输出一个超规格文件糊弄你**。

### 2. 公众号那条 300 帧硬限,再小也传不上去

公众号编辑器对 GIF 有两条互不相干的硬限:**帧数 ≤ 300**、**header 必须干净**(不能有 diff-frame / comment / 偏移帧)。`gifsicle -O3` 反而会把 diff-frame 加回来,所以"我都压到 1 MB 了为啥还是传不上"是几乎所有人都会撞一次的坑。

> Gif Toolkit 内置一条独立的 **WeChat-safe sanitize 子管线**:gifsicle 探针读帧数 → ffmpeg `-gifflags -transdiff-offsetting` 全帧重铸 → gifsicle `-O0 --no-extensions --no-comments --lossy=80`。出来的 GIF 帧数 ≤ 300、variants=1、offset=0,**直接能贴进公众号编辑器**。

### 3. 嗅探不到、登录卡住、Cloudflare 拦截 ……

普通 `axios + cheerio` 抓不下来需要 JS 渲染、需要登录、被 Cloudflare 卡 JA3 指纹的页面。这类站点是动图素材的重灾区。

> Gif Toolkit 提供 **5 档嗅探级联**,从轻到重让你按需切换:
>
> ![嗅探级联](./docs/images/sniffer-cascade.png)
>
> 抓不下来的页面再难,也总有一档能拿到直链。

---

## 界面预览

<table>
  <tr>
    <td width="50%"><img src="./docs/images/screenshots/01-home.png" alt="主页:URL 嗅探 + 媒体网格 + 参数表 + 任务进度" /></td>
    <td width="50%"><img src="./docs/images/screenshots/02-toolbox.png" alt="工具箱:10 子工具 + 拖放区 + 参数表" /></td>
  </tr>
  <tr>
    <td align="center"><sub><b>主页</b> · 粘 URL → 嗅探 → 勾选 → 批处理</sub></td>
    <td align="center"><sub><b>工具箱</b> · 10 个独立工具,拖文件就能跑</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="./docs/images/screenshots/03-history.png" alt="历史 Tab:嗅探与产物历史一站式回看" /></td>
    <td width="50%"><img src="./docs/images/screenshots/04-uploads.png" alt="上传历史 Tab:图床记录 + Markdown 复制" /></td>
  </tr>
  <tr>
    <td align="center"><sub><b>历史</b> · 嗅探 / 产物 / 操作日志全留底</sub></td>
    <td align="center"><sub><b>上传历史</b> · 5 种图床 + 哈希去重 + Markdown</sub></td>
  </tr>
</table>

---

## 快速开始

### 三步上手

```bash
git clone <repo-url>
cd gif-toolkit
npm install     # 自动准备 ffmpeg / gifsicle / sharp / yt-dlp
npm run dev     # 主进程 + 渲染进程热更新
```

打开 App 之后:

1. 顶部地址栏粘贴一个含 GIF / 视频的页面 URL,点 **开始嗅探**
2. 在媒体网格里勾选要的文件,按需调 `softMaxBytes` / `maxWidth` / `fps` / `colors`
3. 点 **开始批处理**,等任务表跑完;到「上传历史」Tab 一键上传 + 复制 Markdown 链接

### 打包

```bash
npm run package:mac     # macOS:dmg + zip(Intel + Apple Silicon)
npm run package:win     # Windows:NSIS x64
npm run package:linux   # Linux:AppImage / deb / tar.gz
```

> 当前未配置 Apple 公证 / Authenticode / Linux 代码签名,首次运行会有"未知开发者"提示,App 内会通过 toast 给出"右键打开 / 跳过 SmartScreen"指引。

### 客户端检查更新（R-UPDATE）

App 启动后约 5 秒会静默查询一次 GitHub Releases；发现严格更高的稳定版本会自动弹出「检查更新」对话框。也可以随时手动触发：主窗口右上「⬆ 关于/更新」按钮、托盘菜单「检查更新…」、或 macOS 应用菜单「Help → About」。「下载最新版」会调用系统浏览器跳到对应 release 页（不引入 electron-updater，签名链路保持当前的 unsigned 状态）。结果在内存里缓存 6 小时；手动按钮始终强刷。

---

## 工具箱(10 个独立工具)

顶部「工具箱」Tab 提供 10 种独立工具,可直接拖入本地文件批量处理:

| 工具 | 用途 |
| --- | --- |
| Video → GIF | 视频转 GIF + 自适应压缩 |
| Video → WebP | 视频转动画 WebP |
| GIF Resize | 等比缩放宽度 |
| GIF Optimize | gifsicle `-O3` / lossy / colors / dither |
| GIF WeChat-safe | 三步 sanitize,产物可直接传公众号(≤ 300 帧 / header 干净) |
| Trim | 裁剪时间区间(无损切片) |
| Speed | 0.25x ~ 4x 调速 |
| Reverse | 倒放 |
| Rotate | 旋转 + 翻转 |
| Crop | 可视化框选裁剪 |
| GIF ↔ WebP | 两种动画格式互转 |

### 渐进式链路（R-TB-CHAIN-V2.6 — 弹窗化 + 自动播放预览）

工具箱右侧的历史结果区，每条 done 行都带「继续 →」按钮（aria-label 仍为「继续处理」）：点一下，会**弹出一个独立的链路弹窗（modal overlay）**，把刚才的产物作为根节点；批量 UI 不会被卸载，仍然挂载在弹窗背后。弹窗顶部一条线性面包屑记录每一步（`原始输入 → GIF Resize → GIF Optimize ...`），中间是当前产物的**自动播放预览**——`.gif/.webp` 用 `<img>` 借浏览器原生动画循环，`.mp4/.mov/.webm` 等视频走 `<video muted autoplay loop playsInline>`（Chromium muted 自动播放无须用户手势）。下方按产物扩展名过滤的下一步 chip（`.gif` 焦点不会出现 `Video → GIF`）+ 参数表单 + 「退出链路 / 取消 / 继续 →」footer。点击中间面包屑可回到历史节点再分叉。ESC 键 / 点击灰色遮罩 / 「退出链路」都关闭弹窗，链路本身不丢——再点任意历史「继续 →」即重新进入。

历史结果行也升级到 4-列布局：左侧 56×56 缩略图（默认显示静态首帧，**鼠标悬停**会切到 `giftk-local://` 真实文件让 GIF/WebP 自播）+ 状态/类型/时间元数据 + 「继续 →」紧凑按钮 + 删除。

![Lineage 弹窗 + 自动播放预览 + 4-列历史行](./docs/images/screenshots/05-toolbox-lineage-modal.png)

每一步实际上是单步 1-step `startToolboxChain` IPC，复用既有的链路运行器 / 取消传播 / 历史记录契约（详见 [docs/ipc-contract.md](./docs/ipc-contract.md) 与 SUITE TB-CHAIN A/B/C/D/E）。Crop 在链路模式下直接复用批量的 CropForm 把矩形写进 draft params，不再走 awaiting-input 暂停模型。

### 体验加速包（R-COMPRESS-V1 — 6 件 P0 体验项）

针对真实使用里"参数命名工程化但用户不知道该选什么"的反馈，工具箱与历史卡上集中落地了 6 处零回归的体验加速：

1. **GIF Optimize 顶部一行「目标体积」chip 条**：`< 2 MB / < 5 MB / < 10 MB / 自定义`，点一下即把 `method='budget'` + `maxBytes` 设到对应阈值。原有 `Optimization method` 下拉与 `Lossy 强度` 数字框不动，仅多出一个"先想清楚目标"的入口。

   ![GIF Optimize 顶部目标体积快捷条](./docs/images/screenshots/06-toolbox-target-bytes-chip.png)

2. **Video → GIF / WebP 的 smart fps 默认**：拖入视频后默认值改为 `min(srcFps, 24)` 而非固定 12，避免高帧率源被偷偷降到电影级帧率。

3. **Video → GIF 编码引擎切换**：参数表新增「编码引擎」segmented control，可在 `Fast (ffmpeg)` 和 `High quality (gifski)` 之间切。`gifski` 引擎走「ffmpeg 抽 PNG 序列 → gifski --fps --quality --repeat 编码」，色彩更细但更慢；默认仍为 ffmpeg 单遍调色板，零行为变更。`gifski-static` 已挂在 `optionalDependencies` 里，不存在时按钮禁用并降级为提示。

   ![Video → GIF 编码引擎切换](./docs/images/screenshots/07-toolbox-engine-toggle.png)

4. **Lineage modal 「试跑 0.5s」预览按钮**：footer 上原本只有 `取消 / 继续 →`，现在中间多了一个`试跑 0.5s`，用当前参数处理前 0.5 秒生成预览（不入历史、不发 progress 事件、不抢 p-queue 槽位）。配套独立 IPC `toolbox:trialRun` / `toolbox:trialCleanup`，临时产物落在 `os.tmpdir()/giftk-trial-*`，由 R-87 sweep 兜底清理。

   ![试跑 0.5s 预览按钮](./docs/images/screenshots/08-lineage-trial-preview.png)

5. **历史卡推荐预设 chip 行**：每张含 done 产物的历史卡，在状态条上方多一行`推荐预设：…`：
   - 视频产物（`.mp4/.mov/.webm/.mkv/.m4v`）→ `转 GIF · 快速` / `转 GIF · 高质量`
   - GIF / WebP 产物 → `压到 <5MB` / `压到 <2MB`

   点 chip 自动切到「工具箱」并原子地清空当前队列、整体替换 `kind+params`、把这条产物作为唯一输入入队，免去手动设 kind / 调参 / 选文件的来回跳。

   ![历史卡推荐预设 chip 行](./docs/images/screenshots/09-history-preset-strip.png)

6. **嗅探卡 → 上传历史一键跳转**（加速项）：嗅探卡顶部的「☁ 已上传 N」胶囊从纯展示改为可点击，跳到「上传历史」并定位到对应 record。

每件功能都跟有真实 UI-driven Playwright e2e（SUITE RCV1-A/B/C/D/E/F），不 mock `window.giftk`、走完整 preload bridge + 主进程 IPC + sqlite 链路，确保渲染端到主进程的 wiring 整体生效。

---

## 自适应压缩管线(为什么压得稳)

四阶段渐进式策略,平均约 12 次 gifsicle 调用即可命中目标体积:

![四阶段自适应压缩](./docs/images/compression-1-targets.png)

1. **缩放优先**:先把长边压到 `maxWidth` 内(很多视频源压一下分辨率体积就够了)
2. **自适应 lossy**:在 `[0, 200]` 区间二分 lossy 等级,优先命中 `softMaxBytes`(默认 2 MB)
3. **几何缩边**:守护短边 `minSize` 下限,长边 × 0.85 反复缩
4. **兜底**:仍超 `maxBytes`(默认 4 MB)就标 `skipped`,**绝不输出超规格文件**

> 详细的状态机、命中条件、emit 信号约定见 [docs/compression-pipeline.md](./docs/compression-pipeline.md);WeChat-safe sanitize 子管线见同文档第 8 节。

可调参数:`maxBytes` / `softMaxBytes` / `maxWidth` / `minSize` / `fps` / `colors` / `concurrency` / `maxSegmentSec`,内置公众号 / 知乎 / 微博等平台预设。

---

## 五档嗅探级联(为什么抓得到)

| 档位 | 实现 | 适合的页面 |
| --- | --- | --- |
| (1) URL 嗅探 | 主进程 axios + cheerio | 普通博客 / 新闻页 / 直链 / og:video 暴露 |
| (2) 嵌入式 WebView | `WebContentsView` + `webRequest.onBeforeRequest` | 需要登录 / Cookie / OAuth / 轻交互的站 |
| (3) 真实 Chrome 嗅探 | spawn 本机 Chrome / Edge / Brave + chrome-remote-interface CDP | Cloudflare / JA3 严校验的站 |
| (4) yt-dlp 直接抓 | ytdlp-nodejs `--dump-single-json` | 1900+ 视频站(Bilibili / YouTube / X / TikTok / Instagram ……) |
| (5) 离线导入 | `.mhtml` / `.html + _files/` / 单文件 / 拖拽 | 站已经打不开了 / 网络不可用 / 整页保存 |

> 详细的嗅探规则、dedupKey 算法、embed provider 列表见 [docs/sniffer-cascade.md](./docs/sniffer-cascade.md) 与 [docs/sniffer-rules.md](./docs/sniffer-rules.md)。

---

## 图床上传

内置 5 种后端,可配置多个并按需切换:

- **自建 Web**(自定义接口签名)
- **GitHub Contents API**
- **七牛 Kodo**
- **阿里云 OSS**
- **腾讯云 COS**

文件 hash 去重(30 天 TTL),同一文件命中即复用远程 URL,不重复消耗带宽和图床配额。上传后自动生成 Markdown 链接,一键复制粘到文章里就能用。所有 token / secret 全程脱敏,**绝不写入日志**。

---

## 跨平台支持

| 能力 | macOS | Windows | Linux |
| --- | --- | --- | --- |
| 安装包 | dmg / zip(Intel + Apple Silicon) | NSIS x64 | AppImage / deb / tar.gz(x64 + arm64) |
| FFmpeg / Sharp / yt-dlp | Yes | Yes | Yes(armv7 / Alpine musl 需自行处理) |
| 真实 Chrome 嗅探 | Chrome / Canary / Edge / Brave / Chromium | Program Files / per-user 路径 | Snap / Flatpak / .deb / .rpm |
| 启动能力探测 | Yes | Yes | Yes |
| App Icon | `.icns`(10 档 iconset) | `.ico`(7 档) | `.png` 多档 8 个尺寸 |

> App Icon 资产链路用了 824 / 1024 安全区(对齐 Apple HIG)+ squircle 圆角,所有平台分发产物由 [scripts/normalize-app-icon.mjs](./scripts/normalize-app-icon.mjs) 单脚本一键生成,零新增依赖。详见 [docs/architecture.md § 8](./docs/architecture.md)。

---

## 技术栈

| 层 | 技术 |
| --- | --- |
| 框架 | Electron 31 + React 18 + TypeScript 5 + Vite 5 |
| 抓取 | axios + cheerio(主进程,绕开 CORS) + chrome-remote-interface(CDP) |
| 视频处理 | ffmpeg-static + ffprobe-static + sharp 0.33 |
| GIF 优化 | gifsicle 5.3 |
| 直链解析 | yt-dlp(随包分发,Unlicense) |
| 数据持久化 | better-sqlite3 |
| 队列 | p-queue(默认并发 3,可配置 1–8) |
| 测试 | vitest + happy-dom + @testing-library/react + playwright(e2e) |

---

## 架构传送门

进程拓扑(Renderer ↔ Preload ↔ Main):

![架构 · 进程拓扑](./docs/images/architecture-1-topology.png)

端到端数据流(URL → 嗅探 → 4-Phase 压缩 → 产物):

![架构 · 端到端数据流](./docs/images/architecture-2-dataflow.png)

并发与取消传播(每 task 独立 AbortController,signal 贯穿到 ffmpeg 子进程):

![架构 · 并发与取消传播](./docs/images/architecture-6-cancel.png)

> 所有架构图都是 mermaid 源 → PNG 派生产物,改图请编辑 [docs/architecture.md](./docs/architecture.md) / [docs/compression-pipeline.md](./docs/compression-pipeline.md) / [docs/sniffer-cascade.md](./docs/sniffer-cascade.md) 中的 mermaid 块,然后跑 `npm run docs:render` 重新出图。

---

## 安全 & 隐私

- `contextIsolation=true` / `nodeIntegration=false`,渲染进程**没有任何** Node 能力
- 仅暴露白名单 IPC,所有下载、解析、转码、上传都在主进程进行
- 任何 URL 都只在本地处理,**不会发送到任何第三方服务器**
- yt-dlp 解析直链时仅透传白名单 header(User-Agent / Referer / Origin / Range 等),**禁止 Authorization / Cookie 沿用**;日志写入前自动脱敏 signed URL / token
- 上传后端的 token / secret 在 UI 中以 `••••••` 显示并启用 masked-merge,持久化时单独加密字段,**永不进入日志**

---

## FAQ

**Q:为什么我嗅探不到视频直链?**
A:站点常会做 TLS 指纹 / Cookie 校验。建议切到「真实 Chrome 嗅探」,勾选「使用我真实 Chrome profile」,让 Cloudflare 等把你识别成正常用户。

**Q:导出的 GIF 仍然超过目标体积怎么办?**
A:工具会标 `skipped` 而不是输出超规格文件。你可以提高 `maxBytes` 兜底阈值,或在工具箱里手动用更激进的 lossy / colors 参数重压。

**Q:公众号还是显示"图片载入失败"?**
A:试一下「GIF WeChat-safe」工具,它会强制重铸帧 + 关闭 transdiff-offsetting + 用 `gifsicle -O0` 输出。详细原理见 [docs/compression-pipeline.md § 8](./docs/compression-pipeline.md)。

**Q:可以离线使用吗?**
A:可以。yt-dlp / ffmpeg / gifsicle / sharp 全部随包分发,不需要联网。仅"嗅探在线 URL"这一步本身需要网络。

**Q:上传到 GitHub 仓库的图片会被识别成代码吗?**
A:不会。GitHub Contents API 返回的是 raw URL,可以直接嵌入 Markdown,与提交代码互不影响。

---

## 文档

面向开发者 / 协作者:

- [架构概览](./docs/architecture.md) — 进程拓扑、数据流、IPC 序列、4-Phase 状态机、跨平台 icon 链路、并发取消传播
- [压缩管线](./docs/compression-pipeline.md) — 4-Phase 命中条件、emit 信号、WeChat-safe sanitize 子管线
- [嗅探级联](./docs/sniffer-cascade.md) — 五档级联总图 + 每档工程要点
- [嗅探规则](./docs/sniffer-rules.md)
- [yt-dlp 嵌入解析](./docs/embed-resolver.md)
- [IPC 契约](./docs/ipc-contract.md)
- [常见故障排查](./docs/troubleshooting.md)
- [SQLite 持久化与原生 ABI](./docs/R-80-SQLITE-NOTES.md)

工程纪律(规则 / 场景 / Checklist):见 [harness/](./harness/)。
新功能或 bug fix 的提交规范见 [AGENTS.md](./AGENTS.md)。

---

## 贡献

欢迎 issue / PR。提交前请阅读:

1. [AGENTS.md](./AGENTS.md) — 项目级硬规则
2. [harness/checklists/pr-checklist.md](./harness/checklists/pr-checklist.md) — 提交前自检
3. [harness/scenarios/](./harness/scenarios/) — 已沉淀的回归场景

每个新功能 / bug fix 都需随测试一同提交。

### 测试三档（fast / smoke / all）

为了在「快速反馈」和「真实场景覆盖」之间取得平衡，测试入口分三档:

| 命令 | 范围 | 时长 | 适用场景 |
| ---- | ---- | ---- | -------- |
| `npm run test:fast` | vitest 单测（main/renderer/shared 全契约层） | ~6s | 本地写代码、commit 前 |
| `npm run test:e2e:smoke` | 真实 Electron 启动 + offline-import → process → mock-oss 上传 → SQLite 回写整链 | ~10s（含 build） | PR 自检、改 IPC/uploader/processor 时 |
| `npm run test:e2e` | 完整 playwright 122 用例（realPipeline 全契约 + UI 回归） | ~1.5min | 发版前、改 renderer 主流程时 |
| `npm run test:all` | 三档串跑 | ~2min | 最严格本地全闸 |

`smoke` 档使用 [`playwright.smoke.config.ts`](./playwright.smoke.config.ts)，testDir 指向 `tests/e2e-smoke/`，与 `tests/e2e/` 隔离;
关键产物上传走 `mock-oss://<sha8>.<ext>` 短路（`GIFTK_E2E_MOCK_UPLOAD=1` env + `!app.isPackaged` 双守卫，release 包永远不命中）。

---

## 致谢

- [ezgif.com](https://ezgif.com/) — 原始功能与交互参考
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — 直链解析事实标准
- [ffmpeg](https://ffmpeg.org/) / [gifsicle](https://www.lcdf.org/gifsicle/) / [sharp](https://sharp.pixelplumbing.com/) — 视频与 GIF 处理三大支柱

---

## License

MIT
