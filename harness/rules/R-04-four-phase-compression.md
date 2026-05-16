# R-04 — 压缩管线必须四阶段

## 规则
压缩流程严格按 Phase A → B → C → D 的顺序,不允许"乱跳"或"合并"。

## 为什么
- 不分阶段会回到 245 次穷举(用户原话:"为什么压缩那么慢?ezgif 实现很快")
- 双层目标(R-05)需要 Phase A/B 走 best,Phase C/D 走 fallback,两条路径必须分开

## 阶段定义
| Phase | 做什么 | 目标 |
|---|---|---|
| A | resize-first(只在 longestSide > maxSide 时) | 进 B/C/D 前满足 maxSide 硬约束 |
| B | adaptive lossy(二分搜索,起点自适应) | softMaxBytes(默认 2MB,best) |
| C | 几何缩边(longSideFloor 守护) | maxBytes(默认 4MB,fallback) |
| D | 终极兜底(finalSide=longSideFloor + 最大 lossy) | 兜底再不行就 skipped |

## 怎么遵守
- 改任何一个 Phase 都先想清楚"我有没有破坏其它 Phase 的入口/出口"
- 在 [src/main/processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) `compressLoop` 顶层保持 4 段清晰边界,不要把它揉成一团

## 反例
- ❌ "我把 Phase B 和 Phase C 合并成一个统一搜索,这样更快" ← 失去分级,违反 R-05
- ❌ "Phase B 直接二分到 lossy=200" ← 自适应起点是 ROI 的核心

## 关联场景
- [SC-02](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-02-aspect-ratio-early-fail.md)
- [SC-03](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-03-soft-vs-hard-target.md)
