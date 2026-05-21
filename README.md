<p align="center">
  <img src="./build/icon.png" alt="Gif Toolkit logo" width="128" />
</p>

<h1 align="center">Gif Toolkit</h1>

<p align="center">
  <a href="./README.en.md">English</a> · <b>简体中文</b>
</p>

<p align="center">
  <b>本地跨平台桌面应用 · macOS / Windows / Linux</b><br/>
  一站式完成 <b>网页媒体抓取 → 视频转 GIF / WebP → 自适应压缩 → 图床上传</b>,<br/>
  把"喂一个文章 URL,拿一组刚好达标的 GIF + 现成 Markdown 链接"做成几次点击的事。
</p>

Gif Toolkit 解决一个非常具体的痛点 —— 各内容平台对动图都有严格的体积上限(微信公众号 ≤ 10 MB、Slack / 微博 ≤ 5 MB、Discord ≤ 8 MB……),而手动反复试边长、帧率、调色板既枯燥又低效。本工具把整条链路自动化,**离线可用、无登录、不上传任何数据到第三方服务器**。

---

## 📸 界面预览

<table>
  <tr>
    <td width="50%"><img src="./docs/images/screenshots/01-home.png" alt="主页:URL 嗅探 + 媒体网格 + 参数表 + 任务进度" /></td>
    <td width="50%"><img src="./docs/images/screenshots/02-toolbox.png" alt="工具箱:9 子工具 + 拖放区 + 参数表 + 历史结果" /></td>
  </tr>
  <tr>
    <td align="center"><sub>① 主页:URL → 嗅探 → 媒体网格 → 批处理</sub></td>
    <td align="center"><sub>② 工具箱:Video→GIF / WebP / Optimize / Trim / Crop ……</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="./docs/images/screenshots/03-history.png" alt="历史 Tab:嗅探与产物历史一站式回看" /></td>
    <td width="50%"><img src="./docs/images/screenshots/04-uploads.png" alt="上传历史 Tab:图床记录 + Markdown 复制" /></td>
  </tr>
  <tr>
    <td align="center"><sub>③ 历史:每轮嗅探 + 产物 + 操作日志全留底</sub></td>
    <td align="center"><sub>④ 上传历史:5 种图床后端 + 哈希去重 + Markdown</sub></td>
  </tr>
</table>

---

## ✨ 主要功能

### 🔍 网页媒体一键抓取
- 输入任意页面 URL,自动识别其中的 GIF、视频、嵌入式播放器(YouTube / Bilibili / Vimeo / X / TikTok / Instagram 等)。
- 提供四种嗅探模式,按反爬强度由弱到强切换:
  - **纯 URL 嗅探**:最快路径,适用于普通博客、新闻页、直链。
  - **嵌入式 WebView**:适用于需要登录或交互的站点。
  - **真实 Chrome 嗅探**:调用本机已安装的 Chrome / Edge / Brave,可绕过 Cloudflare 类反爬。
  - **yt-dlp 直接抓**:面向 1900+ 视频站,无需开浏览器。
- **离线导入**:支持 `.mhtml`、`.html + _files/`、单文件或拖拽,网站打不开也能继续工作。

### 🎞️ 视频 → GIF / 动画 WebP
- ffmpeg 两遍调色板生成 + Lanczos 缩放 + Bayer 抖动,出片质量稳定。
- 时间轴预览 + 关键帧速览,可拖动选取片段;原画面上自由拖拽裁剪框。
- 长视频自动分段,可勾选 0–20s / 20–40s …… 任意区间分别导出。

### ⚙️ 自适应压缩管线
四阶段渐进式策略,平均约 12 次 gifsicle 调用即可命中目标体积:

1. **缩放优先**:先把长边压到 `maxWidth` 内。
2. **自适应 lossy**:二分搜索 lossy 等级,优先命中 `softMaxBytes`(默认 2 MB)。
3. **几何缩边**:守护短边下限,逐步降分辨率。
4. **兜底**:仍超 `maxBytes` 标记 skipped,绝不输出垃圾文件。

可调参数包括 `maxBytes` / `softMaxBytes` / `maxWidth` / `minSize` / `fps` / `colors` / `concurrency` / `maxSegmentSec`,内置公众号 / 知乎 / 微博等平台预设。

### 🧰 GIF / WebP 工具箱
顶部「工具箱」Tab 提供 10 种独立工具,可直接拖入本地文件批量处理:

| 工具 | 用途 |
| --- | --- |
| Video → GIF | 视频转 GIF + 压缩 |
| Video → WebP | 视频转动画 WebP |
| GIF Resize | 等比缩放宽度 |
| GIF Optimize | gifsicle `-O3` / lossy / colors / dither |
| Trim | 裁剪时间区间(无损切片) |
| Speed | 0.25× ~ 4× 调速 |
| Reverse | 倒放 |
| Rotate | 旋转 + 翻转 |
| Crop | 可视化框选裁剪 |
| GIF ↔ WebP | 两种动画格式互转 |

### 📦 批处理 + 历史管理
- 主页一键批跑、运行中追加排队、长视频分段确认。
- 嗅探与产物历史自动落库(SQLite),支持单条 / 批量重跑、打开输出目录、查看产物清单。
- 详情面板内可查看完整操作日志,支持导出 `.log` / `.json`,排查"为什么压不下去"或"为什么重复"非常直观。

### ☁️ 图床上传
内置 5 种后端,可配置多个并按需切换:

- **自建 Web**(自定义接口签名)
- **GitHub Contents API**
- **七牛 Kodo**
- **阿里云 OSS**
- **腾讯云 COS**

文件 hash 去重(30 天 TTL),同一文件命中即复用远程 URL,不重复消耗带宽和图床配额。上传后自动生成 Markdown 链接,一键复制粘到文章里即可使用。所有 token / secret 全程脱敏,**绝不写入日志**。

### 🌐 跨平台支持

| 能力 | macOS | Windows | Linux |
| --- | --- | --- | --- |
| 安装包 | ✅ dmg / zip(Intel + Apple Silicon) | ✅ NSIS x64 | ⚠️ AppImage / deb / tar.gz(x64 + arm64,未在实机自测) |
| FFmpeg / Sharp / yt-dlp | ✅ | ✅ | ✅(armv7 / Alpine musl 需自行处理) |
| 真 Chrome 嗅探 | ✅ Chrome / Canary / Edge / Brave / Chromium | ✅ Program Files / per-user 路径 | ⚠️ 含 Snap / Flatpak / .deb / .rpm |
| 启动能力探测 | ✅ | ✅ | ✅ |

> 当前未配置 Apple 公证 / Authenticode / Linux 代码签名,首次运行需要走系统的"右键打开 / 跳过 SmartScreen"步骤,启动时会通过 toast 自动给出指引。

---

## 🚀 快速开始

### 终端用户(直接使用)

> 暂未提供官方 release。可参考下方"从源码运行"自行打包。

### 从源码运行

```bash
git clone <repo-url>
cd gif-toolkit
npm install            # 自动准备 ffmpeg / gifsicle / sharp / yt-dlp 等二进制
npm run dev            # 开发模式(主进程 + 渲染进程热更)
```

### 打包

```bash
npm run package:mac    # macOS:dmg + zip(Intel + Apple Silicon)
npm run package:win    # Windows:NSIS x64
npm run package:linux  # Linux:AppImage / deb / tar.gz
```

### 使用流程

1. 打开 App,在顶部地址栏粘贴一个含有 GIF / 视频的页面 URL。
2. 选择嗅探模式(默认"纯 URL 嗅探"足够)→ 点 **开始嗅探**。
3. 在媒体网格中勾选要处理的文件,按需调整 `maxWidth` / `softMaxBytes` 等参数。
4. 点击 **开始处理**,等待任务表跑完。
5. 在「上传历史」Tab 配置好图床后,点击 **⚡ 上传所有产物**,完成后复制生成的 Markdown 链接。

---

## 🛠️ 技术栈

| 层 | 技术 |
| --- | --- |
| 框架 | Electron 31 + React 18 + TypeScript 5 + Vite 5 |
| 抓取 | axios + cheerio(主进程,绕开 CORS) |
| 视频处理 | ffmpeg-static + ffprobe-static + sharp 0.33 |
| GIF 优化 | gifsicle 5.3 |
| 直链解析 | yt-dlp(随包分发,Unlicense) |
| 数据持久化 | better-sqlite3 |
| 队列 | p-queue(默认并发 3,可配置 1–8) |
| 测试 | vitest + happy-dom + @testing-library/react |

---

## 🔒 安全 & 隐私

- `contextIsolation=true`、`nodeIntegration=false`,渲染进程无 Node 能力。
- 仅暴露白名单 IPC,所有下载、解析、转码、上传都在主进程进行。
- 任何 URL 都只在本地处理,**不会发送到任何第三方服务器**。
- yt-dlp 解析直链时仅透传白名单 header(User-Agent / Referer / Origin / Range 等),禁止 Authorization / Cookie 沿用;日志写入前自动脱敏 signed URL / token。
- 上传后端的 token / secret 在 UI 中以 `••••••` 显示并启用 masked-merge,持久化时单独加密字段,**永不进入日志**。

---

## ❓ FAQ

**Q:为什么有时候我嗅探不到视频直链?**
A:站点会对未授权设备做 TLS 指纹 / Cookie 校验。建议切换到「真实 Chrome 嗅探」,并勾选「使用我真实 Chrome profile」让 Cloudflare 等把你识别成正常用户。

**Q:导出的 GIF 仍然超过目标体积怎么办?**
A:工具会标 `skipped` 而不是输出超规格文件。你可以提高 `maxBytes` 兜底阈值,或在工具箱里手动用更激进的 lossy / colors 参数重压。

**Q:可以离线使用吗?**
A:可以。yt-dlp、ffmpeg、gifsicle、sharp 全部随包分发,不需要联网。仅"嗅探在线 URL"这一步本身需要网络。

**Q:上传到 GitHub 仓库的图片会被识别成代码吗?**
A:不会。GitHub Contents API 返回的是 raw URL,可以直接嵌入 Markdown,与提交代码互不影响。

---

## 🏗️ 架构

进程拓扑(Renderer ↔ Preload ↔ Main):

![架构 · 进程拓扑](./docs/images/architecture-1-topology.png)

端到端数据流(URL → 嗅探 → 4-Phase 压缩 → 产物):

![架构 · 端到端数据流](./docs/images/architecture-2-dataflow.png)

> 所有架构图都是 mermaid 源 → PNG 派生产物,改图请编辑 [docs/architecture.md](./docs/architecture.md) 中的 mermaid 块,然后跑 `npm run docs:render` 重新出图。

---

## 📚 文档

面向开发者 / 协作者:

- [架构概览](./docs/architecture.md)
- [压缩管线细节](./docs/compression-pipeline.md)
- [嗅探链路](./docs/sniffer-cascade.md)
- [嗅探规则](./docs/sniffer-rules.md)
- [yt-dlp 嵌入解析](./docs/embed-resolver.md)
- [IPC 契约](./docs/ipc-contract.md)
- [常见故障排查](./docs/troubleshooting.md)
- [SQLite 持久化与原生 ABI](./docs/R-80-SQLITE-NOTES.md)

工程纪律(规则 / 场景 / Checklist):见 [harness/](./harness/) 目录。
新功能或 bug fix 的提交规范见 [AGENTS.md](./AGENTS.md)。

---

## 🤝 贡献

欢迎 issue / PR。提交前请阅读:

1. [AGENTS.md](./AGENTS.md) — 项目级硬规则。
2. [harness/checklists/pr-checklist.md](./harness/checklists/pr-checklist.md) — 提交前自检。
3. [harness/scenarios/](./harness/scenarios/) — 已沉淀的回归场景。

每个新功能 / bug fix 都需随测试一同提交。

---

## 致谢

- [ezgif.com](https://ezgif.com/) — 原始功能与交互参考
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — 直链解析事实标准
- [ffmpeg](https://ffmpeg.org/) / [gifsicle](https://www.lcdf.org/gifsicle/) / [sharp](https://sharp.pixelplumbing.com/) — 视频与 GIF 处理三大支柱

---

## License

MIT
