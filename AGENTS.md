# AGENTS.md — Gif Toolkit Agent Harness

> 这是给**任何在本仓库写代码的 Agent / 协作者**的"操作手册"。
> 它不是 README(README 给最终用户看);**这一份是让你不要把现有约束改坏、不要重复造已经踩过的坑**。
>
> 灵感与方法论:["Harness Engineering" 知乎专题 / Mitchell Hashimoto 《Engineer the Harness》(2026.02) / OpenAI 《Harness engineering》(2026.02) / LangChain 《The Anatomy of an Agent Harness》(2026.03)](https://zhuanlan.zhihu.com/p/2014799697290753718)。
> 核心原则:**每发现一个错误,就把"它不再犯"的工程方案沉淀进 Harness**。

---

## 0. 一句话项目定位

输入文章 URL → 嗅探页面里的 video / gif → 选择 → 预览/裁剪/调速度 → 批量转 GIF → **双层目标自适应压缩(best 2MB / fallback 4MB)** → 落到本地子目录。

**Electron 桌面 App,主进程负责所有 I/O 和重活,渲染端只渲染 UI。** 任何"在浏览器侧调 ffmpeg"的提议都要拒绝。

---

## 1. Project Rules 索引(强制硬规则,违反即 PR block)

> 每条规则的**详细条款 / 反向清单 / 验证步骤**全部沉淀在
> [harness/rules/R-XX-*.md](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules)。
> 本表只做**索引 + 一句话**。改代码前**至少**翻同 ID 的 rule 文件。

| # | 一句话 | 详细 |
|---|---|---|
| **R-01** | 任何"嗅探"入口都必须走主进程,renderer 不许直接 fetch 跨域 | [R-01](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-01-sniff-must-go-through-main.md) |
| **R-02** | 不要为某个 host 加白名单,所有规则要结构化适用任意网页 | [R-02](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-02-no-host-whitelist.md) |
| **R-03** | maxSide 同时作用宽和高(取最长边),不能只调宽 | [R-03](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-03-maxside-applies-to-both-axes.md) |
| **R-04** | 压缩管线必须四阶段:resize → adaptive lossy 二分 → 几何缩边(longSideFloor)→ 兜底 | [R-04](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-04-four-phase-compression.md) |
| **R-05** | 双层目标:`softMaxBytes` (best 2MB) + `maxBytes` (fallback 4MB),UI 互相 clamp | [R-05](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-05-soft-and-hard-target.md) |
| **R-06** | 缩边时必须保短边 ≥ minSide,做不到就 throw `AspectRatioConstraintError` 早 fail | [R-06](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-06-shortside-floor.md) |
| **R-07** | 批处理走 PQueue,concurrency 默认 3 / 可配 1..8;不许硬编 1 不许无限并发 | [R-07](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-07-pqueue-concurrency.md) |
| **R-08** | 进度必须有 substep / detail / elapsedMs / stepIndex,不能只有一个 percent | [R-08](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-08-progress-richness.md) |
| **R-09** | iframe 第三方播放器(Vimeo / YouTube / Bilibili 等)只识别不下载,渲染端禁用按钮 | [R-09](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-09-iframe-embed-detect-only.md) |
| **R-10** | renderer 永远不许直接读本地路径或 child_process;contextIsolation ON,nodeIntegration OFF | [R-10](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-10-electron-isolation.md) |
| **R-11** | preload 暴露的 API 必须白名单,新增方法须同步 [global.d.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/global.d.ts) | [R-11](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-11-preload-whitelist.md) |
| **R-12** | 不要为了让一个测试通过就改测试,要改的是代码 | [R-12](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-12-do-not-evade-tests.md) |
| **R-13** | SPA / anti-bot 页面必须三级 fallback:静态正则 → headless → CF challenge 报警 | [R-13](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-13-spa-must-have-fallback.md) |
| **R-14** | embed resolver 必须随包分发 + 自动解析(开箱即用,无 confirm 弹窗) | [R-14](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-14-resolver-bundled.md) |
| **R-15** | npm 供应链卫生:`min-release-age=7d` + `ignore-scripts` allowlist + `save-exact` + `npm ci` + lockfile lint | [R-15](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-15-npm-supply-chain-hygiene.md) |
| **R-16** | 新功能必须随测试,修 bug 先写会失败的回归测试,`npm test` 0 失败硬关卡 | [R-16](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-16-tests-required.md) |
| **R-22** | 长视频默认只跑第 1 段(`maxSegmentSec=20`),`selectedSegments` 贯通 IPC | [R-22](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-22-clip-segment-cap.md) |
| **R-23** | 批处理前必须弹「分段选择」对话框,modal 取消 = 不派发 | [R-23](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-23-batch-confirm-modal.md) |
| **R-24** | ffmpeg single-pass + palettegen 抽帧 + yt-dlp `--download-sections` 多段下载 | [R-24](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-24-ffmpeg-single-pass-and-section-fetch.md) |
| **R-25** | UX 信号 + 默认收紧:加载 overlay / 缩略图 / 重复嗅探 confirm / `minSize=450` `concurrency=3` | [R-25](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-25-ux-signals-and-defaults.md) |
| **R-26** | 规格失败 vs 运行失败 二分;解析进度 amber 阶段化 chip;「强制允许」vs「重试」互斥 | [R-26](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-26-spec-vs-runtime-failure-and-resolve-progress.md) |
| **R-27** | 持久化历史 + 二次处理 + 打开历史目录;HistoryPanel 纯展示组件 | [R-27](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-27-history-panel.md) |
| **R-80** | 本地历史迁 better-sqlite3 + WAL + 外键;native ABI 自愈 + `before-quit` 两阶段 flush + dbErrorBus 单 toast | [R-80](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-80-sqlite-and-native-abi.md) |
| **R-81** | gifsicle 4 旋钮全链路:`lossyCeiling` / `colorsFloor` / `optimizeLevel` / `dither` ceiling vs lock 语义 | [R-81](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-81-gif-optimize-knobs.md) |
| **R-82** | 双保险 import 绕过 barrel + build 前清 dist + sanitize 抽纯模块单测 + NumField defaultValue 防御 | [R-82](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-82-stale-dist-shadow.md) |

---

## 2. 跨进程边界(Architecture Invariants)

```
┌─────────────────┐  IPC (contextBridge)   ┌──────────────────────┐
│   Renderer      │ ───────────────────►   │   Main process       │
│   React + Vite  │                        │   axios / cheerio    │
│   只渲染、只发请求 │ ◄─── 进度推送 ──────── │   ffmpeg / gifsicle  │
└─────────────────┘                        │   sharp / pqueue     │
                                           └──────────────────────┘
```

不变量:

- **renderer 永远不直接调 ffmpeg / 文件系统**;有需要就在 [preload](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/index.ts) 加白名单 IPC。
- **共享类型只放 [src/shared/types/](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types)**,主/渲两边都从这里 import。新加常量遵 R-82 双保险:**直接 import 源文件**而非 barrel。
- **二进制路径只通过 [src/main/binaries.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/binaries.ts)** 解析(asar.unpacked 修正在这里)。

---

## 3. 标准操作流程(SOP for Agents)

每一次 Agent 改代码,必须按这个顺序走:

1. **Read 触发场景** → 翻 [harness/scenarios/](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios) 看是否有同类问题已沉淀。如有,直接复用规则,**不再二次发明**。
2. **Plan** → 用 TodoWrite 列步骤;影响第 1 节任何 R-* 要在计划里点名。
3. **Execute** → 改代码。
4. **Verify** → **四步顺序执行,全部通过才算完成**:
   - `npm run typecheck`
   - `npm run lint`
   - `npm test` + 改了 [src/main/db/](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/db) **必须** `npm run test:db`(R-80 wrapper)
   - `npm run build`
5. **Smoke (R-80 #8 / R-82 铁规则)** — 改了 native module / db schema / IPC / preload bridge / `before-quit` / 共享 enum 常量,**必须**额外跑一次 `npm run dev` 实派发一次任务,主进程日志无 `compiled against a different Node.js version` / `UnhandledPromiseRejection` / `'includes' is undefined` / `db init failed` 才能交付。**测试通过 ≠ 功能可用**。
6. **Regress** → 跑 [harness/run-harness.md](file:///Users/guoshuyu/workspace/gif-toolkit/harness/run-harness.md) 中相关场景集。
7. **Capture** — 修了新发现的 bug,**必须在 [harness/scenarios/](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios) 新增 SC-XX**;新规则**必须**在 [harness/rules/](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules) 新增 R-XX。这是"不再犯"的唯一保证。

---

## 4. 调试与诊断命令(Diagnostics)

| 目的 | 命令 |
|---|---|
| 类型检查(主+渲) | `npm run typecheck` |
| Lint | `npm run lint` |
| 全量构建 | `npm run build`(自动 `clean`,R-82) |
| 开发热更 | `npm run dev`(自动 `predev:main` 清 dist,R-82) |
| 跑生产构建 | `npm start` |
| Mac 打 dmg | `npm run package:mac` |
| Win 打 nsis | `npm run package:win` |
| 嗅探规则命中 | `grep -nE "video-tag\|source-tag\|iframe-embed" src/main/sniffer.ts` |
| 主进程二进制路径 | `node -e "require('./dist/main/binaries.js').printPaths?.()"` |
| **db 测试套件**(R-80) | `npm run test:db` —— wrapper:`to-node → run → finally to-electron`,**禁止**手动两步走 |
| **better-sqlite3 ABI 自检** | `node scripts/ensure-sqlite-abi.mjs` —— 已挂 `predev` / `prestart`,可手动调 |
| **macOS dock tooltip 修复** | `node scripts/patch-electron-plist.mjs` —— 已挂 `postinstall` / `predev` / `prestart`,幂等 |
| **R-82 dist barrel 自检** | `node -e "console.log(Object.keys(require('./dist/shared/types')))"` —— 必须包含全部 `GIF_*` 常量 |

---

## 5. 常见陷阱清单(Foot-guns)

> 每条都是踩过的坑,触发时直接对照修。

1. **改了 [src/shared/types/](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types) 但忘了 [src/preload/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/index.ts) 同步** → `window.giftk.xxx` 是 undefined。
2. **新加 IPC handler 在主进程,但 [global.d.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/global.d.ts) 没补类型** → typecheck 红。
3. **直接修改 `compressLoop` 的某 Phase 而绕过 longSideFloor 守护** → 长条图被压扁、内存炸(违反 R-04 / R-06)。
4. **嗅探规则用裸字符串 `if (host === 'vimeo.com')`** → 违反 R-02。`matchEmbedProvider` 已结构化,继续往那张表里填。
5. **任务"卡住" → 大概率是 [TaskProgress](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types) 没带 substep**,先补 substep 再看代码层。
6. **打包后 ffmpeg 找不到** → 看 [package.json `asarUnpack`](file:///Users/guoshuyu/workspace/gif-toolkit/package.json) 是否覆盖了新引入的二进制依赖。
7. **新加 `GIF_*` / 任何 enum 常量后只走 barrel re-export** → 违反 R-82 双保险,生产可能走 stale dist;直接 `import { X } from '../shared/types/process'`。

---

## 6. 文档地图

- **[README.md](file:///Users/guoshuyu/workspace/gif-toolkit/README.md)** — 用户向,装/跑/用
- **AGENTS.md** — 你正在看的(协作者向,改代码前必读)
- **[docs/architecture.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/architecture.md)** — 主/渲/preload 三段式架构
- **[docs/sniffer-rules.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/sniffer-rules.md)** — 嗅探 7 条规则 + iframe player 白名单
- **[docs/compression-pipeline.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/compression-pipeline.md)** — Phase A/B/C/D 压缩管线
- **[docs/ipc-contract.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/ipc-contract.md)** — preload 暴露的所有 IPC 方法
- **[docs/troubleshooting.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/troubleshooting.md)** — 故障分类与对应规则
- **[docs/embed-resolver.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/embed-resolver.md)** — yt-dlp resolver 设计
- **[harness/](file:///Users/guoshuyu/workspace/gif-toolkit/harness)** — 工程级 harness
  - **[harness/run-harness.md](file:///Users/guoshuyu/workspace/gif-toolkit/harness/run-harness.md)** — 怎么跑 harness
  - **[harness/rules/](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules)** — R-01..R-16 + R-22..R-27 + R-80..R-82 细化版,每条一个文件
  - **[harness/scenarios/](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios)** — SC-01..SC-XX 已沉淀的回归场景
  - **[harness/checklists/pr-checklist.md](file:///Users/guoshuyu/workspace/gif-toolkit/harness/checklists/pr-checklist.md)** — 改前自检清单

---

## 7. 写完代码后的"门禁清单"

> 复制以下清单粘到 PR / 提交说明,逐条打勾。

- [ ] 我读了第 1 节 R-* 索引,没违反任何一条;改动直接关联的 rule 文件已细读
- [ ] 我读了 [harness/scenarios/](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios),没让任何已有 SC 失效
- [ ] `npm run typecheck` / `npm run lint` / `npm test` / `npm run build` 4 步全绿
- [ ] 改了主/渲共享类型 → preload + global.d.ts 已同步
- [ ] 改了 native module / db / preload / before-quit / 共享常量 → `npm run dev` 已 smoke 实派发任务
- [ ] 修了新发现的 bug → [harness/scenarios/](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios) 增了 SC-XX;新规则增了 [harness/rules/](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules) R-XX
- [ ] PR 描述写清"踩了哪条 R-* / 触发了哪个 SC-*"

---

## 8. 拿不准时

1. 先看 [harness/rules/](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules) — 大概率别人已踩过。
2. 再看 [harness/scenarios/](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios) — 把现象分类。
3. 还不行 — 用 AskUserQuestion 问用户,**不要自己猜**。猜一次错一次,得不偿失。
