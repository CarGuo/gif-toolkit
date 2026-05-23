# 第三方播放器 → mp4 直链 resolver

> 解决"YouTube / X / Bilibili 视频嗅探出来后无法处理"的场景。
> 关联规则：[R-14](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-14-resolver-bundled.md)

---

## 1. 问题背景

[R-09](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-09-iframe-embed-detect-only.md) 规定：第三方播放器 iframe 仅识别不下载，因为它们使用 MSE+HLS/DASH 分片流，没有可直接 GET 的 .mp4。

但用户实际场景里这些 embed 才是最有价值的素材（YouTube / X / Bilibili 上的短片段）。完全不能处理 → 用户体验断层。

参考 [twittervideodownloader.com](https://twittervideodownloader.com/) 这类工具的思路：解析 player iframe 拿到真实流 URL 后再下。

---

## 2. 设计选择：yt-dlp（[ytdlp-nodejs](https://www.npmjs.com/package/ytdlp-nodejs) 包装）

调研结论：

| 方案 | 站点覆盖 | 维护活跃度 | 是否需要付费 / 注册 | 选择 |
|---|---|---|---|---|
| **yt-dlp** (binary, ~30 MB) | **1800+** | 极活跃（每周更新） | No Unlicense，无需注册 | Yes |
| youtube-dl | ~600 | 已停滞 | No | No 弃用 |
| @distube/ytdl-core / play-dl (纯 JS) | 仅 YouTube | cipher 经常失效 | No | No 不稳定 |
| RapidAPI / Twitter API | 有限 | 商业 | Yes 需要 API Key + 付费 | No |
| 自实现各家 internal API 嗅探 | 极有限 | 不稳定 | No | No 维护成本高 |

`ytdlp-nodejs@^3.4.4` 提供：
- `helpers.downloadYtDlp(dir)` — 按平台下载 yt-dlp 二进制到指定目录，返回最终路径（仅作为 air-gapped 兜底）
- `helpers.BIN_DIR` — npm 包内置默认目录（`node_modules/ytdlp-nodejs/bin/`）
- `new YtDlp({ binaryPath }).getInfoAsync(url)` — 调 yt-dlp `--dump-single-json --flat-playlist` 拿 VideoInfo
- `VideoInfo.formats[]` — 所有可用格式，含 `url`, `protocol`, `vcodec`, `acodec`, `ext`, `width`, `height`, `tbr`, `format_note`, `http_headers`

---

## 3. 整体架构（开箱即用 / bundled 模型）

```
┌─ 打包阶段（electron-builder） ────────────────────────┐
│ asarUnpack: node_modules/ytdlp-nodejs/bin/** │
│ → app.asar.unpacked/.../bin/yt-dlp_<platform> │
│ build.files 不再排除 yt-dlp bin │
└───────────────────────────────────────────────────────┘
                        │
                        ▼
┌─ Renderer ────────────────────────────────────────────┐
│ App.tsx │
│ useEffect([result]) │
│ pending = items.filter(requiresExternal │
│ && !resolved && !resolving && !errored) │
│ for (m of pending) onResolveEmbedById(m.id) │
│ —— 嗅探完成 → 自动批量解析（无 confirm/install） │
│ onResolveEmbedById(id) │
│ 1. resolveEmbed(media)（直接调，无 install 步骤） │
│ 2. 成功 → resolvedMap[id] = ResolvedMedia │
│ 3. 失败 → resolveErrorMap[id] = redacted msg │
│ MediaGrid │
│ resolved → Yes 已解析 chip（绿色） │
│ resolving → wait 解析中… tag（蓝色） │
│ errored → ↻ 重试解析 小按钮（琥珀色，仅失败显示） │
│ processable filter: !requiresExternal || resolved │
└───────────────────────┬───────────────────────────────┘
                        │ IPC (contextBridge)
                        │ resolve:checkYtdlp / resolve:embed
                        ▼
┌─ Main (Node) ─────────────────────────────────────────┐
│ resolve:embed │
│ sanitizeMedia → isResolvable(host allow-list) │
│ resolveEmbed(media) │
│ ensureYtdlp() ← 四级 fallback 找 binary │
│ 1. app.asar.unpacked/.../bin/<name>（生产） │
│ 2. node_modules/ytdlp-nodejs/bin/<name>（dev） │
│ 3. helpers.BIN_DIR（npm 包内置） │
│ 4. userData/bin/<name>（老版本遗留） │
│ 5. helpers.downloadYtDlp(userData/bin)（兜底） │
│ ← media.url（iframe src，不是 pageUrl） │
│ pickBestFormat: 排除 m3u8/dash/mhtml │
│ sanitizeHeaders: 白名单 │
│ ensurePublicHttp + isPrivateHost │
│ ResolvedMedia { url, headers, mime, qualityLabel,... }│
└───────────────────────┬───────────────────────────────┘
                        │ ResolvedMedia 回流到 Sniff
                        ▼
┌─ 既有处理链路（无修改） ─────────────────────────────┐
│ processor.ts │
│ const fetchUrl = media.resolved?.url || media.url │
│ const fetchHeaders = media.resolved?.headers │
│ downloadToFile(fetchUrl, dest, signal, fetchHeaders)│
│ ffmpeg.ts videoToGifPalette → palettegen → paletteuse │
│ gifsicle 二分搜索压缩到 softMaxBytes/maxBytes │
└───────────────────────────────────────────────────────┘
```

---

## 4. 关键不变量

### 4.1 随包分发 + 自动解析（R-14）

| 阶段 | 行为 | resolver 触发 |
|---|---|---|
| 打包 | `electron-builder.asarUnpack` 包含 `node_modules/ytdlp-nodejs/bin/**`，binary 进 dmg/installer | — |
| 启动 | `checkYtdlp()` 仅作诊断 IPC 暴露，UI 默认不消费 | No 不会 |
| 嗅探 | sniffer 仅打 `requiresExternalDownload: true` 标记 | No 不会 |
| 嗅探完成 | `App.tsx` `useEffect([result])` 自动批量调起 `resolveEmbed` | Yes 自动 |
| 用户重试 | 失败卡片显示 `↻ 重试解析` 按钮 | Yes 用户单击单个重试 |

**已删除概念**：`installYtdlp` / `uninstallYtdlp` IPC、`onResolveInstallProgress` 事件、`ytdlp-chip` 状态徽章、确认下载二进制的 `confirm()` 弹窗、橙色 ` 解析直链` 按钮。

### 4.2 安全防御纵深

每一层都重新校验：

| 层 | 文件 | 校验 |
|---|---|---|
| Renderer | [App.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/App.tsx) `useEffect([result])` | resolveErrorMap 守卫，避免重复触发 |
| Renderer | [MediaGrid.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/MediaGrid.tsx) | resolving / resolved / errored 三态正交 |
| Preload | [preload/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/index.ts) ensureObject | 拒绝非对象 payload |
| Main IPC | [main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) `sanitizeMedia` | embedHost 限 `[a-z0-9.-]{<=64}` |
| Main IPC | [main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) `isResolvable` | host allow-list 三次校验 |
| Resolver | [resolver/ytdlp.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/resolver/ytdlp.ts) `ensurePublicHttp` | http(s) + 非私网（SSRF） |
| Resolver | [resolver/ytdlp.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/resolver/ytdlp.ts) `sanitizeHeaders` | header 白名单 + CRLF/NUL 过滤 |
| Resolver | [resolver/ytdlp.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/resolver/ytdlp.ts) `pickBestFormat` | 排除 m3u8/dash_segments/mhtml |
| Main IPC | [main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) `sanitizeResolved` | 渲染端回流的 ResolvedMedia 也过白名单 |

### 4.3 失败兜底（[SC-15](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-15-resolver-failure-fallback.md)）

任意环节失败 → embed 卡片保留 + 用户可重试，**永不卡死**。`resolveErrorMap` 防止 useEffect 无限循环。

---

## 5. 支持的站点

[main/resolver/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/resolver/index.ts) `SUPPORTED_HOSTS`：

| 站点 | 域名 | 备注 |
|---|---|---|
| YouTube | youtube.com / youtu.be / m. / music. | 首选 progressive mp4，否则 yt-dlp 自动 demux |
| X / Twitter | twitter.com / x.com / mobile. / video.twimg.com | **常受 yt-dlp 上游限制**，需 cookies 兜底（用户自行配置） |
| Bilibili | bilibili.com / b23.tv / player. / m. / www. | **必须透传 Referer** |
| Vimeo | vimeo.com / player. | |
| Twitch | twitch.tv / clips. | 仅短片段（VOD 太大） |
| Reddit | reddit.com / v.redd.it | |
| TikTok | tiktok.com | 区域限制，部分失败 |
| Instagram | instagram.com | 频繁 429 |
| Dailymotion | dailymotion.com | |
| Facebook | facebook.com / fb.watch | 公开视频可解析 |

未列入 `SUPPORTED_HOSTS` 的 host 即使 yt-dlp 支持也不会触发自动解析 —— 防御纵深。

---

## 6. 测试

### 6.1 三件套（每次提交前）

```bash
npm run lint # eslint --max-warnings 0
npm run typecheck # tsc --noEmit (main + renderer)
npm run build # vite build + tsc -p tsconfig.main.json
```

### 6.2 真实 e2e（resolver 层级）

可直接在 main 进程层用 `new YtDlp({ binaryPath: ensureYtdlp() }).getInfoAsync(url)` 探测 YouTube + Bilibili 两个 must-pass case：

```
[case*] YouTube https://www.youtube.com/watch?v=jNQXAC9IVRw ... OK 206 240p 320x240 mp4
[case*] Bilibili https://www.bilibili.com/video/BV1GJ411x7h7 ... OK 206 852x480 mp4
[case ] Twitter/X https://x.com/NASAPersevere/status/... ... INFO-ERROR No video could be found
```

含两类用例：
- **must-pass** (`*`)：YouTube + Bilibili — 必须通过
- **informational**：X/Twitter — yt-dlp 上游对未授权访问的限制，UI 必须能兜底（[SC-15](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-15-resolver-failure-fallback.md)）

### 6.3 探测请求语义

e2e 不真正下载完整文件，只发 `Range: bytes=0-1023` 探测前 1 KB：

| 状态 | 意义 |
|---|---|
| 200 / 206 | CDN 接受请求 → 真直链 Yes |
| 403 | header 不正确（如 B 站缺 Referer） |
| 404 | URL 已过期 |
| 0 / timeout | 网络抖动 |

`Content-Type: video/mp4` 或 `application/octet-stream` 都视为通过（不同 CDN 行为不同）。

---

## 7. 已知限制

1. **X/Twitter 部分推文**：yt-dlp 上游频繁拒绝（`No video could be found in this tweet`），需用户手动配 cookies 或换站。本仓不集成 cookies 上传 UI（隐私敏感），后续可考虑读浏览器 cookies。
2. **YouTube 1080p+ 多为 DASH**：被 `pickBestFormat` 过滤，最终 fallback 到 720p 以下 progressive mp4。GIF 主要诉求是小尺寸，影响可忽略。
3. **直链过期**：YouTube ~6h、B 站 ~6h、X ~24h。用户长时间不操作后再次"开始批处理"会 403，单击 `↻ 重试解析` 即可。
4. **Bilibili Referer**：必须透传 `Referer: https://www.bilibili.com/` 否则 CDN 403。`sanitizeHeaders` 已在白名单允许 Referer。
5. **air-gapped 兜底**：当 4 级 fallback 全部 miss + 无网络时（人为破坏 packaged binary 镜像），`helpers.downloadYtDlp` 会失败；卡片显示 `↻ 重试解析`，用户联网后再点即可。

---

## 8. 关联文件

实现：
- [src/main/resolver/ytdlp.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/resolver/ytdlp.ts)
- [src/main/resolver/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/resolver/index.ts)
- [src/shared/types/](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types/) `ResolvedMedia`
- [src/main/ffmpeg.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/ffmpeg.ts) `buildHttpInputArgs`
- [src/main/processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) embed-only check
- [src/main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) `resolve:*` IPC
- [src/preload/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/index.ts) api 暴露
- [src/renderer/App.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/App.tsx) `useEffect([result])` 自动批量解析
- [src/renderer/components/MediaGrid.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/MediaGrid.tsx) 三态状态机

文档：
- [harness/rules/R-14-resolver-bundled.md](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-14-resolver-bundled.md)
- [harness/scenarios/SC-13-resolver-opt-in.md](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-13-resolver-opt-in.md)
- [harness/scenarios/SC-14-resolver-bilibili.md](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-14-resolver-bilibili.md)
- [harness/scenarios/SC-15-resolver-failure-fallback.md](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-15-resolver-failure-fallback.md)
