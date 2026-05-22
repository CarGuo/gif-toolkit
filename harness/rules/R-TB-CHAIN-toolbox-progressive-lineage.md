# R-TB-CHAIN — Toolbox progressive lineage（工具箱渐进式链路）

**Status**: ratified · **Source**: 第 92+ 轮用户原话
> "你功能还是做错了，批量模式还是之前。单图链路模式，是你可以基于结果一直处理，比如处理了 Video to Gif，得到的结果，可以继续进行 gif resize，gif opt 等等，用户可以快捷选择下一步链路继续。"

## 一句话

工具箱里"基于刚才的产物继续处理"的真实模型是 **渐进式 1-step 链路**——不是预先配 N 步再一把跑——
渲染端按"焦点产物 + 线性面包屑"组织 UI，每一步实际是一次单步 `startToolboxChain` IPC，
继续复用 Phase 1 IPC 契约（取消 / 历史 / outputs[]）。

## 实现位置

- [src/renderer/components/useToolboxLineage.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/useToolboxLineage.ts)
  - `LineageNode = { nodeId, path, kind, params, chainId }`，root 节点 kind=null。
  - `runNextStep(kind, params)` → 单步 chain（`steps:[{id:`${chainId}-s1`}]`）；
    监听全局 `process:progress`，taskId **精确等值** `${chainId}-s1` 匹配 done/failed/cancelled。
  - `cancel()` 入口先快照清空 `pendingRef` / `inflightChainIdRef` 再 `await` IPC，
    避免「await 期间 done 先到把节点追加上」的竞态。
  - `reset(inputPath)` 若仍有 in-flight，fire-and-forget `cancelToolboxChain` 防止幽灵任务。
  - `nextKindOptions = useMemo([focus])`，按 focus 路径扩展名查 `TOOLBOX_INPUT_EXTENSIONS`
    过滤可选下一步 kind。
- [src/renderer/components/ToolboxPanel.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/ToolboxPanel.tsx)
  - `<section class="tb-lineage">` 与批量 UI 互斥；`isLineageActive && !lineageDormant` 决定切换。
  - 历史区每条 done 行 `<button class="tb-history-continue">继续处理 →</button>`，
    `disabled={lineage.isRunning}` 防 in-flight 重入。
  - `handleEnterLineageFromHistory`：in-flight 时先 `await lineage.cancel()` 再 reset。
  - `handleExitLineage`：捕获 `lineageExitEpochRef` 在 `await cancel()` 后比对，
    防止 await 期间用户从历史重新进入又被 dormant 覆盖。
  - 焦点默认 chip effect 依赖 **focus.path 字符串**（非数组引用），
    避免 `nextKindOptions` 数组身份变化清空用户编辑过的 ParamForm。
  - Crop 在链路模式直接复用批量的 `<CropForm>`，把 cropX/Y/W/H 写进 draft params；
    **不**走 awaiting-input 暂停模型。
- [src/preload/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/index.ts)
  Phase 1 已暴露的 `startToolboxChain` / `cancelToolboxChain` / `onProgress`
  保持原契约不动。

## 不变量

1. **每步 1-step**：lineage 永远以 `steps.length === 1` 调链路运行器，
   不构造 N-step pre-config 计划。
2. **chainId 唯一前缀**：`tblineage-<base36ts>-<rand>`；
   listener 用精确等值 `taskId === ${chainId}-s1` 过滤，不用 `startsWith`。
3. **取消优先**：reset / enter-from-history / exit-chain 三处入口
   在有 in-flight 时必须先 cancel（fire-and-forget 或 await）；
   否则后端会留下幽灵 chain 与孤儿产物。
4. **下一步过滤**：`deriveNextKinds(focusPath)` 只允许产物扩展名命中
   `TOOLBOX_INPUT_EXTENSIONS[kind]` 的 kind，UI 不渲染不兼容 chip。
5. **批量 UI 与链路 UI 互斥**：通过 ternary 切换；不允许两套同时挂载
   （e2e 用 `footer.tb-footer button.primary[name=开始]` 应不存在做断言）。

## 红线（NEVER）

- 不准在 lineage 模式恢复 awaiting-input/resumeChain crop 暂停模型。
- 不准把 `nextKindOptions` 数组引用做为 effect dep
  （会清空用户填好的 params；用 focus path 字符串）。
- 不准在 cancel/await 之后无条件 setState；必须 epoch / 快照 ref 守卫。
- 不准修改 `shared/types/toolbox.ts` 的输入扩展名映射来"通过过滤"——
  应改 lineage 渲染逻辑或新增 kind。

## 验收

- 单测：[tests/renderer/useToolboxLineage.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/renderer/useToolboxLineage.test.ts)（12 用例：reset / focus / branch / cancel / running guard / next-kind filter）。
- 集成：[tests/renderer/ToolboxPanel.test.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/tests/renderer/ToolboxPanel.test.tsx) 「lineage (R-TB-CHAIN-V2)」 8 用例
  （继续处理 → 渲染 / chip 过滤 / 单步 chain payload / done emit 推进面包屑 / 退出链路）。
- e2e：[tests/e2e/realPipeline/suite-toolbox-chain.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/e2e/realPipeline/suite-toolbox-chain.ts)
  - SUITE TB-CHAIN-A/B/C/D — Phase 1 IPC oracle
  - SUITE TB-CHAIN-E — UI 真跑：history → 继续处理 → GIF Resize → 2 节点面包屑 → ffprobe 校验产物
- 三道闸：typecheck / lint / vitest 786+ 用例 / playwright 30+ 用例 全绿。
