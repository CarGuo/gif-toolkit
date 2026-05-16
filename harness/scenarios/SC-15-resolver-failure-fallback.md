# SC-15 — resolver 失败兜底（air-gapped / 上游限制 / CDN 403）

> **来源**：用户反馈 "失败时不要卡死,卡片要保留并允许重试"。
> **关联规则**：[R-14](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-14-resolver-bundled.md)

---

## 触发条件

resolver 链路任意一环失败：

| 失败点 | 现实场景 |
|---|---|
| `ensureYtdlp()` 抛错 | air-gapped 机器：packaged binary 缺失（asar.unpacked 没有镜像）+ 无网络下载兜底 |
| `yt.getInfoAsync` 抛错（`No video could be found in this tweet`） | yt-dlp 上游对部分 X 推文 / 年龄限制视频 / 私密视频 拒绝 |
| `pickBestFormat` 返回 undefined | YouTube 仅剩 m3u8/dash_segments 已被 filter 掉 |
| `resolveDirectUrl` ensurePublicHttp 拒绝 | yt-dlp 返回了私网 / 非 http 协议 |
| 下载阶段 axios 403 | 直链已过期（YouTube 签名 URL ~6h）或缺 Referer |

---

## 期望行为

1. **air-gapped**（找不到 binary 且无网络）：
   - main 进程 `resolve:embed` IPC handler 抛出 `YT_DLP_UNAVAILABLE` 结构化错误
   - `App.tsx onResolveEmbedById` 捕获后 `setResolveErrorMap[id] = "yt-dlp 不可用(可能离线且本地无缓存),稍后再试"`
   - MediaGrid 卡片右下变 `↻ 重试解析` 小按钮，tooltip 含错误原因
   - useEffect 自动批量解析 useEffect 因 `!resolveErrorMap[id]` guard **不会**重复触发
2. **解析失败**（yt-dlp `No video could be found` 等）：
   - main 端 throw 原始 message（已 redact URL）
   - `App.tsx onResolveEmbedById` 收到 reject → `setResolveErrorMap[id] = msg`
   - MediaGrid 显示 `↻ 重试解析` 小按钮 + tooltip
   - resolvingSet 清除该 id（解锁）
   - 用户**永远不会卡死**
3. **下载阶段 403**（resolved.url 过期）：
   - 走和普通 video 下载一样的失败路径：`processor.ts` task `progress=failed`
   - 用户可以点 `↻ 重试解析` 重新拿一个新的 signed URL，再点"开始批处理"

---

## 反向断言

- ❌ **不允许**resolver 失败时把 media 从 `sniffResult.items` 删除
- ❌ **不允许**resolver 抛错后 useEffect 在每次 state 变化时重复触发（必须用 resolveErrorMap 守卫）
- ❌ **不允许**渲染端弹任何 confirm 弹窗（即使 air-gapped 也不弹）
- ❌ **不允许**yt-dlp 错误 message 原样进 logger.buffer（含 signed URL / token），必须经 `redactUrls()`
- ❌ **不允许**用户在批处理过程中重试解析（`resolvingSet` + `processingOne` 应正交，不互相阻塞，但 logger 要明确语义）
- ❌ **不允许**重试按钮在 `resolving=true` 时仍可点（必须 disabled 或被 `⏳ 解析中…` 替换）

---

## 复演步骤

### 场景 A — air-gapped 机器
1. 在没有网络的环境下安装 dmg / installer
2. 如果 packaged binary 已正确镜像到 `app.asar.unpacked/...`，**resolver 应直接成功**（这是 R-14 的核心承诺）
3. 仅当人为破坏 unpacked 镜像（比如手动删除 `app.asar.unpacked/.../bin/yt-dlp_macos`）+ 断网时才能复现
4. 嗅探含 YouTube 视频的页面 → 自动批量解析触发 → 卡片立即变 `↻ 重试解析`
5. 联网后单击 `↻ 重试解析` → `helpers.downloadYtDlp(userData/bin)` 一次性兜底成功 → 卡片变 `✓ 已解析`

### 场景 B — yt-dlp 上游拒绝（X 推文）
1. 嗅探含 X 视频的页面
2. 自动批量解析触发 → 5-10 秒后 yt-dlp 返回 `No video could be found in this tweet`
3. 卡片右下变 `↻ 重试解析`，tooltip 显示 redacted error
4. 单击 `↻ 重试解析` → 仍失败（上游限制），卡片状态保持

### 场景 C — 解析成功但 CDN 拒绝
1. 解析 YouTube → 得到 6h 过期的 signed URL
2. 等 6 小时
3. 点"开始批处理" → axios 403 → task failed
4. 点 `↻ 重试解析` 重新解析 → 得到新的 signed URL → 重新批处理 → OK

---

## 关联规则

- [R-14 resolver-bundled](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-14-resolver-bundled.md)
- [R-13 spa-must-have-fallback](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-13-spa-must-have-fallback.md)
- [docs/embed-resolver.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/embed-resolver.md)

---

## 历史 PASS 记录

| 日期 | 提交 | 结果 | 备注 |
|---|---|---|---|
| 初版沉淀 | yt-dlp resolver 接入 + e2e 双层（must-pass / informational） | PASS | X/Twitter 上游受限 → INFO-ERROR；UI 不卡 |
| 反转为 bundled | 删除 confirm/install 路径，新增 `resolveErrorMap` + `↻ 重试解析` 小按钮 | PASS | useEffect 自动批量；失败回退仅卡片态变化 |
