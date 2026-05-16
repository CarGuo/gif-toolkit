# R-14 — embed resolver 随包分发 + 自动解析

## 规则

对于 iframe-embed 类（YouTube / X / Bilibili / Vimeo / Twitch / Reddit / TikTok / Instagram / Dailymotion / Facebook 等支持的 host），App 必须**开箱即用**：yt-dlp 二进制随安装包分发，嗅探完成后自动批量解析所有支持的 embed，**不得**让用户手动点击或确认。

- **打包阶段** ✅ yt-dlp 二进制必须随 dmg / installer 一起分发：`electron-builder.asarUnpack` 必须包含 `node_modules/ytdlp-nodejs/bin/**`，不允许在 `build.files` 排除该路径
- **启动阶段** ✅ `checkYtdlp()` 仅做诊断（fs.stat 优先级目录），不联网；`source` 在生产环境必须命中 `'packaged'`
- **嗅探完成后** ✅ 渲染端 `useEffect` 必须自动遍历 `requiresExternalDownload` 的 items，调 `resolveEmbed` 批量预解析，无需用户交互
- **运行时解析** ✅ resolver 内部按四级优先级 fallback 找 binary：
  1. packaged binary（生产：`app.asar.unpacked/.../bin/yt-dlp_<platform>`）
  2. dev `node_modules/ytdlp-nodejs/bin/<name>`（开发模式）
  3. helpers.BIN_DIR（npm 包内置默认）
  4. `userData/bin/<name>`（兜底，老版本遗留 / 离线缓存）
  - 全部 miss 时调 `helpers.downloadYtDlp(userData/bin)` 一次性兜底（air-gapped 环境唯一会触发的分支）
- **失败兜底** ✅ resolver 失败时**保留 embed 卡片**，仅在卡片右下显示 `↻ 重试解析` 小按钮 + redact 过的 error tooltip；`resolveErrorMap` 防止 useEffect 循环触发
- **不存在的概念** ❌ 渲染端**不允许**有任何 `confirm()` 弹窗、`installYtdlp` / `uninstallYtdlp` IPC、`ytdlp-chip` 状态徽章；preload 不暴露这些 API；main 进程也不再注册 `resolve:installYtdlp` / `resolve:uninstallYtdlp` handler

## 为什么

- yt-dlp 是 Unlicense / 公共领域，分发开源二进制不存在合规问题
- 单平台 yt-dlp ~30 MB，在桌面 App 是可接受成本（业界 Stacher / Cobalt 同款做法）
- opt-in 设计强制用户做合规决策、看额外 chip、点 confirm 弹窗——是糟糕的开箱即用体验
- 纯 JS 替代品（`@distube/ytdl-core` / `play-dl`）只覆盖 YouTube 且 cipher 经常失效；Python 源码版要求用户装 Python，比二进制更糟
- 自动批量解析的并发由 main 进程 `ensureInflight` 单飞 + yt-dlp 内置 CPU/网络限制天然限速

## 怎么遵守

- 主进程 resolver：[ytdlp.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/resolver/ytdlp.ts) 只暴露 `ensureYtdlp()` / `checkYtdlp()` / `resolveDirectUrl()`，不再暴露 install/uninstall
- 主进程 IPC：[main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) 仅注册 `resolve:checkYtdlp` / `resolve:embed`，结构化错误改为 `YT_DLP_UNAVAILABLE`
- 打包配置：[package.json](file:///Users/guoshuyu/workspace/gif-toolkit/package.json) `build.files` 不排除 yt-dlp bin；`build.asarUnpack` 必须包含 `node_modules/ytdlp-nodejs/bin/**`
- 渲染端：[App.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/App.tsx) `useEffect([result])` 自动批量解析；卡片仅在失败时显示 `↻ 重试解析` 小按钮
- preload：[preload/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/index.ts) 仅暴露 `checkYtdlp`（诊断）+ `resolveEmbed`，不再有 `installYtdlp` / `uninstallYtdlp` / `onResolveInstallProgress`

## 反例

- ❌ 在 titlebar 加 `⚠ yt-dlp 未装` chip，要求用户感知二进制存在
- ❌ 在 MediaGrid 卡片上加橙色 `🔗 解析直链` 按钮，要求用户主动点
- ❌ 用 `confirm()` 弹窗询问 "是否下载 yt-dlp 30MB"
- ❌ 让 yt-dlp 二进制不打包，用户首次解析时联网下载（违背开箱即用）
- ❌ resolver header 沿用 yt-dlp extractor 全量返回（包含 Authorization / Set-Cookie / Host 等敏感字段）
- ❌ 自动解析没有 `resolveErrorMap` 守卫，导致 useEffect 在每次失败后无限循环

## 关联场景

- [SC-13](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-13-resolver-opt-in.md)（自动批量解析主路径）
- [SC-14](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-14-resolver-bilibili.md)（Bilibili Referer 透传）
- [SC-15](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-15-resolver-failure-fallback.md)（air-gapped / 网络抖动兜底）

## 关联文档

- [docs/embed-resolver.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/embed-resolver.md)
