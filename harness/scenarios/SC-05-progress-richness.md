# SC-05 — 进度信息要丰富(substep / detail / elapsedMs)

> **来源**:第 16 轮 "目前这个进度显示信息太少,没有当前正在做什么,然后会导致卡很多不知道什么情况"。
> **关联规则**:[R-08](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-08-progress-richness.md)

---

## 触发条件

任何一条任务从 `running` 走到 `done`(或 `error` / `skipped`)。

---

## 期望行为

每个 [TaskProgress](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types.ts) emit 必须**至少包含**:

| 字段 | 例子 |
|---|---|
| `state` | `'running'` |
| `substep` | `'Phase B / lossy=80'` |
| `detail` | `'1.78MB / target 2MB'` |
| `stepIndex` | `3` |
| `totalSteps` | `5`(估算可) |
| `elapsedMs` | `12340` |

**至少**要在以下时刻有 emit:

- 下载开始 / 下载完成
- ffprobe 探测分辨率
- 视频转 GIF(palette 阶段 1 / 阶段 2)
- Phase A 开始 / 结束
- Phase B 二分搜索的每一次 mid 试探(可批量 emit)
- Phase C 每一次缩边
- Phase D 兜底
- 最终落盘

UI [TaskTable](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/TaskTable.tsx) 在 substep 变化时刷新展示,**没有** "看起来卡住几十秒" 的视觉断层。

---

## 反向断言

- ❌ **不允许**只发一次 `percent: 50`,然后 5 秒后突然跳到 `percent: 100`
- ❌ **不允许**在长任务(>3s)里整段静默不 emit
- ❌ **不允许**emit 时漏 `elapsedMs`(用户判断"是否卡死"的核心信号)
- ❌ **不允许**substep 写成英文堆栈(要可读、可展示给用户)

---

## 复演步骤

1. `npm run dev`
2. 粘一个 ~5MB 的源 GIF(确保会经过 Phase A / B / C 全程)
3. 打开 DevTools 看 IPC 流(或在 [TaskTable.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/TaskTable.tsx) 加一个 `console.log(taskProgress)`)
4. **期望**:从 `running` 到 `done` 之间至少 5-10 个 emit,每个都带 substep + detail + elapsedMs
5. UI 上肉眼观察:进度条 + 阶段名 在压缩过程中**有持续可见的变化**

---

## 关联规则

- [R-08 progress-richness](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-08-progress-richness.md)
- [docs/ipc-contract.md §3](file:///Users/guoshuyu/workspace/gif-toolkit/docs/ipc-contract.md)

---

## 历史 PASS 记录

| 日期 | 提交 | 结果 | 备注 |
|---|---|---|---|
| 初版沉淀 | TaskProgress 加 substep/detail/elapsedMs | PASS | — |
