# SC-09 — videoToGifPalette must propagate AbortSignal

## 输入
- 调 `videoToGifPalette({...})` 转一段 5s 视频,150–300ms 后 abort 传入的 signal。

## 期望
- 第二次 ffmpeg 调用立即收到 SIGKILL 退出。
- Promise 抛 `Error` 且 `e.name === 'CancelledError'`。
- 没有半成品 .gif 输出(或 finally 清理临时 palette.png)。

## 验证脚本
```bash
VIDEO_URL=/tmp/giftk-test.mp4 ./node_modules/.bin/electron /tmp/giftk-video-pipeline-e2e.js
# 预期:
#   VIDEO_DONE <2000ms output=... size>1024
#   CANCEL_PROBE name=CancelledError msg=cancelled
#   CANCEL_DONE <500ms cancelled=true
```

## 关联代码
- [videoToGifPalette signal forward](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/ffmpeg.ts)
- [processor.ts L824 调用](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) — 必须传 4 个参数,signal 是第 4 个。

## 反例
- ❌ 调用 `videoToGifPalette(p, onLog)` 不传 signal — 取消批处理时这一步会跑完。
- ❌ baseFilter 末尾带逗号又拼 `[x]` — ffmpeg 抛 "No such filter: ''" SIGSEGV(已修)。
