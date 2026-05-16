# SC-07 — SPA / Hydrated iframe & Cloudflare-Turnstile Fallback

> **来源**:用户最新一轮 "`https://openai.com/zh-Hans-CN/index/testing-ads-in-chatgpt/` 还是测试不出来,你不应该测试下这个嗅探成功了才交付吗?"
>
> **关联规则**:R-09 iframe-embed-detect-only、新增 R-13 spa-must-have-fallback

---

## 触发条件 / 失败现场

OpenAI 这种现代 SPA(Next.js / 类似框架)+ Cloudflare 边缘加 Turnstile 的真实页面:

1. 静态 HTML 流(axios + cheerio)拿到的 HTML **里没有 `<iframe>` 标签**;Vimeo 视频 URL 以 JSON-escaped 形式藏在 `<script>` payload 里:

   ```text
   …vimeo.com\/video\/1162698597?h=bb3311a71a\u0026amp;badge=0…
   ```

2. 在某些 IP/UA 信誉下,服务端会先返回 11KB 的 Cloudflare Turnstile challenge(`<title>Just a moment...</title>` + `cdn-cgi/challenge-platform`),HTML 整体不到 50KB 但**不是常见 `__NEXT_DATA__` SPA 标志**。
3. Electron 隐藏 `BrowserWindow` 同样会被 Turnstile 拦截 — 拿到的依然是 challenge stub。
4. 即便在没有挑战的网络上,Next.js / Nuxt 等 SPA 习惯把 embed URL 序列化进 JSON,**等到客户端 hydration 才把 `<iframe>` 真正挂到 DOM**。所以 cheerio.load(html) 看到的 `iframe.length === 0`。

---

## 期望行为(每一条都要 PASS)

A. **JSON-escaped embed URL 必须被静态规则识别** — 不依赖浏览器渲染。
   ```ts
   {
     kind: 'video',
     source: 'iframe-embed',
     url: 'https://player.vimeo.com/video/1162698597?h=bb3311a71a&badge=0&autopause=0&player_id=0&app_id=58479',
     requiresExternalDownload: true,
     embedHost: 'vimeo.com'
   }
   ```
   - 反斜杠转义 `\/`、Unicode 转义 `\u002f`、`\u0026`、HTML 实体 `&amp;` 必须被 `normaliseEmbed` 规整为标准 URL。
   - 末尾的 `\`、`)`、`]`、`}`、`,`、`.`、`;` 必须裁掉(JSON 引号边界)。
   - URL 进入产品前必须先通过 `matchEmbedProvider` 二次结构化校验,**禁止裸字符串分支**(R-02)。

B. **Headless BrowserWindow fallback 触发条件要宽松** — `noMedia || looksTooShort || looksLikeCsr` 任一即可,而不是三者同时(早期 bug 是 `&&`)。

C. **检测 Cloudflare Turnstile** — 当 HTML 命中 `Just a moment` / `cdn-cgi/challenge-platform` / `challenges.cloudflare.com/turnstile` 之一时,产出明确 warning:
   > "Page is behind a Cloudflare bot challenge (Turnstile / 'Just a moment...'). In the current network/IP we cannot pass it automatically. Open the URL in a normal browser, finish the verification once, then retry — or save the page locally and use the offline file path."

D. **headless 网络稳定性** — 必须 disable QUIC(`app.commandLine.appendSwitch('disable-quic')`),否则在屏蔽 UDP 的网络上会得到 `ERR_CONNECTION_RESET`。

E. **Sec-CH-UA 改写** — headless 请求必须改 `Sec-CH-UA` / `Sec-CH-UA-Mobile` / `Sec-CH-UA-Platform`,移除 `Headless` 痕迹(否则一些 anti-bot 会立即拦截)。

---

## 反向断言

- ❌ **不允许**给 OpenAI(或任何具体 host)写专属分支。新增的规则 8 是「按 provider 结构识别 JSON-escaped URL」,适用于所有 SPA 页面。
- ❌ **不允许**在交付前不跑 e2e 就声称"已修复"。本场景的存在本身就是上一次违反纪律的留痕。
- ❌ **不允许**因为 cheerio 找不到 `<iframe>` 就立刻调用 BrowserWindow 渲染 — 静态正则 8 应当先尝试,只有正则也找不到才落到 headless。

---

## 复演步骤(端到端验证 — 这是 R-13 强制项)

1. 在项目根创建临时 e2e 脚本(参考 `/tmp/giftk-sniff-e2e.js`),用 Electron 直接 `require('dist/main/sniffer.js')` 调 `sniffPage`。
2. 设置 `app.commandLine.appendSwitch('disable-quic')` 后再 `app.whenReady()`。
3. 把目标 URL 设为 `https://openai.com/zh-Hans-CN/index/testing-ads-in-chatgpt/`。
4. 期望输出:
   ```text
   items=1
   - video/iframe-embed https://player.vimeo.com/video/1162698597?h=...&badge=0... [embed=vimeo.com] (external)
   vimeo iframe found: true
   ```
5. 若网络处于 Cloudflare Turnstile 拦截期,期望额外有 warning:`Page is behind a Cloudflare bot challenge…`,但 **items=1 不变**(因为静态规则 8 仍能从 JSON 里抽到 embed URL)。

---

## 关联规则 / 文档

- [R-02 no-host-whitelist](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-02-no-host-whitelist.md)
- [R-09 iframe-embed-detect-only](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-09-iframe-embed-detect-only.md)
- R-13 spa-must-have-fallback(本次新增)
- [docs/sniffer-rules.md §3 + §8](file:///Users/guoshuyu/workspace/gif-toolkit/docs/sniffer-rules.md)
- 实现:[extractFromHtml](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/sniffer.ts) 规则 8 与 [headlessFetch.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/headlessFetch.ts)

---

## 历史 PASS 记录

| 日期 | 提交 | 结果 | 备注 |
|---|---|---|---|
| 初版沉淀 | extractFromHtml 规则 8 + headlessFetch + CF challenge 检测 | PASS | OpenAI URL e2e: items=1, vimeo found |
