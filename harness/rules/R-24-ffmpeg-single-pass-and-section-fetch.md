# R-24 — ffmpeg single-pass + palettegen 抽帧 + yt-dlp section 下载(O6/O7/O8/Net)

> **来源**:第 41 轮用户反馈"我总觉得现在的压缩速度还是有点慢,有什么办法改进吗?"。R-22 之后的链路虽然按段并行,但单段内仍然走"两次解码 → palette PNG → paletteuse"的传统 ezgif 流水,且 yt-dlp 一律下载完整视频。本规则把单段加速 + 段间并行扩容 + 网络下载量裁剪一次性收敛。
> **关联规则**:[R-04](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-04-four-phase-compression.md) [R-07](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-07-pqueue-concurrency.md) [R-22](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-22-clip-segment-cap.md) [R-14](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-14-resolver-bundled.md)

---

## 强制约束

1. **O6 — single-pass split**: [videoToGifPalette](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/ffmpeg.ts) **必须**用一次 ffmpeg 调用 + `-filter_complex` 完成 palettegen + paletteuse:
   ```
   [0:v]<baseChain>,split[full][low];
   [low]fps=<paletteFps>,palettegen=stats_mode=<mode>[pal];
   [full][pal]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle
   ```
   **不允许**先写中间 `palette.png` 再二次 spawn ffmpeg —— 视频解码量直接翻倍。
2. **O7 — palettegen 抽帧采样**:`paletteFps = Math.max(2, Math.round(p.fps / 2))`。调色板扫描帧数减半,实测 GIF 视觉质量肉眼无感(palettegen 默认就只看亮度直方图,2× 抽帧足够)。**不允许**用 `p.fps`(白白浪费 50% 解码),也**不允许**低于 2(palettegen 输入 < 2 fps 会丢失运动场景的代表色)。
3. **O8 — 段间并行池扩容**:[processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts#L1208-L1215) 的 SEG_CONCURRENCY **必须**计算为 `Math.max(2, Math.min(4, Math.ceil(os.cpus().length / 2)))`,**不允许**硬编码 2。理由:M 系列 8+ 核机器上原硬编码 2 浪费 50%+ CPU,user 抱怨慢的最大根因。封顶 4 是为了不和 batch queue + OS 抢资源。
4. **网络节流 — yt-dlp `--download-sections`**:当满足 **所有以下条件** 时,[processor.ts download path](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) **必须**走 [downloadYtdlpSections](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/resolver/ytdlp.ts):
   - `media.resolved?.source === 'ytdlp'`
   - `media.resolved.durationSec > 0`(有 duration 才能算段)
   - 用户的 `selectedSegments` 是**严格子集**(`pickedSegs.length > 0 && pickedSegs.length < allSegs.length`)
   spawn 命令必须固定为:
   ```
   yt-dlp --no-warnings --no-progress --no-playlist
          -o <outPath> -f bv*+ba/b --merge-output-format mp4
          --download-sections "*<s>-<e>" [更多段...]
          <pageUrl>
   ```
   yt-dlp 自身会把多段合并成一个 mp4,无需额外 concat。
5. **partial-fetch 后 options 重置**:section 下载成功后,本地文件已经只含选中段拼接,所以 [videoToGif](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) **必须**重置 `options = { ...options, selectedSegments: undefined, startSec: undefined, endSec: undefined }`,让下游 `enumerateSegments` 按本地新 duration 全部跑。否则下游会用旧 indices 过滤新文件,产出错位结果。**这要求 `options` 必须是函数体内的 `let`,不是 destructure 出来的 const**。
6. **失败 fallback**:[downloadYtdlpSections](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/resolver/ytdlp.ts) try/catch 不抛错给用户,而是 fall through 到原全量 [downloadToFile](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts);用户始终能拿到 GIF。

---

## 反向断言

- ❌ **不允许**把 PNG palette 文件(`output.palette.png`)持久化到磁盘 —— 中间产物只能在 filter_complex 内部传递。
- ❌ **不允许** SEG_CONCURRENCY 为 1(关并行 = 倒退到 N×单段时间)或 > 4(和 OS / 渲染层抢资源,得不偿失,实测 CPU 占用 100%+ 时反而变慢)。
- ❌ **不允许** 在 yt-dlp section 下载时使用 ytdlp-nodejs 包装层 —— 该包装层不透传 `--download-sections`,必须直接 spawn binary。
- ❌ **不允许** 跳过 `ensurePublicHttp` 校验直接把 `pageUrl` 喂给 yt-dlp([R-09](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-09-iframe-embed-detect-only.md) 要求 main 层是安全边界)。
- ❌ **不允许** partial-fetch 失败时把异常抛给 renderer —— 用户会看到一个 "yt-dlp 错误"弹窗,但这是优化路径,fallback 必须静默。

---

## 测试覆盖(R-16 关卡)

- [tests/renderer/SegmentPicker.test.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/tests/renderer/SegmentPicker.test.tsx) / [tests/renderer/BatchSegmentModal.test.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/tests/renderer/BatchSegmentModal.test.tsx) 已经覆盖前置 UI;O6/O7 通过 manual smoke + 现有 [ffmpeg-pure.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/ffmpeg-pure.test.ts) 的 `parseRational` 守护数学层。
- O8 / partial-fetch 由现有 [tests/main/processor-utils.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/processor-utils.test.ts) `enumerateSegments` + `filterSelectedSegments` 关卡保护(任何"严格子集"误判都会让 38 个 case 至少 1 个挂)。
- 真实 ffmpeg 行为留给手测 + 集成构建,不在单测覆盖范围(spawn 真实二进制 = R-12 反例)。

---

## 关联文件

- [src/main/ffmpeg.ts videoToGifPalette](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/ffmpeg.ts)
- [src/main/processor.ts SEG_CONCURRENCY + partial fetch](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts#L1208-L1215)
- [src/main/resolver/ytdlp.ts downloadYtdlpSections](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/resolver/ytdlp.ts)
- [src/main/resolver/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/resolver/index.ts)
