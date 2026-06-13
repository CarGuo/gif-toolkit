# SC-25 — Chip + method picker 互斥 bug / chip 被 method 截胡

> **来源**:第 74 轮怒点。
> 用户先点 chip「<2MB」,再在 method picker 选 `lossy`,产物 3.2MB,
> chip 完全失效。
> **关联规则**:[R-85](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-85-hasBudget-dominates-method-picker.md) / [R-83](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-83-toolbox-budget-ignores-minsize.md) / [R-COMPRESS-V1](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-COMPRESS-V1-six-quick-wins.md)

---

## 现象

```text
[UI] click chip "<2MB"           → params.maxBytes = 2_097_152
[UI] click method picker "lossy" → params.method   = 'lossy'
[UI] click Run                   → 派发 IPC process:start
[main] gif-optimize routing:
       hasMethod=true → goMethod()  ← 修复前命中 method 单 pass 分支
       hasBudget 被忽略
[main] gifsicle --lossy=80 -O3 → output 3.2MB
[UI] chip 仍显示「<2MB」高亮,但产物 3.2MB,用户被欺骗
```

## 根因

修复前 `gif-optimize` 主入口三分支判定顺序是
`hasMethod > hasBudget > hasExplicit`。

```ts
// 错误的旧实现
if (hasMethod)   return goMethod(opts);       // ← 截胡
if (hasBudget)   return goBudget(opts);
if (hasExplicit) return goExplicit(opts);
```

用户的 `maxBytes` 表态比 method 偏好"强",但被弱表态截胡 → chip 被吞。

## 修复

按 [R-85](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-85-hasBudget-dominates-method-picker.md):

1. [src/main/processor.ts#L2625](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts#L2625)
   分支顺序改为 `hasBudget > hasMethod > hasExplicit > fallthrough`。
2. `goBudget` 内部允许把 `method` / `lossy` / `colors` 作为初始种子
   传入 `toolboxBudgetCompress`,但循环条件仍由字节预算驱动。
3. [src/renderer/components/ToolboxPanel.tsx#L446-L485](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/ToolboxPanel.tsx#L446-L485)
   `setMethod` 切 method 时仅清"上一种 method 独有的残留字段"
   (如从 lossy 切到 gifski 时清 `lossy`),`maxBytes` / `softMaxBytes` /
   `maxSide` 等目标类参数完整保留。
4. [src/main/processor.ts#L2422](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts#L2422)
   video-to-gif 路径若用户设了 `maxBytes` 同样走 `toolboxBudgetCompress`,
   不允许 single-pass palette → gif → return。

## 回归脚本

**自动**:
```bash
# 1. 分支顺序正确
grep -n "goBudget\|hasBudget\|hasMethod" src/main/processor.ts | head -20

# 2. 单测覆盖:method='lossy' + maxBytes=2MB → 必须 ≤ 2MB
npm run test:fast -- gif-optimize-routing

# 3. setMethod 清残留逻辑保留
sed -n '446,485p' src/renderer/components/ToolboxPanel.tsx
```

**手工**:
1. App 内拖入一张 5MB 大尺寸 gif。
2. toolbox 选 `gif-optimize`,点 chip「<2MB」。
3. 在 method picker 选 `lossy`(或 `gifski`)。
4. 点 Run → 期望产物 **≤ 2MB**,且日志含 `[budget]` 而非 `[method]`
   开头。
5. 反向验:取消 chip(maxBytes 清空),只选 method=lossy → 产物字节
   自由,但走的是 `goMethod` 分支(日志验证)。

## 反向断言

- 不允许 chip + method 同时存在时走 `goMethod` 分支。
- 不允许 `setMethod` 切换时清掉 `maxBytes` / `softMaxBytes` / `maxSide`。
- 不允许把 `hasBudget` 检测改为 `maxBytes < threshold` 之类的软门槛
  (只要 `maxBytes` 是有限正数就算 hasBudget)。
- 不允许 UI 在选了 method 后把 chip 高亮取消(那是欺骗用户)。

## 关联

- [R-85 hasBudget-dominates-method-picker](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-85-hasBudget-dominates-method-picker.md)
- [R-83 toolbox-budget-ignores-minsize](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-83-toolbox-budget-ignores-minsize.md)
- [R-COMPRESS-V1 six-quick-wins](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-COMPRESS-V1-six-quick-wins.md) — 目标体积 chip / engine 切换互斥的姊妹规则
- [SC-23 budget-chip-must-converge](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-23-budget-chip-must-converge.md)
