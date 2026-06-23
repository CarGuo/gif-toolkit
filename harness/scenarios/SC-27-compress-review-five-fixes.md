# SC-27 — compressLoop / gifsicleMethod 五件 review 修复

> **来源**：2026-XX 用户要求"全面 review 下项目，目前的压缩功能是否
> 合理，是不是存在问题"。TRAE-code-review skill 跑下来命中 5 件 bug，
> 用户确认"全部修"。
> **关联规则**：[R-COMPRESS-V2](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-COMPRESS-V2-loop-coherence.md)
> / [R-04](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-04-four-phase-compression.md)
> / [R-05](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-05-soft-and-hard-target.md)
> / [R-12](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-12-do-not-evade-tests.md)
> / [R-16](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-16-tests-required.md)
> / [R-81](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-81-gif-optimize-knobs.md)
> / [R-82](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-82-stale-dist-shadow.md)

---

## 现象（被 review 揪出的隐性 bug，不是用户直接报）

| ID | 文件 | 隐性现象 |
|---|---|---|
| C-01 | [processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) ↔ [processor-utils.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor-utils.ts) | `adaptiveStartLossy` 双份实现：生产用 inline `30/60/...`，单测打的是 utils `20/40/...`。改一份永远不会被测试发现 |
| C-02 | [processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) `lossySearch` | first-try `lastSize <= target` 直接 return，不走 ACCEPT_TOL 对称早退。best=2MB 请求实测落在 0.5-1.0MB，肉眼可见过压 |
| C-03 | [ffmpeg.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/ffmpeg.ts) `gifsicleMethod('color-reduction')` | picker 命名暗示"只调色，不抖动"，实际在 `colors<256 && opts.dither!=='none'` 时悄悄加 `--dither=floyd-steinberg`。`'color-dither'` picker 失去 A/B 意义 |
| C-04 | [processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) Phase C/D | `imageResizeKeepAspect(inputGif, …)` 看起来像 bug（应该传 curSrc 才"对称"），但实际是**有意从原图重解码**避免双重 quantise。缺注释 → 下次 refactor 一定踩 |
| C-05 | [processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) `recordBest` | 旧逻辑在 already-under-soft 时仍然接受 **更大** 的候选（"better quality"），导致 best 从 1.4MB 漂到 1.99MB，浪费 softCap |

## 根因

5 件全部是"**约定散落在多个文件、没有 single source of truth**"型问题。
TRAE-code-review skill 通过对照
- [processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) 内联实现
- [processor-utils.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor-utils.ts) 导出实现
- [tests/main/processor-utils.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/processor-utils.test.ts)
- [tests/main/gifsicleMethod.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/gifsicleMethod.test.ts)
- 同名 doc 注释

发现"测试覆盖 ≠ 生产代码"、"picker 命名 ≠ 实际 argv"。

## 修复（已落地）

| C-XX | 文件 / 行号 | 关键改动 |
|---|---|---|
| C-01 | [processor.ts#L518-L526](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts#L518-L526) | 删除内联阶梯，改为 `adaptiveStartLossyLocal` wrapper → forward 到 utils 版本，唯一 source of truth |
| C-02 | [processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) `lossySearch` + [processor-utils.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor-utils.ts) 新增 `decideEarlyAccept` | 三返 `'accept'/'refine-shrink'/'refine-grow'`，对称 ±ACCEPT_TOL |
| C-03 | [ffmpeg.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/ffmpeg.ts) `'color-reduction'` | 删除 `ditherArgFor` helper，硬编 `--no-dither` |
| C-04 | [processor.ts#L677](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts#L677) + [#L738](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts#L738) | 加 `// C-04 — deliberately decode from the ORIGINAL inputGif` 注释，钉住意图 |
| C-05 | [processor.ts#L452-L464](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts#L452-L464) + [processor-utils.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor-utils.ts) 新增 `shouldReplaceBest` | 三档 tier + same-tier smaller-wins + tie 保留 current |

## 测试

- 新增：[tests/main/processor-utils.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/processor-utils.test.ts)
  6 case `decideEarlyAccept` + 7 case `shouldReplaceBest`。
- 改写：[tests/main/gifsicleMethod.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/gifsicleMethod.test.ts)
  删除 4 个 pin 旧 'color-reduction' dither 行为的过时测试（**R-12 例外**：
  显式声明这 4 个 case pin 的就是 C-03 修复的 bug；新增 6 case 锁定
  "no-dither / opts override / color-dither 仍带 dither / 256-colors
  仍 --no-dither" 不变量）。
- `npm run test:fast` 887 / 887 pass。
- `npm run test:e2e:smoke` SUITE SMOKE-S1-FULL-A pass；SUITE-S1-FULL-B
  `app.close()` afterAll 超时，但 **stash 我的修改 + 基线复跑**复现同样
  失败 → 与本轮压缩修改无关，是 Playwright Electron 收尾稳定性问题
  （已在交付报告中说明，建议归到后续 SC-XX 单独跟踪）。

## 防回归

按 R-COMPRESS-V2 五个子条款，未来任何改动到
[src/main/processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts)
/ [src/main/processor-utils.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor-utils.ts)
/ [src/main/ffmpeg.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/ffmpeg.ts)
的人都被强制要求过两套单测 + 不变量。
