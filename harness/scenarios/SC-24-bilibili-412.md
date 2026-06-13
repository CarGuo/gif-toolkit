# SC-24 — Bilibili 412 / yt-dlp 默认无 UA + 无 Referer

> **来源**:第 74 轮真机复演。
> `yt-dlp_macos --dump-single-json https://www.bilibili.com/video/BVxxx`
> 返回 `HTTP Error 412: Precondition Failed`,resolver 链路在第一步就死。
> **关联规则**:[R-84](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-84-ytdlp-default-headers.md) / [R-14](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-14-resolver-bundled.md) / [R-13](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-13-spa-must-have-fallback.md) / [R-26](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-26-spec-vs-runtime-failure-and-resolve-progress.md)

---

## 现象

终端复演:
```bash
$ yt-dlp_macos --dump-single-json https://www.bilibili.com/video/BV1GJ411x7h7
ERROR: [BiliBili] BV1GJ411x7h7: Unable to download webpage:
       HTTP Error 412: Precondition Failed
```

App 内表现:
- 嗅探卡片显示 `resolving…` → `failed: Precondition Failed`
- 主进程日志:`[ytdlp] getInfoSpawn exit code 1, stderr: HTTP Error 412`
- 用户重试任意次仍 412(因为根因是 header,不是网络抖)

## 根因

- B 站对**无 UA / yt-dlp 自带 UA**的请求强制 412(自 2024 Q4 起逐步
  收紧反爬层)。
- yt-dlp 默认 UA 字符串是 `Mozilla/5.0 ... yt-dlp/2024.xx.xx`,
  关键字 `yt-dlp` 命中 B 站黑名单。
- 即便 UA 通过,B 站的视频页 endpoint 还要校验 `Referer`;通用
  extractor 把 pageUrl 当 Referer,与请求 host 不完全同源时再次 412。
- 修复前 `getInfoSpawn` / `downloadYtdlpSections` 两个调用点都没显式
  传 `--user-agent` / `--referer`,完全靠 yt-dlp 默认值。

## 修复

按 [R-84](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-84-ytdlp-default-headers.md):

1. [src/main/resolver/ytdlp.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/resolver/ytdlp.ts)
   顶部 export `DEFAULT_UA`(Chrome 127 desktop)+ `bilibiliReferer(url)`
   helper。
2. 两个 spawn 调用点 `getInfoSpawn` / `downloadYtdlpSections` 都注入
   `--user-agent DEFAULT_UA` + 条件 `--referer bilibiliReferer(url)`。
3. `resolveDirectUrl` 走 `ytdlp-nodejs` 高阶 API,**作为已知后续项**,
   下一轮统一接入(在那之前不允许从 `resolveDirectUrl` 回退调 spawn)。

## 回归脚本

**自动**:
```bash
# 1. helper 与三处调用都引用
grep -nE "DEFAULT_UA|bilibiliReferer" src/main/resolver/ytdlp.ts

# 2. typecheck 0 错
npm run typecheck

# 3. 真机 dump-single-json
node -e "require('./dist/main/resolver/ytdlp.js') \
  .getInfoSpawn('https://www.bilibili.com/video/BV1GJ411x7h7') \
  .then(r=>console.log('OK', r.title)) \
  .catch(e=>console.error('FAIL', e.message))"
# 期望:OK 标题字符串;**不再**出现 412
```

**手工**:
1. App 内粘贴 `https://www.bilibili.com/video/BV1GJ411x7h7`。
2. 嗅探卡片从 `resolving…` → 解析成功 → 出现可下载的直链。
3. 点开始 → ffmpeg → gif 全流程通畅。

## 反向断言

- 不允许任何 yt-dlp spawn 调用点绕过 `DEFAULT_UA` / `bilibiliReferer()`
  helper。
- 不允许把 UA 设为空字符串、`curl/...`、`yt-dlp/...`。
- 不允许非 bilibili host 也强行写 `Referer: https://www.bilibili.com`。
- 412 是**运行失败**(R-26),允许 UI 显示重试按钮;但**不**允许把卡
  片从 sniff result 中删除(用户可能换网络再试)。

## 已知后续项

`resolveDirectUrl` 仍走 `ytdlp-nodejs` 路径,UA/Referer 注入点不同,
**未在本轮统一**。下一轮接入时:
1. 改 `new YtDlp({ userAgent: DEFAULT_UA, referer: bilibiliReferer(url) })`。
2. 跑一次本场景的回归脚本。
3. 把"已知后续项"段落从 R-84 中删除。

## 关联

- [R-84 ytdlp-default-headers](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-84-ytdlp-default-headers.md)
- [R-14 resolver-bundled](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-14-resolver-bundled.md)
- [R-13 spa-must-have-fallback](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-13-spa-must-have-fallback.md)
- [R-26 spec-vs-runtime-failure](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-26-spec-vs-runtime-failure-and-resolve-progress.md)
- [SC-14 resolver-bilibili](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-14-resolver-bilibili.md)
- [SC-15 resolver-failure-fallback](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-15-resolver-failure-fallback.md)
