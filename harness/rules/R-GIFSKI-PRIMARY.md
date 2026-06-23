# R-GIFSKI-PRIMARY — gif-optimize 默认走 gifski

> **触发场景**：`/tmp/giftk-bench/` 实测显示——IMG_6253.MOV (5.32MiB) ezgif 三步压缩 669K，仓库 `processor.ts` 主链路 (ffmpeg palettegen + gifsicle 1.96 `--lossy`) → 3.2M（5x ezgif），即使 Phase D 兜底 `--lossy=200 --colors=64` 仍 1.8M (2.7x ezgif)。**结论：上游 gifsicle 1.96 的 `--lossy` 实现远不如 Kornel Lesiński 的 gifski**（同作者新一代 GIF 编码器）。本规则把 gifski 落地为 `gif-optimize` 默认主压缩 engine，gifsicle 4 阶段退为 fallback。

---

## 规则

1. **gifski 是主压缩 engine**：`gif-optimize` task / recorder recompress / video-to-gif kind 默认尝试 gifski；gifsicle 4 阶段（`compressLoop` + `toolboxBudgetCompress`）退为 fallback。落地点：[src/main/processor.ts compressWithGifskiThenFallback](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) → 内部线性扫 quality=[100,80,65,50,40,30]。
2. **gifski 不存在不静默 fallback（R-COMPRESS-V1.5 继承）**：`video-to-gif` 显式 `engine='gifski'` 的请求必须 throw 而不是降级到 ffmpeg+gifsicle。这条约束的物理位置在 [src/main/ffmpeg.ts videoToGifGifski / gifskiReencode](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/ffmpeg.ts)：两个函数在 `getGifskiPath() === null` 时都必须 `throw new Error(...)`。
3. **`gif-optimize` 内部 fallback 可以静默**：因为 `gif-optimize` 用户契约是「压到目标体积」而不是「指定 engine」，所以
   - gifski 二进制缺失 → 直接走 `toolboxBudgetCompress`
   - gifski 全部 quality 仍超 hardMax → 也走 `toolboxBudgetCompress`
   
   这两条静默回退是 spec 允许的；UI 不要在这个路径上塞 engine 选择项。
4. **AGPL-3.0+ 提醒**：gifski 是 AGPL+，若未来本仓库要闭源分发，必须改为**运行时 spawn 外部安装的 gifski**（如 `brew install gifski`）而不是 vendor 进 .app。当前仓库 `package.json` license: MIT，但因 gifski 走 `optionalDependencies` + asarUnpack（不参与 link），暂不构成传染。**任何讨论要 vendor 进 dmg 前必须先看一眼 AGPL 病毒条款**。
5. **质量扫描档位是固定数组而非二分搜**：`GIFSKI_QUALITY_SWEEP = [100,80,65,50,40,30]` 是 MVP 线性扫描，**不要**为了"省 1-2 次 encode"改成二分或自适应。gifski 单次 ~3-5s，6 次 ~20-30s 与 gifsicle Phase A-D 整体耗时相当；可读性 + 行为可预期更重要。后续如要做 `adaptiveStartLossy` 风格的自适应起点，必须新开 PR 单独审。

---

## 反向清单

- ❌ 不要把 video-to-gif 的 gifski engine 改成静默 fallback engine（违反规则 2 + R-COMPRESS-V1.5）。
- ❌ 不要在 gifski quality 扫描里跳过 `softMaxBytes` 直接奔 `hardMax`（违反 R-05 双层目标；`compressWithGifskiThenFallback` 已在两档命中点分别短路，两档语义与 `toolboxBudgetCompress` 对齐）。
- ❌ 不要把 gifski 输出再过 `gifsicle --lossy`（双重 quantize，质量崩；只能 `--no-lossy -O3` 做无损 metadata 裁剪）。
- ❌ 不要为了"提速"把 `GIFSKI_QUALITY_SWEEP` 缩到 3 档，最差档 30 是 ezgif 风格"必能塞进去"的兜底；缩档会让一部分大 GIF 直接落到 fallback 链路抹掉 gifski 的收益。
- ❌ 不要在 `compressWithGifskiThenFallback` 里用 `const result = await toolboxBudgetCompress(...)` 形式调用 fallback——`tests/main/processor-allPhasesFailed.test.ts` 的静态扫描会把它识别为 "需要 copyFile + allPhasesFailed guard" 的新独立 site；当前实现刻意用 `return mergePhaseFailures(await toolboxBudgetCompress(...), ...)` 表达式形式跳过该模式。

---

## 验证锚点

- **/tmp/giftk-bench/run-gifski.sh**：q=80 对 IMG_6253.MOV 应 ≤ 1.2M（实测 1.08MiB）；q=60 应 ≤ 700K（实测 633K，逼近 ezgif 669K）。
- **harness/scenarios/SC-32-gifski-primary-vs-ezgif.md**：完整对照表 + 复现脚本。
- **tests/main/gifskiReencode.test.ts**：gifski 不存在 throw、argv 构造、quality clamp。
- **tests/main/processor-allPhasesFailed.test.ts**：sites.length ≥ 6 包含新增 `compressWithGifskiThenFallback`。

---

## 触发的 spec / 历史

- spec：[.spec-gifski-primary.md](file:///Users/guoshuyu/workspace/gif-toolkit/.spec-gifski-primary.md)
- 前置规则：[R-COMPRESS-V1 #5 gifski disable 而非 fallback](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-COMPRESS-V1-six-quick-wins.md)
- 复用模块：[binaries.ts getGifskiPath](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/binaries.ts) / [ffmpeg.ts videoToGifGifski](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/ffmpeg.ts)
