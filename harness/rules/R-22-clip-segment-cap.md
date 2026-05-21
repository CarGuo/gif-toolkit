# R-22 — 长视频默认只跑第 1 段(`maxSegmentSec` + `selectedSegments`)

> **来源**:第 39 轮用户反馈"视频默认只支持 20s 最长……一次处理一堆片段太夸张"。在此之前,长视频(durationSec > maxSegmentSec)会被 [videoToGif](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) 切成 ceil(range/maxSegmentSec) 段并**全部跑**,2 分钟视频直接产出 6+ 个 GIF,任务列表炸开。
> **关联规则**:[R-04](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-04-four-phase-compression.md) [R-08](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-08-progress-richness.md) [R-16](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-16-tests-required.md)

---

## 强制约束

1. **`ProcessOptions.maxSegmentSec` 默认 20**(原 15)。同时是单段最大时长 + 自动分段触发阈值,语义不变。
2. **`ProcessOptions.selectedSegments?: number[]`**:可选,长视频被切成 N 段后,此白名单限制只处理列出的下标。语义:
   - `undefined` / `[]` → 处理所有段(向后兼容,旧 IPC 调用方不受影响)。
   - `[0]` → 只处理第 1 段(默认推荐)。
   - `[0, 2]` → 处理第 1 + 第 3 段。
   - 越界下标在 [filterSelectedSegments](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor-utils.ts) 中被静默 drop;若过滤后为空则 fallback 到全部(防止误操作产出 0 输出)。
3. **renderer 自动注入 `[0]`**:[App.tsx onStart / onProcessOne](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/App.tsx#L190-L260) 在分发任务前,对 `kind==='video' && durationSec > maxSegmentSec` 的 task 自动写 `selectedSegments=[0]`,**除非**用户已通过 PreviewPanel 显式设置了 startSec/endSec 或 selectedSegments。**必须在日志面板提示用户已自动截断**。
4. **PreviewPanel 必须暴露分段勾选 UI**:[PreviewPanel.tsx segment-picker](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/PreviewPanel.tsx#L197-L242) 渲染所有分段为复选框 chip,默认勾选第 1 段;提供"全选"和"仅第 1 段"按钮。
5. **enumerateSegments 等长切分**:N 段必须每段长度相同(`range / N`),不允许 `[20, 20, 10]` 这种"N 满 + 1 余"形式,UI 进度条才好看。

---

## 反向断言

- No **不允许** processor.ts 内联计算 `segCount = Math.ceil(range / segLen)` 等分段逻辑——必须走 [enumerateSegments](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor-utils.ts#L163-L180) + [filterSelectedSegments](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor-utils.ts#L191-L202) 纯函数,以便单测覆盖。
- No **不允许** main 层对 `selectedSegments` 不做 sanitize(必须在 [src/main/index.ts sanitizeOptions](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L210-L220) 里去重 + 排序 + 整数过滤,renderer 来源不可信)。
- No **不允许** 长视频在没有日志提示的情况下被自动截断(用户必须知道默认行为,否则会困惑"为什么只输出了 1 个 GIF")。
- No **不允许** 当 PreviewPanel 内分段全部取消勾选时把 `selectedSegments=[]` 传给 main(必须留至少 1 段或回退 undefined,否则用户会困惑"为什么没有任何输出")。

---

## 测试覆盖(R-16 关卡)

- [tests/main/processor-utils.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/processor-utils.test.ts):
  - `enumerateSegments` × 5 用例(短范围 single seg / 长范围等长切分 / 非零 clipStart / 空范围 / 0 maxSegmentSec)
  - `filterSelectedSegments` × 5 用例(undefined / 空数组 / 白名单 / 越界 drop / dedup)
- [tests/renderer/PreviewPanel.test.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/tests/renderer/PreviewPanel.test.tsx):
  - 短视频不显示 picker
  - 长视频显示 N chip 默认勾第 1
  - "全选" 按钮
  - chip 切换 toggle 数组
  - chip 区间标签数值正确

---

## 关联文件

- [src/main/processor-utils.ts enumerateSegments + filterSelectedSegments](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor-utils.ts#L141-L202)
- [src/main/processor.ts videoToGif segments](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts#L1063-L1082)
- [src/main/index.ts sanitizeOptions](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L206-L220)
- [src/renderer/App.tsx onStart / onProcessOne](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/App.tsx#L190-L290)
- [src/renderer/components/PreviewPanel.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/PreviewPanel.tsx)
