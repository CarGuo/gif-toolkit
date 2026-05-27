# R-TRIM-CROP-SINGLE — Trim 与 Crop 必须单文件处理 + 队列内可选目标

## 一句话

Toolbox 里的 **Trim** 与 **Crop** 是"单文件参数"工具(单个 `startSec/endSec` 区间或单个 `cropX/cropY/cropW/cropH` 矩形,跨文件没有意义)。所以这两个 `kind` 必须满足:**多文件可入队、aside 加文件单选器、`start()` 只派发当前选中的那一个、其余文件原封不动留在队列**。

## 为什么(踩过的坑)

- 早期 Crop 在 footer 直接挂"Crop 仅支持单文件,请删除其余文件后再处理"——用户想批量裁也只能反复"删队列 / 加一个 / 跑一次"。
- Trim 在 R-TRIM-FRAMESTRIP 落地后帧条只对接 `tb.jobs[0]`,如果用户加了多个文件,后面的帧条参数就是错位的。
- 直接退化成"Trim/Crop 限制 1 个文件"会让用户把这两个工具排除在批处理工作流之外,失去价值。
- 折中是显式承认这两个 `kind` 是单文件操作,但**通过 UI 单选**让用户在多文件队列里逐个选择目标。

## 强制条款

1. **状态层**(useToolbox 层):
   - 必须在 `UseToolboxResult` 暴露 `selectedJobId: string | null` + `selectJob(id: string | null): void`。
   - 必须维护一个 effect:`kind === 'trim' || 'crop'` 且 `jobs.length > 0` 时 auto-pin `jobs[0].id`;选中行被移除时切到新 `jobs[0]`;`jobs.length === 0` 时设 `null`。
   - **不许**在切到非 trim/crop 的 kind 时清空 `selectedJobId`(允许"切走再切回保留焦点")。
   - `selectJob(id)` 必须用 `jobsRef.current.some(j => j.id === id)` 校验,过期点击不能让面板进入"选了一个不存在的行"的状态。

2. **`start()` 派发**:
   - `kind === 'trim' || kind === 'crop'` 时,payload **必须**只包含 `jobs.find(j => j.id === selectedJobId) ?? jobs[0]` 这一条。
   - 其余 `kind`(`video-to-gif` / `resize` / `optimize` / ...)保持现有"全部派发"语义不变。
   - 派发完不许把其余行从 `jobs` 里出队——只有那一条选中行走完处理后会被 history-migration 自然移走。

3. **UI 层**(ToolboxPanel,v2 — 2026-05-27 后):
   - **入口位置**:文件单选必须做在**队列 item 行内**(`.tb-job-row.is-pickable` + radio dot + 整行可点击 + `is-selected` 高亮),**不许**再放回 aside 顶部 picker 列表(`.tb-side-picker` 已废弃)。理由:用户已经在左侧队列扫文件,要选目标就在那个上下文里完成;aside 应专注参数表单。
   - **aside 行为**:仅在 `jobs.length > 1` 时显示一行 `.tb-side-pick-hint`(muted 文案"在左侧队列点击行即可切换"),≤1 文件时不渲染任何提示(无布局跳变,因为提示是单行 padding-bottom 12px,有/无差异肉眼可忽略)。
   - **a11y 要求**:`.tb-job-row.is-pickable` 必须有 `role="radio"` + `aria-checked` + `tabIndex=0` + Space/Enter 键盘选中。
   - **冒泡防御**:`.tb-job-remove` 的 onClick 必须 `e.stopPropagation()`,否则点 × 会先选中再删除当前行,体验异常。
   - `previewPath` / `mediaInfo` / TrimFrameStrip 的 `inputPath` / CropForm 的 `inputPath` 在这两个 `kind` 下**必须**从 `selectedJob` 派生,而**不是** `jobs[0]`。其他 `kind` 维持 `jobs[0]` 行为。
   - footer **不许**再出现"Crop 仅支持单文件请删除其余"这种命令式提示;改成 muted hint:"Crop / Trim 每次处理一个,其余文件保留在队列里"。
   - `cropBlocked` 的判定**必须**改成 `!selectedJob` 而不是 `tb.jobs.length !== 1`(否则多文件队列下永远 disable)。

5. **布局层**(2026-05-27 v2):
   - panel 内层从 `.tb-body`(grid 1fr/320px,只包 jobs+aside)升级为 `.tb-content`(grid 1fr/320px,col1 = `.tb-main`,col2 = aside)。
   - `.tb-main` 必须按 `jobs → footer → history` 三段堆叠,使 aside 在 col2 自然 stretch 贯通整列(`align-self: stretch`)。
   - **不许**把 footer / history 留在 .tb-content 之外(会让 history 行占满 panel 宽度、压缩主区域,且 aside 上短下空)。

6. **测试约束**:
   - useToolbox 的 selectedJobId 行为(auto-pin / 移除时切首个 / start 只派发 1 条)必须有单元测试覆盖。
   - Trim/Crop 的 footer 不许再 assert "Crop 仅支持单文件"字样;原断言要被替换或删除。

## 反向清单(违反即 PR block)

- ❌ 退化"Trim/Crop 限 1 个文件,多了就 throw"
- ❌ 切到非 trim/crop 后就清 `selectedJobId`(导致用户切回 Trim 焦点丢失)
- ❌ `start()` 在 trim/crop 下还派发整队(后续行的 startSec/endSec/cropRect 会被错误共用)
- ❌ TrimFrameStrip / CropForm 还接 `tb.jobs[0]?.inputPath`(必须接 selectedJob)
- ❌ 把文件单选 UI 放回 aside(`.tb-side-picker` 已废弃,选择器必须在队列行内)
- ❌ 选择器用 path 当 key 而不是 id(同 path 入队两次会混淆)
- ❌ `.tb-job-row.is-pickable` 漏掉 a11y(role/aria-checked/tabIndex/键盘选中)
- ❌ `.tb-job-remove` 不 stopPropagation,导致点 × 同时触发选中

## 验证步骤

```bash
npm run typecheck       # selectedJobId / selectJob 接口暴露
npm run lint            # useToolbox.ts 不超 600 行(max-lines)
npm run test:fast       # 含 useToolbox 单元 + ToolboxPanel 集成
npm run build
npm start               # 手动 smoke:Trim 加两个 GIF,选第二个,跑一次,只第二个被处理
```

## 关联

- 原始批处理约束:[R-23](./R-23-batch-confirm-modal.md)、[R-25](./R-25-ux-signals-and-defaults.md)
- 帧条:[R-TRIM-FRAMESTRIP](./R-TRIM-FRAMESTRIP-thumbnail-range-selector.md)
- paramsByKind 隔离:[R-COMPRESS-V1](./R-COMPRESS-V1-six-quick-wins.md)#1
