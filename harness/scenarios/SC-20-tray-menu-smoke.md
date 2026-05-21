# SC-20 — Tray menu smoke / 跨平台托盘菜单冒烟

> **来源**:第 73 轮用户指令"增加不同平台的后台托盘和快捷功能支持"。
> **关联规则**:[R-86](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-86-tray-and-shortcuts.md) [R-11](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-11-preload-whitelist.md) [R-25](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-25-ux-signals-and-defaults.md)

---

## 触发条件

| 因素 | 影响 |
|---|---|
| `setupTray(deps)` 在 `whenReady` 末尾被调用,主窗已可获取 | 必须保证 nativeImage 加载到正确的 `build/icons/16x16.png` / `32x32.png` |
| macOS 行为:单击托盘弹菜单 + template image 适配深浅 | macOS 要 `setTemplateImage(true)`,resize 18×18,不需要 `tray.on('click')` |
| Windows / Linux 行为:单击托盘唤回主窗,右键菜单 | 需要 `tray.on('click', () => showOrCreateMainWindow())` |
| 关闭主窗后菜单"显示主窗"项必须能"重开关掉的窗" | `showOrCreateMainWindow` 必须在 mainWindow 为 null / destroyed 时调 `createWindow()`,而不是只 `focus` |

---

## 期望行为

1. **应用启动 → 托盘出现**,nativeImage 不为空(`build/icons/16x16.png` 必存在)。
2. **macOS 单击托盘** → 弹出 7 项菜单(显示主窗 / 从剪贴板嗅探 URL / 打开输出目录 / 上次任务回看 / 一键重传最近产物 / 关于 Gif Toolkit X.Y.Z / 退出)。
3. **关闭主窗 → 托盘"显示主窗"** → `createWindow()` 被调用,主窗回来,渲染端能继续 `app:log` 收日志。
4. **"打开输出目录"** → `defaultOutDir()` 不存在时 `mkdir -p`,然后 `shell.openPath`,失败给 `tray:toast` warn。
5. **"从剪贴板嗅探 URL"**:
   - 剪贴板为空 / 非 http(s) → `tray:toast` warn("剪贴板没有可识别的 URL")。
   - 合法 URL → `tray:sniff-url` 推 renderer,renderer 走与 `sniff:url` 同款 sanitizeOptions。
6. **"退出"** → `app.quit` → `before-quit` 头部 `unregisterAllShortcuts` + `destroyTray` + `sessionTmpRegistry.cleanupSessionSync` 必须先于 `cancelAllTasks`。

---

## 反向断言

- 不允许 tray 菜单项**直接**做有副作用的 IO(如 `axios.get` / `fs.writeFile`):所有副作用必须经 mainWindow.webContents.send 走 renderer,或经 main 内已有的 IPC handler 复用。
- 不允许在 `window-all-closed` 调 `app.quit()`(R-86 红线 #3),否则 tray 形同虚设。
- 不允许 nativeImage path 写死绝对路径:必须基于 `app.getAppPath()` 或 `process.cwd()` 解析,生产打包后 `app.asar` 内仍能找到。

---

## 验收 checklist

- [ ] mac:**Cmd+Shift+G** 唤回主窗,**Cmd+Shift+V** 触发剪贴板嗅探,主窗弹 toast。
- [ ] win:Ctrl+Shift+G 唤主窗;托盘单击同样唤主窗;右键弹菜单。
- [ ] linux:同 win。
- [ ] 主窗已关 → 托盘"显示主窗" → 主窗重建。
- [ ] 退出 → `before-quit` 日志依次出现 `globalShortcut: unregister`、`tray: destroyed`、`session tmp cleanup`、`db.close`。
