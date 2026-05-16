# SC-13 — embed resolver opt-in 路径

> **来源**：用户最新一轮 "遇到 YouTube/X/B 站视频，解析得到 mp4 直链，是流程里的特殊支持"。
> **关联规则**：[R-14](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-14-resolver-opt-in.md)

---

## 触发条件

页面出现 yt-dlp 支持的第三方播放器 iframe（覆盖 1800+ host，本仓白名单 ≈14 host）：

```html
<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>
<iframe src="https://player.bilibili.com/player.html?bvid=BV1GJ411x7h7"></iframe>
```

---

## 期望行为（首次使用）

1. **嗅探**：sniffer 命中规则 6，产出 `requiresExternalDownload: true` 的 SniffedMedia。
2. **启动 / 嗅探阶段不得自动调用 resolver、不得自动下载 yt-dlp 二进制**：
   - `App.tsx` 启动时只调 `giftk.checkYtdlp()`（仅 fs.stat，不联网）
   - `resolver/index.ts` 只在 `resolve:embed` IPC handler 内被使用
3. **MediaGrid** 卡片上 `embed` 视频展示橙色按钮 `🔗 解析直链` （而非黄色徽章）—— 表明这条 host 在 resolver allow-list 内
4. 用户**主动点击**该按钮：
   - `App.tsx onResolveEmbedById` 弹 `confirm()` 解释：将下载 yt-dlp（30 MB）到 userData/bin
   - 同意后链：`installYtdlp` → `checkYtdlp` → `resolveEmbed`
   - `resolve:install-progress` 事件以 `starting`/`done`/`error` stage 驱动 UI（`ytdlp-chip` 状态切换）
5. 解析成功：
   - `resolvedMap[id] = { url, headers, mime, qualityLabel, ... }`
   - 卡片左下角显示绿色 `✓ 已解析` chip
   - 卡片右下角原"解析直链"按钮被 `▶ 处理(已解析)` 替换，且自动加入 processable 集合
   - 用户点"开始批处理"时该 media 走和普通 video 一样的 download → ffmpeg → palette → gif → 压缩链路

## 期望行为（后续使用）

- yt-dlp 已安装：`checkYtdlp` 直接返回 `installed=true`，跳过 `installYtdlp` + `confirm()`
- 已解析过的 media：再次嗅探（同一 sniff 会话）会清空 `resolvedMap` —— 重新解析（链接可能过期）
- 卸载：用户可以通过未来菜单调 `uninstallYtdlp`（删 `userData/bin/yt-dlp_*`）

---

## 反向断言

- ❌ **不允许**在 sniff 阶段自动调用 resolveEmbed（用户没主动点）
- ❌ **不允许**在 app 启动时自动 installYtdlp（即使首次可加速 UX）
- ❌ **不允许**打 dmg / exe 时把 `node_modules/ytdlp-nodejs/bin/yt-dlp_*` 打进去（必须由 [package.json files](file:///Users/guoshuyu/workspace/gif-toolkit/package.json) 排除）
- ❌ **不允许**resolver 把 `media.pageUrl`（用户粘贴的文章页）喂给 yt-dlp —— 必须用 `media.url`（iframe 的 `src`）
- ❌ **不允许**resolver 返回 m3u8 / dash_segments / mhtml 这些清单格式（downloader.ts 是单文件 axios stream，处理不了）
- ❌ **不允许**把 yt-dlp 抛出的原始错误 message（含 signed CDN URL / token）原样写进 logger buffer

---

## 复演步骤

1. 启动 `npm run dev`，输入含 YouTube embed 的页面 URL
2. 嗅探完成后看到 yt 视频卡片右下角 `🔗 解析直链` 按钮
3. 点击 → `confirm()` 弹窗 → 同意 → titlebar 右上角 `ytdlp-chip` 出现 `⬇ yt-dlp 安装中…`
4. 安装完成（约 5-15 s）→ chip 变 `✓ yt-dlp`
5. 紧接着解析 → 卡片左下绿色 `✓ 已解析`，右下按钮变 `▶ 处理(已解析)`
6. 点击"开始批处理" → 该 media 进 processable，走完整 GIF 转换链路
7. 关闭 app → 重启 → `checkYtdlp` 命中已安装的 binary，无需再下载

---

## 真实 e2e 验证

`/tmp/giftk-resolver-e2e.js`（详见 [docs/embed-resolver.md §测试](file:///Users/guoshuyu/workspace/gif-toolkit/docs/embed-resolver.md)）：

```bash
node /tmp/giftk-resolver-e2e.js
# [setup] yt-dlp at /tmp/giftk-e2e-bin/yt-dlp_macos
# [case*] YouTube   ... OK 206 240p 320x240 mp4
# [case*] Bilibili  ... OK 206  852x480 mp4
# [e2e] PASSED
```

---

## 关联规则

- [R-09 iframe-embed-detect-only](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-09-iframe-embed-detect-only.md)
- [R-14 resolver-opt-in](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-14-resolver-opt-in.md)
- [docs/embed-resolver.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/embed-resolver.md)

---

## 历史 PASS 记录

| 日期 | 提交 | 结果 | 备注 |
|---|---|---|---|
| 初版沉淀 | yt-dlp resolver 接入 | PASS | YouTube + Bilibili 两个 must-pass case 全绿；X/Twitter 信息性失败（yt-dlp 上游限制） |
