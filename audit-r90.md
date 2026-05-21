# R-WS-90 Audit — Workspace 多 Tab × Sniff 路由能力盘点

> 审计时间:2026-05-21
> 范围:`src/renderer/App.tsx` + `src/renderer/components/useWorkspaces.ts` + `src/renderer/components/*` + `src/main/*` 中所有 `sniff*` IPC。
> 目的:为后续把 `sniff:progress` / `currentSniffCtrl` 路由到具体 workspace(R-WS-90)提供事实依据。

---

## 1. App.tsx 中所有 `makeWsSetter` 创建的 setter

`makeWsSetter<K>(key)` 定义在 `src/renderer/App.tsx:60-67`,所有 setter 均通过 `ws.patchActive` 写入**当前激活的 workspace**(没有任何形式的 wsId 路由能力)。

| # | setter 名 | 关联字段 (Workspace[K]) | 定义行 |
|---|---|---|---|
| 1 | `setUrl` | `url: string` | App.tsx:69 |
| 2 | `setSniffing` | `sniffing: boolean` | App.tsx:82 |
| 3 | `setResult` | `result: SniffResult \| null` | App.tsx:103 |
| 4 | `setSelected` | `selected: Set<string>` | App.tsx:105 |
| 5 | `setOptions` | `options: ProcessOptions` | App.tsx:108 |
| 6 | `setProgress` | `progress: Record<string, TaskProgress>` | App.tsx:124 |
| 7 | `setLogs` | `logs: string[]` | App.tsx:126 |
| 8 | `setProcessingOne` | `processingOne: Set<string>` | App.tsx:144 |

> 注意 Workspace 中还有 `previewOverrides / resolvedMap / resolvingSet / resolveErrorMap / historyId / createdAt`,但 App.tsx 当前并没有为它们生成 makeWsSetter 形 shim:
> - `previewOverrides` 由独立 hook `usePreviewState` 持有(全局 useState,**未 ws 化**)。
> - `resolvedMap / resolvingSet / resolveErrorMap` 由 `useEmbedResolve` 持有(全局 useState,**未 ws 化**)。
> - `historyId` 写入通过 `ws.patchById(wsId, { historyId })` 直接走,不经 makeWsSetter。

### 1.1 这些 setter 被传给了谁?

**传给 hooks(在 deps bag 中以函数引用注入):**

- `useSniffSession({ setUrlError, setSniffing, setSniffProgress, setResult, setSelected, setActiveId, setPreview, setLogs, setActiveSniffMode, … })` — App.tsx:282-304
- `useIpcEvents({ setProgress, setLogs, setSniffProgress, setUploadResult, … })` — App.tsx:398-411
- `useProcessDispatch({ setLogs, setProgress, setProcessingOne, setLastBatchDir, … })` — App.tsx:655-672
- `useUploadDispatch({ setLogs, setUploadResult, setUploadSettingsOpen, … })` — App.tsx:926-938
- `useUploadOrchestrator({ setUploadConfigs, setLogs, … })` — App.tsx:956-964
- `useEmbedResolve({ appendLog, addSelected, patchItemResolved, … })`(自定义包装) — App.tsx:264-271
- `useBootstrapEffects(toaster, { reloadHistory, reloadSniffHistory, reloadUploadHistory, flushHistoryPending, flushUploadHistoryPending })` — App.tsx:337-343 (**不直接消费 ws setter**)

**传给视图组件 props:**

- `<SniffSection setUrl={setUrl} setUrlError={setUrlError} setUseRealChromeProfile={setUseRealChromeProfile} setSniffHistoryOpen={setSniffHistoryOpen} … />` — App.tsx:1170-1193
- `<OptionsSection setOptions={setOptions} … />` — App.tsx:1195-1203
- `<ModalsHost setOptions={setOptions} setLogs={setLogs} setBatchModal={setBatchModal} setHistoryDetail={setHistoryDetail} setManualOpt={setManualOpt} setUploadSettingsOpen={setUploadSettingsOpen} setUploadResult={setUploadResult} setPreviewOverride={setPreviewOverride} … />` — App.tsx:1294-1332
- `<MediaGridPane progress={progress} logs={logs} … />` — App.tsx:1207-1265 (读 ws state,不直接接收 setter)

**App.tsx 内部直接调用点(非 props 传递):**

- `setUrl(url)` — App.tsx:483 (tray:sniff-url 桥接)
- `setLogs(prev => …)` — App.tsx:226, 498, 515, 531, 677, 713, 731, 746, 874, 876, 879, 891, 1004
- `setSelected(prev => …)` — App.tsx:232, 1116
- `setResult(prev => …)` — App.tsx:253 (patchItemResolved 双写)
- `setProgress(prev => …)` — App.tsx:820, 863 (onCancel / onCancelOne 乐观 sweep)

> **风险信号(R-WS-90 直接相关)**:`makeWsSetter` 全部走 `ws.patchActive`。这意味着 **任何在 IPC 回调或异步分支里调用 setLogs/setProgress 的代码,只要执行时刻用户切到了别的 tab,日志/进度都会写到错误的 workspace。** `useSniffSession` 已经规避(改用 `ws.patchById(wsId, …)`),但 `useIpcEvents` / `useProcessDispatch` / 多处 onCancel 仍然依赖 active = 正确目标。

---

## 2. `useWorkspaces.ts` 关键事实

### 2.1 `Workspace` interface 完整 per-ws 字段(useWorkspaces.ts:68-97)

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | `readonly string` | 内部 stable id (`ws-<base36>-<seq>`),不展示给用户 |
| `historyId` | `string \| null` | 1:1 对应的 HistoryRecord id;sniff 完成才赋值 |
| `url` | `string` | 用户输入的 URL,可空 |
| `result` | `SniffResult \| null` | 当前嗅探结果 |
| `sniffing` | `boolean` | 网络请求 in-flight 标志 |
| `selected` | `Set<string>` | 已勾选 mediaId 集合 |
| `options` | `ProcessOptions` | per-tab 处理参数 |
| `progress` | `Record<string, TaskProgress>` | per-task 进度表 |
| `processingOne` | `Set<string>` | 单条派发中的 mediaId 集合 |
| `previewOverrides` | `Record<string, PreviewOverride>` | 预览模态局部覆盖 (**目前未被 App.tsx 实际写入**) |
| `resolvedMap` | `Record<string, ResolvedMedia>` | embed 解析结果 (**目前未被 App.tsx 实际写入**) |
| `resolvingSet` | `Set<string>` | embed 解析 in-flight (**目前未被 App.tsx 实际写入**) |
| `resolveErrorMap` | `Record<string, string>` | embed 解析错误 (**目前未被 App.tsx 实际写入**) |
| `logs` | `string[]` | 与 LogOverlay 同源的 in-memory 日志缓冲 |
| `createdAt` | `number` | 创建时间戳 |

> **风险信号**:`previewOverrides / resolvedMap / resolvingSet / resolveErrorMap` 在 schema 上是 per-ws,但**实际状态被全局 hook(`usePreviewState` / `useEmbedResolve`)持有**。结果就是预览覆盖与 embed 解析进度**会跨 tab 串台**。这是隐性 R-WS bug。

### 2.2 `blankWorkspace()` 默认值(useWorkspaces.ts:106-122)

```ts
{
  id: newWorkspaceId(),                 // ws-<base36>-<seq>
  historyId: null,
  url: '',
  result: null,
  sniffing: false,
  selected: new Set(),
  options: { ...DEFAULT_OPTIONS },      // 来自 src/shared/types
  progress: {},
  processingOne: new Set(),
  previewOverrides: {},
  resolvedMap: {},
  resolvingSet: new Set(),
  resolveErrorMap: {},
  logs: [],
  createdAt: Date.now()
}
```

### 2.3 `claimForSniff()` 完整行为(useWorkspaces.ts:292-301)

```ts
const claimForSniff = useCallback((): string => {
  const list = listRef.current;
  const active = list.find((w) => w.id === activeIdRef.current);
  // isBlank: result === null && !sniffing  (URL 不计入,见 useWorkspaces.ts:131-138 注释)
  if (active && isBlank(active)) return active.id;
  // 否则新开 tab + 切活
  const ws = blankWorkspace();
  setList((cur) => [...cur, ws]);
  setActiveId(ws.id);
  return ws.id;
}, []);
```

要点:
1. **判断标准**:`isBlank(w) === w.result === null && !w.sniffing`(URL 不算)。意味着用户在当前 tab 输了 URL 但没嗅探,新点 sniff 仍会**复用**当前 tab。
2. **如果 active tab 已经有 result(或正在 sniffing)**,新建空白 tab 并切到它。**注意:claimForSniff 没有 `signal/sessionId/wsId` 参数**,即没办法把这个返回的 wsId 注入到主进程,主进程的 sniff 仍然是单一全局 in-flight。
3. **副作用**:`setActiveId(ws.id)` 同步切活。`useSniffSession` 拿到 wsId 之后立即 `ws.patchById(wsId, …)` 用直读 wsId 而非 active 写入(见 useSniffSession.ts:235-254 / 350-367 / 444-458 注释 R-WS-89),正是为了规避用户在 await 期间切 tab 的串台。

> **风险信号**:`claimForSniff` 返回的 wsId 仅在 renderer 端被 useSniffSession 持有,**没有透传给主进程**。主进程对所有 sniff 模式共享同一个 `currentSniffCtrl`,因此**两个 tab 同时点 sniff 会互相 abort**(R-53 注释里写的"unified single-flight"),这与"workspace 应该独立"的 R-WS 目标直接冲突。

---

## 3. `src/renderer/components` 各组件对核心 state 的使用矩阵

> 仅列出**真正消费 url / options / result / sniffing / selected / preview / logs / progress** 的组件。`*Modal`、`*Picker` 等只接收派生数据/回调的不重复。

| 组件文件 | 来源 prop / state | 类型 |
|---|---|---|
| `TaskTable.tsx` (`Props`,L4-50) | `progress: Record<string, TaskProgress>` | per-ws progress 直读 |
| `MediaGrid.tsx` (`Props`,L4-28) | `selected: Set<string>` | per-ws selected 直读 |
| `MediaList.tsx` (`Props`,L6) | `selected: Set<string>` | per-ws selected 直读 |
| `ProgressDock.tsx` (`ProgressDockProps`,L35-54) | `progress`, `logs?`, `logsVisible?` | per-ws progress + per-ws logs |
| `PreviewModal.tsx` (主 props,L40-100;`CropPaneProps` L399-410;`FramesPaneProps` L536-545) | `options: ProcessOptions`, `preview: PreviewResult \| null`, `onChangeOptions` | options 来自 active ws;preview 是**全局** `usePreviewState` |
| `OptionsForm.tsx` (`NumFieldProps` L19) | `value: ProcessOptions`, `onChange` | options 直接绑 active ws (走 setOptions=makeWsSetter('options')) |
| `BatchSegmentModal.tsx` | `entries: BatchSegmentEntry[]` (从 ws.activeWs.result 派生) | 间接消费 result |
| `HistoryDetailModal.tsx` (`HistoryDetailModalProps`,L74-110) | `progress: Record<string, TaskProgress>`, `options: ProcessOptions`, `logs?: string[]` | **直读 active ws progress + logs**(modal 不 scope record) |
| `HistoryPanel.tsx` (`HistoryPanelProps`,L48-…) | 只读 `history: HistoryRecord[]`(SQLite) | 不直接消费 ws state |
| `WorkspaceTabs.tsx` (`WorkspaceTabsProps`,L27) | `workspaces: Workspace[]`, `activeId: string` | 唯一直接 enumerate workspaces 的组件 |
| `ToolboxPanel.tsx` | 自己的 useToolbox state(独立) | 不消费 ws state |
| `UploadHistoryPanel.tsx` / `UploadResultModal.tsx` / `UploadSettingsModal.tsx` | 来自 `useUploadHistory` / `uploadConfigs`(全局) | 不消费 ws state |
| `SniffHistoryPicker.tsx` (`SniffHistoryPickerProps`,L28) | `entries: SniffUrlEntry[]`(全局 LRU) | 不消费 ws state |
| `LogBox.tsx` | `lines: string[]`(由 ProgressDock 转发 active ws.logs) | per-ws logs 间接 |
| `Toast.tsx` (`ToasterProps`,L126) | toaster handles | 不消费 ws state |
| `CropBox.tsx` / `Timeline.tsx` / `SegmentPicker.tsx` / `ManualOptimizeModal.tsx` / `ErrorBoundary.tsx` | 仅 props/局部 state | 不消费 ws state |

> **结论**:**真正 per-ws 的只有 progress / logs / selected / options / result / sniffing / url**,其余全是全局或派生。`preview` / `previewOverride` / `resolvedMap` / `resolvingSet` / `resolveErrorMap` 看上去是 per-ws,实际是**全局**。

---

## 4. `src/main` 所有 `sniff*` IPC handler 签名

文件:`src/main/index.ts`(全部集中在 L705-1115)。

| Handler | 行号 | 参数 (renderer→main) | 是否带 sessionId | 是否带 wsId | 备注 |
|---|---|---|---|---|---|
| `sniff:url` | L751 | `(url, maybeFilterOpts)` | `readOrMintSessionId(maybeFilterOpts, 'sniff')`(L754) — sessionId 内嵌在 filterOpts | ❌ 无 | `sessionId` 仅用于 sessionLogger,不参与进度路由 |
| `sniff:cancel` | L807 | 无参 | ❌ | ❌ | 无路由参数,abort 全局 `currentSniffCtrl` 与 `currentSystemChromeFinalizeCtrl` |
| `sniff:webview` | L835 | `(url, maybeFilterOpts)` | ✅ via filterOpts | ❌ | 绑共享 `currentSniffCtrl` |
| `sniff:system-chrome:detect` | L892 | 无参 | ❌ | ❌ | 探测安装的浏览器,不嗅探 |
| `sniff:system-chrome` | L895 | `(url, maybeFilterOpts, maybeChromeOpts)` | ✅ via filterOpts | ❌ | 共享 `currentSniffCtrl` + 单独 `currentSystemChromeFinalizeCtrl` |
| `sniff:system-chrome:finalize` | L964 | 无参 | ❌ | ❌ | 单一全局 finalize ctrl,**无法识别要 finalize 哪个 ws 的 sniff** |
| `sniff:offlineImport` | L992 | `(maybePath, maybeOpts)` | ✅ via maybeOpts | ❌ | 共享 `currentSniffCtrl` |
| `sniff:ytdlp-direct` | L1069 | `(url, maybeFilterOpts)` | ✅ via filterOpts | ❌ | 共享 `currentSniffCtrl` |

### 4.1 `sniff:progress` 事件 payload 结构

定义:`src/shared/types/media.ts:82-89`

```ts
export interface SniffProgress {
  stage: 'fetching' | 'parsing' | 'probing' | 'done';   // SniffStage
  percent: number;          // 0..100
  message?: string;
  found?: number;
  probed?: number;
  total?: number;
}
```

发送侧(`webContents.send('sniff:progress', p)`):
- `src/main/index.ts:768` — sniff:url 内 onProgress
- `src/main/index.ts:931` — sniff:system-chrome 内 onProgress
- `src/main/index.ts:1031` — sniff:offlineImport 内 onProgress
- `src/main/index.ts:1089` — sniff:ytdlp-direct 内 onProgress
- (`sniff:webview` 不通过 channel,而是同步在 `openWebviewSniff(safe, mainWindow, { signal })` 的 Promise 里完成,**没有 progress 推送**)

接收侧:`src/preload/index.ts:228-233`

```ts
onSniffProgress(cb: (p: SniffProgress) => void): () => void {
  const handler = (_: unknown, payload: SniffProgress) => { try { cb(payload); } catch {} };
  ipcRenderer.on('sniff:progress', handler);
  return () => ipcRenderer.removeListener('sniff:progress', handler);
}
```

消费侧:`useIpcEvents.ts:162-164` → `depsRef.current.setSniffProgress(p)` → App.tsx:83 的全局 `useState<SniffProgress | null>` → `<SniffSection sniffProgress={…} />`(App.tsx:1176)。

> **关键风险**:`SniffProgress` payload **不带 sessionId、不带 wsId、不带 mode**。两个 tab 同时跑(即使主进程逻辑上只有 single-flight),如果一个未取消的旧回调还在 in-flight、新 sniff 已发出,renderer 也无法区分该 progress 属于哪个 ws。当前能正常工作完全靠 main 的 single-flight 假设。

### 4.2 主进程内部 sniff 函数签名

| 函数 | 文件 | 签名 |
|---|---|---|
| `sniffPage` | `src/main/sniffer.ts:450` | `(pageUrl, onProgress?, signal?)` |
| `openWebviewSniff` | `src/main/webviewSniff.ts:374` | `(targetUrl, parent?, opts: { signal? } = {})` — **无 onProgress** |
| `sniffViaSystemChrome` | `src/main/systemChromeSniff.ts:257` | `(url, opts: SniffOpts)`(SniffOpts 含 signal/finalizeSignal/useRealProfile/onProgress) |
| `sniffViaYtdlp` | `src/main/ytdlpDirectSniff.ts:141` | `(url, opts: YtdlpDirectSniffOpts)` |
| `importOfflinePath` | `src/main/offlineImport.ts:859` | `(absPath, opts)` (含 signal/includeStaticImages/onProgress) |

所有内部函数均**只接受 signal,不接受 sessionId/wsId 路由 token**。

---

## 5. 关键风险点(R-WS-90 紧迫度排序)

1. **R1【最高】 `sniff:progress` payload 无 wsId/sessionId 路由信息**:renderer 全局 `setSniffProgress` 单 useState,**两个 tab 同时跑 sniff 必串台**。修法:在 payload 加 `sessionId`,renderer 用 `ws.patchByHistoryId/patchById` 路由。
2. **R2【最高】 主进程 `currentSniffCtrl` 是单一全局**:任何 tab 启动新 sniff 都会 abort 上一个,`sniff:cancel` 也是无参全局 abort。**多 workspace 并发 sniff 在主进程层就被互斥了**,与 R-WS 多 tab 独立目标根本冲突。修法:`Map<sessionId, AbortController>`。
3. **R3【最高】 `sniff:system-chrome:finalize` 无参,无法识别 finalize 哪个 sniff**:单 finalizeCtrl 与 currentSniffCtrl 同生命周期,但跨 tab 时 renderer 的 `onFinalizeSystemChromeSniff` 永远 finalize"最近一个"。
4. **R4【高】 makeWsSetter 全部走 `ws.patchActive`,IPC 回调用 setLogs/setProgress 时不验证目标 ws**:`useIpcEvents` 中虽有 `taskRecordMapRef` 路由 process:progress 到 `patchHistory`,但 sniff 进度 / 日志依然回到 active。用户在 await 期间切 tab,setLogs 写错地方。
5. **R5【高】 Workspace.previewOverrides / resolvedMap / resolvingSet / resolveErrorMap 字段被 schema 占住但全局 hook 接管**:UI 上看是 per-ws,实际跨 tab 共享。tab A 解析中,切到 tab B 看到的是 A 的 spinner / 错误。
6. **R6【高】 `claimForSniff` 不向主进程透传 wsId**:返回的 wsId 只在 renderer 用,主进程没有 token 把进度回灌到正确 tab。需要把 wsId(或 sessionId)作为 IPC 第三参数透传,并在 progress payload 里回带。
7. **R7【中】 `sniff:webview` 没有进度推送**:openWebviewSniff 不接 onProgress,renderer 端 sniffProgress 一直停留在 `{stage:'fetching', percent:0}` 直到 Promise resolve。R-WS 路由化后这条要么补 onProgress,要么在 SniffProgress 边界明确 mode='webview' → 不推。
8. **R8【中】 `sniff:offlineImport` / `sniff:ytdlp-direct` 各自的 inflight flag (`webviewSniffInFlight` / `systemChromeSniffInFlight` / `ytdlpDirectSniffInFlight`) 是单标志位**:意味着同一种 mode 跨 tab 也只能并发 1 个。把它们改成 `Set<sessionId>` 或者 per-ws Map。
9. **R9【中】 `HistoryDetailModal` 直接消费 active ws 的 progress / logs**:重跑历史记录时,如果用户切 tab,modal 里看到的会是新 active ws 的进度,而非 modal 绑定的 record。需要 modal 走 `taskRecordMapRef` 路由出的 record-scoped 进度。
10. **R10【中】 `useEmbedResolve` 全局单实例 vs Workspace.resolvedMap 字段并存**:既是 dead schema,又是 cross-tab leak。建议二选一:要么把 useEmbedResolve 推进 ws.patchById,要么删除 Workspace 里的对应字段并加注释。
11. **R11【低】 `usePreviewState` 同 R10**,但因为 PreviewModal 一次只为一个 activeMedia 服务,串台风险最低,排在最后。
12. **R12【低】 Workspace 没有持久化层**:close tab 即丢内存,虽然 useWorkspaces 注释里说"未来可加 workspaces 表",但当前设计若加 wsId 到 IPC,要注意主进程崩溃 / 重启 / before-quit 怎么把 in-flight 的 sniff 路由回新 sessionId(R-80 / R-86 共生关系)。

---

## 附录 A:`makeWsSetter` 调用关系总览(机读)

```
makeWsSetter(key)
  └─ ws.patchActive((prev) => ({ [key]: nextValue }))
       └─ applyPatch(activeIdRef.current, patch)   // useWorkspaces.ts:323-328
            └─ setList((cur) => merge cur[idx] with patch)
```

被注入到 hook deps 后,hook 再通过 `depsRef.current.setX` 解引用。**这意味着只要 hook 内部能拿到 wsId,完全可以选择走 `ws.patchById(wsId, …)` 绕过 active 写入** —— 这正是 useSniffSession.ts 中 R-WS-89 的修法,可作为后续 useIpcEvents / useProcessDispatch 的样板。
