# R-80 — Local history → better-sqlite3 + native ABI self-heal + no-loss on quit

**Status**: ratified · **Source**: 第 56–66 轮 (R-79b → R-80) + 第 65 轮 post-mortem
"ABI 错配 + tooltip 仍是 Electron + 做完要测试吗?不要交付半成品"

## 一句话

把 4 大本地历史(history / uploadHistory / sniffHistory / toolbox)从
`localStorage` 迁到主进程 `better-sqlite3`(WAL + 外键),并把"装完即用"硬性
保证 — native ABI 自动重编译、退出前 IPC flush、错误统一 toast、bootstrap
分 family 容错 — 全部沉淀进 harness。

## 八件,缺一不可

1. **#1 主进程仓** — [src/main/db/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/db/index.ts) 用 `better-sqlite3` + WAL + `PRAGMA foreign_keys=ON`;`upload_history` 父子两表 + FK CASCADE;`history` 用 hot 列(id/pageUrl/createdAt/updatedAt)+ JSON 列(items/options/uploadsByOutputPath)混合,sniff/toolbox 扁平化。

2. **#2 17 个 `db:*` IPC** — [src/main/db/dbIpc.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/db/dbIpc.ts) 全部经 `safeHandle<TArgs,TResult>(channel, fn)` 包裹:try/catch + `console.error` + **重抛**保留 renderer reject 契约,**不允许**裸 `ipcMain.handle`。

3. **#3 hook 同步 API + 异步初始化** — 4 个 hook(useHistory / useUploadHistory / useSniffHistory / useToolbox)保留旧公共 API,初始 `readAll` 异步且暴露 `isLoading`,mutation 走乐观更新 + fire-and-forget IPC;高频写**必须** 250ms 尾随合并;App 暴露 `flushPending()` 返回 `Promise.all(...)`。

4. **#4 一次性 bootstrap import** — [bootstrapImport.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/db/bootstrapImport.ts) **每个 family 独立 try + 独立 transaction**,坏 family 不阻断其它三个;成功后删除 4 个 legacy localStorage key 并写 `giftk.db.bootstrap.v1=1`,失败保留 legacy 等下次重试;失败必经 [storageSchema.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/storageSchema.ts) → `reportDbError('bootstrap','import',err)` 上报 dbErrorBus。

5. **#5 `before-quit` 两阶段 flush** — [src/main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) `before-quit` 必须 `event.preventDefault()` → `wc.send('db:flushBeforeQuit', requestId)` → 等 `db:flushBeforeQuit:ack` 或 1s 超时 → `setImmediate(() => app.quit())`;preload 暴露 `onFlushBeforeQuit(cb)`;App.tsx useEffect 必须 `Promise.allSettled([...flushPending])` 后 `acked()`;**禁止**裸退出导致 250ms 队列里的 upsert 丢失。

6. **#6 dbErrorBus 单 toast** — [dbErrorBus.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/dbErrorBus.ts) 模块级单 listener + per-session `firedOnce`;4 个 hook + storageSchema 的 `.catch` **禁止**继续 `console.error` 静默,统一调 `reportDbError(family, op, err)`,UI 层一个 toast 提示并降级为只读模式。

7. **#7 ABI 自愈 (R-80 hardening A~F)** —
   - **A** [scripts/ensure-sqlite-abi.mjs](file:///Users/guoshuyu/workspace/gif-toolkit/scripts/ensure-sqlite-abi.mjs) 在 `predev` / `prestart` 自动跑:读 `node_modules/better-sqlite3/build/Release/better_sqlite3.node` 的 `NODE_MODULE_VERSION`,与 `electron --abi` 不一致就 `npx electron-rebuild -f -w better-sqlite3`,幂等。
   - **B** `npm run test:db` wrapper 顺序:`to-node → run → finally to-electron`;**禁止**手动两步走(测完忘记切回 → dev 启动 ABI mismatch crash)。
   - **C** [scripts/patch-electron-plist.mjs](file:///Users/guoshuyu/workspace/gif-toolkit/scripts/patch-electron-plist.mjs) 在 `postinstall` / `predev` / `prestart` 自动跑,改 [Electron.app/Contents/Info.plist](file:///Users/guoshuyu/workspace/gif-toolkit/node_modules/electron/dist/Electron.app/Contents/Info.plist) 的 `CFBundleName` / `CFBundleDisplayName` 为 `Gif Toolkit (dev)`,幂等;dock tooltip 不再显示 `Electron`。
   - **D** `package.json scripts` 任何会触发 sqlite 加载的入口(`dev` / `start` / `package:*`)都必须挂 `pre*` ensure-sqlite-abi。
   - **E** vitest 配置区分 `test:node`(纯 helper)和 `test:electron`(IPC mock),不允许 mix。
   - **F** CI 必须跑 `test:db` wrapper,不允许只跑 `npm test`。

8. **#8 post-mortem(铁规则)** — 改了 native module(better-sqlite3 / sharp / ffmpeg-static / ffprobe-static / gifsicle / ytdlp-nodejs)、db schema/IPC、preload bridge、`before-quit`,**必须**额外跑一次 `npm run dev`,看主进程日志没有 `compiled against a different Node.js version` / `UnhandledPromiseRejection` / `db init failed` 才能交付。**测试通过 ≠ 功能可用**。

## 反向(不允许)

- 任何 `db:*` IPC 裸 `ipcMain.handle`
- bootstrap import 4 个 family 共用一个 transaction
- mutation 走异步 read-back(性能崩溃)
- `before-quit` 直接 `app.quit()` 不等 ack
- 改了 sqlite native 但跳过 ABI ensure script

## 沉淀来源

- [src/main/db/](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/db)
- [scripts/ensure-sqlite-abi.mjs](file:///Users/guoshuyu/workspace/gif-toolkit/scripts/ensure-sqlite-abi.mjs)
- [scripts/patch-electron-plist.mjs](file:///Users/guoshuyu/workspace/gif-toolkit/scripts/patch-electron-plist.mjs)
- [src/renderer/components/dbErrorBus.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/dbErrorBus.ts)
- [SC-20 ~ SC-22](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios)
