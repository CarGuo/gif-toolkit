# 第三方播放器 → mp4 直链 resolver

> 解决"YouTube / X / Bilibili 视频嗅探出来后无法处理"的场景。
> 关联规则：[R-14](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-14-resolver-opt-in.md)

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
| **yt-dlp** (binary, ~30 MB) | **1800+** | 极活跃（每周更新） | ❌ Unlicense，无需注册 | ✅ |
| youtube-dl | ~600 | 已停滞 | ❌ | ❌ 弃用 |
| RapidAPI / Twitter API | 有限 | 商业 | ✅ 需要 API Key + 付费 | ❌ |
| 自实现各家 internal API 嗅探 | 极有限 | 不稳定 | ❌ | ❌ 维护成本高 |

`ytdlp-nodejs@^3.4.4` 提供：
- `helpers.downloadYtDlp(dir)` — 按平台下载 yt-dlp 二进制到指定目录，返回最终路径
- `new YtDlp({ binaryPath }).getInfoAsync(url)` — 调 yt-dlp `--dump-single-json --flat-playlist` 拿 VideoInfo
- `VideoInfo.formats[]` — 所有可用格式，含 `url`, `protocol`, `vcodec`, `acodec`, `ext`, `width`, `height`, `tbr`, `format_note`, `http_headers`

---

## 3. 整体架构

```
┌─ Renderer ────────────────────────────────────────────┐
│ App.tsx                                               │
│   onResolveEmbedById(id)                              │
│     1. confirm()  ← 用户主动同意                      │
│     2. installYtdlp()  ← 首次才走这步                 │
│     3. resolveEmbed(media)  ← 真正解析               │
│     4. resolvedMap[id] = ResolvedMedia                │
│ MediaGrid                                             │
│   canResolve = isEmbed && !isResolved && hostMatch    │
│   isResolved → 卡片左下绿色 ✓ 已解析 chip            │
│   processable filter: !requiresExternal || resolved   │
└───────────────────────┬───────────────────────────────┘
                        │ IPC (contextBridge)
                        ▼
┌─ Main (Node) ─────────────────────────────────────────┐
│ resolve:checkYtdlp / installYtdlp / uninstallYtdlp    │
│ resolve:embed                                         │
│   sanitizeMedia → isResolvable(host allow-list)       │
│   resolveEmbed(media)                                 │
│     ← media.url（iframe src，不是 pageUrl）          │
│     pickBestFormat: 排除 m3u8/dash/mhtml             │
│     sanitizeHeaders: 白名单                          │
│     ensurePublicHttp + isPrivateHost                  │
│ ResolvedMedia { url, headers, mime, qualityLabel,... }│
└───────────────────────┬───────────────────────────────┘
                        │ ResolvedMedia 回流到 Sniff
                        ▼
┌─ 既有处理链路（无修改） ─────────────────────────────┐
│ processor.ts                                          │
│   const fetchUrl = media.resolved?.url || media.url   │
│   const fetchHeaders = media.resolved?.headers        │
│   downloadToFile(fetchUrl, dest, signal, fetchHeaders)│
│ ffmpeg.ts videoToGifPalette → palettegen → paletteuse │
│ gifsicle 二分搜索压缩到 softMaxBytes/maxBytes         │
└───────────────────────────────────────────────────────┘
```

---

## 4. 关键不变量

### 4.1 opt-in（R-14）

| 阶段 | 自动调用 | resolver 触发 |
|---|---|---|
| 启动 | `checkYtdlp()`（仅 stat，不联网） | ❌ 不会 |
| 嗅探 | sniffer 仅打 `requiresExternalDownload: true` 标记 | ❌ 不会 |
| 用户点击"解析直链" | confirm → install（首次）→ resolve | ✅ 唯一入口 |
| 打包阶段 | `electron-builder.files` 排除 `node_modules/ytdlp-nodejs/bin/**` | ❌ 不进 dmg/exe |

### 4.2 安全防御纵深

每一层都重新校验：

| 层 | 文件 | 校验 |
|---|---|---|
| Renderer | [App.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/App.tsx) RESOLVABLE_HOSTS | host 在白名单才显示按钮 |
| Renderer | [MediaGrid.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/MediaGrid.tsx) `canResolve` | 二次 host 校验 |
| Preload | [preload/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/index.ts) ensureObject | 拒绝非对象 payload |
| Main IPC | [main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) `sanitizeMedia` | embedHost 限 `[a-z0-9.-]{<=64}` |
| Main IPC | [main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) `isResolvable` | host allow-list 三次校验 |
| Resolver | [resolver/ytdlp.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/resolver/ytdlp.ts) `ensurePublicHttp` | http(s) + 非私网（SSRF） |
| Resolver | [resolver/ytdlp.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/resolver/ytdlp.ts) `sanitizeHeaders` | header 白名单 + CRLF/NUL 过滤 |
| Resolver | [resolver/ytdlp.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/resolver/ytdlp.ts) `pickBestFormat` | 排除 m3u8/dash_segments/mhtml |
| Main IPC | [main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) `sanitizeResolved` | 渲染端回流的 ResolvedMedia 也过白名单 |

### 4.3 失败兜底（[SC-15](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-15-resolver-failure-fallback.md)）

任意环节失败 → embed 卡片保留 + 用户可重试，**永不卡死**。

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

未列入 `SUPPORTED_HOSTS` 的 host 即使 yt-dlp 支持也不会暴露按钮 —— 防御纵深。

---

## 6. 测试

### 6.1 三件套（每次提交前）

```bash
npm run lint       # eslint --max-warnings 0
npm run typecheck  # tsc --noEmit (main + renderer)
npm run build      # vite build + tsc -p tsconfig.main.json
```

### 6.2 真实 e2e

`/tmp/giftk-resolver-e2e.js` 不依赖 Electron / IPC，直接调 ytdlp-nodejs：

```bash
node /tmp/giftk-resolver-e2e.js
```

预期输出：

```
[setup] yt-dlp at /tmp/giftk-e2e-bin/yt-dlp_macos
[case*] YouTube    https://www.youtube.com/watch?v=jNQXAC9IVRw ... OK 206 240p 320x240 mp4
[case*] Bilibili   https://www.bilibili.com/video/BV1GJ411x7h7 ... OK 206  852x480 mp4
[case ] Twitter/X  https://x.com/NASAPersevere/status/... ... INFO-ERROR No video could be found

[e2e] must-pass failures: 0, informational failures: 1
[e2e] PASSED
```

含两类用例：
- **must-pass** (`*`)：YouTube + Bilibili — 必须通过，否则 e2e exit 1
- **informational**：X/Twitter — yt-dlp 上游对未授权访问的限制，UI 必须能兜底（[SC-15](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-15-resolver-failure-fallback.md)）

### 6.3 探测请求语义

e2e 不真正下载完整文件，只发 `Range: bytes=0-1023` 探测前 1 KB：

| 状态 | 意义 |
|---|---|
| 200 / 206 | CDN 接受请求 → 真直链 ✓ |
| 403 | header 不正确（如 B 站缺 Referer） |
| 404 | URL 已过期 |
| 0 / timeout | 网络抖动 |

`Content-Type: video/mp4` 或 `application/octet-stream` 都视为通过（不同 CDN 行为不同）。

---

## 7. 已知限制

1. **X/Twitter 部分推文**：yt-dlp 上游频繁拒绝（`No video could be found in this tweet`），需用户手动配 cookies 或换站。本仓不集成 cookies 上传 UI（隐私敏感），后续可考虑读浏览器 cookies。
2. **YouTube 1080p+ 多为 DASH**：被 `pickBestFormat` 过滤，最终 fallback 到 720p 以下 progressive mp4。GIF 主要诉求是小尺寸，影响可忽略。
3. **直链过期**：YouTube ~6h、B 站 ~6h、X ~24h。用户长时间不操作后再次"开始批处理"会 403，重新点"解析直链"即可。
4. **Bilibili Referer**：必须透传 `Referer: https://www.bilibili.com/` 否则 CDN 403。`sanitizeHeaders` 已在白名单允许 Referer。
5. **二进制下载源**：`helpers.downloadYtDlp` 走 [github.com/yt-dlp/yt-dlp/releases/latest](https://github.com/yt-dlp/yt-dlp/releases/latest)，国内网络可能慢/失败。后续可加镜像支持。

---

## 8. 关联文件

实现：
- [src/main/resolver/ytdlp.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/resolver/ytdlp.ts)
- [src/main/resolver/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/resolver/index.ts)
- [src/shared/types.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types.ts) `ResolvedMedia`
- [src/main/ffmpeg.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/ffmpeg.ts) `buildHttpInputArgs`
- [src/main/processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) embed-only check
- [src/main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) `resolve:*` IPC
- [src/preload/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/index.ts) api 暴露
- [src/renderer/App.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/App.tsx) `onResolveEmbedById`
- [src/renderer/components/MediaGrid.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/MediaGrid.tsx) `canResolve` / `isResolved`

文档：
- [harness/rules/R-14-resolver-opt-in.md](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-14-resolver-opt-in.md)
- [harness/scenarios/SC-13-resolver-opt-in.md](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-13-resolver-opt-in.md)
- [harness/scenarios/SC-14-resolver-bilibili.md](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-14-resolver-bilibili.md)
- [harness/scenarios/SC-15-resolver-failure-fallback.md](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-15-resolver-failure-fallback.md)
