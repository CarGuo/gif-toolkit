# R-03 — maxSide 同时作用于宽和高

## 规则
配置项 `maxSide` 是 **"长边上限"**,不是"宽度上限"。它必须同时约束 `max(width, height) ≤ maxSide`。

## 为什么
- 用户明确说过(第 17 轮):"应该是宽和高都需要满足最大那个设置"
- 长条图(4000×300)如果只压宽度,会出现 width=800 但 height=2400 的内存炸裂场景

## 怎么遵守
- Phase A 缩放使用 [shortSideAfterCap](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts#L77-L81)
- 凡是涉及"resize"的代码路径都先取 `longestSide = max(w, h)`,以它为基准缩

## 反例
- ❌ `if (width > maxSide) resize(maxSide, height * maxSide / width)` ← 没看 height
- ❌ 只在视频路径加,GIF 路径漏(Phase A 必须覆盖两条路径)

## 关联场景
- [SC-02](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-02-aspect-ratio-early-fail.md)
