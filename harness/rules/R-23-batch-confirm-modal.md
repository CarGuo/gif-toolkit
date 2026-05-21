# R-23 — 批处理前必须弹「分段选择」确认对话框

> **来源**:第 41 轮用户反馈"我点击批处理之后,没有让我选择片段的流程啊?你把流程坐在那里?我们只需要下载需要处理的片段就好了吧?"。R-22 的 chip UI 只在 [PreviewPanel](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/PreviewPanel.tsx)(单 media 详情页)出现,批处理 [onStart](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/App.tsx) 直接打 IPC,完全绕过 PreviewPanel,长视频被静默自动截断成第 1 段,用户没有"我现在能选别的段"的感知。
> **关联规则**:[R-22](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-22-clip-segment-cap.md) [R-08](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-08-progress-richness.md) [R-16](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-16-tests-required.md)

---

## 强制约束

1. **批处理前的拦截点**:[App.tsx onStart](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/App.tsx) 在打 IPC 之前**必须**先判断:
   ```ts
   const longCandidates = processable.filter(t =>
     t.media.kind === 'video' && t.durationSec > t.options.maxSegmentSec
   );
   if (longCandidates.length > 0 && !userExplicitGlobal) setBatchModal(longCandidates);
   else dispatchBatch(null);
   ```
   只要有 ≥ 1 个长视频,且用户没有显式全选/全排除,就**必须**打开 [BatchSegmentModal](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/BatchSegmentModal.tsx)。
2. **Modal 内每个长视频独立选择**:每条 entry 渲染一个独立的 [SegmentPicker](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/SegmentPicker.tsx),互不影响。默认每个视频只勾 `[0]`,与 R-22 的"自动截断"行为一致 —— **取消 modal === 等价于 R-22 fallback**,所以用户取消也不会出错。
3. **取消按钮 / 点击 backdrop**:都触发 `onCancel`,**不**派发任何任务,modal 关闭后 `processable` 列表保持原样,用户可以再次点击批处理。
4. **确认按钮**:label 必须实时显示总段数 `开始处理 (N 段)`,N = `Object.values(selection).reduce((a, arr) => a + arr.length, 0)`。
5. **优先级链**:[dispatchBatch(perId)](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/App.tsx) 注入选项时优先级:
   1. modal 显式选择(`perId[mediaId]`)
   2. task 上已存在的 `selectedSegments`(用户在 PreviewPanel 单独 set 过)
   3. R-22 fallback `[0]`
6. **抽组件**:[SegmentPicker](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/SegmentPicker.tsx) 必须是纯组件,只接收 `segments / selectedSegments / onChange / title? / hint? / compact?`,**不**直接读 `ProcessOptions`。`buildSegmentPreviews(startSec, endSec, maxSegmentSec)` 是同文件 export 的纯函数,行为与 [enumerateSegments](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor-utils.ts) 镜像。

---

## 反向断言

- No **不允许** 在 onStart 内联展开 segment picker UI,UI 必须只在 SegmentPicker / BatchSegmentModal 两个组件里。
- No **不允许** 把 `selection: {}` 当作"用户没选"来 fallback —— 用户也许就是想清空所有视频但 hit 了 confirm,这种情况 [setOne](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/BatchSegmentModal.tsx) 必须把空数组归一为 `[0]`,确保至少 1 段。
- No **不允许** modal 显示短视频 entry —— 上游必须 `filter(durationSec > maxSegmentSec)`,否则用户会看到"1 段你也让我选"很 confused。
- No **不允许** 直接复用 R-22 的 PreviewPanel chip 代码而不抽组件 —— 复制粘贴会导致 R-23 修了 R-22 不修。

---

## 测试覆盖(R-16 关卡)

- [tests/renderer/SegmentPicker.test.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/tests/renderer/SegmentPicker.test.tsx):11 用例(buildSegmentPreviews 4 + 组件 7)
- [tests/renderer/BatchSegmentModal.test.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/tests/renderer/BatchSegmentModal.test.tsx):6 用例(渲染计数 / 默认 / 修改后 confirm payload / cancel / backdrop / 空选 fallback)
- [tests/renderer/PreviewPanel.test.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/tests/renderer/PreviewPanel.test.tsx):R-22 既有 5 用例继续保留,验证 PreviewPanel 内联 picker 仍走 SegmentPicker 不退化。

---

## 关联文件

- [src/renderer/components/SegmentPicker.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/SegmentPicker.tsx)
- [src/renderer/components/BatchSegmentModal.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/BatchSegmentModal.tsx)
- [src/renderer/components/PreviewPanel.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/PreviewPanel.tsx)
- [src/renderer/App.tsx onStart / dispatchBatch](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/App.tsx)
