# harness/run-harness.md

> 怎么跑一遍 harness 回归。**本仓库已经接入 vitest + Playwright e2e**——
> 静态门禁与动态回归都已自动化，下面表格说明三档测试入口、它们覆盖的范围、
> 以及 SC 文档里手动复演步骤仍然有效的边界情况。

---

## 1. 静态门禁（每次提交必跑，~10 秒）

```bash
cd gif-toolkit
npm run typecheck   # 主+渲 tsc --noEmit
npm run lint        # eslint 0 warning
npm run build       # 主+渲全量构建（自动 clean，R-82）
```

三个全部退出 0 才算静态门禁通过。**任何一项红 → 不允许进入下面的动态回归**。

---

## 2. 测试三档（fast / smoke / all）

| 命令 | 范围 | 时长 | 适用场景 |
| ---- | ---- | ---- | -------- |
| `npm run test:fast` | vitest 单测（main / renderer / shared 全契约层，55 文件 / 831 cases） | ~6s | 本地写代码、commit 前 |
| `npm run test:e2e:smoke` | 真实 Electron 启动 + offline-import → process → mock-oss 上传 → SQLite 回写整链（2 cases） | ~10s（含 build） | PR 自检、改 IPC / uploader / processor 时 |
| `npm run test:e2e` | 完整 Playwright 真实管线（122 / 127，5 skipped 是 R-PRESET-PRUNE-V1 等正确 skip） | ~1.5min | 发版前、改 renderer 主流程时 |
| `npm run test:all` | 三档串跑 | ~2min | 最严格本地全闸 |

`smoke` 档使用 [playwright.smoke.config.ts](file:///Users/guoshuyu/workspace/gif-toolkit/playwright.smoke.config.ts)，
testDir 指向 [tests/e2e-smoke/](file:///Users/guoshuyu/workspace/gif-toolkit/tests/e2e-smoke)，
与 [tests/e2e/](file:///Users/guoshuyu/workspace/gif-toolkit/tests/e2e) 隔离；
关键产物上传走 `mock-oss://<sha8>.<ext>` 短路（`GIFTK_E2E_MOCK_UPLOAD=1` env + `!app.isPackaged` 双守卫，release 包永远不命中）。

> 改 [src/main/db/](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/db) 时 **必须** 额外跑 `npm run test:db`（R-80 wrapper：`to-node → run → finally to-electron`，禁止手动两步走）。

---

## 3. 动态回归（按改动影响的 SC 集跑）

每个 SC 都有"复演步骤 + 期望产物"。按下面这张映射表，**找到你这次改动影响哪些规则，把对应的 SC 全跑一遍**。SUITE 列指 [tests/e2e/realPipeline](file:///Users/guoshuyu/workspace/gif-toolkit/tests/e2e/realPipeline) 内已经把 SC 自动化掉的 e2e 套件——能跑自动化就跑自动化，跑不了的（涉及登录态 / Cloudflare / Electron crash 等环境敏感场景）按 SC 文档手动复演。

| 你改了… | 必跑场景 | 已自动化的 SUITE |
|---|---|---|
| [src/main/sniffer.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/sniffer.ts) | SC-01 / SC-04 / SC-08 / SC-11 | SUITE NETWORK-SNIFF / SUITE OFFLINE-SNIFF / SUITE CANCEL-ROBUST |
| [src/main/processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) | SC-02 / SC-03 / SC-05 / SC-06 / SC-09 / SC-17 / SC-18 / SC-19 | SUITE CONVERSION-CORE / SUITE PROCESS-CANCEL / SUITE COMPRESSION-ISOLATION-ORACLES / SUITE SEGMENT-TRIM-REOPTIMIZE |
| [src/main/uploader/](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/uploader) | — | SUITE UPLOAD-FULL / SUITE UPLOAD-NEGATIVE + 必跑 `npm run test:e2e:smoke` |
| [src/shared/types/](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types) | **全部**（共享类型变化波及面最大） | 全 SUITE |
| [src/preload/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/index.ts) | 全部（白名单挂错前端就空白） | SUITE EVENT-WIRE / SUITE DB-IPC / SUITE SESSION-LOGS-IPC |
| [src/renderer/components/OptionsForm.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/OptionsForm.tsx) | SC-03 / SC-06 | SUITE UI-FULL-PIPELINE |
| [src/renderer/components/MediaGrid.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/MediaGrid.tsx) | SC-04 | SUITE UI-FULL-PIPELINE |
| [src/renderer/App.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/App.tsx) | SC-04 / SC-05 | SUITE APP-SHELL / SUITE CROSS-TAB-ISOLATION |
| [src/main/resolver/](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/resolver) | SC-13 / SC-14 / SC-15 / SC-16 | （主要靠手动复演 + vitest 中的 [ytdlpDirectSniff.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/ytdlpDirectSniff.test.ts)） |
| [src/main/tray.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/tray.ts) / [globalShortcut.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/globalShortcut.ts) | SC-20 / SC-21 | （平台敏感，手动复演） |
| [src/main/tmpCleanup.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/tmpCleanup.ts) | SC-22 | [tests/main/tmpCleanup.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/tmpCleanup.test.ts) |

---

## 4. SC 单条复演法（不能自动化的场景）

每个 SC 文件结构:

```
## 触发条件     ← 输入是什么
## 期望行为     ← 应该输出什么
## 反向断言     ← 不应该输出什么(关键!防止"碰巧通过")
## 复演步骤     ← 你照着点就行
## 关联规则     ← 出问题时回去查的总规约
```

**手工跑一条 SC 时**:

1. 启动 `npm run dev`
2. 复演 "复演步骤" 里的输入(可能是粘 URL / 上传文件 / 调参数)
3. 对照 "期望行为" 看 UI / 日志 / 输出文件
4. **再** 对照 "反向断言" — 比如 SC-02 不能仅看到"早 fail"就过,还要确认**没有产出畸变文件**
5. 都符合 → 标 `PASS`(在 PR 描述写 `SC-02: PASS`)
6. 不符合 → **不要修测试,改代码** ([R-12](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-12-do-not-evade-tests.md))

---

## 5. 运行结果记录(在 PR 里贴)

复制下面的模板到 PR 描述:

```
## Harness 回归

### 静态
- [x] npm run typecheck
- [x] npm run lint
- [x] npm run build

### 测试三档
- [x] npm run test:fast            (831 / 831)
- [x] npm run test:e2e:smoke       (2 / 2)
- [x] npm run test:e2e             (122 / 127, 5 expected-skip)

### 动态(根据改动影响的 SC，未自动化的部分)
- [x] SC-04 iframe-embed-vimeo (PASS, 手动复演)
- [ ] SC-20 tray-menu-smoke   (N/A 本次未触及托盘)
```

**N/A 的项必须给出"为什么没跑"的理由**,不能空着。

---

## 6. 当 SC / SUITE 失败时

1. **首要假设是代码错了，不是测试错了**（[R-12](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-12-do-not-evade-tests.md)）
2. 重读对应的 R-XX 规则文档
3. 看是否触发了某个边界条件 → 修代码
4. 修完再跑一次该 SUITE / SC + 它强相关的两个（防止"修一个引出三个"）

---

## 7. Smoke vs UI dev（什么时候跑 `npm run dev`）

测试三档全绿仍**不等于**功能可用。改了下列任一项，必须额外跑一次 `npm run dev` 实派发一次任务，主进程日志无 `compiled against a different Node.js version` / `UnhandledPromiseRejection` / `'includes' is undefined` / `db init failed` 才能交付：

- native module（better-sqlite3 / sharp / ffmpeg-static / gifsicle）
- db schema / IPC handler / preload bridge
- `before-quit` 生命周期钩子
- 共享 enum 常量 / barrel re-export（R-82）

> 测试通过 ≠ 功能可用 —— 见 [AGENTS.md §3](file:///Users/guoshuyu/workspace/gif-toolkit/AGENTS.md) 第 5 步。
