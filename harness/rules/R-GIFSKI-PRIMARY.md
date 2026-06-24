# R-GIFSKI-PRIMARY — gif-optimize 默认走 gifski

> **触发场景**：`/tmp/giftk-bench/` 实测显示——IMG_6253.MOV (5.32MiB) ezgif 三步压缩 669K，仓库 `processor.ts` 主链路 (ffmpeg palettegen + gifsicle 1.96 `--lossy`) → 3.2M（5x ezgif），即使 Phase D 兜底 `--lossy=200 --colors=64` 仍 1.8M (2.7x ezgif)。**结论：上游 gifsicle 1.96 的 `--lossy` 实现远不如 Kornel Lesiński 的 gifski**（同作者新一代 GIF 编码器）。本规则把 gifski 落地为 `gif-optimize` 默认主压缩 engine，gifsicle 4 阶段退为 fallback。

---

## 规则

1. **gifski 是主压缩 engine（v2 起：唯一 lossy engine）**：`gif-optimize` task / recorder recompress / video-to-gif kind / 嗅探批处理 (`compressLoop`) 默认都先尝试 gifski。落地点：
   - [src/main/processor.ts compressWithGifskiThenFallback](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) — gif-optimize 唯一入口
   - [src/main/processor.ts compressLoop](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) — 在 Phase A 之后、Phase B 之前插入 gifski 短路；命中 soft 直接 return，否则结果通过 `shouldReplaceBest` 喂回 best 跟踪，再走 Phase B-D
   - 任意调用 `toolboxBudgetCompress` / `compressLoop` 的 5 个 fan-out 点都自动受益
2. **gifski 不存在不静默 fallback（R-COMPRESS-V1.5 继承 + v2 收紧）**：
   - `video-to-gif` 显式 `engine='gifski'` 仍必须 throw（保持原 R-COMPRESS-V1.5）
   - **v2 新增**：`compressWithGifskiThenFallback` 不再有「gifski 缺失 → 走 gifsicle」分支。gifski 是 bundled optionalDependency + asarUnpack，缺失视为结构性安装失败，直接 throw `gifski binary missing`。
   - `compressLoop` 入口判断 `getGifskiPath()` 缺失时跳过短路、安静走老 Phase A-D 兜底（这是为了不让"机器临时少了二进制"把整批嗅探/录屏 recompress 全炸），但**不再有"gifski 失败再 fallback gifsicle"**的二次降级。
3. **v2 自适应外推算法替代线性扫描**：旧 `GIFSKI_QUALITY_SWEEP = [100,80,65,50,40,30]` 已废弃。新算法基于经验模型 `size ≈ k · q^2`：
   - 第 1 次：probe `q=GIFSKI_Q_PROBE=80`
   - 第 2 次：单样本外推 `qNext = q · sqrt(target / sizeMB)`
   - 第 3 次：两样本 log-log 拟合 `refineGifskiQuality(q1,mb1,q2,mb2,target)`
   - 命中 `decideGifskiAccept` ±12% tol 或耗尽 `GIFSKI_MAX_TRIES=3` 即停
   - 最佳产物用 `shouldReplaceBest` 在 soft/hard 两档 band 中选 winner（与 compressLoop 一致）
   - 全部纯函数在 [src/main/processor-utils.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor-utils.ts)：`nextGifskiQuality` / `predictGifskiQuality` / `refineGifskiQuality` / `decideGifskiAccept`
   - 单测：[tests/main/processor-utils.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/processor-utils.test.ts) 含 19 case 锁边界
4. **AGPL-3.0+ 提醒**：gifski 是 AGPL+，若未来本仓库要闭源分发，必须改为**运行时 spawn 外部安装的 gifski**（如 `brew install gifski`）而不是 vendor 进 .app。当前仓库 `package.json` license: MIT，但因 gifski 走 `optionalDependencies` + asarUnpack（不参与 link），暂不构成传染。**任何讨论要 vendor 进 dmg 前必须先看一眼 AGPL 病毒条款**。
5. **GIFSKI_MAX_TRIES 上限不要扩**：3 次是经验值——典型 in-the-ballpark clip 1-2 次收敛，离谱大小最差 3 次仍能定到 ±12% tol。**不要**为了挤最后 5% 体积扩到 5/6/7 次——线性扫的成本回来了，违背 v2 改造的初衷。
6. **几何缩边仍是 compressLoop 的 Phase C/D 独占职责**：gifski 自身不会动尺寸，所以 compressLoop 在 gifski 未达 soft 时回到 Phase B-D 是有意义的（剩余知识是几何 shrink）。**不要**把几何缩边塞进 `compressWithGifskiThenFallback`——它的契约是「只动 quality 维度」。

---

## 反向清单

- ❌ 不要把 video-to-gif 的 gifski engine 改成静默 fallback engine（违反规则 2 + R-COMPRESS-V1.5）。
- ❌ 不要在 gifski quality 扫描里跳过 `softMaxBytes` 直接奔 `hardMax`（违反 R-05 双层目标；`compressWithGifskiThenFallback` v2 用 `aimMB = hasDistinctSoft ? softMB : hardMB` 把搜索瞄准 soft 而非 hard，自然落在更小的 best 区间）。
- ❌ 不要把 gifski 输出再过 `gifsicle --lossy`（双重 quantize，质量崩；只能 `--no-lossy -O3` 做无损 metadata 裁剪）。
- ❌ **v2 起删除**：不要恢复"gifski 全档失败 → 走 gifsicle fallback"分支——`compressWithGifskiThenFallback` 现在直接 `given:true / allPhasesFailed:true` 让上层 caller 的 size-regression guard 接管；compressLoop 的 caller 会用 Phase C/D 几何缩边再试。
- ❌ 不要在 `compressLoop` 入口 gifski 短路里把 `gifskiRes.finalPath` 直接 `fsp.copyFile` 到用户输出目录——这是 compressLoop 内部 helper 调用，结果只 update `bestPath` 内部状态；外层 caller 通过 compressLoop 自己的 `allPhasesFailed` flag 控制最终 copy（`tests/main/processor-allPhasesFailed.test.ts` 的 `INTERNAL_HELPER_PREFIXES = ['gifskiRes']` 白名单刻意豁免）。
- ❌ 不要新增 `compressLoop` 内部 helper 调用而不沿用 `gifskiRes*` 命名前缀——会被 `processor-allPhasesFailed.test.ts` 误判为新 fan-out site 要求加 copyFile + guard。

---

## 验证锚点

- **/tmp/giftk-bench/run-gifski.sh**：q=80 对 IMG_6253.MOV 应 ≤ 1.2M（实测 1.08MiB）；q=60 应 ≤ 700K（实测 633K，逼近 ezgif 669K）。
- **harness/scenarios/SC-32-gifski-primary-vs-ezgif.md**：完整对照表 + 复现脚本（v2 已补 adaptive 收敛断言）。
- **tests/main/gifskiReencode.test.ts**：gifski 不存在 throw、argv 构造、quality clamp。
- **tests/main/processor-utils.test.ts**：v2 新增 `predictGifskiQuality` / `refineGifskiQuality` / `decideGifskiAccept` / `nextGifskiQuality` 19 case 锁外推算法边界（power-curve 单调性、clamp、log-log 退化、对称 tol、0/1/2 样本路径）。
- **tests/main/processor-allPhasesFailed.test.ts**：白名单 `INTERNAL_HELPER_PREFIXES = ['gifskiRes']` 跳过 compressLoop 内部 helper；fan-out site 列表仍要求 `compressWithGifskiThenFallback` 后必须 `fsp.copyFile` + `allPhasesFailed` guard（这是 caller 边界，不是 helper 边界）。

---

## 触发的 spec / 历史

- spec：[.spec-gifski-primary.md](file:///Users/guoshuyu/workspace/gif-toolkit/.spec-gifski-primary.md)
- 前置规则：[R-COMPRESS-V1 #5 gifski disable 而非 fallback](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-COMPRESS-V1-six-quick-wins.md)
- 复用模块：[binaries.ts getGifskiPath](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/binaries.ts) / [ffmpeg.ts videoToGifGifski](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/ffmpeg.ts)
