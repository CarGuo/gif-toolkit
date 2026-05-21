# R-07 — PQueue 并发默认 3 / clamp 1..8

## 规则
- 批处理用 [p-queue](https://www.npmjs.com/package/p-queue)
- 默认 concurrency = 3,UI 上可配置
- 接受范围 [1, 8],外部输入 clamp

## 为什么
- 用户问过(第 16 轮):"能并行执行吗?为什么这么慢?"
- 1 太慢、8 以上对桌面 Electron 来说会显著热(ffmpeg 内部还有自己的线程)

## 怎么遵守
- [sanitizeOptions](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) 入口 clamp
- [OptionsForm.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/OptionsForm.tsx) 输入框上设置 min=1 max=8 step=1
- 改并发后**重建** PQueue 或者 `queue.concurrency = n`

## 反例
- No `new PQueue({ concurrency: 1 })` 硬编码
- No 接受任意整数(导致用户填 999 把机器烤掉)

## 关联场景
- [SC-06](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-06-concurrency-default-3.md)
