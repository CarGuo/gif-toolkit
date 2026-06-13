# R-85 — gif-optimize 三分支选路:hasBudget 优先于 method picker

**Status**: ratified · **Source**: 第 74 轮怒点
"chip「<2MB」点了之后,我在 method picker 又选了 lossy,产物居然 3MB
多,chip 完全被忽略"。

## 一句话

`gif-optimize` 主入口的三分支选路顺序**必须固定**为
`hasBudget > hasMethod > hasExplicit > fallthrough`:只要 `maxBytes`
被显式设定(chip 或 API 传入),无论用户是否同时选了 `method='lossy'`
或显式 `lossy=80 / colors=128`,都必须走 budget 分支(即
[R-83](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-83-toolbox-budget-ignores-minsize.md)
的 `toolboxBudgetCompress`),不能被 method picker 单 pass 截胡。

## 为什么

- 修复前的选路顺序是 `hasMethod > hasBudget > hasExplicit`,导致用户
  "先点 chip 再选 method" 时,maxBytes 被沉默丢弃 —— chip 不兑现。
- "chip 是用户最强表态"(我要 ≤2MB),method/lossy 是"用户的偏好提
  示"。**强表态吃偏好,而不是反过来**。
- 三分支顺序还必须配 ToolboxPanel.setMethod 切 method 时清理残留参
  数,否则上次 method 的 lossy/colors 会被带到下一次。

## 禁止(反向清单)

- ❌ 让 `method='lossy'` + `maxBytes=2MB` 命中 method picker 单 pass
  分支(必须进 budget 分支)。
- ❌ 让显式 `lossy=80 / colors=128` 在 `hasBudget=true` 时覆盖 budget
  分支(显式参数在 budget 分支内**可作为起点种子**,但不能跳过迭代)。
- ❌ 删除或弱化 [ToolboxPanel.tsx#L446-L485](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/ToolboxPanel.tsx)
  `setMethod` 切 method 时清残留字段的逻辑;切 method 后保留 maxBytes
  字段。
- ❌ 把 `hasBudget` 检测改为 `maxBytes != null && maxBytes < someThreshold`
  之类的"软门槛" —— 只要 `maxBytes` 是有限正数就算 hasBudget。
- ❌ 在 method picker UI 上把 chip 状态隐藏掉(让用户以为 chip 失效);
  chip 始终高亮可见。

## 正面要求

1. [src/main/processor.ts#L2625](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts#L2625)
   gif-optimize 主入口的判定顺序必须是:
   ```ts
   const hasBudget = typeof opts.maxBytes === 'number' && opts.maxBytes > 0;
   const hasMethod = !!opts.method;
   const hasExplicit = opts.lossy != null || opts.colors != null;

   if (hasBudget) {
     return goBudget(opts);          // → toolboxBudgetCompress
   }
   if (hasMethod) {
     return goMethod(opts);          // method picker 单 pass
   }
   if (hasExplicit) {
     return goExplicit(opts);        // 直接 gifsicle 一次
   }
   return goFallthrough(opts);       // 走 DEFAULT_OPTIONS 链
   ```
2. `goBudget` 内部允许把 explicit `lossy/colors` 作为**初始种子**传给
   `toolboxBudgetCompress`,但循环条件仍由字节预算驱动,不被种子锁死。
3. [ToolboxPanel.tsx setMethod](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/ToolboxPanel.tsx)
   切 method 时清掉**仅与上一种 method 相关**的残留(如从 lossy 切到
   gifski 时清掉 `lossy`),但 `maxBytes` / `softMaxBytes` / `maxSide`
   等"目标类"参数必须保留。
4. [src/main/processor.ts#L2422](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts#L2422)
   video-to-gif 也遵守:用户设 `maxBytes` 则走 `toolboxBudgetCompress`
   (而非走 single-pass palette → gif → return)。

## 验证脚本(SOP §5 强制)

```bash
# 1. goBudget 分支存在
grep -n "goBudget\|hasBudget" src/main/processor.ts

# 2. 判定顺序:hasBudget 必须早于 hasMethod
awk '/goBudget|hasMethod|hasBudget/{print NR": "$0}' src/main/processor.ts | head -20

# 3. ToolboxPanel.setMethod 清残留逻辑保留
sed -n '446,485p' src/renderer/components/ToolboxPanel.tsx | grep -E "delete|undefined|null"

# 4. 单测:method='lossy' + maxBytes=2MB → 必须 ≤ 2MB
npm run test:fast -- gif-optimize-routing
```

## 关联

- [R-04 four-phase-compression](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-04-four-phase-compression.md) — budget 分支内部仍按四阶段
- [R-05 soft-and-hard-target](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-05-soft-and-hard-target.md) — `maxBytes` / `softMaxBytes` 的双层语义
- [R-81 gif-optimize-knobs](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-81-gif-optimize-knobs.md) — 4 旋钮 ceiling vs lock 语义
- [R-83 toolbox-budget-ignores-minsize](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-83-toolbox-budget-ignores-minsize.md) — budget 分支内部底线
- [R-86 (toolbox-paramsByKind-sticky)](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-88-toolbox-paramsByKind-sticky.md)
  → 实际编号 [R-88](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-88-toolbox-paramsByKind-sticky.md)(R-86/R-87 已占用)
- [SC-25 chip-method-bypass](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-25-chip-method-bypass.md)

## 沉淀来源

- [src/main/processor.ts#L2625](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts#L2625) — 三分支选路
- [src/main/processor.ts#L2422](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts#L2422) — video-to-gif 同样进 budget 分支
- [src/renderer/components/ToolboxPanel.tsx#L446-L485](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/ToolboxPanel.tsx#L446-L485) — setMethod 清残留
- [src/main/ffmpeg.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/ffmpeg.ts) — `gifsicleMethod` 接 `optimizeLevel` / `dither`
