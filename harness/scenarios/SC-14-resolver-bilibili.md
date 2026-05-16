# SC-14 — Bilibili 视频解析（resolver 主路径）

> **来源**：用户最新一轮 "B 站视频，解析得到可以下载的 mp4 直链"。
> **关联规则**：[R-14](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-14-resolver-opt-in.md)

---

## 触发条件

页面含 Bilibili player iframe / 文章里嵌的 BV 视频：

```html
<iframe src="https://player.bilibili.com/player.html?bvid=BV1GJ411x7h7&aid=...&page=1"></iframe>
```

或者用户直接粘贴 `https://www.bilibili.com/video/BV1GJ411x7h7`，sniffer 把它识别为 `iframe-embed` 类型并标 `embedHost: bilibili.com`。

---

## 期望行为

1. **白名单命中**：`isResolvable(media)` 检查 `embedHost` 命中 `SUPPORTED_HOSTS`（包含 `bilibili.com` / `b23.tv` / `player.bilibili.com`）
2. **resolver 调用**：用户点击"解析直链"后：
   - `resolveDirectUrl(media.url)` —— 注意是 `media.url`（iframe `src`），不是 `media.pageUrl`
   - yt-dlp 内部 dispatch 到 `BiliBili` extractor
   - `pickBestFormat()` 排除 `m3u8_native` / `http_dash_segments` / `mhtml`，选最高分辨率的 progressive mp4
3. **B 站特有的 Referer 校验**：
   - yt-dlp 返回的 format `http_headers` 含 `Referer: https://www.bilibili.com/` 等
   - `sanitizeHeaders` 白名单允许 `Referer` 通过，注入到 `ResolvedMedia.headers`
   - `processor.ts:670` 调 `downloadToFile(url, dest, signal, headers)`，axios cfg 合并 headers
   - 如缺 Referer，B 站 CDN 返回 403
4. **下载完成** → ffmpeg → palette → gif → 压缩

---

## 反向断言

- ❌ **不允许**直接用 `media.pageUrl` 喂 yt-dlp（B 站文章页 URL 经常带各种 tracking query，generic extractor 抓错视频）
- ❌ **不允许**`sanitizeHeaders` 漏掉 `Referer`（B 站 403）
- ❌ **不允许**`pickBestFormat` 选 `m3u8_native`（B 站默认会暴露 m3u8 + flv + mp4 多种 protocol，选错会导致 axios 拿到清单文本）
- ❌ **不允许**resolver 失败时把 `media` 从 sniff result 删除（用户可能是 yt-dlp 临时抽风，留卡片让用户重试）

---

## 复演步骤

```bash
node /tmp/giftk-resolver-e2e.js
```

预期输出包含：
```
[case*] Bilibili   https://www.bilibili.com/video/BV1GJ411x7h7 ... OK 206  852x480 mp4 ct=video/mp4
```

`OK 206` 表示 axios `Range: bytes=0-1023` 探测请求被 B 站 CDN 接受，证明：
- yt-dlp 拿到了真实的 progressive mp4 URL
- `http_headers` 中的 Referer 透传成功

---

## 关联规则

- [R-14 resolver-opt-in](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-14-resolver-opt-in.md)
- [docs/embed-resolver.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/embed-resolver.md)

---

## 历史 PASS 记录

| 日期 | 提交 | 结果 | 备注 |
|---|---|---|---|
| 初版沉淀 | yt-dlp resolver 接入 | PASS | BV1GJ411x7h7 852x480 mp4 ct=video/mp4 |
