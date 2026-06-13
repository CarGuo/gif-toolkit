# R-88 — useToolbox.setKind 必须 per-kind sticky

**Status**: ratified · **Source**: 第 74 轮怒点
"chip「<2MB」点击后,切去 gif-resize 看一眼又切回 gif-optimize,
chip 不再高亮了,字节预算被吞了"。

> 编号说明:本规则原计划占 R-86,因 R-86(tray-and-shortcuts)/
> R-87(tmp-cleanup-guardrails)已先占用,顺位后挪至 R-88。

## 一句话

`useToolbox.setKind(nextKind)` 在切换 kind 时,**必须先查 per-kind
sticky cache (`paramsByKindRef`)** 还原用户上次在该 kind 留下的参数,
而不是每次都 fallback `defaultParamsFor(kind)`;切走再切回时 chip 高
亮 / lossy 旋钮 / maxSide 必须**完整恢复**。

## 为什么

- 用户的心智模型:「我在 gif-optimize 设的 chip,切到其他 kind 看一
  下,切回来还是我的设置」。这是任何带 tab 的工具普遍预期。
- 修复前的 `setKind` 实现是 `setParams(defaultParamsFor(kind))`,把用
  户的所有定制粗暴抹平,导致**切走即丢**。
- 这个 bug 与 [R-COMPRESS-V1](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-COMPRESS-V1-six-quick-wins.md)
  "paramsByKind 隔离不许打破"是同一根:用户在每个 kind 的参数命名空
  间是独立的;隔离 + 持久化两件事必须同时做。

## 禁止(反向清单)

- ❌ 删除 [useToolbox.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/useToolbox.ts)
  内 `paramsByKindRef`(`useRef<Record<ToolboxKind, ToolboxParams>>`)。
- ❌ `setParams(next)` 内**不**同步写回 `paramsByKindRef.current[kind]
  = next`(写不回去等于没缓存)。
- ❌ `applyPreset(preset)` 完成后**不**同步写回 cache(用户应用预设
  也是一种 sticky 输入,必须落 cache)。
- ❌ 让 `setKind` 在切换时跑 `setParams(defaultParamsFor(nextKind))`
  而**不**先查 `paramsByKindRef.current[nextKind]`。
- ❌ 把 cache key 改成 taskId / lineageId 等"瞬时身份" —— sticky 必
  须按 `ToolboxKind` 维度,不能跟着任务流走。
- ❌ 在卸载组件 / 切根 tab 时清空 `paramsByKindRef`(那会让用户回到
  toolbox 再次丢失;持久化范围至少是组件生命周期内)。

## 正面要求

1. [useToolbox.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/useToolbox.ts)
   顶部:
   ```ts
   const paramsByKindRef = useRef<Partial<Record<ToolboxKind, ToolboxParams>>>({});
   ```
2. `setKind(nextKind)`:
   ```ts
   const cached = paramsByKindRef.current[nextKind];
   const next = cached ?? defaultParamsFor(nextKind);
   setParams(next);
   setKindState(nextKind);
   ```
3. `setParams(updater)` 必须在 state 更新的同一 tick 内 mirror 写:
   ```ts
   const next = typeof updater === 'function' ? updater(params) : updater;
   paramsByKindRef.current[kind] = next;
   setParamsState(next);
   ```
4. `applyPreset(preset)` 完成后:
   ```ts
   const merged = mergePresetIntoParams(params, preset);
   paramsByKindRef.current[kind] = merged;
   setParamsState(merged);
   ```
5. 至少**4 处** `paramsByKindRef` 引用:声明 1 + setKind 读 1 +
   setParams 写 1 + applyPreset 写 1 = 4。

## 验证脚本(SOP §5 强制)

```bash
# 1. paramsByKindRef 至少 4 处引用
grep -nc "paramsByKindRef" src/renderer/components/useToolbox.ts
# 期望:>=4

# 2. setKind 必须先查 cache
awk '/setKind\s*=/,/^  };/' src/renderer/components/useToolbox.ts \
  | grep -E "paramsByKindRef\.current\[" || echo "VIOLATION"

# 3. setParams 同步镜像写
awk '/setParams\s*=/,/^  };/' src/renderer/components/useToolbox.ts \
  | grep -E "paramsByKindRef\.current\[.*\]\s*=" || echo "VIOLATION"

# 4. e2e 复演:切走切回 chip 仍高亮
npm run test:e2e:smoke -- toolbox-kind-switch
```

## 关联

- [R-COMPRESS-V1 six-quick-wins](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-COMPRESS-V1-six-quick-wins.md)
  — "paramsByKind 隔离不许打破" 的姊妹规则,本规则补"隔离 + 持久化"
- [R-TB-CHAIN toolbox-progressive-lineage](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-TB-CHAIN-toolbox-progressive-lineage.md)
  — toolbox 链式 UI 的总规则
- [R-83 toolbox-budget-ignores-minsize](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-83-toolbox-budget-ignores-minsize.md) — budget 落地路径
- [R-85 hasBudget-dominates-method-picker](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-85-hasBudget-dominates-method-picker.md) — chip 状态进入后端的判定
- [SC-26 toolbox-kind-switch-loses-chip](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-26-toolbox-kind-switch-loses-chip.md)

## 沉淀来源

- [src/renderer/components/useToolbox.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/useToolbox.ts) — `paramsByKindRef` 实现
- [src/renderer/components/ToolboxPanel.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/ToolboxPanel.tsx) — `setMethod` / `setKind` 调用点
