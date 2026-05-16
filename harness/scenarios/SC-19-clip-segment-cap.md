# SC-19 — 长视频自动分段炸开 / clip-segment-cap

> **来源**:第 39 轮用户反馈"视频默认只支持 20s 最长……一次处理一堆片段太夸张"。一个 2 分钟视频在旧逻辑下会被切成 8 段并**全部跑**,任务列表瞬间炸开。
> **关联规则**:[R-22](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-22-clip-segment-cap.md) [R-04](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-04-four-phase-compression.md) [R-08](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-08-progress-richness.md) [R-16](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-16-tests-required.md)

---

## 触发条件

| 因素 | 影响 |
|---|---|
| `ProcessOptions.maxSegmentSec` 既是单段最大时长又是自动分段阈值 | 用户拖了一个 90s 视频 → ceil(90/15)=6 段全跑 |
| 旧 `videoToGif` 在 [processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) 内联计算 `segCount = Math.ceil(range / segLen)` | 缺少**用户级旋钮**让人选"我只要前 20s",没法降级 |
| 没有 segment 概念暴露给 renderer | PreviewPanel 即便看到 6 段也无法把"只跑第 1 段"的意图传回 main |
| 旧默认 `maxSegmentSec=15` | 视觉/动效短片很多刚好 15-20s,容易触发分段 |

---

## 期望行为

1. **`maxSegmentSec` 默认 15 → 20**(覆盖大多数短视频/广告/预告/动效片段;原值过严)。
2. **`ProcessOptions.selectedSegments?: number[]` 字段贯通**:
   - `undefined`(legacy) → 全跑(旧调用方不受影响)。
   - `[0]` → 只跑第 1 段。
   - `[0, 2]` → 跑第 1 + 第 3 段(任意子集)。
3. **renderer 在 [App.tsx onStart / onProcessOne](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/App.tsx#L190-L290) 自动注入 `[0]`**:对 `kind==='video' && (resolved?.durationSec ?? media.durationSec) > options.maxSegmentSec` 的 task,在分发前写 `selectedSegments=[0]`,但**只在用户没有显式设置 startSec/endSec/selectedSegments 时**注入,日志面板必须给提示。
4. **PreviewPanel 必须显示分段 chip 列表**,允许用户加勾其它段或全选;chip 区间显示 `start..end s`。
5. **main 层 sanitize**:[sanitizeOptions](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L206-L220) 必须 dedup + 整数过滤 + 排序 + 长度上限(防 DOS)。
6. **processor.ts 必须走纯函数**:[enumerateSegments](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor-utils.ts#L163-L180) + [filterSelectedSegments](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor-utils.ts#L191-L202),便于单测和后续重构。

---

## 反向断言

- ❌ **不允许** renderer 把空数组 `selectedSegments=[]` 传给 main(会被 main 内 sanitize 折叠成 undefined → 行为变成"全跑",和"取消所有勾选"的用户意图相反;PreviewPanel 应在最后一段被取消时落到 `[0]` 兜底或 disable 取消按钮)。
- ❌ **不允许** processor.ts 直接计算 segments 数组(必须走两个纯函数,否则单测无法覆盖,违反 R-16)。
- ❌ **不允许** 自动注入 `[0]` 时不在日志中提示用户(用户会困惑"为什么 90s 视频只输出了 1 个 GIF")。
- ❌ **不允许** 文件名中的 `s${seg.index}` 用密集 i 替代(选 `[0, 2]` 时输出文件必须是 `.s0.gif` + `.s2.gif`,保留可识别性,而不是 `.s0.gif` + `.s1.gif`)。

---

## 复演步骤

1. 嗅探一个 ≥ 60s 视频(可用 `<video>` 标签直接给 mp4 链接,或经 yt-dlp 解析)。
2. 不打开 PreviewModal,直接点 ▶ 开始批处理。
3. **修复前**:任务列表出现 N 个 segment 输出,N=ceil(60/15)=4 个 GIF,用户的 4MB 配额被均分浪费。
4. **修复后**:
   - 任务列表只出现 **1** 个输出,文件名包含 `.s0`。
   - 日志面板出现 `[batch/single] X 个长视频已默认只处理第 1 段(0..20s);如需更多段,请在预览中勾选`。
5. 双击卡片打开 PreviewModal → PreviewPanel 显示 N 个 chip,第 1 个默认勾选;点 "全选" → 重新点 ▶ → N 个输出回归。

---

## 测试覆盖(R-16)

- [tests/main/processor-utils.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/processor-utils.test.ts):
  - 5 个 `enumerateSegments` 用例(等长切分 / 非零 clipStart / 边界 / 异常)
  - 5 个 `filterSelectedSegments` 用例(undefined / [] / 白名单 / 越界 / dedup)
- [tests/renderer/PreviewPanel.test.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/tests/renderer/PreviewPanel.test.tsx):
  - 短视频不显示 picker
  - 长视频显示 N chip 默认勾第 1
  - "全选" 按钮把所有索引写回
  - chip 切换 toggle 数组
  - chip 显示等长区间数值

---

## 历史 PASS 记录

| 日期 | 提交 | 结果 | 备注 |
|---|---|---|---|
| 初版沉淀 | maxSegmentSec 15→20;新增 selectedSegments;processor 走 enumerateSegments+filterSelectedSegments;PreviewPanel 加 chip;App.tsx 自动注入 `[0]`+日志提示 | PASS | typecheck/lint/test(96)/build |
