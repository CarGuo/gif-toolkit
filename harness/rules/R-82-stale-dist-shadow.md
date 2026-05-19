# R-82 — Stale dist shadow + UI default fallback + sanitize purity

**Status**: ratified · **Source**: 第 71 轮怒点(截图 + 文字)
"1、UI 不对; 2、默认值不对; 3、又整出新 bug 没测试 — `process:start` crash:
`TypeError: Cannot read properties of undefined (reading 'includes')` at sanitizeOptions"

## 一句话

R-77 把 `src/shared/types.ts` 拆成 `src/shared/types/` 目录,但旧的
**`dist/shared/types.js` 单文件残留没被清**。Node CommonJS 解析优先匹配
`.js` 文件而非同名目录,导致 main 进程加载到 5 月 18 日的旧 barrel,
新的 5 个常量(`GIF_OPTIMIZE_LEVELS` / `GIF_DITHER_MODES` / `GIF_LOSSY_MAX`
/ `GIF_COLORS_MIN` / `GIF_COLORS_MAX`)全是 `undefined`,renderer 一派发
`process:start` 立刻在 `(GIF_OPTIMIZE_LEVELS as readonly number[]).includes(lvl)`
上 crash。

## 五件,缺一不可

1. **#1 双保险 import** — main/preload 中**绝对不能**只依赖 barrel re-export
   解析新加的常量。新加常量的 import 必须**直接**指向其源文件:
   ```ts
   import { GIF_* } from '../shared/types/process';
   ```
   barrel `import {} from '../shared/types'` 仍可用于已稳定的旧导出。

2. **#2 build 前清 dist (硬规则)** — [package.json](file:///Users/guoshuyu/workspace/gif-toolkit/package.json) 必须挂:
   ```json
   "clean": "node -e \"require('fs').rmSync('dist',{recursive:true,force:true})\"",
   "predev:main": "node -e \"require('fs').rmSync('dist',{recursive:true,force:true})\"",
   "build": "npm run clean && npm run build:renderer && npm run build:main",
   ```
   不允许任何 build 路径跳过 clean(`tsc --build` 默认增量,**不会**清残留)。

3. **#3 sanitize 抽出纯模块 + 单测** — 任何在 main/index.ts 用到
   "外部常量做 enum membership 检查" 的代码必须抽成独立纯模块
   (本轮:[src/main/sanitizeOptions.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/sanitizeOptions.ts) 的 `sanitizeGifOptimizeKnobs`),
   并在 [tests/main/sanitizeOptions.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/sanitizeOptions.test.ts) 覆盖 happy / unhappy / edge,
   显式 regression 一条:
   ```ts
   it('R-82 regression: never throws on a normal renderer payload', () => {
     expect(() => sanitizeGifOptimizeKnobs({ optimizeLevel: 3, ... })).not.toThrow();
   });
   ```
   import 路径错配将立即被该 test fail 捕获。

4. **#4 NumField defaultValue 防御** — [OptionsForm.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/OptionsForm.tsx) `NumField`
   接受 `defaultValue?: number`,内部 `resolved = isFinite(value) ? value : defaultValue ?? min`;
   advanced-gif drawer 4 控件全部 `value={options.X ?? DEFAULT_OPTIONS.X}` + `defaultValue={DEFAULT_OPTIONS.X}`。
   **不允许**让 `min` 当 fallback(那会让 lossy 默认渲染成 `0`,colors 默认渲染成 `2`)。
   [ManualOptimizeModal.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/ManualOptimizeModal.tsx) 三层 fallback:`?? baseOptions.X ?? DEFAULT_OPTIONS.X ?? GIF_*_BOUND`。

5. **#5 advanced-gif 抽屉 CSS** — [styles.css](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/styles.css) 必须有
   `details.advanced-gif { grid-column: 1 / -1; }` + `.advanced-gif-grid` 子表格样式
   (2x2 grid + select width 100%);否则 4 个控件被父 grid 切到同一行宽度异常,
   `<select>` 在 macOS 默认外观下被压扁到 0 宽不可见。

## 反向(不允许)

- 任何新加 `GIF_*` / `IPC_*` / 任何 enum 常量后,只通过 barrel 导出 → 必须双保险
- build/dev 跳过 clean(`tsc --build` 增量产物天然有 stale 残留风险)
- sanitizeOptions 在 main/index.ts 内联(无法被纯单测覆盖)
- NumField 用 `min` 当默认显示值
- 用户怒点修复未跑 dev smoke 实派发任务即交付

## 验证(SOP 第 5 步,本规则强制)

- `node -e "const t=require('./dist/shared/types'); console.log(Object.keys(t));"`
  必须输出**完整**新常量名单(不再是旧两个 key)
- `npx vitest run tests/main/sanitizeOptions.test.ts` 全绿
- `npm run dev` 实派发一次 GIF 任务,主进程日志**无** `'includes'` TypeError
- OptionsForm 截图比对:lossy 上限 = 200 / colors 下限 = 2 / -O 级别 + dither 两 select 可见

## 沉淀来源

- [src/main/sanitizeOptions.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/sanitizeOptions.ts)
- [tests/main/sanitizeOptions.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/sanitizeOptions.test.ts)
- [package.json clean / predev:main / build](file:///Users/guoshuyu/workspace/gif-toolkit/package.json)
- [src/renderer/components/OptionsForm.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/OptionsForm.tsx)
- [src/renderer/components/ManualOptimizeModal.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/ManualOptimizeModal.tsx)
- [src/renderer/styles.css](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/styles.css)
