# SC-13 — embed resolver 自动批量解析（开箱即用）

> **来源**：用户反馈 "没必要，我们要提供的是开箱即用的功能，都打包进去，没必要做这种未装的情况"。
> **关联规则**：[R-14](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-14-resolver-bundled.md)

---

## 触发条件

页面出现 yt-dlp 支持的第三方播放器 iframe（覆盖 1800+ host，本仓白名单 ≈14 host）：

```html
<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>
<iframe src="https://player.bilibili.com/player.html?bvid=BV1GJ411x7h7"></iframe>
```

---

## 期望行为（生产环境，开箱即用）

1. **打包**：`electron-builder` 必须把 `node_modules/ytdlp-nodejs/bin/**` 通过 `asarUnpack` 复制到 `app.asar.unpacked/` 子目录；用户安装 dmg / installer 后，binary 已在文件系统就位
2. **启动**：`App.tsx` 启动 useEffect **不再调用** `checkYtdlp`（保留作为诊断 IPC，但 UI 默认不消费）；titlebar **不再显示** `ytdlp-chip` 状态徽章
3. **嗅探**：sniffer 命中规则 6，产出 `requiresExternalDownload: true` 的 SniffedMedia
4. **嗅探完成回调**：`useEffect([result])` 自动触发 —— 遍历所有 `requiresExternalDownload && !resolved && !resolving && !errored` 的 items，并行调 `giftk.resolveEmbed(media)`：
   - 卡片右下显示蓝色 `wait 解析中…` 临时标签（`resolveErrorMap[id]` 未写入时）
   - 解析成功 → `resolvedMap[id] = ResolvedMedia`，左下 `Yes 已解析 · 720p` 绿色 chip，自动加入 `selected` 集合
   - 解析失败 → `resolveErrorMap[id] = redacted message`，右下变 `↻ 重试解析` 小按钮（用户可单击重试单个）
5. **批处理**：用户点"开始批处理" → 解析成功的 media 走与普通 video 相同的 download → ffmpeg → palette → gif → 压缩链路

## 期望行为（resolver 内部）

- 第一次调用走 `ensureYtdlp()`：四级 fallback 找已存在的 binary
  - 命中 `app.asar.unpacked/.../bin/yt-dlp_<platform>` → 0 网络开销，立即可用
  - 命中 `node_modules/ytdlp-nodejs/bin/<name>`（dev 模式）
  - 命中 `helpers.BIN_DIR` / `userData/bin/<name>`（老版本遗留）
  - 全部 miss（罕见，仅 air-gapped + 老 cache 全清）→ 调 `helpers.downloadYtDlp(userData/bin)` 一次性兜底
- 后续调用：直接读 `cachedBinPath`，零开销

---

## 反向断言

- No **不允许**在 titlebar 显示任何 `yt-dlp` 状态 chip（已就绪 / 未装 / 安装中 三态都禁）
- No **不允许**在 MediaGrid 卡片显示橙色 ` 解析直链` 按钮 —— resolve 必须由 sniff 完成回调自动触发
- No **不允许** preload / IPC 暴露 `installYtdlp` / `uninstallYtdlp` / `onResolveInstallProgress` —— 这些 API 在 R-14 反转后已删除
- No **不允许**在 sniff 阶段就开始 resolveEmbed —— 必须在 sniff 完整 result 落地后才触发（避免 race + 部分 item）
- No **不允许**自动解析没有 error guard —— `useEffect([result])` 中过滤条件必须包含 `!resolveErrorMap[m.id]`，否则失败后会无限循环
- No **不允许**把 yt-dlp 抛出的原始 message（含 signed CDN URL / token）原样写进 logger buffer，必须经 `redactUrls()`
- No **不允许**resolver 把 `media.pageUrl`（用户粘贴的文章页）喂给 yt-dlp —— 必须用 `media.url`（iframe 的 `src`）
- No **不允许**resolver 返回 m3u8 / dash_segments / mhtml 这些清单格式（downloader.ts 是单文件 axios stream，处理不了）

---

## 复演步骤

1. 启动 `npm run dev`，输入含 YouTube embed 的页面 URL（例如内嵌 YouTube 的博客文章）
2. 嗅探完成 → MediaGrid 渲染：YouTube 卡片立即出现 `wait 解析中…` 蓝色标签
3. 5-15 秒内（取决于 yt-dlp + 网络）→ 标签换为 `Yes 已解析 · 720p` 绿色 chip，复选框自动勾上
4. 点"开始批处理" → 该 media 进 processable，走完整 GIF 转换链路
5. 关闭 app → 重启 → 再次嗅探同一页面 → resolveEmbed 走缓存的 packaged binary，速度几乎不变

---

## 真实 e2e 验证（resolver 层级）

resolver 自身仍可用之前的 e2e 思路在 main 进程层验证：直接 `new YtDlp({ binaryPath: ensureYtdlp() }).getInfoAsync(url)` 走 YouTube + Bilibili 两个 must-pass case 探测 1KB Range，验证打包 binary 可用。但本场景的核心断言已转移到**渲染端 useEffect 自动触发 + 卡片状态机**层面，需要走真实 dev 环境验证 UX。

---

## 关联规则

- [R-09 iframe-embed-detect-only](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-09-iframe-embed-detect-only.md)
- [R-14 resolver-bundled](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-14-resolver-bundled.md)
- [docs/embed-resolver.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/embed-resolver.md)

---

## 历史 PASS 记录

| 日期 | 提交 | 结果 | 备注 |
|---|---|---|---|
| 初版沉淀 | yt-dlp resolver 接入（opt-in 版本） | PASS | YouTube + Bilibili must-pass 全绿；X/Twitter 信息性失败 |
| 反转为 bundled | 移除 chip / confirm / install IPC，自动批量解析 | PASS | 嗅探完成自动并行解析，失败仅显示重试小按钮 |
