# R-06 — 缩边时必须保短边 ≥ minSide

## 规则
任何会改变尺寸的阶段(A/C/D)都要先算 longSideFloor,**保证短边不会破 minSide**;若做不到,**抛 [AspectRatioConstraintError](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts#L46-L70) 早 fail**。

## 为什么
- 用户明确(第 18 轮):"改高让宽超过最小,这就不对了,要直接提示问题"
- 没有这条会把 4000×300 强行压成 800×60 的畸变图,视觉惨不忍睹

## 关键公式
```
fromShort = ceil(longestSide * minSide / shortestSide)
longSideFloor = max(minSide, min(longestSide, fromShort))
```

## 怎么遵守
- 在 Phase A 入口验:`shortSideAfterCap < minSide` → throw
- 在 Phase C/D 缩边时:`newLongest = max(newLongest, longSideFloor)`

## 反例
- No Phase C 直接 `newLong = oldLong * 0.85`,不算 longSideFloor
- No 把 AspectRatioConstraintError 改成 console.warn 然后继续压

## 关联场景
- [SC-02](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-02-aspect-ratio-early-fail.md)
