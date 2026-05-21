# R-11 — Preload 暴露的 API 三处一致

## 规则
新增 IPC 方法时,**必须同时改三处**:

1. [src/main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) — `ipcMain.handle('your:channel', ...)`
2. [src/preload/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/index.ts) — `contextBridge.exposeInMainWorld('giftk', { yourMethod: ... })`
3. [src/renderer/global.d.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/global.d.ts) — TS 类型

## 为什么
- 任何一处漏掉,生产构建里就是 `window.giftk.yourMethod is undefined`
- 开发期 Vite HMR 看着没事,**装包后才暴露**

## 怎么遵守
- 把这三步当成 atomic 操作,要么三处都改,要么都不改
- 跑 `npm run typecheck` 会捕获第 3 步缺失;前两步缺失靠 [docs/ipc-contract.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/ipc-contract.md) 表格巡检

## 反例
- No "我先在 main 加 handler,renderer 那边后面再说" ← 你会忘的
- No "TS 类型 just any 一把" ← 失去类型保护

## 关联场景
- 没有专属 SC,但提交前的 [pr-checklist.md](file:///Users/guoshuyu/workspace/gif-toolkit/harness/checklists/pr-checklist.md) 必查这一条。
