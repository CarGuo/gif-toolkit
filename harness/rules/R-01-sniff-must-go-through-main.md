# R-01 — 嗅探必须走主进程

## 规则
所有外部 URL 抓取(`axios.get` / `fetch`)只能发生在 main process。Renderer **永远** 不许直接 fetch 跨域资源。

## 为什么

- Renderer 受同源策略限制,目标站可能拒绝
- Renderer 没有可控的 cookie/UA 策略
- 大文件流必须经过 fs / Range,Renderer 没法处理
- Electron 安全基线要求渲染端最小权限

## 怎么遵守
- 新增抓取逻辑放在 [src/main/sniffer.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/sniffer.ts) 或 [src/main/downloader.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/downloader.ts)
- Renderer 只通过 `window.giftk.sniff(url)` 发请求

## 反例
- No 在 React 组件里 `fetch('https://...')` 然后解析 HTML
- No 在 Renderer 里用 `<webview>` 加载外站,然后把 DOM 抠出来

## 关联场景
- [SC-01](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-01-dedup-key-generic.md)
- [SC-04](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-04-iframe-embed-vimeo.md)
