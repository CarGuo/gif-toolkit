# SC-10 — headlessFetch must reject SSRF / private targets

## 输入
- `fetchRenderedDom('http://127.0.0.1/anything')`
- `fetchRenderedDom('http://10.0.0.1/anything')`
- `fetchRenderedDom('file:///etc/passwd')`
- 入口公网 URL,但 30x 重定向到内网或子资源加载内网 IP / `file://`。

## 期望
- 上面四种全部直接抛错,不实际发起 BrowserWindow 加载。
- 即使入口可控,session 的 `webRequest.onBeforeRequest` 也必须拦下后续:
  - 子资源里的 `http://10.x` / `http://172.16.x` / `http://192.168.x`
  - `file://` 协议
  - `chrome://`, `chrome-extension://`, `view-source:` 等非 http(s)
- 同时一个 sniffPage 进程内并发调 fetchRenderedDom 不能让 `webRequest` filter 互相覆盖(用 single-flight mutex)。

## 关联代码
- [isUnsafeRequestUrl](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/headlessFetch.ts)
- [isPrivateHost](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/helpers.ts)
- [single-flight mutex (activeChain)](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/headlessFetch.ts)

## 反例
- ❌ 只在入口 `assertSafeUrl(pageUrl)`,redirect/子资源不挡 — 经典 SSRF 泄露。
- ❌ 用 `persist:sniffer` partition — 每次嗅探累计 cookie / cache,会被指纹 / 被 CF turnstile 记忆。本项目改用 `giftk-sniffer-<rand>` 非 persist + finally 清 storage。
