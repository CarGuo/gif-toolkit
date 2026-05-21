# R-WS-90 Spec — Tab 提级 + 嗅探小模块独立化 + 后端 Sniff 路由化

> Author: AI agent
> Date: 2026-05-21
> Audit reference: [audit-r90.md](file:///Users/guoshuyu/workspace/gif-toolkit/audit-r90.md)
> Replaces: R-WS-89 (R-WS-89 的 patchById 修复并入此 task)

---

## 0. 用户原话与现象证据

> "有 bug,比如我嗅探出 A workspace,然后工作,然后工作中有嗅探出来 B workspace,然后切换 tab 后 A workspace 里的内容就看不到了"
> "所以是不是应该把 tab 提级,做成主页全局 tab,然后把嗅探小模块单独力一个 UI,其他就是都在 tab 内才对,因为下面处理参数也是需要跟着 workspace"

**现象级证据**(用户 2026-05-21 截图):同一时刻 URL 输入框 + 嗅探按钮 + 系统 Chrome 下拉 + 离线导入按钮 **全部显示"嗅探中..."**,即使用户切到 B tab,B tab 也被 A 的"嗅探中"状态污染。

**根因**(综合 audit-r90.md 12 项风险):
1. 主进程 `currentSniffCtrl` 单一全局 → 多 tab 后端互斥(audit 风险 #2)
2. `sniff:progress` IPC payload 无 sessionId/wsId → renderer 无法路由进度到正确 ws(audit #1)
3. renderer 端 `sniffProgress / activeSniffMode / urlError` 是顶层 useState 而非 per-ws 字段 → 全局单例,看错值(audit #4)
4. `useSniffSession` setX shim 全部走 patchActive,async 期间 active 漂移导致写错 ws(R-WS-89,audit #4)
5. `previewOverrides / resolvedMap / resolvingSet / resolveErrorMap` Workspace schema 已声明但 App.tsx 用全局 hook 持有 → dead schema + cross-tab leak(audit #5,#10)

---

## 1. 设计目标

### 1.1 必须解决(must-fix,验收 = 用户截图场景消失)

- **F1**: 同时多个 sniff 进行中,每个 tab 各自显示自己的"嗅探中 / 进度 / URL / 结果",切 tab 不互相污染。
- **F2**: 处理参数(`options: ProcessOptions`)per-ws,A tab 设了 fps=12,切到 B tab 是 B 自己的 fps,切回 A 还是 12。
- **F3**: 一个 tab 的批量处理(`progress / processingOne`)与另一个 tab 完全隔离,切 tab 进度条不串。
- **F4**: 关闭一个 tab 时,该 tab 上 in-flight 的 sniff 必须被 abort(对应主进程的 controller),不能造成"幽灵 sniff"。
- **F5**: R-WS-89 cross-tab 数据丢失(本任务最初触发原因)从 patchById 短期补丁升级为架构上不可能复现。

### 1.2 边界(out of scope,本任务不做)

- 工作区持久化(R-WS-91 单开):tab 关闭即丢内存仍然成立。
- 同 tab 内"暂停 sniff / 续上下载"等高阶生命周期。
- 历史详情面板 (`HistoryDetailModal`) 重跑过程中切 tab 的 progress 路由(audit #9):标记为 R-WS-92 单开。

---

## 2. 架构分层(参照用户原话)

```
┌─────────────────────────────────────────────────────────────┐
│ App shell (全局唯一)                                         │
│  • <TabBar workspaces={...} activeWsId={...} />             │
│  • 顶部 logo / 主题切换 / 设置 / 关于                        │
│  • 全局 toaster / 托盘 / 快捷键 / 自更新                    │
│  • <SniffPanel /> (新增, 独立 UI 模块, 见 §2.1)              │
│  • <WorkspaceView ws={activeWs} /> (按 active 切换)          │
└─────────────────────────────────────────────────────────────┘
```

### 2.1 SniffPanel — 嗅探小模块完全脱离 workspace(用户 2026-05-21 澄清)

**关键澄清(用户原话)**:"嗅探部分和输入框应该是脱离 workspace 之外的"。

也就是说,SniffPanel 是 App shell 自己的子组件,**自己持有所有输入侧 state**,与 active workspace **没有任何 props 耦合**。它和 workspace 的唯一接口是:sniff 完成的瞬间把结果灌到某个 wsId。

#### 2.1.1 SniffPanel 自治的 state(全部留在 SniffPanel 内)

| state | 含义 | 持久性 |
|---|---|---|
| `panelUrl: string` | URL 输入框值 | 仅 panel 内 |
| `panelUrlError: string \| null` | URL 校验错误 | 仅 panel 内 |
| `panelInflight: { sessionId, mode } \| null` | 当前 panel 启动的 sniff (用于禁用按钮、显示嗅探中) | 仅 panel 内 |
| `panelProgress: SniffProgress \| null` | 当前 sniff 的进度 | 仅 panel 内 |
| `panelActiveSniffMode: SniffMode \| null` | 用于显示「✓ 完成嗅探」按钮 | 仅 panel 内 |
| `panelUseRealChromeProfile: boolean` | 系统 Chrome 选项 | 仅 panel 内(这本来就是全局选项,不应跟 ws 走) |

#### 2.1.2 SniffPanel 与 workspace 的唯一接口

```
SniffPanel 触发 sniff
  ↓
useSniffSession.runX({ url, mode, options })
  ↓
generate sessionId
claimForSniff() → wsId
ws.patchById(wsId, { url, sniffing: true, result: null, selected: empty, historyId: null })
giftk.sniff/sniffWith*/import(url, { sessionId })
  ↓ (主进程 work)
sniff:progress(sessionId, payload)
  ↓ (renderer)
useIpcEvents 看 sessionId,如果是 SniffPanel 启动的 → 写 SniffPanel 的 panelProgress
                                                 → (如果 sniff 是为了灌入特定 ws) 同步 ws.sniffing 标记
  ↓
sniff resolve
  ↓
ws.patchById(wsId, { result, selected, historyId, sniffing: false })
SniffPanel 把 panelProgress / panelInflight 清空,但 panelUrl 保留(用户随时可以再点嗅探)
```

#### 2.1.3 切 tab 不影响 SniffPanel

- 切到 ws-A:SniffPanel **不变**(因为它根本不读 ws)
- 切到 ws-B:SniffPanel **也不变**
- 用户在 SniffPanel 输了 URL,无论切 tab 多少次,URL 都还在那(因为是 SniffPanel 自己的 state)

这同时解决了用户截图里"三个按钮全是嗅探中"的现象 — 因为按钮状态来自 `panelInflight`,而 `panelInflight` 只在用户当前 in-flight 时为 truthy,不再被某个 ws 的 sniffing 字段污染。

#### 2.1.4 多 sniff 并发的 SniffPanel UI 模式

由于 SniffPanel 是单实例,**同一时刻只能从 SniffPanel 启动 1 个 sniff**(panelInflight 占住按钮)。但**已经 in-flight 的 sniff 仍在后台跑**:用户在 panel 启动 sniff A → claim ws-A → A 还没结束 → 用户**先无法**再启动 sniff B。如果想同时并发,有两种 UX:

- **方案 P-Single**(初版,推荐):SniffPanel 同时只允许 1 个 sniff in-flight,按钮显示嗅探中,点按钮可取消;sniff 完成后立即可启动下一个。**简单清晰,与用户原话语义一致**。
- **方案 P-Multi**(可选,后续 R-WS-93):SniffPanel 每次启动一个 sniff 时,把当前 in-flight 推到一个"进行中列表"(类似 multi-tab 内的 "background sniffs"),允许立即启动下一个。需要新的 UX 区域,留作 followup。

**默认采用 P-Single**,验收用户的"嗅探按钮和 ws 解耦"先做到。

### 2.2 WorkspaceView — 处理参数 + 结果 + 历史 pin

- 接收 `ws: Workspace` 作为 prop,**不再读全局 state**。
- 内含三块:
  1. `<ProcessOptionsPanel ws={ws} />` — fps / maxSide / 输出目录 / …(`options` per-ws)
  2. `<ResultGrid ws={ws} />` — 嗅探结果列表 + 选择(`result / selected` per-ws)
  3. `<TaskProgress ws={ws} />` — 批量处理进度 + 日志(`progress / processingOne / logs` per-ws)
- 切 tab → React 拿到新 `activeWs`,WorkspaceView 重新 render,所有 props-driven 子组件状态自动跟随。

### 2.3 TabBar — 主页全局 tab

- 在 App shell 顶部,与 SniffPanel 平级。
- 每个 tab 显示:`title`(默认 URL host 或 "新工作区") + sniffing 时一个小 spinner + 关闭按钮。
- 关闭 tab 触发 `useWorkspaces.close(wsId)`,后者 emit cancelSniff 给主进程(见 §3.4)。

---

## 3. 后端 Sniff 路由化

### 3.1 协议变更(IPC payload schema)

```ts
// src/shared/types.ts
export interface SniffProgress {
  stage: 'fetching' | 'parsing' | 'probing' | 'done';
  percent: number;
  message?: string;
  found?: number;
  probed?: number;
  total?: number;
  // R-WS-90 新增:每个 progress 事件强制带 sessionId,
  // renderer 用 sessionId → wsId 反查路由到正确 ws。
  sessionId: string;
}

// 三个 sniff IPC 全部从单参 (url) 改为 (url, opts) 强制带 sessionId
giftk.sniff(url, { sessionId })
giftk.sniffWithWebview(url, { sessionId, includeStaticImages? })
giftk.sniffWithSystemChrome(url, { sessionId, includeStaticImages? }, chromeOpts?)
giftk.sniffWithYtdlpDirect(url, { sessionId, includeStaticImages? })
giftk.importOfflinePage(absPath?, { sessionId, includeStaticImages? })

// finalize / cancel 强制带 sessionId 路由
giftk.finalizeSystemChromeSniff(sessionId)
giftk.cancelSniff(sessionId)
```

### 3.2 主进程改造

- `currentSniffCtrl: AbortController | null` → `sniffCtrls: Map<sessionId, AbortController>`
- `finalizeCtrl` → `finalizeCtrls: Map<sessionId, AbortController>`
- `webviewSniffInFlight: boolean` → `webviewSniffInFlight: Set<sessionId>`(同 system-chrome / ytdlp-direct)
- `sniff:progress` 推送时带上 `sessionId`,renderer 端按 sessionId 路由

### 3.3 renderer 路由

- `useSniffSession.runEmbed/runWebview/runOffline`:**新签名 = `(input: { url?, absPath?, mode, ... })` → 返回 `{ sessionId, wsId, promise }`**(不再依赖 active ws shim setter)。
  - 内部:生成 `sessionId = crypto.randomUUID()`;调 `claimForSniff()` 拿 `wsId`;把 `(sessionId → wsId)` 写入模块级 `sniffSessionMapRef`(useSniffSession 自己持有的 ref Map)。
  - `ws.patchById(wsId, { url, sniffing: true, result: null, selected: empty })` 标记 ws 进入 sniff 状态。
  - 调 `giftk.sniff*(url, { sessionId, …filterOpts })` 触发主进程。
  - resolve 时 `ws.patchById(wsId, { result, selected, historyId, sniffing: false })`。

- `useIpcEvents.onSniffProgress(payload)`:从 `payload.sessionId` 取 `wsId`(若 panel 也订阅了同一个 sessionId,则直接写 SniffPanel 的 `panelProgress`)。
  - **关键**:`sniffProgress / activeSniffMode / urlError` **不下沉到 Workspace**;它们留在 SniffPanel 自己的 useState 里(用户原话:"嗅探部分和输入框应该是脱离 workspace 之外的")。
  - Workspace 只持有"结果侧" state(result / selected / sniffing 标记 / historyId / url / options / progress / logs / processingOne / createdAt)。`sniffing` 字段仍然 per-ws,因为 TabBar 上要给非 active 但 in-flight 的 tab 显示一个 spinner。

- SniffPanel 通过 hook 获取 inflight state:
  ```ts
  const { runEmbed, runWebview, runOffline, panelInflight, panelProgress } = useSniffPanelController();
  ```
  panelInflight 由 SniffPanel 自身 setState(在 runX 调用前置为 `{sessionId, mode}`,resolve/error 后清空)。

### 3.4 tab 关闭 → cancel sniff

- `useWorkspaces.close(wsId)`:如果 ws.sniffing,调用 `giftk.cancelSniff(ws.sniffSessionId)`,并清理 `sniffSessionMapRef`。
- 兜底:hook unmount(整个 app 关闭)时遍历 sniffSessionMapRef 全 cancel。

---

## 4. Workspace schema 整理(audit #5,#10 + 用户 2026-05-21 澄清)

### 4.1 当前混乱

| 字段 | schema 声明 | 实际持有者 | 状态 |
|---|---|---|---|
| url, historyId, sniffing, result, selected, options, progress, logs, processingOne, createdAt | Workspace | useWorkspaces | OK |
| previewOverrides | Workspace | usePreviewState (全局) | dead schema, leak |
| resolvedMap, resolvingSet, resolveErrorMap | Workspace | useEmbedResolve (全局) | dead schema, leak |
| sniffProgress, activeSniffMode, urlError, preview, activeId | (无) | App.tsx 顶层 useState | 含混不清 |

### 4.2 R-WS-90 后(用户澄清:嗅探/输入框脱离 ws)

| 字段 | 持有 |
|---|---|
| url, historyId, sniffing, result, selected, options, progress, logs, processingOne, createdAt | Workspace ✅ |
| sniffSessionId | Workspace ✅(新增,绑当前 in-flight sniff,关闭 tab 时用来 cancel) |
| **sniffProgress, activeSniffMode, urlError, panelUrl, panelInflight** | **SniffPanel 自身 useState** ✅(留在 panel 内,不进 Workspace,因为它们与 ws 无关) |
| preview, activeId(预览模态选中的 mediaId) | App shell 顶层 useState(全局,因为 PreviewModal 是单例) |
| previewOverrides, resolvedMap, resolvingSet, resolveErrorMap | usePreviewState / useEmbedResolve **改为 per-ws Map<wsId, …>**;Workspace interface 里**删除**这些字段以避免误导(audit #5/#10) |

### 4.3 makeWsSetter 命运

- 全部删除。
- 子组件直接接 `ws: Workspace` props + `wsApi: UseWorkspacesApi` props,内部 `wsApi.patchById(ws.id, …)`。
- SniffPanel **不接** `ws` 任何 props,只接 `wsApi`(用于 sniff 完成时灌结果);其余 panel state 全在自己 useState 里。
- 这同时根治 R-WS-89(active 漂移写错 ws),因为没有 active-shim 了。

---

## 5. 迁移顺序(每步独立可 commit + 可回滚)

| 阶段 | 内容 | 测试增量 | commit 单元 |
|---|---|---|---|
| **P1** 协议层 | shared/types 加 sessionId 字段;giftk preload TypeScript 签名扩展;主进程 IPC handler 接 sessionId(向后兼容:旧调用方不传时主进程 fallback 当前行为)| 单元:sniff payload schema 测 | 1 commit |
| **P2** 主进程 | currentSniffCtrl → Map;cancel/finalize 走 sessionId;webview/system-chrome/ytdlp inflight 改 Set | 单元:Map 路由测 + abort 隔离测 | 1 commit |
| **P3** Workspace schema 微调 | 把 `sniffSessionId` 加进 Workspace interface(blankWorkspace 默认 null);**不**下沉 sniffProgress/activeSniffMode/urlError(它们留在 SniffPanel) | 单元:useWorkspaces 新字段默认值 + close-with-sniff cancel | 1 commit |
| **P4** renderer hook 改造 | useSniffSession 接 wsApi + 显式 wsId;生成 sessionId 路由;useIpcEvents 改 progress 路由按 sessionId → wsId;useEmbedResolve / usePreviewState 改 per-ws Map | 单元:**R-WS-89 cross-tab 隔离**(已写) + 多 sniff 并发隔离 + sessionId 路由 | 1 commit |
| **P5** UI 抽组件 | 抽 SniffPanel / ProcessOptionsPanel / ResultGrid / TaskProgress;TabBar 提升;App.tsx 删 makeWsSetter | E2E 行为:dev 启动 + 手动场景脚本 | 1-2 commit |
| **P6** 清理 | 删除 dead schema 字段 + 删除 makeWsSetter helper + 删 setX 形 shim 老路径 | 全量回归三道闸 | 1 commit |

---

## 6. 回归测试矩阵(必补)

| ID | 场景 | 类型 | 已有? |
|---|---|---|---|
| T1 | runEmbed happy path 写到正确 wsId | unit (vitest) | 已修(89 改造) |
| T2 | runEmbed stale-guard 不写 stale ws | unit | 已修 |
| T3 | runEmbed timeout 写到正确 wsId | unit | 已修 |
| T4 | runWebview('system-chrome') 转发 useRealChromeProfile | unit | 已修 |
| T5 | runOffline picker-cancel 静默 | unit | 已修 |
| **T6** | **R-WS-89:A 嗅探中切 B,A resolve 后写到 ws-A**| **unit (已写,含正反断言)** | **已写**|
| **T7** | **多 sniff 并发:A、B 同时跑,各自进度事件按 sessionId 路由,A 进度不串到 B**| **unit** | **新增**|
| **T8** | **per-ws options 隔离:A 设 fps=12 / B 设 fps=20,切 tab 互不影响**| **unit** | **新增**|
| **T9** | **关闭 tab 中途 sniff:close(wsId) 触发 giftk.cancelSniff(sessionId)** | **unit + main 单元** | **新增**|
| **T10** | **dev 真启动手动验证脚本**:开 A 输 URL → 嗅探 → 不等结果开 B → 输不同 URL → 嗅探 → 切回 A → A 显示自己的 URL/嗅探中/结果 | **手动 / Playwright 可选** | **新增**|

---

## 7. 风险与回滚

- **冲击面 ~20 文件**:App.tsx (大改) / useWorkspaces / useSniffSession / useIpcEvents / useEmbedResolve / usePreviewState / 主进程 4 个 sniff handler / preload / shared types + 新增 4 个组件文件。
- **回滚单位**:每个阶段独立 commit。如果 P5 出问题,P1-P4 的协议 + 后端 + state 下沉已经独立可用,UI 旧形态退回 makeWsSetter 仍能跑(但不再有 active 漂移 bug 因为 P4 已改路由)。
- **dev 验证**:每个阶段 commit 前必跑一次 `npm run dev`,手动跑 T10 脚本。

---

## 8. 提议接下来的执行顺序

1. **请求确认 spec**(本步)→ 你 OK 后进入执行。
2. P1 协议层(无破坏性,纯加字段)。
3. P2 主进程 Map 化。
4. P3 Workspace schema 下沉。
5. P4 hook 改造 + 补 T6/T7/T8/T9 测试。
6. P5 UI 抽组件 + TabBar 提升 + SniffPanel 独立。
7. P6 清理 + dev 真启动 T10 + commit + push。

每步结束都跑三道闸 + dev 启动验证,最终用户截图场景消失才算 done。
