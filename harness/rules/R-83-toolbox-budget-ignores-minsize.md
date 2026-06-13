# R-83 — toolboxBudgetCompress 必须绕开 minSize=450 floor

**Status**: ratified · **Source**: 第 74 轮怒点
"toolbox 选了「<2MB」,反复跑链条产物越来越大,138% size-regression
警告;ezgif 同一文件能压到 1.8MB,我们压不下去"。

## 一句话

`toolboxBudgetCompress` 必须**绕开** `DEFAULT_OPTIONS.minSize=450` 的全局
short-side floor,改用 `ABSOLUTE_MIN_SIDE=200` 作短边下限;否则竖屏视频
/ 大尺寸图片在 Phase C 几何缩边阶段被 `longSideFloor = round(minSide *
ratio)` 锁死(竖屏 9:16 → 800),永远算不出能命中字节预算的尺寸,只
"shrink 一点点 → 还是超" 循环,最终 chip "<2MB" 不兑现承诺。

## 为什么

- `DEFAULT_OPTIONS.minSize=450` 是 R-25 为"通用单次压缩"设的体验下限
  (避免用户手滑把短边压到不可看)。
- toolbox 是**显式带字节预算**的二次/链式处理,用户已经接受"为了字节
  我愿意更小",不能继续把 450 当硬底线。
- 同时 R-04 Phase C 的 `longSideFloor` 是按短边 × 长宽比算的:短边
  450 + 9:16 ratio → 长边底线 800px;原视频 1080×1920 在 Phase C 只能
  收到 800×1422,远不到字节预算所需的几何缩量。
- 之前 size-regression 只 emit warn,不 fsp.copyFile 回退原图,导致链
  式跑下来"越压越大"。

## 禁止(反向清单)

- ❌ 在 [src/main/processor.ts#L801-L1049](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts#L801-L1049)
  `toolboxBudgetCompress` 内 `import` 或读取 `DEFAULT_OPTIONS.minSize`
  / `DEFAULT_OPTIONS.longSideFloor`。
- ❌ 把 `ABSOLUTE_MIN_SIDE` 抬高到 ≥ 450(失去本规则意义)。
- ❌ 删除 size-regression 检测分支;删除 `fsp.copyFile` 回退原图分支;
  把 `sizeRegression.reverted` 改回可选 `undefined`。
- ❌ 让 toolboxBudgetCompress 失败时**静默**不 emit `substep:'size-
  regression-reverted'`(用户必须看到 amber「自动回退」badge,R-08)。
- ❌ 把"shrink until it fits"(ezgif-style)循环改成只做一次 pass 就
  return —— budget 分支必须迭代,直到 ≤ maxBytes 或触及 ABSOLUTE_MIN_SIDE。

## 正面要求

1. `ABSOLUTE_MIN_SIDE=200` 作为 module-level 常量定义在
   [src/main/processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts)
   `toolboxBudgetCompress` 同文件顶部,**不**走 DEFAULT_OPTIONS。
2. 每一轮缩边后必须比较产物 size vs 上一轮 size,若 **size 增加且超
   出 maxBytes** → 立刻 `fsp.copyFile(prevPath, outPath)` 回退,emit:
   ```ts
   { substep: 'size-regression-reverted',
     sizeRegression: { reverted: true, fromBytes, toBytes, ratio } }
   ```
   并提前结束循环,不再继续 shrink。
3. `TaskProgress.sizeRegression.reverted?: boolean` 字段必须保留
   ([src/shared/types/process.ts:204](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types/process.ts));
   渲染端 4 处(ToolboxLineageTreeView / ToolboxLineageProgress /
   ToolboxLineageModal / TaskTable)识别该字段并展示 amber「自动回退」
   badge。
4. 触底兜底:迭代到短边 ≤ `ABSOLUTE_MIN_SIDE` 仍超 maxBytes → 返回最
   后一次产物 + emit `substep:'budget-floor-hit'`,不再 shrink,不
   throw(让上层链路继续展示卡片而非 fail)。

## 验证脚本(SOP §5 强制)

```bash
# 1. ABSOLUTE_MIN_SIDE 常量存在且 = 200
grep -nE "ABSOLUTE_MIN_SIDE\s*=\s*200" src/main/processor.ts

# 2. budget 分支不读 DEFAULT_OPTIONS.minSize
awk '/function toolboxBudgetCompress/,/^}/' src/main/processor.ts \
  | grep -E "DEFAULT_OPTIONS\.(minSize|longSideFloor)" && echo "VIOLATION" || echo "OK"

# 3. size-regression-reverted substep 必须 emit
grep -n "size-regression-reverted" src/main/processor.ts

# 4. sizeRegression.reverted 字段在 shared types
grep -n "reverted" src/shared/types/process.ts

# 5. 渲染端 4 处都识别 reverted
grep -rn "reverted" src/renderer/components/{ToolboxLineageTreeView,ToolboxLineageProgress,ToolboxLineageModal,TaskTable}.tsx
```

## 关联

- [R-04 four-phase-compression](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-04-four-phase-compression.md) — 本规则是 Phase C `longSideFloor` 的 toolbox 例外
- [R-06 shortside-floor](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-06-shortside-floor.md) — `AspectRatioConstraintError` 早 fail 仍生效,但触发点改为 ABSOLUTE_MIN_SIDE
- [R-08 progress-richness](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-08-progress-richness.md) — `substep:'size-regression-reverted'` 是必须字段
- [R-25 ux-signals-and-defaults](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-25-ux-signals-and-defaults.md) — `minSize=450` 仍是通用 default
- [R-85 hasBudget-dominates-method-picker](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-85-hasBudget-dominates-method-picker.md) — 决定何时进入本规则覆盖的 budget 分支
- [SC-23 budget-chip-must-converge](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-23-budget-chip-must-converge.md)

## 沉淀来源

- [src/main/processor.ts#L801-L1049](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts#L801-L1049) — `toolboxBudgetCompress`
- [src/main/processor.ts#L2422](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts#L2422) — video-to-gif 带 maxBytes 时也走本函数
- [src/main/processor.ts#L2625](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts#L2625) — gif-optimize 三分支 hasBudget 选路
- [src/shared/types/process.ts#L204](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types/process.ts#L204) — `sizeRegression.reverted?: boolean`
