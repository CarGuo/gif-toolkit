# PR Checklist — 提交前自检

> 复制这份清单到 PR 描述里,**逐条勾选**。任何一项 N/A 都要写"为什么"。

## 静态门禁
- [ ] `npm run typecheck` 退出 0
- [ ] `npm run lint` 退出 0(0 warning)
- [ ] `npm run build` 退出 0

## 项目级硬规则(影响项打勾)
- [ ] R-01 嗅探走主进程 — 没在 Renderer 加 `fetch`
- [ ] R-02 不为某个 host 写白名单 — 新规则是结构化的
- [ ] R-03 maxSide 同时作用宽高
- [ ] R-04 压缩管线四阶段边界清晰
- [ ] R-05 soft ≤ hard,UI clamp 不破
- [ ] R-06 缩边保短边,做不到就 throw AspectRatioConstraintError
- [ ] R-07 concurrency 默认 3,clamp 1..8
- [ ] R-08 TaskProgress 带 substep / detail / elapsedMs
- [ ] R-09 iframe-embed 只识别不下载
- [ ] R-10 contextIsolation/nodeIntegration 没动
- [ ] R-11 改 IPC 时 main + preload + global.d.ts 三处都改了
- [ ] R-12 没为了让 SC 通过而改 SC

## 共享类型 / 边界
- [ ] 改了 [src/shared/types.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types.ts)?(若是,确认对应的 sanitizeOptions / OptionsForm 都更新了)
- [ ] 改了 IPC 通道?(若是,确认 [docs/ipc-contract.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/ipc-contract.md) 已更新)

## 动态回归
- [ ] 跑了 [run-harness.md](file:///Users/guoshuyu/workspace/gif-toolkit/harness/run-harness.md) §2 的影响场景表所列的 SC
- [ ] 在 PR 描述里贴了 SC PASS / N/A 列表

## 沉淀
- [ ] 如果修了一个新发现的 bug:已在 [scenarios/](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/) 增加 SC-XX
- [ ] 如果发现这是反复同类问题:已升格成 R-XX 规则并在 [AGENTS.md](file:///Users/guoshuyu/workspace/gif-toolkit/AGENTS.md) 第 1 节加行
