# SC-29 — Floating Desktop Dock（桌面悬浮控件）

## 触发场景

用户希望在不打开主窗的情况下快速：
- 启动一次剪贴板嗅探
- 跳到「区域录屏」 / 「工具箱」 / 「历史」
- 显示 / 隐藏主窗
- 退出 App

并且这个入口必须**始终浮在屏幕最上层**（不被全屏 App 遮挡）、**不进任务栏**、可被用户拖到屏幕任意角落。

## 现象与失败模式（如不沉淀会反复犯）

1. **复刻业务**：第一版直觉是「dock 也加一份『直接录屏』的 IPC handler」。结果与 [src/main/recorder.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/recorder.ts) + RecorderPanel 链路重复，行为漂移。  
   **解法**：dock 只负责 navigation + 触发 tray 已有原语；任何「业务」必须落到主窗的 React 视图（沿用 'tray:navigate' tab 协议）。

2. **过度暴露 preload**：第一版直接把主窗 preload 复用给 dock 窗口，结果 dock 窗口里 `window.giftk.history.delete(...)` 这类高危 IPC 完全可用，攻击面爆炸。  
   **解法**：[src/preload/dockOverlay.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/dockOverlay.ts) 单独白名单，**只**导 6 个 dock 自己用的 IPC。

3. **拖动靠 `-webkit-app-region: drag`**：CSS 拖动跨平台行为不一致（mac OK / Linux 经常失灵 / 与 pointerEvents 互斥导致按钮点不到）。  
   **解法**：renderer pointerDown/Move/Up + setPointerCapture → IPC `dock:drag` 三相位 → 主进程 setBounds。

4. **screen.getPrimaryDisplay 写死**：多屏用户拖到副屏会立刻被 clamp 回主屏中心，毁体验。  
   **解法**：`computeDockMoveTarget` 算完先用 `screen.getDisplayNearestPoint({x, y})` 取该坐标所在的显示器 + workArea，再 clamp。

5. **退出 App 时 dock 不消失**：alwaysOnTop + skipTaskbar 窗一旦没被显式 destroy，在 mac 会成为孤儿，直到强杀。  
   **解法**：`before-quit` 钩子 try { destroyDockWindow() } catch { /* ignore */ }。

6. **mainWindow.hide() 后无法显示**：用户先「隐藏主窗」再「显示主窗」，第二次因为 mainWindow 还在但 `isVisible() = false`，必须 mainWindow.show() + focus()。我们把这一切委托给 [showOrCreateMainWindow](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) 它已经处理过。

## 回归用例

### RCV-29-A：dockActionMeta 顺序与 union 完全对齐
- 文件：[tests/main/dock.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/dock.test.ts) - "exposes all 7 actions in deterministic order"
- 锁定：7 个 DockActionKind 出现顺序 + 无重复 + 每项 label/icon/description 非空

### RCV-29-B：clampDockPosition 边界
- 同文件，5 个 case：
  - 内部坐标透传
  - 负数 clamp 到 DOCK_EDGE_PADDING
  - 极大值 clamp 到右下角
  - 浮点像素四舍五入（避免 setBounds 子像素警告）
  - workArea 偏移（多屏 origin 非 0,0）

### RCV-29-C：computeDockMoveTarget 纯函数性
- 同文件，2 case：算术 + 幂等

### RCV-29-D（手测）：mac 真机 smoke
1. 点 TopBar 「⚪ 悬浮球」按钮 → 屏幕右下角出现蓝色圆球 + 按钮变 「🟢 悬浮球」
2. 拖球到屏幕中央 → 释放后停在中央
3. 单击球 → 横向展开 7 图标 → 再单击折叠
4. 点「嗅探剪贴板 URL」→ 主窗弹起 + 进入嗅探流程
5. 右键球 → 球消失（dockEnabled 仍 true，按钮仍 🟢）→ 再点按钮变 ⚪ 再点回 🟢 球重新出现
6. Cmd+Q 退出 → 球与主窗同时消失，无孤儿窗

### RCV-29-E（手测）：多屏拖动
- 主屏在左、副屏在右 → 把球从主屏拖到副屏 → 球应停在副屏 work-area 内，而不是被 clamp 回主屏边缘

### RCV-29-F（手测）：dock 就地录屏全链路（v2）
**前置**：开启 dock；主窗可见或隐藏均可，不影响验证
1. 点 dock 圆球 → 展开面板 → 点「录屏」按钮  
   ✅ 屏幕拉起全屏遮罩 + 拖框选区（重用 RecorderPanel 的 overlay）
2. 框选区域 → 按 Enter / 点「开始录制」  
   ✅ 主进程 ffmpeg 启动（mac 上即使没传 `avfoundationDeviceIndex` 也不能 throw `required on darwin`，必须兜底 1）  
   ✅ 选区位置出现**只读红色高亮 + 「正在录制」chip**，**全程**显示直到停止  
   ✅ 用户可在录制区内继续点桌面（点击穿透），不抢交互  
   ✅ dock 圆球变红 + 实时显示 `mm:ss` 计时  
   ✅ dock 自动展开横幅显示「录制中 / 00:12」
3. 点 dock 圆球（最快路径，不展开）  
   ✅ 录制立即停止，dock 进入 finalizing → done，圆球变绿 ✓，出现「打开」按钮  
   ✅ 静态高亮遮罩自动关闭，无残留窗口  
   ✅ ~3.5 秒后自动回 idle
4. 点「打开」  
   ✅ 系统文件管理器 reveal 最后产物
5. 再次录制 → 点 dock「取消」按钮  
   ✅ 圆球回 idle，无产物落盘，无残留 ffmpeg 进程（ps aux | grep ffmpeg 验证）
6. 录制中 Cmd+Q  
   ✅ ffmpeg 被 cancel，dock + 静态遮罩同时消失，无孤儿进程

### RCV-29-G（手测）：跨界停止
1. 主窗最小化 / 隐藏到托盘  
2. 用 dock 启动录制  
3. 在任何 app（Chrome、终端、Finder）的前台都能看到 dock 始终最顶层  
4. 点 dock 圆球 → 仍能停止录制  
   ✅ 这就是「跨界支持」——停止按钮不依赖主窗在前台

### RCV-29-H（单测，已锁）：recorderStateReducer 状态机
- `npm run test:fast -- dock.test`  
- 锁定 8 个 case：select-start / select-cancelled / recording-start / progress (匹配 / 不匹配 sessionId / idle 期间) / finalize-request / cancel-request / done / cancelled / error

### RCV-29-I（手测 v2.1）：错误必须走「底部独立气泡」+ 圆球只加 mini-dot

复现录屏错误的最简方式：mac 上拔掉屏幕录制权限或断电源（也可手动 throw 一个 'mock-fail' 在 startDockRecording 里测）。

1. dock 启动录制 → 模拟 error  
2. **断言**：圆球**不应**整圆变红、**不应**出现大写 `!`、**不应**触发 scale 脉动  
3. 圆球右上角应**出现** 10×10 红 dot（带深色描边）  
4. dock window 自动扩高到 ≥150px（DOCK_ERROR_SIZE）  
5. 窗口底部应出现一条暗红毛玻璃 toast 条：「录制失败」+ 错误详情（2 行 line-clamp）+ ✕ 按钮  
6. 5s 后 toast 自动消失、窗口缩回（idle）  
7. 用户立刻点 ✕ → toast 立即消失，圆球红点消失，窗口缩回（不需要等 5s）

### RCV-29-J（单测 v2.1）：avfoundation 设备探测

`npm run test:fast -- recorder.test`，必须锁三 case：

| case | stderr 内容 | 期望返回 |
|---|---|---|
| 1 | `[0] FaceTime\n[1] Capture screen 0\nAVFoundation audio devices:\n` | `index=1` |
| 2 | `[0] FaceTime\n[1] iPhone Camera\n[2] OBS Virtual\n[3] Capture screen 0\n[4] Capture screen 1\naudio devices:\n` + `displayOrdinal=0` | `index=3` |
| 3 | `AVFoundation video devices:\naudio devices:\n` | `index=1`（fallback） |

且必锁 `toEvenSize(275) === 274 / toEvenSize(1) === 2 / toEvenSize(0) === 2`，以及 `buildRecorderArgs({region:{w:275,h:223,...}})` 的 `-vf crop=...` 必须含 `crop=274:222:...`。

## 与已有规则的关联

- R-10：dock renderer 永远不直接 IO，所有重活走主进程
- R-11：dockOverlay preload 白名单（v1=6, v2=8）方法，不许夹带
- R-82：[src/shared/types/dock.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types/dock.ts) **直接** import 源文件，不走 barrel re-export 单点（即使 `index.ts` 已 re-export 也优先直接路径）
- R-86：tray + 全局快捷键 + dock 三套悬浮入口 before-quit 必须同步 destroy
- R-87：dock 不创建任何 tmp 文件（录制产物由 startRecorder 自己 register tmpdir）
- R-REC-DESKTOP-AREA：dock 自治录屏复用其全部主进程入口（startRecorder/stopRecorder/cancelRecorder/openRegionSelectorOverlay），不复刻
- R-DOCK-FLOATING：本场景对应规则（v2 加 §dock-in-place-recorder 章节）
