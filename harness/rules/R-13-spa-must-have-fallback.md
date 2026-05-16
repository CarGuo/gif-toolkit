# R-13 — SPA / anti-bot 页面必须有「静态正则 → headless 渲染 → 显式 challenge 报错」三级 fallback

## 规则
对所有现代 Web 文章页(尤其是 Next.js / Nuxt / Vue / React SPA + Cloudflare/Akamai 边缘)的嗅探,必须按下面顺序串行兜底,**不能只跑 axios + cheerio 然后报"未发现媒体"**:

1. **L1 静态 cheerio 抽取**(规则 1–7):`<video>` / `<source>` / `<img>.gif` / og 元标签 / `<a>` / JSON-LD / `<iframe>` 的标准提取。
2. **L2 静态正则 + provider 校验**(规则 8):对 `player.vimeo.com/video/...`、`youtube.com/embed/...`、`player.bilibili.com/player.html?...`、`fast.wistia.net/embed/iframe/...`、`streamable.com/o|e/...`、`embed.ted.com/...` 等已知 player URL,**用宽松正则**直接扫整段 HTML(包含 `<script>` JSON payload),并对 JSON-escaped(`\/`、`\u002f`、`\u0026`、`&amp;`)做 `normaliseEmbed` 规整。每一个匹配都必须再次过 `matchEmbedProvider` 结构化白名单(R-02)。
3. **L3 隐藏 Electron `BrowserWindow` 渲染回放**(`headlessFetch.fetchRenderedDom`):
   - 触发条件 = `noMedia || looksTooShort || looksLikeCsr` 中**任一为真**(早期 `&&` 的写法是 bug)。
   - 必须 `app.commandLine.appendSwitch('disable-quic')`,否则在屏蔽 UDP 的网络上会得到 `ERR_CONNECTION_RESET` (-100)。
   - 通过 `webRequest.onBeforeSendHeaders` 改写 `Sec-CH-UA` / `Sec-CH-UA-Mobile` / `Sec-CH-UA-Platform`,移除 `HeadlessChrome` 痕迹。
   - 等待策略:`did-finish-load` + 5s post-load hydration delay + network-idle quiet 2.5s,硬上限 75s。
   - 渲染完成后再次调 `extractFromHtml` 并消费 `document.querySelectorAll('iframe')` live 列表。
4. **L4 显式 Cloudflare challenge 检测**:静态 HTML 或 headless HTML 命中 `Just a moment` / `cdn-cgi/challenge-platform` / `challenges.cloudflare.com/turnstile` 时,产出明确 warning,引导用户在浏览器中先通过验证。

## 为什么
真实世界(本仓库踩过的坑):

| 站点 | L1 (cheerio) | L2 (正则) | L3 (headless) | 解释 |
|---|---|---|---|---|
| 知乎专栏 | ✅ | — | — | 标准 `<img>.gif` |
| Android Developers Blog | ✅ | — | — | 标准 `<iframe>` |
| OpenAI ChatGPT 广告页 | ❌(0 iframe)| ✅ vimeo embed | ❌(被 Cloudflare Turnstile 拦) | Next.js + JSON 序列化 + Turnstile |

只有 L1 的实现会让 OpenAI 这类页面**永远嗅不出**;只有 L1+L3 的实现会被 Turnstile 拦死;**L2 是 SPA 时代的真正主力**。

## 怎么遵守
- 任何对 sniffer 的改动都必须先在 `harness/scenarios/SC-07` 上跑端到端通过(`./node_modules/.bin/electron /tmp/giftk-sniff-e2e.js`)再合入。
- 任何"加一个新 player"的需求都要同时在 `matchEmbedProvider` 和 `EMBED_PATTERNS` 里加结构化匹配 — **禁止裸字符串分支**。
- normaliseEmbed 的替换顺序必须是 `\u0026` → `&amp;` → `&`,顺序错会留 `&amp;` 残渣。

## 反例
- ❌ 仅用 `cheerio.load(html); $('iframe')` 然后报 0 项就交付。
- ❌ 用 `noMedia && looksLikeCsr` 当 fallback 触发条件 — Cloudflare 给的 200+11KB challenge 既不像 `__NEXT_DATA__` 也不像 stub。
- ❌ headless 不关 QUIC,在中国大陆机器跑会大量 `handshake failed; net_error -100`。
- ❌ 命中 Turnstile 不报警,让用户以为页面"真没视频"。

## 关联场景 / 文档
- [SC-04 iframe-embed-vimeo](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-04-iframe-embed-vimeo.md)
- [SC-07 spa-hydrated-iframe-fallback](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-07-spa-hydrated-iframe-fallback.md)
- 实现:[extractFromHtml](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/sniffer.ts)、[headlessFetch](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/headlessFetch.ts)
- 文档:[docs/sniffer-rules.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/sniffer-rules.md)
