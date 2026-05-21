# SC-04 — iframe 嵌入(Vimeo / YouTube)只识别不下载

> **来源**:用户最新一轮 "OpenAI mhtml 里其实是有视频的,为什么会嗅探不出来" + "不集成 yt-dlp"。
> **关联规则**:[R-09](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-09-iframe-embed-detect-only.md)

---

## 触发条件

页面里出现已知第三方播放器 iframe,例如:

```html
<iframe src="https://player.vimeo.com/video/1162698597?h=bb3311a71a"></iframe>
<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>
<iframe src="https://player.bilibili.com/player.html?aid=12345"></iframe>
```

代表性现实输入:`/Users/guoshuyu/Desktop/在 ChatGPT 中测试广告 _ OpenAI.mhtml`。

---

## 期望行为

- sniffer 命中规则 6,产出 SniffedMedia:
  ```ts
  {
    kind: 'video',
    source: 'iframe-embed',
    url: 'https://player.vimeo.com/video/1162698597?h=bb3311a71a',
    requiresExternalDownload: true,
    embedHost: 'vimeo.com'
  }
  ```
- Renderer 上:
  - 卡片右下角显示金色徽章 `vimeo.com 嵌入 · 无法直抓`
  - hover tooltip:"视频由 vimeo.com 嵌入(如 Vimeo / YouTube),无法直接抓取视频流。请到原页面获取 .mp4 直链后再回来嗅探。"
  - 不被自动勾选,不参与"开始批处理"
  - PreviewModal 底部"单独处理本项"按钮变成不可点
  - 用户强行调用 `onProcessOne` 时,日志写 `[single] 已跳过(vimeo.com 嵌入,无法直接下载视频流): ...`

---

## 反向断言

- No **不允许**真的去下载这个 iframe URL(它返回 player HTML,不是视频流)
- No **不允许**为某个 host 加裸字符串分支(如 `if (host === 'vimeo.com')`)。所有 player 域名走 [matchEmbedProvider](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/sniffer.ts#L51-L78) 的结构化白名单
- No **不允许**把 disqus/stripe-checkout 这种非视频 iframe 也错认为 player(用 host + needsPath 双重判定)
- No **不允许**让"批处理"绕过 `requiresExternalDownload`,把 iframe-embed 也跑一遍

---

## 复演步骤

1. 启动 `npm run dev`
2. 粘 OpenAI 那个 ChatGPT 广告页面 URL(或离线 mhtml 复测时手工构造一个含 Vimeo iframe 的页面)
3. 嗅探完成后,在结果列表里:
   - 应当至少有 1 条 `source: 'iframe-embed'` 的 video 卡片
   - 默认未被自动勾选
   - 卡片显示黄色"vimeo.com 嵌入 · 无法直抓"徽章
4. 点击"开始批处理"
5. **期望**:processable 数量不计入这条 iframe 视频
6. 单独点这条 iframe 的卡片 → 大图弹窗里底部按钮显示"vimeo.com 嵌入 · 无法直抓",不可点

---

## 关联规则

- [R-02 no-host-whitelist](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-02-no-host-whitelist.md)
- [R-09 iframe-embed-detect-only](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-09-iframe-embed-detect-only.md)
- [docs/sniffer-rules.md §3](file:///Users/guoshuyu/workspace/gif-toolkit/docs/sniffer-rules.md)

---

## 历史 PASS 记录

| 日期 | 提交 | 结果 | 备注 |
|---|---|---|---|
| 初版沉淀 | matchEmbedProvider 引入 | PASS | 14 条 host 规则 |
