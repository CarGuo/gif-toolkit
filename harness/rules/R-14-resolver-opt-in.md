# R-14 — embed resolver 必须 opt-in，二进制不打包

## 规则

对于 iframe-embed 类（YouTube / X / Bilibili / Vimeo / Twitch / Reddit / TikTok / Instagram / Dailymotion / Facebook 等支持的 host），用户主动点击"解析直链"时才允许调用 yt-dlp 解析得到 mp4 直链：

- **嗅探阶段** ❌ 禁止自动调用 resolver — sniffer 仅识别 + 标记 `requiresExternalDownload: true`
- **启动阶段** ❌ 禁止自动下载 yt-dlp 二进制 — 仅做 `checkYtdlp()`（stat 用户目录）
- **打包阶段** ❌ 禁止把 yt-dlp 二进制装进 installer — `electron-builder.files` 必须排除 `node_modules/ytdlp-nodejs/bin/**`
- **触发阶段** ✅ 必须用户单击 MediaGrid 卡片上的"🔗 解析直链"按钮才走完整链路：
  1. 渲染端 `confirm()` 询问"是否安装 yt-dlp"（首次）
  2. 同意后调 `installYtdlp()` IPC，写入 `userData/bin/yt-dlp_<platform>`
  3. `resolveDirectUrl(media.url)` 经 yt-dlp 拿到带 sig 的 mp4 直链
  4. 失败时**保留原 embed 卡片**，用户可重试或留作纪念
- **解析失败 / 未安装 / 安装失败 / CDN 拒绝** ✅ UI 必须保持 embed 兜底链路（黄色徽章 + 处理按钮 disabled）
  — 用户**永远不会卡死**

## 为什么

- yt-dlp 是 Unlicense 但分发 youtube/x 直链涉及 ToS 灰色地带 → 用户主动同意是合规底线
- yt-dlp 单平台二进制 ~30 MB，打包一并塞进 dmg/installer 既臃肿又违 R-14 的 opt-in
- yt-dlp 上游对 X/Twitter 经常拒绝（"No video could be found in this tweet"），需要 `--cookies` 兜底；这种灰色场景必须**用户感知**而不是静默失败
- npm `ytdlp-nodejs` 的 postinstall 会自动下载，必须在 CI 用 `npm ci --ignore-scripts`，或运行时清掉 `node_modules/ytdlp-nodejs/bin/`，再或在 `electron-builder.files` 显式排除（本仓选这条）

## 怎么遵守

- 主进程层：[src/main/resolver/ytdlp.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/resolver/ytdlp.ts) `installYtdlp()` 仅暴露给 IPC handler `resolve:installYtdlp`，且 `resolve:installYtdlp` 没有任何自动调用入口
- IPC 层：[src/main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) 暴露 `resolve:checkYtdlp` / `resolve:installYtdlp` / `resolve:uninstallYtdlp` / `resolve:embed`，加 `installInflight` 单飞 + install/uninstall 互斥
- 打包配置：[package.json](file:///Users/guoshuyu/workspace/gif-toolkit/package.json) `build.files` 含 `!node_modules/ytdlp-nodejs/bin/**`
- 渲染端：[App.tsx onResolveEmbedById](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/App.tsx) 必须先 `confirm()` 后才链 `installYtdlp` → `resolveEmbed`，且失败不删 media，仅 log

## 反例

- ❌ 启动后悄悄调 `installYtdlp()`，让用户 30 s 后多出一个 30 MB 文件
- ❌ sniff 阶段自动 resolver 所有 embed，用户一进 app 就被 yt-dlp 撞墙 30 次
- ❌ resolver 失败后从 sniff result 删除 media（用户以为嗅探漏了）
- ❌ 把 yt-dlp 直接打进 dmg/exe（违反 opt-in、肿打包、灰色合规）
- ❌ resolver header 沿用 yt-dlp extractor 全量返回（包含 Authorization / Set-Cookie / Host 等敏感字段）

## 关联场景

- [SC-13](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-13-resolver-opt-in.md)
- [SC-14](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-14-resolver-bilibili.md)
- [SC-15](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-15-resolver-failure-fallback.md)

## 关联文档

- [docs/embed-resolver.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/embed-resolver.md)
