# SC-26 — Toolbox kind 切换丢 chip / "切走再切回 chip 不再高亮"

> **来源**:第 74 轮怒点。
> 用户在 `gif-optimize` 点了 chip「<2MB」,切到 `gif-resize` 看一眼,
> 切回 `gif-optimize` → chip 不再高亮,maxBytes 字段被默认值覆盖。
> **关联规则**:[R-88](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-88-toolbox-paramsByKind-sticky.md) / [R-COMPRESS-V1](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-COMPRESS-V1-six-quick-wins.md) / [R-TB-CHAIN](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-TB-CHAIN-toolbox-progressive-lineage.md)

---

## 现象

```text
[UI] click toolbox kind = gif-optimize
[UI] click chip "<2MB"            → params.maxBytes = 2_097_152
[UI] click toolbox kind = gif-resize  ← 用户只想瞄一眼参数
[UI] click toolbox kind = gif-optimize
[UI] chip 「<2MB」 不再高亮,params.maxBytes = undefined
[UI] 用户再次手动点 chip,以为是 UI 抖 → 实则被 default 覆盖
```

## 根因

修复前 `useToolbox.setKind(nextKind)` 是粗暴 reset:

```ts
// 错误的旧实现
const setKind = (k: ToolboxKind) => {
  setKindState(k);
  setParams(defaultParamsFor(k));   // ← 无视用户之前的修改
};
```

没有 per-kind sticky cache,切走的瞬间用户输入丢失;切回时只能从
`defaultParamsFor(kind)` 重建,跟"用户从来没设过 chip"一模一样。

## 修复

按 [R-88](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-88-toolbox-paramsByKind-sticky.md):

1. [useToolbox.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/useToolbox.ts)
   加 `paramsByKindRef = useRef<Partial<Record<ToolboxKind, ToolboxParams>>>({})`。
2. `setKind(nextKind)` 先查 cache:
   ```ts
   const cached = paramsByKindRef.current[nextKind];
   const next = cached ?? defaultParamsFor(nextKind);
   setParams(next);
   ```
3. `setParams(updater)` mirror 写回 cache。
4. `applyPreset(preset)` 完成后 mirror 写回 cache。
5. 至少 4 处 `paramsByKindRef` 引用(声明 1 + setKind 读 1 + setParams
   写 1 + applyPreset 写 1)。

## 回归脚本

**自动**:
```bash
# 1. paramsByKindRef 至少 4 处引用
[ $(grep -c "paramsByKindRef" src/renderer/components/useToolbox.ts) -ge 4 ] \
  && echo "OK" || echo "VIOLATION"

# 2. setKind 必须先查 cache
awk '/setKind\s*=/,/^  };/' src/renderer/components/useToolbox.ts \
  | grep "paramsByKindRef.current\[" || echo "VIOLATION"

# 3. setParams 同步镜像写
awk '/setParams\s*=/,/^  };/' src/renderer/components/useToolbox.ts \
  | grep -E "paramsByKindRef.current\[.*\]\s*=" || echo "VIOLATION"

# 4. e2e
npm run test:e2e:smoke -- toolbox-kind-switch
```

**手工**:
1. App 内拖入任意图片,toolbox 选 `gif-optimize`。
2. 点 chip「<2MB」→ chip 高亮。
3. 切到 `gif-resize`,确认 chip 区不渲染(因为 resize 没这个 chip)。
4. 切回 `gif-optimize` → chip「<2MB」**仍高亮**,无需再点。
5. 反向验:切到 `gif-resize`,改 `maxSide=400`,切到 `gif-optimize`
   看一眼,切回 `gif-resize` → `maxSide` 仍是 400(每个 kind 独立 sticky)。
6. 用 React DevTools 看 `paramsByKindRef.current` → 应是
   `{ 'gif-optimize': { maxBytes: 2097152, ... }, 'gif-resize':
   { maxSide: 400, ... } }`。

## 反向断言

- 不允许 `setKind` 内调 `setParams(defaultParamsFor(nextKind))` 而**不**
  先查 cache。
- 不允许 `setParams` 改 state 但不 mirror 写 `paramsByKindRef`。
- 不允许 `applyPreset` 跳过 mirror 写。
- 不允许把 cache key 改成 taskId / lineageId(sticky 维度必须是
  `ToolboxKind`)。
- 不允许在组件未卸载时清空 `paramsByKindRef`。

## 关联

- [R-88 toolbox-paramsByKind-sticky](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-88-toolbox-paramsByKind-sticky.md)
- [R-COMPRESS-V1 six-quick-wins](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-COMPRESS-V1-six-quick-wins.md) — "paramsByKind 隔离不许打破"
- [R-TB-CHAIN toolbox-progressive-lineage](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-TB-CHAIN-toolbox-progressive-lineage.md)
- [SC-23 budget-chip-must-converge](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-23-budget-chip-must-converge.md) — chip 已恢复后还要保证收敛
