# SC-15 — resolver 失败兜底（X / Twitter 上游限制 / CDN 403）

> **来源**：用户最新一轮 "X 视频虽然 yt-dlp 上游受限，但 UI 不能卡死"。
> **关联规则**：[R-14](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-14-resolver-opt-in.md)

---

## 触发条件

resolver 链路任意一环失败：

| 失败点 | 现实场景 |
|---|---|
| `checkYtdlp` 返回 `installed: false` | 用户从未点过"解析直链"，二进制还没下 |
| `installYtdlp` 抛错 | GitHub Release 接口 5xx / DNS 抖动 / 磁盘满 |
| `yt.getInfoAsync` 抛错（`No video could be found in this tweet`） | yt-dlp 上游对部分 X 推文 / 年龄限制视频 / 私密视频 拒绝 |
| `pickBestFormat` 返回 undefined | YouTube 仅剩 m3u8/dash_segments、被 P0 修复后 filter 掉 |
| `resolveDirectUrl` ensurePublicHttp 拒绝 | yt-dlp 返回了私网 / 非 http 协议 |
| 下载阶段 axios 403 | 直链已过期（YouTube 签名 URL ~6h）或缺 Referer |

---

## 期望行为

1. **未安装**（首次点解析直链 → 用户拒绝 confirm）：
   - `App.tsx onResolveEmbedById` 在 `confirm()=false` 时直接 return
   - **embed 卡片继续显示**（黄色徽章 + `🔗 解析直链` 按钮还在）
   - 用户随时可以再点重试
2. **安装失败**：
   - `installInflight` 抛错 → main 端 `webContents.send('resolve:install-progress', { stage:'error', error })`
   - `App.tsx` useEffect 监听器 `setYtdlpInstalling(false) + setYtdlpInstallError(msg)`
   - titlebar `ytdlp-chip` 变 `⚠ yt-dlp 未装`
   - **UI 不卡住，用户可重试**
3. **解析失败**（yt-dlp `No video could be found` 等）：
   - main 端 `resolve:embed` IPC handler throw 原始 message（已 redact URL）
   - `App.tsx onResolveEmbedById` 收到 reject → 仅 `console.warn` + log buffer，**不删 media**
   - resolvingSet 删除该 id（解锁按钮可重试）
   - 用户**永远不卡死**
4. **YT_DLP_NOT_INSTALLED**（结构化错误码）：
   - `App.tsx` 检测到 message === 'YT_DLP_NOT_INSTALLED' → 弹 confirm 重新触发安装
5. **下载阶段 403**（resolved.url 过期）：
   - 走和普通 video 下载一样的失败路径：`processor.ts` task `progress=failed`
   - 用户可以点"解析直链"重新拿一个新的 signed URL，再点"开始批处理"

---

## 反向断言

- ❌ **不允许**resolver 失败时把 media 从 `sniffResult.items` 删除
- ❌ **不允许**resolver 抛错后 UI 永久 disable 按钮（必须从 `resolvingSet` 删除该 id）
- ❌ **不允许**yt-dlp 错误 message 原样进 logger.buffer（含 signed URL / token），必须经 `redactUrls()`
- ❌ **不允许**安装中点卸载（`installInflight` 时 `resolve:uninstallYtdlp` 抛错）
- ❌ **不允许**安装中再点"解析直链"（main 端 `resolve:embed` 抛 `yt-dlp is currently being installed`）

---

## 复演步骤

### 场景 A — yt-dlp 未安装时点击解析直链
1. 打开 app（首次或刚卸载完 yt-dlp）
2. 嗅探含 X 视频的页面
3. 点"🔗 解析直链" → `confirm()` 弹窗 → **拒绝**
4. **期望**：embed 卡片不变、resolvingSet 清空、可再次点击

### 场景 B — yt-dlp 上游拒绝（X 推文）
```bash
node /tmp/giftk-resolver-e2e.js
```
预期输出：
```
[case ] Twitter/X  https://x.com/.../status/... ... INFO-ERROR yt-dlp exited with code 1: No video could be found in this tweet
[e2e] PASSED  # informational failure 不让 suite 失败
```
此场景在 UI 上的表现：
- titlebar `ytdlp-chip` 仍是 `✓ yt-dlp`（已装）
- 卡片继续显示 `🔗 解析直链` 按钮（无 `✓ 已解析` chip）
- log buffer 含 `resolver: failed: <url> (No video could be found in this tweet)`（URL 已 redacted）

### 场景 C — 解析成功但 CDN 拒绝
1. 解析 YouTube → 得到 6h 过期的 signed URL
2. 等 6 小时
3. 点"开始批处理" → axios 403 → task failed
4. 点"🔗 解析直链"重新解析 → 得到新的 signed URL → 重新批处理 → OK

---

## 关联规则

- [R-14 resolver-opt-in](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-14-resolver-opt-in.md)
- [R-13 spa-must-have-fallback](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-13-spa-must-have-fallback.md)
- [docs/embed-resolver.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/embed-resolver.md)

---

## 历史 PASS 记录

| 日期 | 提交 | 结果 | 备注 |
|---|---|---|---|
| 初版沉淀 | yt-dlp resolver 接入 + e2e 双层（must-pass / informational） | PASS | X/Twitter 上游受限 → INFO-ERROR；UI 不卡 |
