# R-16 — 新功能必须随测试(Tests Are Mandatory)

> **触发场景**:
> 第 39 轮用户反馈："给所有功能增加测试用例，这样有利于回归测试功能的正常，
> 后续新加的每个功能也都要需要这个规则。"

---

## 强制约束

每一个 PR / commit 在被合并前,必须满足以下**全部**条件:

1. **新增的纯函数 / 组件 / IPC handler 必须配套测试**。"配套"=同一个 PR 里
   有对应的 `tests/**/*.test.{ts,tsx}` 文件,断言其行为契约(包括边界与失败路径)。
2. **修复 bug 时必须先写一个会因为该 bug 而失败的回归测试**,再修代码。
   提交时该测试必须从红变绿。这是"不再犯"的最低保证。
3. **`npm test` 必须 0 失败,且不允许 `it.skip` / `describe.skip` 兜底**。
   要跳过测试必须解释原因并 link issue。
4. **测试不能为了通过而被弱化或删除**(R-12 子条款)。要修的是代码,不是测试。
5. **覆盖率红线**:`src/main/helpers.ts`、`src/main/processor-utils.ts`、
   `src/renderer/components/**` 的行覆盖率不得低于已有水位。降覆盖率的 PR 必须
   在描述里说明原因。

## 例外清单(被显式豁免单测的模块)

下列模块强依赖 Electron / 真实二进制 / 远程网络,不要求单元测试。它们由
`harness/scenarios/` 下的回归场景兜底:

- `src/main/index.ts`(Electron 入口、窗口管理)
- `src/main/binaries.ts`(asar 解包路径解析)
- `src/main/sniffer.ts`(依赖真实 HTML 抓取,由 SC-07/SC-13/SC-14 覆盖)
- `src/main/headlessFetch.ts`(同上,需要真实 Chromium)
- `src/main/downloader.ts`(I/O,集成测试)
- `src/main/resolver/**`(yt-dlp 二进制,SC-13~SC-17 覆盖)
- `src/preload/**`(contextBridge 声明,typecheck 即检查)

如果这些模块里**有可纯化的子函数**(如 `helpers.ts` / `processor-utils.ts`
的抽离方式),**应当先抽出再测**,而不是把它们拉进豁免名单。

## 测试栈

- 框架:[vitest 2.1.8](file:///Users/guoshuyu/workspace/gif-toolkit/package.json) + `@vitest/coverage-v8`
- 渲染端:`happy-dom` + `@testing-library/react` + `@testing-library/jest-dom`
- 配置:[vitest.config.ts](file:///Users/guoshuyu/workspace/gif-toolkit/vitest.config.ts)
  - `environmentMatchGlobs: [['tests/renderer/**', 'happy-dom']]` —— 主进程
    测试用 node 环境,渲染端测试用 happy-dom,避免无谓启动开销。
  - `setupFiles: ['./tests/setup.ts']` —— 装载 jest-dom matchers + happy-dom
    polyfill (`URL.createObjectURL` / `matchMedia`)。
- 启动 Electron 的代码用 `vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))`
  让 `import` 不爆炸。

## 命令

```bash
npm test           # 一次性跑全部
npm run test:watch # 开发时监听
npm run test:coverage
```

## 验证步骤(SOP 第 4 步)

```bash
npm run typecheck
npm run lint
npm test           # ← R-16 新增的硬关卡
npm run build
```

四步全过才算通过门禁。任何一步失败都不允许提交 / 合并。

## 沉淀的回归测试入口

| 文件 | 覆盖范围 |
|---|---|
| [tests/main/helpers.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/helpers.test.ts) | `isPrivateHost` SSRF 名单 / `safeName` 路径净化 / `fileNameFor` 扩展名推断 |
| [tests/main/processor-utils.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/processor-utils.test.ts) | `clampConcurrency` / `shortSideAfterCap` / `compressCacheKey` / `planPhase0` / `adaptiveStartLossy` / `extrapolateNextLossy` / `geometricShrinkLongestSide` |
| [tests/main/ffmpeg-pure.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/ffmpeg-pure.test.ts) | `parseRational` 容错解析 |
| [tests/renderer/TaskTable.test.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/tests/renderer/TaskTable.test.tsx) | 重试按钮启用条件 / 防双击 / 警告详情弹窗 / 复制到剪贴板 |
