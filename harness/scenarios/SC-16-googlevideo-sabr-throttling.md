# SC-16 — googlevideo SABR throttling / 缓存文件无扩展名 → ffprobe Invalid data

> **来源**:第 32 轮用户测试 `https://android-developers.googleblog.com/2026/05/the-android-show-developers-cut-2026.html`,YouTube 嵌入视频 `KvTRMSa1w4E` 解析成功 360p 但转换失败 `ffprobe failed (1): .../KvTRMSa1w4E: Invalid data found when processing input`。
> **关联规则**:[R-14](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-14-resolver-bundled.md) [R-13](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-13-spa-must-have-fallback.md)

---

## 触发条件

YouTube / googlevideo 单 GET 直链下载,组合命中:

| 因素 | 现象 |
|---|---|
| googlevideo SABR throttling | 单 GET 不带 Range / 接受 chunked encoding 时,服务器返回带 throttle preamble 的字节流,文件头部不干净 |
| 缓存文件无扩展名 | `media.url` 是 embed 页 (`/embed/<videoId>`),basename 无 ext;`fileNameFor` fallback 到 `media.id`(还是无 ext);ffprobe 没 ext 提示对脏头容错差 |
| 短读无自检 | content-length 给了完整长度,但实际只接收了头部几 KB CDN 就关闭连接,生成的 `.part` 仍被 rename 成 target |

---

## 期望行为

1. **`Accept-Encoding: identity` + `Connection: keep-alive`**:
   - [downloader.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/downloader.ts) 必须在所有请求里强制这两项,避免 CDN 走 chunked / gzip 路径(SABR 在协商完整内容编码时更激进)。
2. **短读自检**:
   - 下载完成后,若 `received < 95% × content-length`,**不允许**把 `.part` rename 成 target,直接抛错 `incomplete download: received X of expected Y bytes`,让 caller 看到失败。
3. **缓存文件名补 ext**:
   - [fileNameFor](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/helpers.ts) 当 cleaned base 无 ext 且 suffix 也无 ext 时,根据 `media.resolved?.mime` / `media.mime` / `media.kind` 推导默认 ext(mp4/webm/mov/mkv/gif/jpg/webp/...)。
   - 默认兜底:video → `.mp4`、gif → `.gif`、image → `.bin`。
4. **缩略图独立失败 ≠ 整张卡片失败**:
   - [Thumb error](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/MediaGrid.tsx) 视觉降级为右下小角标 `.thumb-error-corner`,**不再**整张红色蒙版。
   - tooltip 文案明确 "缩略图生成失败,不影响后续解析与转换尝试"。

---

## 反向断言

- ❌ **不允许**downloader 默默把短读文件 rename 到 target(必须自检 + 抛错)。
- ❌ **不允许**缓存文件名既无 ext 又无 mime hint(ffprobe 容错差,无 ext 就要补)。
- ❌ **不允许**Thumb error 仍用整张红色 `.thumb-error` 大蒙版(误导用户以为整张卡片失败)。
- ❌ **不允许**downloader 不带 `Accept-Encoding: identity`(googlevideo CDN 在协商压缩时 SABR 概率显著上升)。

---

## 复演步骤

1. 嗅探 `https://android-developers.googleblog.com/2026/05/the-android-show-developers-cut-2026.html`(含 YouTube embed `KvTRMSa1w4E`)。
2. 自动批量解析 → 卡片显示 `✓ 已解析 · 360p`(右上)。若缩略图失败,卡片右下显示**小角标** `!`(不再整张红);hover 显示 "缩略图生成失败 ... 不影响后续解析与转换尝试"。
3. 选中 → 开始批处理 → 下载阶段:
   - **正常情况**:Accept-Encoding=identity 让 SABR 不触发,文件完整下载 + 缓存文件名 = `KvTRMSa1w4E.mp4`(自动补 ext)→ ffprobe 正常 → 转换成功。
   - **SABR 触发**:短读自检捕获 `received < 95% × content-length`,task 直接 `failed`,error message 含 "incomplete download: ... (short-read; remote may be SABR-throttled or signed URL expired)";用户看到清晰诊断,不会再看到不知所谓的 "Invalid data found"。

---

## 关联规则 / 文件

- [src/main/downloader.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/downloader.ts)
- [src/main/helpers.ts fileNameFor](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/helpers.ts)
- [src/renderer/components/MediaGrid.tsx Thumb](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/MediaGrid.tsx)
- [src/renderer/styles.css .thumb-error-corner](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/styles.css)

---

## 历史 PASS 记录

| 日期 | 提交 | 结果 | 备注 |
|---|---|---|---|
| 初版沉淀 | downloader 加 identity + short-read self-check;fileNameFor 补 ext;Thumb error 视觉降级为小角标 | PASS | typecheck/lint/build |
