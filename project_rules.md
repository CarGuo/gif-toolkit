# Project Rules — gif-toolkit

> 本文是开发约束的"硬规则"汇总。每次开工前必读 5 分钟，避免重蹈
> [App.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/App.tsx)
> 一度膨胀到 2098 行的覆辙。

最后更新：2026-05-23

---

## 1. 文件大小硬阈值

| 阈值 | 触发动作 |
|---|---|
| 单 .ts / .tsx **> 600 行** | ESLint warn（[.eslintrc](file:///Users/guoshuyu/workspace/gif-toolkit/.eslintrc) `max-lines: ['warn', 600]`），CI 不会卡，但代码评审必须解释。 |
| 单 .ts / .tsx **> 1000 行** | 视为违规。必须先拆分再补功能；除非显式 `eslint-disable max-lines` 加完整理由注释（≥ 3 行说明为何无法拆）。 |

**反面教材**：
- [App.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/App.tsx) 历史最高 2098 行；现已通过多个 hook + view 拆到 ~1465 行（在 R-WS-90 全套 workspace 多 tab 落地后稳定在该量级）。
- 拆分历史见 [src/renderer/views](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/views) 目录每个文件头注释的「Step 10 阶段 X」说明。

**显式豁免（已审计 / 不再追问）**：
- [src/main/processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) ≈ **3200 行** —— 真实业务复杂度（4-Phase 压缩 × R-43.2 per-task cancel × R-20 retry-while-draining × R-79 hard-target warning × toolbox 多入口共享 PQueue/activeAborts/taskAborts singleton），**不是设计债**。详见 §7「何时不该拆」的逐块复盘。每次想动它前，必须先通读 §7。

## 2. 拆分思路（按优先级）

碰到大文件时，按以下顺序找拆分点：

1. **副作用 → hook**：`useEffect`/`useState` 簇是复用资产。先看 [src/renderer/components](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components) 已有 `useXxx.ts` 名单，避免重复造轮子。
2. **JSX 子树 → view**：连续 ≥ 30 行的 JSX 块且 props 数 ≤ 30 个时，抽到 [src/renderer/views](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/views)。
3. **byte-equivalent**：拆出来的 view 必须保留原 className、aria-*、内联 style、行内注释 1:1，避免 e2e 选择器漂移（参考 SUITE E/I/J/L/M/N/O 都依赖 `.fab-start-batch`）。
4. **不可拆**：纯类型 / 纯常量 / 纯工具 不强制拆。

## 3. 测试覆盖原则（HL 启发式）

- **真实链路 e2e** 是 source of truth。任何 IPC 路径必须有一条
  [tests/e2e/realPipeline.spec.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/e2e/realPipeline.spec.ts)
  下的 SUITE 覆盖，**严禁** `page.evaluate(window.giftk.*)` 绕过 UI（仅二次优化等无 UI 入口可破例）。
- **三类 oracle**：
  - 量化：SUITE O — `second.size <= first.size × 0.95`
  - 过程：SUITE J — `progress.substep == 'compress'` 事件级
  - 反向：SUITE Q — `skipCompress=true` 故意把 maxBytes 设极低，断言产物显著大于 maxBytes
- **HL 弱单调**：当严格断言被 fixture 限制击穿时，**降到弱单调不变量**而不是删测试。SUITE R 即此例：
  原 `lossy200 ≤ lossy0 × 0.95` → 新 `lossy200 ≤ lossy0`，并在 comment 沉淀「fixture 极简下 lossy 维度不可观测」契约。
- **三道闸**：每次 commit 前必须 `npm run typecheck && npm run lint && npm run test:fast && npm run build` 全绿；改了 IPC / uploader / processor / preload / db schema 必须额外跑 `npm run test:e2e:smoke`；发版前 `npm run test:e2e` 全量回归。三档定义见 [run-harness.md §2](file:///Users/guoshuyu/workspace/gif-toolkit/harness/run-harness.md)。

## 4. Workspace 模型不变量（2026-05-21 确立）

详见 [useWorkspaces.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/useWorkspaces.ts)。

- **Workspace 由嗅探产生**：仅 [claimForSniff()](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/useWorkspaces.ts#L286-L295) 是合法的创建入口。UI 不暴露 `+` 新建按钮（[WorkspaceTabs](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/WorkspaceTabs.tsx) 的 `onNewTab` 不传即不渲染）。
- **复用 blank tab**：[isBlank](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/useWorkspaces.ts#L137-L138) 的 tab 在下次嗅探时被复用（`result==null && !sniffing`）。R-WS-2026-05-21：`url` 不参与 blank 判定——填 URL 但还没嗅探只是"待发起"中间态，必须复用当前 tab。
- **关闭 = 弹出**：关闭 tab 仅从内存数组移除；底层 HistoryRecord 仍在 SQLite，可通过 历史 面板恢复。
- **永远 ≥ 1 tab**：[close()](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/useWorkspaces.ts#L244-L284) 关掉最后一个时自动重置为 blank tab。
- **空间布局**：tabs 落在 `.right` 内顶部（[MediaGridPane.tabs prop](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/views/MediaGridPane.tsx#L62-L70)），与「已选媒体 + 处理进度」一起。切换 tab 时左栏（嗅探 URL / OptionsForm）通过 `ws.activeWs` 数据绑定自动跟进。**禁止**把 tabs 横跨整窗顶部或仅放左栏。
- **busy 检测**：[isBusy()](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/useWorkspaces.ts#L141-L154) 唯一判定—— `processingOne` 非空 或 任一 progress.status ∉ {done, failed, skipped, cancelled}。关闭 busy tab 必须 window.confirm。

## 5. IPC 契约不变量

- `g.startBatch(tasks: ProcessTask[], pageTitle?, outputDirOverride?, sessionId?)` —— **位置参数**，非对象包装。
- `g.cancelTask(taskId)` —— R-43.2 单任务 cancel；DEFAULT_CONCURRENCY = 3。
- `g.reoptimizeFromGifPath` / `skipCompress` —— manual 二次优化 / 跳过压缩循环。
- `ProcessTask.options`：`lossyCeiling: 0..200` / `colorsFloor: 2..256` / `optimizeLevel: 1..3` / `dither: floyd-steinberg|ordered|none` / `forceAllowSmallSide` / `reoptimizeFromGifPath` / `skipCompress`。

## 6. 当一个新需求来时…

按以下顺序自检：

1. 这个改动会不会让某个文件 > 600 行？→ 先想拆分
2. 有没有现成的 hook / view / util 能直接拼？→ 先看 [src/renderer/components](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components) 和 [src/renderer/views](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/views)
3. 真实链路 e2e 怎么覆盖？→ 翻 [realPipeline.spec.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/e2e/realPipeline.spec.ts) 的 SUITE 命名表，找最像的样板
4. 三道闸都会绿吗？→ 提交前在本机 `npm run typecheck && npm run lint && npm run test:fast && npm run build`，改了链路相关再加 `npm run test:e2e:smoke`

---

## 7. 何时不该拆 —— processor.ts 真实业务复杂度豁免（2026-05-21 确立）

> **核心原则：文件长 ≠ 设计差。该拆的才拆，不为拆而拆。**
> 触发本节的场景：当 §1 的行数阈值与「拆出去会损耦合」发生冲突时，本节决定哪个赢。

### 7.1 拆分必要性的判定流程（先做这五步，再决定动不动刀）

对任何「想拆某个 > 1000 行文件」的提议，按顺序自问：

| # | 判据 | 不通过 → 不拆 |
|---|---|---|
| 1 | 拟拆出的模块**对外只有 1 个 caller** 吗？ | 是 → 拆出去 = 增加 import 跳转 + 不降低耦合，**不拆** |
| 2 | 拟拆出的模块是**纯函数 / 纯类型 / 纯常量**吗？ | 否（含 mutable singleton / 内部抛接的 error class）→ **不拆** |
| 3 | 拟拆出的模块**与原文件共享 module-level 可变状态**（PQueue / Map / Set）吗？ | 是 → 拆到独立模块仍是 singleton，但 cross-module mutable state 比 same-file 更难追踪不变量，**不拆** |
| 4 | 拟拆出的模块**有独立的测试入口**（i.e. 单测能直接 import 它而不需要 mock 父模块）吗？ | 否 → 拆出去无测试增益，**不拆** |
| 5 | 拟拆出的模块的**接口面**（参数 / 返回类型）能在 5 行内说清吗？ | 否（要 8+ 个参数才能传完上下文）→ 它是连续叙事的一段，**不拆** |

**全 5 项通过才算"该拆"。** 任何一项不通过 + 强行拆 = **以文件数代替设计**，违反 §7 原则。

### 7.2 processor.ts（≈ 2626 行）的逐块复盘 —— 反面教材

下面是 2026-05-21 那一轮"为拆而拆"提议的诚实复盘。**这些块都被判定不该拆**，固化为教材：

| 拟拆出的模块 | 行数 | §7.1 哪一项失败 | 真实原因 |
|---|---|---|---|
| `errors.ts`（[CancelledError](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) / [AspectRatioConstraintError](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts)） | ~30 | #1, #2 | 只在 processor 内部抛接；跨边界仅靠 `TaskProgress.errorCode` **字符串**。拆出去 = 多 1 个 import 跳转、零耦合改善 |
| `queueState.ts`（PQueue / activeAborts / taskAborts / activeBatchPromises） | ~120 | #3 | 5 处 caller 共享的 module singleton。**拆出去仍是 singleton**，但 cross-module mutable state 比 same-file 更难追踪 R-43.2 / R-20 不变量 |
| `compressLoop.ts`（4-Phase 主循环） | ~500 | #2, #5 | 真正的纯计算（[compressCacheKey](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor-utils.ts) / [chooseCompressionTargetMB](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor-utils.ts)）**早就抽到 [processor-utils.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor-utils.ts)** 并配 [tests/main/processor-utils.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/processor-utils.test.ts) 单测。剩下的 Phase A→D 是连续叙事 |
| `processOneTask.ts`（单 task 完整流水线） | ~830 | #1, #5 | 单 task 流水线 = download → ffmpeg → compressLoop → emit，**一个 caller**，连续叙事。拆出去文件数 +1，认知负担没下降 |
| `toolbox.ts`（10 个工具入口） | ~720 | #3 | 边界相对独立，**唯一勉强可拆的**，但与 PQueue/activeAborts/sniff-batch 强绑定，拆出去要么暴露 module state、要么走 DI。**得不偿失** |

### 7.3 替代方案：minimal effective change（这才是 2026-05-21 实际产出）

不拆模块，而是逐刀清除**误导读者但不影响行为**的代码：

| 改动 | 修改方式 | 删除行数 |
|---|---|---|
| `void MAX_CONCURRENCY` 死引用 + 误导注释（"local closures still reference"，但全文无引用） | 整段删 | -7 |
| `function clampConcurrency(n)` thin wrapper（只 1 caller） | 改用 `import { clampConcurrency }` 直通 | -7 |
| `function shortSideAfterCap()` thin wrapper（5 caller 但都直接转手） | 改用 `import { shortSideAfterCap }` 直通 | -9 |
| compressLoop 内 3 个 `const ACCEPT_TOL = ACCEPT_TOL_EXT` 等套娃 const | 直接 `import { ACCEPT_TOL, ... }` 用原名 | -3 |

**总效果**：2649 → 2626（-23 行），语义零变化，696/696 vitest + 25 Playwright 全绿，**真正消除了"为什么有 thin wrapper / 为什么 import 用 `_EXT` 别名"这类阅读者困惑**。

### 7.4 决策启发式（写给未来的自己）

- Yes 看到 thin wrapper（`function f(...args) { return fExt(...args); }`）→ 直接 inline，删 wrapper
- Yes 看到 `import { x as xExt } from '...'` + `const x = xExt`（套娃 const）→ 直接 `import { x }`
- Yes 看到 `void X` 死引用 + 注释说"X 还在被引用" → grep 全文，如果真的没引用就连注释一起删
- No 看到文件超过 1000 行的第一反应**不应该是**「我把它拆成 5 个文件」
- No 看到一个内部 error class 的第一反应**不应该是**「我抽 errors.ts」
- No 看到一组 module-level 可变 singleton 的第一反应**不应该是**「我抽 state.ts」

> **底线**：每次想动 [processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) 的结构（不是行为），必须先在 PR 描述里**逐项对照 §7.1 五条**，证明"这次拆不会复刻 §7.2 的反例"。否则评审打回。

---
