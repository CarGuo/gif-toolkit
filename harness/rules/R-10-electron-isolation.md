# R-10 — Electron 安全基线

## 规则
- `contextIsolation: true`(永远)
- `nodeIntegration: false`(永远)
- `sandbox` 不强制,但 preload 不允许直接挂 Node API 到 window
- 任何"为了开发方便临时关一下"都不允许,**会忘了关**

## 为什么
- Electron 安全基线
- Renderer 一旦能跑 Node API,XSS 就等于 RCE

## 怎么遵守
- BrowserWindow 配置写在 [src/main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts)
- preload 仅通过 `contextBridge.exposeInMainWorld('giftk', { ... })` 暴露白名单方法
- Renderer 永远 `import { ... } from 'react'`,**禁止** `require('electron')`

## 反例
- No `nodeIntegration: true`
- No `contextIsolation: false`
- No preload 里 `window.fs = require('fs')`

## 关联场景
- 没有专属 SC,但是所有 SC 都默认依赖这条不破。
