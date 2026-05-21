# SC-11 — embed-only media must early-fail in main process

## 输入
- 嗅探到一个 `iframe-embed` 项,例如 `https://player.vimeo.com/video/1121717410`,标记 `requiresExternalDownload: true, embedHost: 'vimeo.com'`。
- Renderer 把它放进 `process:start` payload。

## 期望
- 主进程在 `processOneTask` 开始前(非 ffmpeg 启动后)立即 emit `error` state,带可读 message,例如:
  - `"This is an embedded vimeo.com player; please open the original page to grab a direct .mp4 URL."`
- `sanitizeMedia` 必须保留并校验 `requiresExternalDownload` + `embedHost`(host 字符白名单 `/^[a-z0-9.-]+$/`,长度 ≤64)。
- 不会启动 ffmpeg / 不会写部分 GIF 文件。

## 关联代码
- [sanitizeMedia](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts)
- [processOneTask early fail](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts)
- [R-09 iframe-embed-detect-only](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-09-iframe-embed-detect-only.md)

## 反例
- No sanitizeMedia 把 `embedHost`/`requiresExternalDownload` 抹掉 — processor 拿不到外部下载标记,会试图把 vimeo 的 player.html 当 video 文件喂给 ffmpeg。
- No 跨字段不校验 host 字符 — 攻击者可在 host 注入特殊字符,让后续日志 / 文件名出问题。
