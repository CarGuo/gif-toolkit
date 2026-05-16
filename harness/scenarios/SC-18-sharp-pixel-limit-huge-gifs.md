# SC-18 — sharp pixel limit on huge animated GIFs / 巨型 GIF 缩略图与 resize 失败

> **来源**:第 33 轮用户测试日志显示 `shrink failed at side=643: Input image exceeds pixel limit` 与 `final aggressive step failed: Input image exceeds pixel limit`,导致 9.80MB / 18.04MB GIF 处理后仍是原始大小;同一组 GIF 卡片缩略图也出现红 `!` 角标(独立失败,但同根源)。
> **关联规则**:[R-04](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-04-four-phase-compression.md) [R-08](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-08-progress-richness.md) [SC-17](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-17-compressLoop-all-phases-failed-reporting.md)

---

## 触发条件

sharp(libvips)对动图的处理是把每帧拼成一张高度 = `H × frames` 的虚拟画布:

| 因素 | 影响 |
|---|---|
| 默认 `limitInputPixels = 0x3FFF² ≈ 268,402,689` 像素 | 一张 800×450 的 GIF,只要超过 ~745 帧就直接被 sharp 拒绝 |
| 帧数多的中长 GIF(IO 大会片段、教程录屏) | `H × frames` 极易突破 268MP |
| `imageResizeKeepAspect` 是 [compressLoop](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) Phase A / C / D 的核心步骤 | 一旦 sharp 抛错,Phase B 单纯 gifsicle lossy 没法 resize 缩尺寸,4MB 硬目标永远达不到 |
| `buildThumbnailDataUrl` 也用 sharp | 缩略图链路同样 hit 限制,卡片显示红 `!` 角标 |

---

## 期望行为

1. **`imageResizeKeepAspect` 双层引擎**(主修复):
   - 先尝试 `sharp(input, { animated: true, limitInputPixels: false }).resize().gif().toFile()` —— 显式关闭 268MP guard;
   - sharp 抛任何错(libvips 内部还有更深的硬保护)→ **静默 fallback 到 ffmpeg**:`ffmpeg -i in.gif -vf "scale=W:-2:flags=lanczos" -loop 0 out.gif`;
   - ffmpeg 走 native GIF demuxer 逐帧处理,**没有虚拟画布,没有 pixel-limit guard**,慢一些但 100% 兜底。
2. **`buildThumbnailDataUrl` 显式 `limitInputPixels: false`**:
   - 缩略图只取第一帧(animated:false),即便如此原图维度本身可能很大,要关闭 268MP guard;
3. **不向调用方暴露具体引擎**:
   - 主流程 [compressLoop](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) / [imageResizeKeepAspect](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/ffmpeg.ts) 接口不变,sharp / ffmpeg 切换内部完成;
4. **取消信号必须穿透**:
   - sharp 抛错走到 ffmpeg fallback 之前,要先重 throw `name === 'CancelledError'` 的取消错误;ffmpeg 子进程也用 `signal` 参数挂接 [run](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/ffmpeg.ts) 的 abort 监听器。

---

## 反向断言

- ❌ **不允许**`sharp(...)` 调用不传 `limitInputPixels: false`(默认 268MP 上限对动图太低)。
- ❌ **不允许**sharp 失败后直接 throw 给 compressLoop(必须 ffmpeg 兜底,否则 R-04 全 phase 失败)。
- ❌ **不允许**sharp fallback 吞掉 `CancelledError`(取消信号必须穿透到外层任务调度)。
- ❌ **不允许**ffmpeg 兜底的 `-vf scale` 用奇数宽度(部分编码器 / 滤镜要求偶数,用 `Math.floor(W/2)*2` 或 `-2` 占位)。

---

## 复演步骤

1. 找一个大型 / 长动画 GIF(用户场景:`TAS-Gif.gif` 9.80MB、`IO26_105_TSV_auto_widgets_loop.gif` 18MB,二者均 > 268MP virtual canvas)。
2. 拖入 / 嗅探 → 开始批处理。
3. **修复前**:日志出现 `shrink failed at side=643: Input image exceeds pixel limit` + `final aggressive step failed: Input image exceeds pixel limit`,task done warning `final size XX.XMB exceeds hard target 4.0MB`,实际未压缩。
4. **修复后**:
   - sharp 第一次失败 → **不再 swallow,直接走 ffmpeg fallback**;
   - ffmpeg 输出文件被正确生成,`producedAny=true`,Phase B/C 后续 lossy + 进一步 shrink 正常进行;
   - 最终 final size ≪ 9.80MB,task `done` 不带 warning(或 warning 文案是 `did not reach soft target` 而非 `exceeds hard target`);
   - 卡片缩略图也不再显示红 `!`(buildThumbnailDataUrl 同步修复)。

---

## 关联规则 / 文件

- [src/main/ffmpeg.ts imageResizeKeepAspect](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/ffmpeg.ts#L434-L467)
- [src/main/ffmpeg.ts buildThumbnailDataUrl](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/ffmpeg.ts#L478)
- [src/main/processor.ts compressLoop](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts)
- [SC-17 compressLoop-all-phases-failed-reporting](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-17-compressLoop-all-phases-failed-reporting.md)

---

## 历史 PASS 记录

| 日期 | 提交 | 结果 | 备注 |
|---|---|---|---|
| 初版沉淀 | imageResizeKeepAspect 双层引擎 + limitInputPixels: false;buildThumbnailDataUrl 同样修复 | PASS | typecheck/lint/build |
