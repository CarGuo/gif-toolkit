# AGENTS.md — Gif Toolkit Agent Harness

> 这是给**任何在本仓库写代码的 Agent / 协作者**的"操作手册"。  
> 它不是 README(README 给最终用户看,告诉你这个 App 是干嘛的)。  
> 这一份是**让你不要把现有约束改坏、不要重复造已经踩过的坑**。
>
> 灵感与方法论:["Harness Engineering" 知乎专题 / Mitchell Hashimoto 《Engineer the Harness》(2026.02) / OpenAI 《Harness engineering》(2026.02) / LangChain 《The Anatomy of an Agent Harness》(2026.03)](https://zhuanlan.zhihu.com/p/2014799697290753718)。
> 核心原则:**每发现一个错误,就把"它不再犯"的工程方案沉淀进 Harness**。

---

## 0. 一句话项目定位

输入文章 URL → 嗅探页面里的 video / gif → 选择 → 预览/裁剪/调速度 → 批量转 GIF → **双层目标自适应压缩(best 2MB / fallback 4MB)** → 落到本地子目录。

**这是一个 Electron 桌面 App,主进程负责所有 I/O 和重活,渲染端只渲染 UI。** 任何要"在浏览器侧调 ffmpeg"的提议都要拒绝。

---

## 1. Agent 必须遵守的项目级硬规则(Project Rules)

| # | 规则 | 触发场景 | 沉淀来源 |
|---|---|---|---|
| **R-01** | **任何"嗅探"入口都必须走主进程**,绝不许 renderer 直接 fetch 跨域资源 | renderer CORS / cookie 政策不一样,远端站会偶发拒绝 | [src/main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) `ipcMain.handle('sniff:url')` |
| **R-02** | **不要为某个 host 加白名单**;所有规则要结构化,适用于任意网页 | 第 14/15 轮用户反馈"我要的是通用实现,不是针对某个 url 进行特定化处理" | [sniffer.ts dedupKey](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/sniffer.ts) |
| **R-03** | **maxSide 同时作用于宽和高,取最长边**;不能只调宽 | 第 17 轮 "应该是宽和高都需要满足最大那个设置" | [shortSideAfterCap](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts#L77-L81) |
| **R-04** | **压缩管线必须四阶段**:Phase A resize-first → Phase B adaptive lossy 二分 → Phase C 几何缩边(longSideFloor 守护) → Phase D 兜底 | 第 16 轮 "为什么压缩那么慢?ezgif 实现很快" | [compressLoop](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) |
| **R-05** | **双层目标**:`softMaxBytes`(默认 2MB,best)+ `maxBytes`(默认 4MB,fallback);UI 上 soft ≤ hard 互相 clamp | 第 17 轮 "最佳目标 2M 以内,降级目标 4M" | [DEFAULT_OPTIONS](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types.ts) / [OptionsForm.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/OptionsForm.tsx) |
| **R-06** | **缩边时必须保短边 ≥ minSide**;若做不到,**抛 [AspectRatioConstraintError](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts#L46-L70) 早 fail**,而不是压扁出垃圾文件 | 第 18 轮 "改高让宽超过最小就要直接提示问题" | longSideFloor 推导 |
| **R-07** | **批处理走 PQueue**,concurrency 默认 3、可配置 1..8;不要硬编码 1 也不要无限并发 | 第 16 轮 "能并行执行吗" | [ProcessOptions.concurrency](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types.ts) |
| **R-08** | **进度必须有 substep / detail / elapsedMs / stepIndex**,不能只有一个 percent | 第 16 轮 "进度信息太少,看起来卡住" | [TaskProgress](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types.ts) |
| **R-09** | **iframe 第三方播放器(Vimeo / YouTube / Bilibili 等)只识别不下载**;在 SniffedMedia 上设 `requiresExternalDownload: true`,渲染端禁用"处理"按钮 | 用户最新一轮反馈 "OpenAI mhtml 里其实是有视频的,为什么会嗅探不出来" + 拍板"不集成 yt-dlp" | [matchEmbedProvider](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/sniffer.ts#L51-L78) |
| **R-10** | **renderer 永远不许直接读本地路径或运行 child_process**;contextIsolation 永远 ON,nodeIntegration 永远 OFF | Electron 安全基线 | [BrowserWindow webPreferences](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) |
| **R-11** | **preload 暴露的 API 必须白名单**;新增方法须同步更新 [src/preload/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/index.ts) 和 [src/renderer/global.d.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/global.d.ts) | 否则 `window.giftk.foo` 在生产构建里就是 undefined | — |
| **R-12** | **不要为了让一个测试通过就改测试,要改的是代码** | 全局 SOP | — |
| **R-13** | **SPA / anti-bot 页面必须走「静态正则 → headless → CF challenge 报警」三级 fallback**:1) 规则 8 用宽松正则在 `<script>` JSON payload 里抽 player URL;2) `noMedia ‖ looksTooShort ‖ looksLikeCsr` 任一即触发 [headlessFetch](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/headlessFetch.ts);3) 命中 Turnstile / Just-a-moment 时显式 warning。同时 main 入口必须 `app.commandLine.appendSwitch('disable-quic')`,否则部分网络上 Chromium 会 ERR_CONNECTION_RESET。**任何 sniffer 改动都必须先用真实 OpenAI URL 跑通 e2e 才能交付** | 第 23 轮 "OpenAI 还是测试不出来,你不应该测试下这个嗅探成功了才交付吗?" | [extractFromHtml](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/sniffer.ts) 规则 8 + [headlessFetch.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/headlessFetch.ts) + [SC-07](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-07-spa-hydrated-iframe-fallback.md) |
| **R-14** | **embed resolver 随包分发 + 自动解析(开箱即用)**:1) `electron-builder.asarUnpack` 必须包含 `node_modules/ytdlp-nodejs/bin/**`,yt-dlp 二进制随 dmg/installer 分发,**不允许**在 `build.files` 排除该路径;2) 嗅探完成后 `App.tsx useEffect([result])` 自动批量调起 `resolveEmbed`,**不得**有任何 `confirm()` 弹窗 / `installYtdlp` IPC / `ytdlp-chip` 状态徽章;3) resolver 内部 4 级 fallback 找 binary(packaged → dev node_modules → helpers.BIN_DIR → userData/bin → helpers.downloadYtDlp 兜底);4) resolver 失败 / 上游拒绝时 embed 卡片必须保留 + 显示 `↻ 重试解析` 小按钮 + `resolveErrorMap` 守卫(永不卡死、永不循环);5) resolver target 必须是 `media.url`(iframe `src`),不是 `media.pageUrl`(文章页);6) header 沿用必须经白名单(User-Agent/Referer/Origin/Accept-*/Range/X-CSRF-Token/X-Requested-With),禁止 Authorization/Cookie/Set-Cookie/Host 沿用;7) log buffer 写入前必须 `redactUrls()` 脱敏。**改 resolver 必须先验证 YouTube + Bilibili must-pass 才能交付** | 第 29 轮 "没必要,我们要提供的是开箱即用的功能,都打包进去,没必要做这种未装的情况" | [resolver/ytdlp.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/resolver/ytdlp.ts) + [resolver/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/resolver/index.ts) + [SC-13](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-13-resolver-opt-in.md) / [SC-14](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-14-resolver-bilibili.md) / [SC-15](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-15-resolver-failure-fallback.md) |

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
- **共享类型只放 [src/shared/types.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types.ts)**;主/渲两边都从这里 import,杜绝结构漂移。
- **二进制路径只通过 [src/main/binaries.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/binaries.ts)** 解析(asar.unpacked 修正在这里)。

---

## 3. 标准操作流程(SOP for Agents)

每一次 Agent 改代码,必须按这个顺序走:

1. **Read 触发场景** → 翻 [harness/scenarios/](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios) 看是否有同类问题已有沉淀。如果有,直接复用规则,**不再二次发明**。
2. **Plan** → 用 TodoWrite 列出步骤;影响 R-01..R-13 中任何一条要在计划里点名。
3. **Execute** → 改代码。
4. **Verify** → 三步顺序执行,**全部通过才算完成**:
   - `npm run typecheck`
   - `npm run lint`
   - `npm run build`
5. **Regress** → 跑 [harness/run-harness.md](file:///Users/guoshuyu/workspace/gif-toolkit/harness/run-harness.md) 中和你改动相关的场景集。
6. **Capture** → 如果你这次修了一个新发现的 bug,**必须在 [harness/scenarios/](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios) 中新增一个 SC-XX**,把现象 / 根因 / 期望行为 / 验证步骤都写下来。这是"不再犯"的唯一保证。

---

## 4. 调试与诊断命令(Diagnostics)

| 目的 | 命令 |
|---|---|
| 类型检查(主+渲) | `npm run typecheck` |
| Lint | `npm run lint` |
| 全量构建 | `npm run build` |
| 开发热更 | `npm run dev` |
| 跑生产构建 | `npm start` |
| Mac 打 dmg | `npm run package:mac` |
| Win 打 nsis | `npm run package:win` |
| 探一下嗅探规则的命中(grep) | `grep -nE "video-tag\|source-tag\|iframe-embed" src/main/sniffer.ts` |
| 看主进程二进制路径 | `node -e "require('./dist/main/binaries.js').printPaths?.()"` |
| 真实 e2e(yt-dlp resolver) | 直接在 main 进程层用 `new YtDlp({ binaryPath: ensureYtdlp() }).getInfoAsync(url)` 探测 YouTube + Bilibili must-pass case |

---

## 5. 常见陷阱清单(Foot-guns)

> 每一条都是"踩过的坑",触发时直接对照修。

1. **改了 [src/shared/types.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types.ts) 但忘了 [src/preload/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/index.ts) 同步**:`window.giftk.xxx` 是 undefined。
2. **新加 IPC handler 在主进程,但 [src/renderer/global.d.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/global.d.ts) 没补类型**:typecheck 红。
3. **直接修改 `compressLoop` 的某一个 Phase 而绕过 longSideFloor 守护**:长条图被压扁、内存炸。
4. **新加嗅探规则用裸字符串 `if (host === 'vimeo.com')`**:违反 R-02,扩展性归零。`matchEmbedProvider` 已经把"白名单"做成结构化规则,**继续往那张表里填**。
5. **看到任务"卡住"就以为死锁**:大概率是 [TaskProgress](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types.ts) 没带 substep。**先去补 substep,再考虑代码层**。
6. **打包后 ffmpeg 找不到**:看 [package.json `asarUnpack`](file:///Users/guoshuyu/workspace/gif-toolkit/package.json#L61-L68) 是否覆盖了你新引入的二进制依赖。

---

## 6. 文档地图

- **[README.md](file:///Users/guoshuyu/workspace/gif-toolkit/README.md)** —— 用户向,装/跑/用
- **[AGENTS.md](file:///Users/guoshuyu/workspace/gif-toolkit/AGENTS.md)** —— 你正在看的(协作者向,改代码前必读)
- **[docs/architecture.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/architecture.md)** —— 主/渲/preload 三段式架构详解
- **[docs/sniffer-rules.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/sniffer-rules.md)** —— 嗅探 7 条规则 + iframe player 白名单
- **[docs/compression-pipeline.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/compression-pipeline.md)** —— Phase A/B/C/D 压缩管线 & longSideFloor
- **[docs/ipc-contract.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/ipc-contract.md)** —— preload 暴露的所有 IPC 方法及消息类型
- **[docs/troubleshooting.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/troubleshooting.md)** —— 故障分类与对应规则
- **[docs/embed-resolver.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/embed-resolver.md)** —— yt-dlp resolver 设计(随包分发 + 自动解析)、e2e 验证
- **[harness/](file:///Users/guoshuyu/workspace/gif-toolkit/harness)** —— 工程级 harness 规则与回归场景库
  - **[harness/run-harness.md](file:///Users/guoshuyu/workspace/gif-toolkit/harness/run-harness.md)** —— 怎么跑 harness
  - **[harness/rules/](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules)** —— R-01..R-14 的细化版,每条一个文件
  - **[harness/scenarios/](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios)** —— SC-01..SC-15 已沉淀的回归场景
  - **[harness/checklists/pr-checklist.md](file:///Users/guoshuyu/workspace/gif-toolkit/harness/checklists/pr-checklist.md)** —— 改前自检清单

---

## 7. 你写完代码以后的"门禁清单"

> 复制以下清单粘到你 PR / 提交说明里,逐条打勾。

- [ ] 我读了 AGENTS.md 第 1 节(R-01..R-14),没违反任何一条
- [ ] 我读了 [harness/scenarios/](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios),确认我的改动没有让任何已有 SC 失效
- [ ] `npm run typecheck` 通过
- [ ] `npm run lint` 通过(0 warning)
- [ ] `npm run build` 通过
- [ ] 如果改了主/渲共享类型 → preload 和 global.d.ts 已同步
- [ ] 如果修了一个新发现的 bug → 已在 [harness/scenarios/](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios) 增加 SC-XX 沉淀
- [ ] PR 描述里写清"踩了哪条 R-* / 触发了哪个 SC-*"

---

## 8. 当你拿不准时

1. 先看 [harness/scenarios/](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios) — 大概率别人已经踩过类似坑。
2. 再看 [docs/troubleshooting.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/troubleshooting.md) — 把现象分类。
3. 还不行 — 用 AskUserQuestion 问用户,**不要自己猜**。猜一次错一次,一次错一个 SC,得不偿失。
