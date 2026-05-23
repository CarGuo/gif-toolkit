# R-08 — 进度信息必须丰富

## 规则
[TaskProgress](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types/) emit 时必须带:
- `substep`(当前在做什么,人类可读)
- `detail`(具体数字,如"1.78MB / target 2MB")
- `stepIndex` / `totalSteps`(预估)
- `elapsedMs`(累计耗时)

## 为什么
- 用户原话(第 16 轮):"进度信息太少,看起来卡住"
- 用户判断"是否卡死"靠的就是 elapsedMs 在动 + substep 在变

## 怎么遵守
- 至少在每个 Phase 切换、每次 gifsicle 二分 mid 试探时 emit 一次
- 长任务(>3s)中间不允许静默
- substep 写中文 + 关键数字,**不要写英文堆栈**

## 反例
- No `emit({ percent: 50 })` 单字段
- No Phase B 跑 30 秒不发 emit
- No `substep: 'lossy_pass_3_of_inner_iter_42'` ← 用户看不懂

## 关联场景
- [SC-05](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-05-progress-richness.md)
