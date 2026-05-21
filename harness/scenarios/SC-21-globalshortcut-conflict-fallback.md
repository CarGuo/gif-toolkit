# SC-21 — globalShortcut 冲突回退 / register fallback

> **来源**:R-86 红线 #1"快捷键冲突必须降级,不得抛错"。
> **关联规则**:[R-86](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-86-tray-and-shortcuts.md) [R-25](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-25-ux-signals-and-defaults.md)

---

## 触发条件

| 场景 | OS | 预期 |
|---|---|---|
| 用户已开 Alfred / Raycast 占用 Cmd+Shift+G | macOS | `globalShortcut.register` 返回 false |
| 用户改了系统键盘快捷键映射占用同组合 | win/linux | 同上 |
| 用户的 Electron 版本在 `register` 异常情况会抛 | 全平台 | try/catch 兜底,log + 继续启动 |
| 第二次启动 App(单实例锁未释放) | 全平台 | second-instance focus 主窗,不重复注册 shortcut |

---

## 期望行为

1. **`registerShortcuts` 永不 throw 出 whenReady 之外**:`tryRegister` 内 try/catch 必兜住所有异常,返回 `{ ok: false }`。
2. **`isRegistered` 失败时 log 必有清晰前缀** `globalShortcut:`,内容含 accelerator 字符串与失败原因摘要。
3. **App 主流程不被快捷键失败阻塞**:tray + 主窗 + renderer 必须照常启动;只有快捷键这一条退路不可用。
4. **`before-quit` 必须 `unregisterAllShortcuts`**:即便注册全失败,`unregister` 也是 no-op safe,不准让残留绑定泄漏到下一次 dev session。
5. **未来扩展**:`bindings` 参数允许 user 自改键(目前未暴露 UI,但接口已留)。

---

## 反向断言

- 不允许在快捷键失败时 `app.quit()`、弹原生 dialog、或反复重试。
- 不允许在 main 进程外调 `globalShortcut.*`(必须经过 [src/main/globalShortcut.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/globalShortcut.ts) 这一层)。
- 不允许把 mac 的 `Command` 与 win/linux 的 `Control` 写死在调用方:必须经 `defaultBindings()`,平台分流只有这一处。

---

## 验收 checklist

- [ ] mock `globalShortcut.register` 返回 false → `registerShortcuts` 返回 `{ show: { ok: false }, sniffClipboard: { ok: false } }`,log 出现两条 `registration declined`。
- [ ] mock 抛错 → 同样两条 `threw:` log,无未捕获 promise rejection。
- [ ] 真机 mac:用 Karabiner / 系统设置抢 Cmd+Shift+G,启动 → log 含 declined,主窗仍可托盘唤回。
- [ ] before-quit:即使初始 register 全失败,quit 时无 `globalShortcut.unregister` 抛错(unregister 不存在的 accelerator 是 silent)。
