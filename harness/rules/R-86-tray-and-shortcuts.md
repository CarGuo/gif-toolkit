# R-86 — Background tray + global shortcut

**Status**: ratified · **Source**: 第 73 轮用户指令
"增加不同平台的后台托盘和快捷功能支持"

## 一句话

App 必须能在主窗关闭后从系统托盘 + 全局快捷键被唤回,行为按平台习惯分流;
托盘菜单的每条入口必须是"无副作用前置 + 显式确认才动手"——剪贴板嗅探、
打开输出目录、上次任务回看都允许失败回退到 toast,绝不静默。

## 实现位置

- [src/main/tray.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/tray.ts) — `setupTray(deps)` / `destroyTray()` /
  `sniffClipboardURL(deps)`,7 项菜单(显示主窗 / 嗅探剪贴板 / 打开输出目录 /
  上次任务回看 / 一键重传 / 关于 / 退出)。
- [src/main/globalShortcut.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/globalShortcut.ts) — `registerShortcuts(deps, bindings?)` /
  `unregisterAllShortcuts()` / `defaultBindings()`。
- [src/main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) `whenReady` 末尾启动,`before-quit`
  头部 `unregisterAllShortcuts()` + `destroyTray()` + `sessionTmpRegistry.cleanupSessionSync()`。
- [src/preload/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/index.ts) — `onTrayToast` / `onTraySniffUrl` /
  `onTrayNavigate` / `onTrayReuploadLatest` 4 条订阅。

## 平台行为

| 平台 | 单击托盘 | 右键托盘 | 全局快捷键 |
|------|----------|----------|------------|
| macOS | 弹出菜单(模板图自动适配深浅色) | 同左 | `Cmd+Shift+G` 显示主窗 / `Cmd+Shift+V` 嗅探剪贴板 |
| Windows | 唤回主窗 | 弹出菜单 | `Ctrl+Shift+G` / `Ctrl+Shift+V` |
| Linux | 唤回主窗 | 弹出菜单 | 同 Windows |

## 红线

1. **快捷键冲突必须降级,不得抛错**
   `globalShortcut.register` 返回 `false` 或抛出时,只 log + 通过
   `tray:toast` 提示用户改键,**不准** `app.quit()` 也**不准**重试。
2. **剪贴板嗅探必须走主窗 IPC 复用现有 sanitize 链路**
   tray 的"从剪贴板嗅探 URL"读到非 http/https 文本时,推 `tray:toast`
   告警;合法 URL 通过 `tray:sniff-url` 转给 renderer,renderer 走与
   常规 URL 嗅探一样的 `sniff:url` invoke(同一份 sanitizeOptions)。
3. **主窗已关时不能直接 `app.quit()`**
   macOS 习惯是关窗保留 dock,本规则要求其他平台也尊重 tray:tray
   存在 → `window-all-closed` 不调 `app.quit()`(留给"退出"菜单 +
   `before-quit` 处理)。
4. **before-quit 必须先 unregister + destroyTray + sessionTmpCleanup**
   在 `cancelAllTasks` / `killAllProcs` / `closeDb` 之前完成,确保
   即使 DB flush 超时,后台资源也已释放。

## 验收

- 三道闸:typecheck + lint + vitest 全绿。
- SC-20 / SC-21 冒烟:见 [harness/scenarios/SC-20-tray-menu-smoke.md](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-20-tray-menu-smoke.md) /
  [SC-21-globalshortcut-conflict-fallback.md](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-21-globalshortcut-conflict-fallback.md)。
