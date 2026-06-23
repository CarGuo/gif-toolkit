# R-DOCK-FLOATING — 桌面悬浮控件（floating desktop dock）

## 一句话

一个 **frame-less / transparent / alwaysOnTop / skipTaskbar** 的小 `BrowserWindow`，承载圆球 + 展开后的 7 个快捷动作；所有真正的业务（嗅探剪贴板 URL、显示主窗、跳录屏/工具箱/历史、退出）都委托给主进程**已有的入口**（[sniffClipboardURL](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/tray.ts#L65-L80) / [showOrCreateMainWindow](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) / `'tray:navigate'` IPC / `app.quit`），dock 自己不复刻业务逻辑（R-10 + DRY）。

## 反向清单（这些事情**禁止**做）

1. **禁止**让 dock renderer 直接读剪贴板 / 调 `app.quit` / 操作 BrowserWindow。  
   理由：违反 R-10（renderer 不许做重 IO / 进程级操作）+ 攻击面最小化。dock 触发任何动作都必须走 `window.giftkDock.trigger(kind)` → 主进程 [dispatchDockAction](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/dock.ts) 分发。

2. **禁止**给 dock 注入主窗口的 [preload/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/index.ts)（含 `giftk.*` 100+ 个 IPC 的那一套）。  
   dock 必须用专门的 [preload/dockOverlay.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/dockOverlay.ts) 暴露**白名单 6 个方法**：`getActions / trigger / setExpanded / drag / hide / onState`（R-11）。新增方法须 PR 描述里写明"为什么必须暴露给 dock"。

3. **禁止**在 dock 里复刻已有业务。  
   例如想加「直接录屏」按钮，必须先在 [src/main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) 找已有的 `recorder:selectRegion` + `recorder:start` 链路 → dock 只通过 `dispatchDockAction` 触发一次 `'tray:navigate'` 让 RecorderPanel 接管。**禁止**让 dock 直接调 `recorder:start`。

4. **禁止**让 dock 永久持有 / 锁定主窗的指针。  
   `dockDepsRef` 只保存 `trayDeps`，`trayDeps.getMainWindow()` 是 lazy 取，主窗销毁后这一调用返回 null，dispatchDockAction 必须 `if (w && !w.isDestroyed())` 守卫，否则 mainWindow 销毁后点 dock 直接 throw。

5. **禁止**与 macOS 系统 `app.dock`（系统 Dock 图标）混淆命名。  
   `src/main/index.ts` 里 `(app as any).dock` 是 macOS 的系统 Dock，跟我们的"floating dock"同名不同物。代码里凡是涉及悬浮控件的，命名必须用 `dockWindow / dockDepsRef / floating dock / createDockWindow`；涉及 macOS 系统 dock 的，保持原有 `app.dock.show / app.dock.hide` 调用习惯，注释带"Apple Dock icon"消歧。

6. **禁止**用 `BrowserWindow#movable=true` 让系统接管拖动。  
   `movable: false`，自己用 `pointerdown / pointermove / pointerup` 算坐标 + 主进程 `setBounds`，保证 Linux/Windows 上拖动行为一致 + 不会被 OS WM 截胡。`-webkit-app-region: drag` 也不要用（与 pointerEvents 互斥）。

7. **禁止**在 `before-quit` 漏掉 [destroyDockWindow](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/dock.ts)。  
   同 R-86 tray 同款守则：所有 alwaysOnTop / skipTaskbar 的辅助窗都必须在 before-quit 主动 destroy，否则 macOS 上会出现"主窗已关闭但 dock 还在"的幽灵窗口。

8. **禁止**让 dock 在没启用时仍然占内存。  
   `createDockWindow` 必须**懒创建**——只在用户点 TopBar 的「悬浮球」按钮（`dock:enable` IPC）时才 new BrowserWindow。不要在 app ready 时直接拉起。

## 跨进程边界

```
主窗 mainWindow + preload/index.ts (giftk.*)
       │
       │  giftk.dock.enable() / disable() / isVisible()   (3 IPC)
       ▼
   主进程 dock.ts
   ├─ createDockWindow / destroyDockWindow
   ├─ dispatchDockAction (7 case, switch + exhaustive)
   ├─ moveDockTo（clampDockPosition + screen.getDisplayNearestPoint）
   └─ ipcMain.handle('dock:{getActions,trigger,setExpanded,drag,hide}')
       ▲
       │  6 个白名单 IPC
       │
   dock window + preload/dockOverlay.ts (giftkDock.*)
   └─ dockOverlay.tsx — 圆球 + action grid + pointer drag
```

## IPC 契约

| Channel | Direction | 主用途 |
|---|---|---|
| `dock:enable` | renderer (main window) → main | TopBar 「⚪/🟢 悬浮球」按钮启用 |
| `dock:disable` | renderer (main window) → main | 同上按钮关闭 |
| `dock:isVisible` | renderer (main window) → main | App.tsx mount 时查询初始态 |
| `dock:getActions` | renderer (dock) → main | 渲染时一次性拉 metadata，免 dock 硬编码 |
| `dock:trigger` | renderer (dock) → main | 触发 7 个 [DockActionKind](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types/dock.ts) 之一 |
| `dock:setExpanded` | renderer (dock) → main | 折叠 ↔ 展开切换尺寸 |
| `dock:drag` | renderer (dock) → main | `phase: start/move/end` + DockDragInput |
| `dock:hide` | renderer (dock) → main | 右键圆球隐藏（保留 enable 状态，下次 enable 再显示） |
| `dock:state` | main → renderer (dock) | 主动广播 `{visible, expanded, mainWindowVisible}` |

## DockActionKind 完整清单

| kind | 路由 |
|---|---|
| `open-recorder` | showOrCreateMainWindow + `'tray:navigate' { tab: 'recorder' }` |
| `open-toolbox` | showOrCreateMainWindow + `'tray:navigate' { tab: 'toolbox' }` |
| `open-history` | showOrCreateMainWindow + `'tray:navigate' { tab: 'history' }` |
| `sniff-clipboard` | sniffClipboardURL(trayDeps)（与 tray 菜单/全局快捷键同源） |
| `show-main` | showOrCreateMainWindow |
| `hide-main` | mainWindow.hide() |
| `quit-app` | app.quit() |

新增 kind 时**必须**：
1. 在 [src/shared/types/dock.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types/dock.ts) `DockActionKind` union 加值
2. 在 [src/main/dock.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/dock.ts) `dispatchDockAction` switch 加 case（`exhaustive: never` 兜底会让漏写处 typecheck red）
3. 在 [src/main/dock.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/dock.ts) `dockActionMeta` 加 label/icon/description
4. 在 [tests/main/dock.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/dock.test.ts) `'exposes all N actions'` 的 `toEqual` 数组里加值（顺序锁定）

## 验证步骤

1. `npm run test:fast` — [tests/main/dock.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/dock.test.ts) 必须 9/9 绿。
2. `npm run typecheck` + `npm run lint` — 零错。
3. `npm run build` — `dist/renderer/dockOverlay.html` + `dist/renderer/assets/dockOverlay-*.js` + `dist/preload/dockOverlay.js` + `dist/main/dock.js` 均产出。
4. 改了 dock.ts / dockOverlay.ts / preload/dockOverlay.ts → 跑 `npm run test:e2e:smoke`。
5. mac 真机 smoke：
   - 点 TopBar 「⚪ 悬浮球」→ 屏幕右下出现蓝色圆球 → 按钮变 「🟢 悬浮球」。
   - 拖圆球到屏幕任意位置（含贴四角）→ clampDockPosition 把它停在 work-area 内 4px padding 处。
   - 单击圆球 → 横向展开 7 个图标按钮，再单击折叠。
   - 右键圆球 → dock 隐藏（dockEnabled 仍为 true，再点 TopBar 按钮可重新显示）。
   - 点「嗅探」→ 主窗弹起并尝试抓剪贴板 URL。
   - 退出 app → dock 必须同时消失（before-quit 钩子）。

## 文件清单

- 主进程：[src/main/dock.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/dock.ts)
- 主进程接入：[src/main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts)（import、`dockDepsRef`、`dock:enable/disable/isVisible` IPC、mainWindow show/hide 通知、before-quit destroyDockWindow）
- preload：[src/preload/dockOverlay.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/dockOverlay.ts)（dock 窗口专用，6 方法白名单）+ [src/preload/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/index.ts) `dock: { enable, disable, isVisible }`（主窗用，3 方法）
- 共享类型：[src/shared/types/dock.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types/dock.ts)（已挂 [src/shared/types/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types/index.ts) barrel）
- dock 渲染：[src/renderer/dockOverlay.html](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/dockOverlay.html) + [src/renderer/dockOverlay.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/dockOverlay.tsx)
- 主窗 UI：[src/renderer/views/TopBar.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/views/TopBar.tsx) 「⚪/🟢 悬浮球」开关 + [src/renderer/App.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/App.tsx) `dockEnabled` state + `onToggleDock`
- vite multi-entry：[vite.config.ts](file:///Users/guoshuyu/workspace/gif-toolkit/vite.config.ts) `rollupOptions.input.{main,recorderOverlay,dockOverlay}`
- 测试：[tests/main/dock.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/dock.test.ts) — actionMeta 顺序/完整性（11 项）+ clampDockPosition 边界 + computeDockMoveTarget + recorderStateReducer 状态机

## v2 —— dock 就地录屏（dock-in-place-recorder）

**核心反向**：v1 把 dock 当「打开主窗的快捷启动器」是错的。dock 的存在价值是「**不打开主窗也能完成高频任务**」，否则用 tray 菜单就够了。

v2 起 dock 拥有完整自治录屏链路：
1. 用户点 dock 圆球（idle 态）→ 展开 → 点「录屏」
2. 主进程 `dispatchDockAction('dock-record-region')` 调 [openRegionSelectorOverlay](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/recorderOverlay.ts) 拉选区遮罩
3. 拿到 region 后调 [startRecorder](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/recorder.ts) + [showStaticOverlayForRegion](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/recorderOverlay.ts)（**录制全程**显示只读高亮 + 「正在录制」横幅，点击穿透）
4. dock 圆球变红 + 实时显示 `mm:ss`；点圆球直接停止（最快路径，不用展开）
5. ffmpeg 落盘后 dock 显示 ✓ + 「打开」按钮 → reveal 文件

### v2 反向清单（这些事情**禁止**做）

9. **禁止**让 dock 录制走 `tray:navigate` 跳主窗 RecorderPanel。  
   理由：用户开 dock 就是为了不开主窗。dock 的录制必须用 [dock.ts startDockRecording](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/dock.ts) 走主进程已有 recorder/recorderOverlay 入口，绕过 RecorderPanel。

10. **禁止**让 dock 的录制态依赖 main window 存在。  
    `dispatchDockAction('dock-record-region')` 在 mainWindow=null / hidden / destroyed 都必须能完成。停止按钮也必须**跨界可点**（主窗不在前台也能点），靠 dock 的 `dock-record-stop` action。

11. **禁止**在录制过程中关闭静态遮罩。  
    [showStaticOverlayForRegion](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/recorderOverlay.ts) 必须 `focusable=false` + `setIgnoreMouseEvents(true, { forward: true })` 让用户能照常点桌面，但视觉上始终能看到「现在在录哪儿」。只有 done/cancelled/error 三个终态才 closeStaticOverlay。

12. **禁止**让 mac 上 `avfoundationDeviceIndex` 缺省时 throw 「required on darwin」。  
    [src/main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) `recorder:start` handler 在 mac 上未传时**必须**兜底 `1`（标准 "Capture screen 0" 索引），dock 才能开箱即用。后续可加 `detectMacScreenDevice` 跑 `ffmpeg -f avfoundation -list_devices` 精确探测，但兜底 1 是先决条件。

13. **禁止**让 `recorder:progress` 只发给 mainWindow。  
    必须 fan-out 给 mainWindow + dock（[fanOutProgress](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) → [notifyDockRecorderProgress](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/dock.ts)），且 dock 端只在 `recorderState.sessionId === p.sessionId` 时更新 elapsedMs，避免主窗 RecorderPanel 的录制污染 dock 状态。

14. **禁止**在 `before-quit` / `destroyDockWindow` 漏掉 cancelRecorder + closeStaticOverlay。  
    dock 销毁但 ffmpeg 进程还在跑会产生孤儿进程；静态遮罩残留会让用户以为还在录。必须双 cancel。

### v2 IPC 白名单变更（preload 8 方法，比 v1 多 2 个）

| # | 方法 | 用途 |
|---|---|---|
| 1-6 | `getActions / trigger / setExpanded / drag / hide / onState` | v1 沿用 |
| 7 | `getRecorderState` | 初次 mount 拉一次 dock 录制态 |
| 8 | `revealLastRecording` | done 后点圆球或「打开」按钮 reveal 产物 |
| extra | `onRecorderState` 订阅 | 走 `dock:recorderState` channel |

### v2 DockActionKind 扩展（11 个，比 v1 多 4 个）

新增 `dock-record-region / dock-record-stop / dock-record-cancel / open-output-dir`。dispatchDockAction switch 同步加 case，dockActionMeta 数组同步更新，[tests/main/dock.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/dock.test.ts) 锁定顺序。`tone='danger'` 给 stop（红色），`tone='primary'` 给 record-region（蓝色高亮）。

### v2 状态机 [recorderStateReducer](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/dock.ts)

```
idle ──select-start──> selecting ──[overlay cancel]──> idle
                              │
                              └─[region]──> recording ──progress──> recording (elapsedMs++)
                                            │
                              finalize-request / cancel-request
                                            │
                                            ▼
                                       finalizing ──done──> done ──(3.5s timer)──> idle
                                                  └─cancelled──> idle
                                                  └─error──────> error ──(5s timer)──> idle
```

纯函数 reducer 抽出便于单测（8 个 case 锁定，见 [tests/main/dock.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/dock.test.ts)）。

---

## v2.1 — #error-toast：错误必须走「底部独立气泡」而不是圆球红爆炸

### 反向条款（这些事情**禁止**做）

1. **禁止**让 dock 圆球本身在 `error` 阶段：
   - 整圆变红（`background: C.danger`）
   - 渲染巨型 `!`（fontSize ≥ 18）
   - 触发 `orb-pulse` / 增强 `box-shadow` 红光  
   
   截图证据：用户反馈"巨大红色 ❗ 圆盖住悬浮球"（v2.0 一度同时叠红底 + 大 `!` + scale 1.06 脉动 + 红 box-shadow，视觉上等同于桌面悬浮"红色警报弹窗"）。

2. **正确做法**：`error` 阶段圆球保持 idle 蓝底 + 录像 icon，**仅**在右上角加一个 10×10 红 dot（带 2px 深色描边、轻微红光 box-shadow、`pointer-events: none`）。错误**内容**走 dock window 内的「绝对定位贴底 toast 条」：
   - 主进程进入 `error` 阶段时 `setDockSize(DOCK_ERROR_SIZE)`（440×150，比 EXPANDED_SIZE 高出 46px 容纳 toast）
   - 渲染端 `position: absolute; left:8; right:8; bottom:8` 渲一条暗红毛玻璃条：标题「录制失败」+ 2 行 line-clamp 错误详情 + ✕ 关闭按钮
   - 5s 后主进程定时器自动 reset 到 idle（`recorderResetTimer`），窗口缩回 collapsed/expanded
   - 用户点 ✕ → 触发 `dock-record-cancel`，主进程 [cancelDockRecording](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/dock.ts) 在 `done`/`error` 阶段必须接受为「立即关闭 toast」入口（清 timer + 重置 state + setDockSize 缩回），**不能**像 v2.0 那样 early-return no-op。

3. **禁止**把错误条塞进 expanded panel 的 buttons 行旁边（v2.0 的做法）。  
   理由：buttons 行的 `overflow: hidden` 会把长错误信息截掉；且与 done 提示条共占一行视觉混乱。错误必须是「物理上独立的浮条」。

### 实现锁

- [DOCK_ERROR_SIZE](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types/dock.ts) 常量必须存在且 height ≥ 140
- [setDockSize](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/dock.ts) 必须在 `recorderState.phase === 'error'` 时优先用 ERROR_SIZE，覆盖 expanded/collapsed
- [applyRecorderEvent](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/dock.ts) 进入 `error` 阶段（prevPhase !== error）必须 setDockSize(true)
- [cancelDockRecording](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/dock.ts) 在 `done`/`error` 阶段必须清 timer + 重置 + setDockSize 缩回，而不是 no-op
- [dockOverlay.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/dockOverlay.tsx) 圆球 `orbBg` 在 error 阶段必须等于 `C.primary`（不是 `C.danger`），`hasErrorDot` 控制右上角小红点
