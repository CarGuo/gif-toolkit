# R-COMPRESS-V1 — Toolbox / History UX accelerator pack (six P0 quick wins)

> **触发场景**：用户反馈"参数命名工程化但用户不知道该选什么"——已知机器但不知所措。本规则记录这次为弥合用户心智模型 ↔ 现有参数空间所做的 6 件零回归改动的硬约束，避免后续重构时被悄悄推翻。

---

## 1. Six quick-wins inventory

| # | 入口 | UI | 后端契约 |
|---|---|---|---|
| #1 | ToolboxPanel · GIF Optimize | 顶部「目标体积」chip 条 `< 2 MB / < 5 MB / < 10 MB / 自定义` | 仅 setParams(`method='budget' + maxBytes`)，**不**改 schema |
| #2 | ToolboxPanel · Video → GIF / WebP | smart fps 默认值 = `min(srcFps, 24)` | useToolbox.applyFile 读 ffprobe 的 `srcFps` 后写入 paramsByKind[kind].fps |
| #3 | ToolboxPanel · Video → GIF | 「编码引擎」segmented `Fast (ffmpeg) / High quality (gifski)` | `ToolboxParams.engine?: 'ffmpeg' \| 'gifski'`；main `videoToGifGifski()` 走 ffmpeg → PNG → gifski |
| #4 | ToolboxLineageModal footer | 「试跑 0.5s」按钮（取消 / 试跑 0.5s / 继续 →） | 独立 IPC `toolbox:trialRun` / `toolbox:trialCleanup`；不入历史 / 不发 progress / 不抢 p-queue |
| #5 | HistoryPanel card | 「推荐预设」chip 行（每张 done 卡） | useToolbox.applyPreset 原子地清空 jobs+progress+lastOutputDir + 整体替换 kind+params + 入队唯一 inputPath |
| #6 (加速) | HistoryPanel sniff card | 「☁ 已上传 N」胶囊从展示改为可点击 | App.tsx setView('uploads') + UploadHistoryPanel 滚到对应 record |

---

## 2. 硬约束（违反即 PR block）

### R-COMPRESS-V1.1 · paramsByKind 隔离不许打破
- useToolbox 的 params **按 kind 存**（`paramsByKind: Record<ToolboxKind, ToolboxParams>`）。
- engine、target-bytes 等 kind-scope 字段切完后 **round-trip kind 会回到 kind-default** —— 这是**有意**设计：防 gifski 泄漏到下个 batch、防 5MB 目标溢出到 Trim 等无关 kind。
- 不许引入"全局 sticky params"。如需跨 kind 持久化，必须显式过 SQLite per-kind 存。

### R-COMPRESS-V1.2 · #4 trial-run 三隔离
- **不进 p-queue**：`runToolboxTrialJob()` 直接调 ffmpeg/gifski，绕过共享队列，避免阻塞用户当前批处理。
- **不进 history**：`toolbox:trialRun` IPC handler 不写 toolboxHistoryRepo。
- **不发 progress**：handler 不调 `mainWindow.webContents.send('toolbox:progress', ...)`，避免污染 ProgressDock。
- 临时输出 basename 必须以 `giftk-trial-` 前缀开头，落在 `os.tmpdir()` 子树。`toolbox:trialCleanup` 必须严格白名单校验这两条；R-87 `ALLOWED_PREFIXES` 已加入 `giftk-trial-` 兜底。

### R-COMPRESS-V1.3 · #4 trial-run 必须剥离时间区间
- Lineage params 可能带 `startSec / endSec`（用户拖了 segment）；trial 时**必须**在调用前 stripTimeRangeForTrial 把这两字段抹掉，再用 `toolboxTrim -ss 0 -t 0.5` 截前 0.5s。
- 不剥离会触发 trim clamp 抛错（trial 区间 < lineage 区间 → 内部断言）。

### R-COMPRESS-V1.4 · #5 applyPreset 必须是原子动作
- 任何"切到工具箱并预填"的入口（推荐预设 chip / 未来其他外部跳转）必须走 `useToolbox.applyPreset({ inputPath, kind, params })` 这一个统一 API。
- applyPreset 必须**原子**：`setJobs([])` + `setProgressByJobId({})` + `setLastOutputDir(null)` + `setKind(nextKind)` + `setParamsByKind({ ...prev, [nextKind]: nextParams })` + `enqueueFile(inputPath)`。
- 不许 merge：上一个 batch 的残留 params **必须**被整体替换，否则用户预期"我点 5MB 就该是 5MB 的全新 batch"会被破坏。
- 扩展名校验失败必须 no-op，不静默改 kind。

### R-COMPRESS-V1.5 · #3 gifski 引擎降级路径
- `optionalDependencies.gifski` 存在性通过 main 的 `getGifskiPath()` + `cachedGifski` 负缓存判定。
- gifski 不存在时：UI 显示 segmented 但 gifski 选项 **disabled** + tooltip 提示"未安装"；不许悄悄 fallback 到 ffmpeg（用户会以为他选了 hq）。
- gifski 路径下，PNG 序列必须落在 `os.tmpdir()/giftk-gifski-<stamp>/frame-%06d.png` 并 `finally` 清理；AbortSignal 必须传透到 ffmpeg + gifski 两个子进程。

### R-COMPRESS-V1.6 · 真实 e2e 不许 mock window.giftk
- 6 件每件都必须有一个 `tests/e2e/realPipeline/suite-r-compress-v1-ui.ts` 内的 SUITE RCV1-A/B/C/D/E/F。
- 范式：**绝不** mock `window.giftk`；`page.evaluate` 直接调真实 preload bridge + 真实 main IPC + 真实 ffmpeg/sqlite。任何 mock 层都会让 wiring bug 漏过。
- 单测可以补 DOM/状态机覆盖，但不能替代 realPipeline 这层。

---

## 3. 验证步骤

改动了 R-COMPRESS-V1 任意一件后必须跑：

```bash
npm run typecheck
npm run lint
npm test                                   # vitest 831/831
npx playwright test -g "SUITE RCV1"        # 6 个 e2e 必须全过
npx playwright test                        # 完整 realPipeline 36 passed / 4 skipped / 0 failed
```

UI 改动同步必须重拍截图：

```bash
npm run docs:screenshots
```

并人眼复核 `docs/images/screenshots/06-09` 四张是否正确（chip 行可见 / engine segmented 可见 / 试跑 0.5s 在 footer / 推荐预设 chip 在历史卡）。

---

## 4. 关联文件

**生产代码**：
- [src/renderer/components/ToolboxPanel.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/ToolboxPanel.tsx) — #1/#2/#3 的 ParamForm 区
- [src/renderer/components/ToolboxLineageModal.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/ToolboxLineageModal.tsx) — #4 试跑 0.5s 按钮 + 自动 cleanup
- [src/renderer/components/HistoryPanel.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/HistoryPanel.tsx) — #5 PresetChipStrip + #6 上传胶囊跳转
- [src/renderer/components/useToolbox.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/useToolbox.ts) — `applyPreset()` 原子 API + `defaultParamsFor`
- [src/main/ffmpeg.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/ffmpeg.ts) — `videoToGifGifski()`
- [src/main/binaries.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/binaries.ts) — `getGifskiPath()`
- [src/main/processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) — engine 分支调度 + `runToolboxTrialJob()`
- [src/main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) — `toolbox:trialRun` / `toolbox:trialCleanup` IPC handlers + `sanitizeToolboxParams`
- [src/main/tmpCleanup.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/tmpCleanup.ts) — `ALLOWED_PREFIXES` 加入 `giftk-trial-`
- [src/preload/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/index.ts) — `window.giftk.toolbox.{trialRun, trialCleanup}` 子命名空间
- [src/shared/types/toolbox.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types/toolbox.ts) — `ToolboxParams.engine`

**测试**：
- [tests/e2e/realPipeline/suite-r-compress-v1-ui.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/e2e/realPipeline/suite-r-compress-v1-ui.ts) — SUITE RCV1-A/B/C/D/E/F
- [tests/renderer/useToolbox.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/renderer/useToolbox.test.ts)
- [tests/renderer/HistoryPanel.test.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/tests/renderer/HistoryPanel.test.tsx)
- [tests/renderer/ParamForm-RCOMPRESSV1.test.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/tests/renderer/ParamForm-RCOMPRESSV1.test.tsx)

**文档**：
- [README.md § 体验加速包](file:///Users/guoshuyu/workspace/gif-toolkit/README.md)
- [docs/compression-pipeline.md § 9](file:///Users/guoshuyu/workspace/gif-toolkit/docs/compression-pipeline.md)
