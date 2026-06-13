# R-84 — yt-dlp 调用必须带默认 UA + Bilibili Referer

**Status**: ratified · **Source**: 第 74 轮真机复演
"`yt-dlp_macos --dump-single-json https://www.bilibili.com/video/BVxxx`
返回 HTTP 412 Precondition Failed,解析直接失败"。

## 一句话

所有 `yt-dlp` 调用必须带**默认 Chrome UA**(`Mozilla/5.0 ... Chrome/...
Safari/537.36`),并且对 `bilibili.com` / `b23.tv` / `player.bilibili.com`
host 额外注入 `Referer: https://www.bilibili.com`,否则 B 站反爬层直接
回 412,整个解析链路在 `getInfoSpawn` 阶段就死。

## 为什么

- B 站对**无 UA 或非浏览器 UA**的请求强制 412(自 2024 Q4 起逐步收紧)。
- yt-dlp 自身的 `--user-agent` 默认是 `Mozilla/5.0 ... yt-dlp/...`,
  关键字 `yt-dlp` 命中黑名单。
- 即使加了 UA,B 站对**视频页 URL** 还要校验 Referer,空 Referer 同样
  412;通用 extractor 的 Referer 是 page url,与请求 host 不同源时被拦。
- 之前 `spawn('yt-dlp', [...])` 三个调用点(`getInfoSpawn` /
  `downloadYtdlpSections` / `resolveDirectUrl`)各自不同程度漏了 UA 或
  Referer,导致解析失败模式飘忽。

## 禁止(反向清单)

- ❌ 在 main 进程外任何位置 `spawn('yt-dlp', ...)` 或 `new YtDlp(...)`
  时绕过 `DEFAULT_UA` / `bilibiliReferer()` helper。
- ❌ 用空字符串、`'curl/...'`、`'yt-dlp/...'` 作 UA。
- ❌ 给非 bilibili host 也写死 `Referer: https://www.bilibili.com`
  (反过来会被 youtube / 直链 CDN 拦)。
- ❌ 把 UA / Referer 散落到三个调用点各自硬编一遍 —— 必须经过同一个
  helper(单点修改,单点审计)。
- ❌ `--add-header` 与 `--referer` 重复传同一 header(yt-dlp 行为未定义,
  可能 last-wins 也可能合并,留隐患)。

## 正面要求

1. [src/main/resolver/ytdlp.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/resolver/ytdlp.ts)
   顶部 export:
   ```ts
   export const DEFAULT_UA =
     'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
     '(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

   export function bilibiliReferer(url: string): string | undefined {
     const host = new URL(url).hostname;
     if (/(^|\.)bilibili\.com$/.test(host) || host === 'b23.tv') {
       return 'https://www.bilibili.com';
     }
     return undefined;
   }
   ```
2. **三个调用点必须各自显式注入**:
   - `getInfoSpawn(url)` → `['--user-agent', DEFAULT_UA, ...(ref ? ['--referer', ref] : [])]`
   - `downloadYtdlpSections(url, ...)` → 同上
   - `resolveDirectUrl(url)`(走 `ytdlp-nodejs` 路径)→ 通过库 API 传
     `userAgent` / `referer` 字段
3. `resolveDirectUrl` 因为走 `ytdlp-nodejs` 高阶 API,其 UA/Referer 注入
   入口与 spawn 路径不同 —— **作为已知后续项标注在本规则附录**,新
   PR 接入时统一引用本 helper。
4. 如未来引入第 4 个 yt-dlp 调用点,**必须**经 helper,不允许复制粘贴。

## 验证脚本(SOP §5 强制)

```bash
# 1. helper 与常量定义存在
grep -nE "^export const DEFAULT_UA" src/main/resolver/ytdlp.ts
grep -nE "^export function bilibiliReferer" src/main/resolver/ytdlp.ts

# 2. getInfoSpawn + downloadYtdlpSections 必须都引用
grep -nE "DEFAULT_UA|bilibiliReferer" src/main/resolver/ytdlp.ts

# 3. 真机复演:bilibili 视频 dump-single-json 必须 200 / 不再 412
node -e "require('./dist/main/resolver/ytdlp.js').getInfoSpawn('https://www.bilibili.com/video/BV1GJ411x7h7').then(r=>console.log('OK', r.title)).catch(e=>console.error('FAIL', e.message))"

# 4. typecheck 0 错(已确认)
npm run typecheck
```

## 已知后续项

- `resolveDirectUrl` 走 `ytdlp-nodejs` 而非 spawn,UA/Referer 注入入口
  是库的 options 对象。**当前轮未统一**,下一轮单独修;在修之前不要
  在 `resolveDirectUrl` 内 fallback 调 spawn(那是绕过本规则的捷径)。

## 关联

- [R-13 spa-must-have-fallback](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-13-spa-must-have-fallback.md) — B 站反爬触发后走三级 fallback
- [R-14 resolver-bundled](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-14-resolver-bundled.md) — yt-dlp 二进制随包分发
- [R-26 spec-vs-runtime-failure](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-26-spec-vs-runtime-failure-and-resolve-progress.md) — 412 属运行失败,非规格失败,允许重试
- [SC-14 resolver-bilibili](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-14-resolver-bilibili.md) — 已存在的 bilibili Referer 场景
- [SC-24 bilibili-412](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-24-bilibili-412.md)

## 沉淀来源

- [src/main/resolver/ytdlp.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/resolver/ytdlp.ts) — `DEFAULT_UA` / `bilibiliReferer` helper + 两个 spawn 调用点
