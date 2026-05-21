# R-09 — iframe 第三方播放器只识别不下载

## 规则
对 Vimeo / YouTube / Bilibili / Dailymotion / Wistia / Brightcove / Streamable / TED / Twitter video 等第三方播放器 iframe:
- 嗅出来 + 标 `requiresExternalDownload: true` + `embedHost`
- **不下载、不预览、不批处理**
- UI 上禁用处理按钮 + 黄色徽章 + tooltip

## 为什么
- 这些 player 用 MSE+HLS/DASH 分片流,没有现成的 .mp4 直链
- 抓真实流需要 yt-dlp 这种专用 extractor → 用户拍板"不集成"
- 嗅出来但不告诉用户 = 静默失败,体验差;告诉了不能处理 = 透明

## 怎么遵守
- 域名识别用 [matchEmbedProvider](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/sniffer.ts#L51-L78) 的结构化白名单
- 渲染端 [App.tsx onProcessOne](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/App.tsx) 守卫 + processable 过滤
- [MediaGrid.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/MediaGrid.tsx) 卡片显示徽章而不是处理按钮

## 反例
- No 真去 GET `https://player.vimeo.com/video/xxx` 然后用 ffmpeg 转(它返回 player HTML)
- No 静默丢弃 iframe(用户不知道有视频)
- No 只对 vimeo 做,不管 YouTube(不全)

## 关联场景
- [SC-04](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-04-iframe-embed-vimeo.md)
