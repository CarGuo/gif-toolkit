# SC-17 — compressLoop 全 phase 失败必须上报(R-04 / R-08 反例)

> **来源**:第 32 轮用户测试 `TAS-Gif.gif`(9.80MB),处理后 final 仍是 9.80MB(原始大小),warning `final size 9.80MB exceeds hard target 4.0MB at min 240px` —— 用户问"为什么没处理直接就 final 原始大小????"。
> **关联规则**:[R-04](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-04-four-phase-compression.md) [R-08](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-08-progress-richness.md)

---

## 触发条件

[compressLoop](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) 任一关键步抛错(常见:`sharp({animated:true}).resize().gif().toFile()` 对大 / 非标准 animated GIF 偶发失败 / gifsicle CJS 加载失败 / 临时文件写权限错):

| Phase | swallow 点 | 反模式现象 |
|---|---|---|
| A | `probe` 失败 | fallback no-resize(还合理) |
| A | `imageResizeKeepAspect` 失败 | catch + log,workSrc 不变,bestPath = inputGif |
| B | `lossySearch` start lossy 失败 | return Infinity,bestPath = inputGif |
| B | `lossySearch` binary 失败 | break,bestPath 可能 = inputGif |
| C | `imageResizeKeepAspect` 失败 | break,bestPath 可能 = inputGif |
| C | `lossySearch` 失败 | break,bestPath 可能 = inputGif |
| D | `imageResizeKeepAspect` + `tryOptimize` 失败 | catch + log,bestPath 可能 = inputGif |

任一关键步失败时 `bestPath` 永远 = `inputGif`,task 仍 emit `done`,warning 看起来像"试过了但没打下来",**实际是"什么都没成功"**。R-04 / R-08 都被绕过。

---

## 期望行为

1. **每个 swallow 点必须 push 错误到 `phaseFailures` 数组并 emit substep='phase-failed' 进度**(R-08 进度必须有 substep / detail):
   - [recordPhaseFailure](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) 在所有 catch 处统一调用,既记录到结果对象,又通过 emit 推到 UI 进度面板。
2. **`producedAny` 计数器**:每次 `imageResizeKeepAspect` / `gifsicleOptimize` **成功**才 `producedAny = true`。
3. **`CompressResult` 暴露 `phaseFailures: string[]` + `allPhasesFailed: boolean`**:
   - `allPhasesFailed === true` ⇔ 没有任何 phase 实际产出 → bestPath 必然是 inputGif。
4. **gif 分支(`processOneTask`)**:
   - 当 `result.allPhasesFailed === true`:emit `status: 'failed'`(**不是 done**),`error` 含完整 phase 失败诊断(前 3 条);
   - 当 `result.given === true && phaseFailures.length > 0`:warning 文案区分 "exceeds hard target [N phase failure(s): ...]";
   - 当 `result.reachedSoft && phaseFailures.length > 0`:warning "reached soft target with N phase failure(s) ignored: ..."。
5. **video 分支**:
   - 单 segment 全 phase 失败 → warning `seg N compress: every phase failed (...)`;
   - 单 segment 部分 phase 失败但 reach 目标 → warning `seg N reached target but N phase(s) failed silently`。

---

## 反向断言

- No **不允许**任何 swallow 处只 `log()` 而不 push `phaseFailures`(用户永远看不到诊断)。
- No **不允许**`allPhasesFailed === true` 时 task 仍 emit `done`(必须 `failed`)。
- No **不允许**warning 文案不区分 "试过了打不下来" 和 "什么都没成功"(用户不会知道发生了什么)。
- No **不允许**新增 phase 后忘记把对应 catch 接到 `recordPhaseFailure`(R-04 + R-08 双重违反)。

---

## 复演步骤

### 场景 A — 大 / 非标准 animated GIF + sharp 偶发失败
1. 拖入 / 嗅探一个大 animated GIF(用户场景:9.80MB 的 `TAS-Gif.gif`)。
2. 开始批处理:压缩管线进入 Phase A → sharp `{animated: true}` 抛错。
3. **修复前现象**:Phase A swallow → bestPath = inputGif → Phase B 再用 inputGif 走 gifsicle,可能也失败 → 最终 bestPath 仍 = inputGif → task done,warning `final size 9.80MB exceeds hard target 4.0MB`。
4. **修复后现象**:
   - 进度面板会显示多条 substep='phase-failed' 进度,detail 含 sharp / gifsicle 报错(用户能看到"哦,sharp 在 phase-A-resize 失败了");
   - 若所有 phase 都失败 → task `failed`,error message 含 `every phase failed → kept original 9.80MB. phase-A-resize: ... | phase-B-lossySearch-start-lossy=...`;
   - 若部分 phase 失败但 reach hard target → warning 含 `[N phase failure(s)]`。

### 场景 B — gifsicle CJS load 失败(SC-12 反例)
1. 模拟 gifsicle 不可用(rename binary)。
2. 触发批处理。
3. 期望:Phase A resize 成功 → Phase B start lossy gifsicle 抛 ENOENT → recordPhaseFailure → 后续 phase 也失败 → `allPhasesFailed=false`(因 phase A 成功了,但其实没 reach target)→ warning `did not reach soft target ...`。
4. 用户能看到 `phase-failed` substep 进度,知道是 gifsicle 出问题。

---

## 关联规则 / 文件

- [src/main/processor.ts compressLoop](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts)
- [src/main/processor.ts processOneTask gif branch](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts)
- [R-04 four-phase-compression](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-04-four-phase-compression.md)
- [R-08 progress-richness](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-08-progress-richness.md)

---

## 历史 PASS 记录

| 日期 | 提交 | 结果 | 备注 |
|---|---|---|---|
| 初版沉淀 | compressLoop 加 phaseFailures + recordPhaseFailure + producedAny;allPhasesFailed → task failed;warning 文案区分两种情况 | PASS | typecheck/lint/build |
