# SC-23 — Budget chip 必须收敛 / "<2MB" 链式跑产物越来越大

> **来源**:第 74 轮怒点。用户在 toolbox 选 18.25MB 竖屏 mp4,点 chip
> 「<2MB」,反复跑链路,产物从 2.1MB → 2.4MB → 2.9MB,138% size-
> regression 警告刷屏,chip 承诺不兑现。ezgif 同一文件能压到 1.8MB。
> **关联规则**:[R-83](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-83-toolbox-budget-ignores-minsize.md) / [R-85](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-85-hasBudget-dominates-method-picker.md) / [R-04](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-04-four-phase-compression.md) / [R-08](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-08-progress-richness.md)

---

## 现象

```text
[toolbox] kind=gif-optimize chip=<2MB
  input  : portrait-1080x1920.mp4  18.25MB
  run #1 : portrait.gif            2.1MB   ⚠ size-regression 0% (vs input N/A)
  run #2 : portrait.gif            2.4MB   ⚠ size-regression 114%
  run #3 : portrait.gif            2.9MB   ⚠ size-regression 138%
  …chip 仍显示「<2MB」、用户被迫手动取消
```

主进程日志:
```
[compressLoop] Phase C: shortSide=450 → longSideFloor=800 (locked)
[compressLoop] Phase C: tried (800x1422, lossy=200, colors=8) → 2.4MB, exit
[compressLoop] WARN: outputBytes 2.4MB > prevBytes 2.1MB (regression)
```

## 根因

两个 bug 叠加:

1. **R-83 漏洞**:`toolboxBudgetCompress` 在 Phase C 计算
   `longSideFloor = round(DEFAULT_OPTIONS.minSize * ratio)`,DEFAULT
   minSize=450 + 竖屏 9:16 ratio → 长边底线 800,**永远算不出能命中
   2MB 字节预算的几何尺寸**(竖屏 800×1422 + 适度 lossy 仍是 2.4MB+)。
   循环把 lossy 推到上限后仍超 → exit → 比上一轮还大。
2. **R-83 漏洞#2**:即使检测到 size-regression,旧实现只 `emit warn`,
   **不 fsp.copyFile 回退原图**,导致链路下一步消费的是更大的产物,
   越压越大。
3. **R-85 漏洞**:三分支选路顺序错(`hasMethod > hasBudget`),用户
   在 chip 之后切了一下 method picker → maxBytes 被吞 → 走单 pass 分
   支,根本没进 budget loop。

## 修复

- [R-83](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-83-toolbox-budget-ignores-minsize.md):
  `toolboxBudgetCompress` 改用 `ABSOLUTE_MIN_SIDE=200`,绕开 minSize=450;
  size-regression 时 `fsp.copyFile(prevPath, outPath)` 回退 + emit
  `substep:'size-regression-reverted'` + `sizeRegression.reverted=true`。
- [R-85](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-85-hasBudget-dominates-method-picker.md):
  `gif-optimize` 三分支判定改为 `hasBudget > hasMethod > hasExplicit`。
- 渲染端 4 处(ToolboxLineageTreeView / ToolboxLineageProgress /
  ToolboxLineageModal / TaskTable)识别 `sizeRegression.reverted` 显示
  amber「自动回退」badge。

## 回归脚本(手工 + 自动两条腿)

**手工(真机)**:

1. 准备测试样本:18.25MB 竖屏 1080×1920 mp4(或参考 ezgif 用户案例
   样本),拖入 toolbox。
2. 选 `gif-optimize`,点 chip「<2MB」。
3. 跑 → 期望产物 **≤ 2MB**(典型 1.7~1.9MB)。
4. 再次跑同产物 → 若仍 ≤ 2MB,卡片不出 size-regression badge;若触底
   反弹,必须出 amber「自动回退」badge 且产物字节 = 上一轮字节(回退
   成功)。
5. 切到 `gif-resize` 看一眼,切回 `gif-optimize` → chip「<2MB」仍高亮
   (这是 [R-88](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-88-toolbox-paramsByKind-sticky.md) 的责任,顺手验)。

**自动**:

```bash
npm run test:fast -- toolboxBudgetCompress
npm run test:e2e:smoke -- budget-chip-converge
```

## 反向断言

- 不允许 chip「<2MB」点击后产物大于 maxBytes 且**没有** amber 「自动
  回退」badge(二者必居其一)。
- 不允许 size-regression 只 emit warn 不回退。
- 不允许在 toolbox budget 分支内读 `DEFAULT_OPTIONS.minSize`。

## 关联

- [R-83 toolbox-budget-ignores-minsize](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-83-toolbox-budget-ignores-minsize.md)
- [R-85 hasBudget-dominates-method-picker](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-85-hasBudget-dominates-method-picker.md)
- [R-04 four-phase-compression](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-04-four-phase-compression.md)
- [R-08 progress-richness](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-08-progress-richness.md)
