# docs/sniffer-rules.md

> 嗅探器的全部规则、优先级、去重逻辑、iframe player 白名单。
> 源代码:[src/main/sniffer.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/sniffer.ts)。
> 关联规则:[R-02](file:///Users/guoshuyu/workspace/gif-toolkit/AGENTS.md) / [R-09](file:///Users/guoshuyu/workspace/gif-toolkit/AGENTS.md)。

---

## 1. 通用原则

- **不为某个 host 加白名单**(R-02)。任何"我专门加了 example.com 的处理"都要拒绝。
- **结构化的规则可以加**。比如"识别 `<iframe>` 中 `vimeo.com/video/<id>` 这种路径模式"——这是结构化,不是 host 白名单。
- 每条规则会塞 `source` 字段:`'video-tag' | 'source-tag' | 'img-tag' | 'og-meta' | 'link' | 'json-ld' | 'pattern' | 'iframe-embed'`。**新增规则时必须扩这个 union**。

---

## 2. 7 条规则的优先级

按代码出现顺序,**前面规则的命中会覆盖后面规则的同 URL 命中**(通过 `pushUnique` + `variantScore`)。

| # | 规则 | source | kind | 备注 |
|---|---|---|---|---|
| 1 | `<video src>` + `<source src>` | `video-tag` / `source-tag` | `video` | 含 `data-src` / `data-lazy-src` |
| 2 | `<img src>` 后缀 `.gif` | `img-tag` | `gif` | 不含静态图片(避免 noise) |
| 3 | `<meta property="og:video">` / `twitter:player:stream` | `og-meta` | `video` | — |
| 4 | `<a href>` 后缀 `.mp4 / .webm / .gif` | `link` | 按后缀分类 | — |
| 5 | JSON-LD `VideoObject.contentUrl` | `json-ld` | `video` | — |
| 6 | **`<iframe>` 已知 player 域名** | `iframe-embed` | `video` | `requiresExternalDownload: true` + `embedHost` |
| 7 | 全文正则 `/(https?:\/\/[^\s"'<>()]+\.(?:mp4\|webm\|gif))/gi` | `pattern` | 按后缀分类 | 兜底,经过 dedupKey 去重 |

---

## 3. iframe player 白名单(规则 6)

**只列结构化匹配规则,host + 必要 path 片段**。新增 player 时直接往这张表里填,不要绕开。
源代码:[matchEmbedProvider](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/sniffer.ts#L51-L78)。

| hostSuffix | needsPath | provider |
|---|---|---|
| `player.vimeo.com` | `/video/` | `vimeo.com` |
| `vimeo.com` | `/video/` | `vimeo.com` |
| `youtube.com` | `/embed/` | `youtube.com` |
| `youtube-nocookie.com` | `/embed/` | `youtube.com` |
| `youtu.be` | — | `youtube.com` |
| `player.bilibili.com` | — | `bilibili.com` |
| `bilibili.com` | `/player` | `bilibili.com` |
| `dailymotion.com` | `/embed/` | `dailymotion.com` |
| `fast.wistia.net` | — | `wistia.com` |
| `wistia.com` | `/embed/` | `wistia.com` |
| `players.brightcove.net` | — | `brightcove.com` |
| `streamable.com` | `/o/` 或 `/e/` | `streamable.com` |
| `embed.ted.com` | — | `ted.com` |
| `video.twimg.com` | — | `twitter.com` |

**为什么命中后不下载?** Vimeo/YouTube 这种用 MSE + HLS/DASH 分片流播放(`blob:` URL),没有现成的 .mp4 直链。要拿到真实流需要类似 yt-dlp 的专用 extractor,**当前工程明确不集成**。所以策略是:**列出来 + 标"无法直抓" + 引导用户去原页面**。

---

## 4. 去重逻辑(dedupKey)

源:[dedupKey](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/sniffer.ts#L178)。

合并规则:**只在 URL 的"展示型差异"上做归一化**(尺寸、裁剪、质量、格式 hint),不动其它任何 query。

|被认为是同一资源的差异 | 例子 |
|---|---|
| `=s640` `=s1280` 等 google 缩图 hint | `https://...=s640` 与 `https://...=s1280` |
| `width=400` `w=800` `quality=70` query | `?w=400&q=80` 与 `?w=800` |
| `_thumb` `_small` `_400x400` 后缀 | `foo_400x400.gif` 与 `foo.gif` |
| 大小写 host | `Example.com` 与 `example.com` |

**特别注意**:不要把不同的 query 全部砍掉(那会把"同一域名下的不同视频"误归为一个)。只剔已知的展示参数。

---

## 5. variantScore(同 dedupKey 时取哪个)

代码 [variantScore](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/sniffer.ts)。**新规则覆盖旧规则的优先级:**

`video-tag` > `source-tag` > `og-meta` > `json-ld` > `iframe-embed` > `link` > `pattern` > `img-tag`

> 直觉:结构化越强、可信度越高的命中赢。`pattern` 兜底永远最弱。

---

## 6. 加新规则的步骤(模板)

1. 阅读 [src/main/sniffer.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/sniffer.ts) `sniffPage` 主循环
2. 决定优先级:你的规则比 `pattern` 强吗?是就插在它前面
3. 在 [src/shared/types/](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types/) `SniffedMedia.source` union 上加你的新值
4. 调 `pushUnique(map, { ...media, source: '<your-source>', pageUrl })`
5. **写一个 SC-XX 场景** 到 [harness/scenarios/](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/),记录"什么样的页面会命中这条新规则"
6. typecheck + lint + build 三连
