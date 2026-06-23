# docs/compression-pipeline.md

> Phase A/B/C/D 的设计目的、入口/出口条件、关键不变量。
> 源代码:[src/main/processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) `compressLoop`。
> 关联规则:[R-03](file:///Users/guoshuyu/workspace/gif-toolkit/AGENTS.md) / [R-04](file:///Users/guoshuyu/workspace/gif-toolkit/AGENTS.md) / [R-05](file:///Users/guoshuyu/workspace/gif-toolkit/AGENTS.md) / [R-06](file:///Users/guoshuyu/workspace/gif-toolkit/AGENTS.md)。

---

## 1. 双层目标(R-05)

![双层目标](./images/compression-1-targets.png)

```mermaid
flowchart TD
  Start(["输入：oversized GIF"]) --> A["Phase A: 缩到 maxSide<br/>(长边硬约束)"]
  A --> B["Phase B: 二分 lossy<br/>(自适应起点)"]
  B --> Hit1{"≤ softMaxBytes?"}
  Hit1 -- "是" --> DoneSoft(["Yes 落 best target<br/>'X.XX MB ≤ 2.0MB (best)'"])
  Hit1 -- "否" --> C["Phase C: 几何缩长边 × 0.85<br/>守 longSideFloor"]
  C --> Hit2{"≤ softMaxBytes?"}
  Hit2 -- "是" --> DoneSoft
  Hit2 -- "否" --> D["Phase D: finalSide + lossy=200"]
  D --> Hit3{"≤ maxBytes?"}
  Hit3 -- "是" --> DoneHard([" 落 fallback target<br/>'X.XX MB ≤ 4.0MB (fallback)'<br/>R-79 warning toast"])
  Hit3 -- "否" --> Skip(["No skipped<br/>'gif over 4.0MB, marking skipped'<br/>**不输出文件**"])

  classDef ok fill:#e8f5e9,stroke:#2e7d32;
  classDef warn fill:#fff3e0,stroke:#e65100;
  classDef bad fill:#ffebee,stroke:#c62828;
  class DoneSoft ok;
  class DoneHard warn;
  class Skip bad;
```

UI 上 `softMaxBytes ≤ maxBytes` 互相 clamp,见 [OptionsForm.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/OptionsForm.tsx)。

---

## 2. Phase A — Resize-first(R-03)

**目的**:在压缩前先满足"长边 ≤ maxSide"硬约束。

```
longestSide = max(width, height)
shortestSide = min(width, height)
if (longestSide <= maxSide) skip Phase A;
else cap = maxSide
     newShort = round(shortestSide * cap / longestSide)
     if (newShort < minSide) throw AspectRatioConstraintError(...)
     resize to (cap on long side, newShort on short side)
```

**早 fail**(R-06):若按 maxSide 缩之后短边会 < minSide(典型场景:9:1 长条图 + minSide=240),**直接抛异常**,UI 把这条任务标 skipped。绝不能压扁出畸变图。

---

## 3. Phase B — Adaptive lossy(R-04 / R-GIFSKI-PRIMARY)

**目的**:在不动尺寸的前提下,把体积压到 softMaxBytes。

**v1.1 起的主路径(gifski-first)**:

1. **gifski quality sweep**(由高到低):`[100, 80, 65, 50, 40, 30]`
2. 每一档:`ffmpeg 抽 PNG 序列 → gifski 编码 → 量体积`
3. **first-fit** 命中 softMaxBytes 即 best;若全档都 ≤ hardMax,取最小的那一档作 fallback
4. **gifski 不存在**(用户裁掉了 [optionalDependencies](file:///Users/guoshuyu/workspace/gif-toolkit/package.json)),或**全档超 hardMax**,降级走下方 gifsicle 二分

详见 [R-GIFSKI-PRIMARY](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-GIFSKI-PRIMARY.md) 与 [SC-32](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-32-gifski-primary-vs-ezgif.md)。实测 IMG_6253.MOV 在 gifsicle 路径 3.2 MB,gifski 路径 669 KB,接近 ezgif `lossy=80`。

**Fallback:gifsicle `--lossy` 二分**(原 v1.0 路径,保留作 safety net):

1. **自适应起点 startLossy**:根据 currentSize/softTarget 比值取
   ```
   ratio < 1.2 → startLossy = 30
   ratio < 1.6 → startLossy = 60
   ratio < 2.2 → startLossy = 90
   ratio < 3.0 → startLossy = 120
   ratio < 4.5 → startLossy = 150
   ratio ≥ 4.5 → startLossy = 180
   ```
   不像最早那样从 0 一路跑到 200(245 次穷举),现在 ~12 次以内基本收敛。
2. **二分搜索**:`lo=0`,`hi=startLossy*2`,每次取 mid 调 gifsicle,根据是否达标更新区间。
3. **Phase B 内只动 lossy,不动尺寸/帧率**。

---

## 4. Phase C — 几何缩边 + longSideFloor(R-06)

**目的**:Phase B 没把体积压到 softMax 时,**等比缩长边**(每次 ×0.85),并保证短边 ≥ minSide。

**关键不变量(longSideFloor 推导)**:

```
fromShort = ceil(longestSide * minSide / shortestSide)
longSideFloor = max(minSide, min(longestSide, fromShort))
```

意思:"长边最少缩到多少,才能让短边恰好不破 minSide"。**Phase C 缩到 longSideFloor 就停**,不能更小。
源代码:[longSideFloor 推导](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts#L391-L401)。

---

## 5. Phase D — 终极兜底

**目的**:Phase C 没把体积压到 maxBytes(fallback)时,直接用 `finalSide=longSideFloor` + 最大 lossy(180/200) 再来一次。

**出口条件**:

- 命中 `<= maxBytes` → emit "gif saved (X MB <= 4.0MB (fallback))"
- 仍 > maxBytes → emit "gif over 4.0MB, marking skipped",**不输出文件**

---

## 6. emit 信号(给 UI / 日志)

| 信号 | 意义 |
|---|---|
| `gif saved (X.XX MB <= 2.0MB (best))` | Phase A→B 命中 best |
| `gif saved (X.XX MB <= 4.0MB (fallback))` | Phase C/D 命中 fallback |
| `gif over 4.0MB, marking skipped` | Phase D 仍超,跳过 |
| `AspectRatioConstraintError: ...` | Phase A 早 fail |

---

## 7. 改动这条管线时的检查清单

- [ ] 新阶段是否依然保证短边 ≥ minSide?
- [ ] 新阶段是否依然先尝试 softMax,失败再降级到 maxBytes?
- [ ] 是否给 emit 加了对应的 substep / detail / elapsedMs(R-08)?
- [ ] 是否给 [harness/scenarios/](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/) 增加了对应回归场景?
- [ ] [SC-02 aspect-ratio](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-02-aspect-ratio-early-fail.md) 是否仍然按预期 fail?
- [ ] [SC-03 soft-vs-hard](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-03-soft-vs-hard-target.md) 是否仍然按预期分级?

---

## 8. WeChat-safe sanitize 子流程

公众号编辑器会因两条独立硬限同时触发"图片载入失败 / 来源信息无法识别":

1. **帧数 ≤ 300**(超过则直接拒绝插入)
2. **header 干净**:不能有非标 `application extension` / `comment` / **diff-frame**(transparent diff + offset frame)— 任意一条命中,公众号 CDN 会拒识别

普通 `gifsicle -O3` 反而会**把 diff-frame 加回来**(逐帧只编码差分块)。所以我们走一条独立的 **三步法 sanitize 子管线**,作为 [GIF Optimize](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/ffmpeg.ts) 工具的 `wechat-safe` method 暴露给 UI,也可作为 [scripts/sanitize-gif.mjs](file:///Users/guoshuyu/workspace/gif-toolkit/scripts/sanitize-gif.mjs) 离线 CLI 跑:

![WeChat-safe sanitize 子流程](./images/compression-2-wechat-safe.png)

```mermaid
flowchart TD
  Src["输入 GIF<br/>(可能 frames>300 / 含 ezgif comment / 多种帧尺寸)"] --> Probe["gifsicle -I<br/>读 frameCount + totalDelay + 帧尺寸表"]
  Probe --> D1{"frameCount > 300?"}
  D1 -- "是" --> Down["计算降帧 fps<br/>floor(300 * 0.95 / totalDelay)<br/>留 5% 安全 margin"]
  D1 -- "否" --> Keep["不降帧,沿用原 fps"]
  Down --> FF["ffmpeg 全帧重铸<br/>palettegen + paletteuse:new=0<br/>-gifflags '-transdiff-offsetting'"]
  Keep --> FF
  FF --> Note1["关键:-transdiff-offsetting<br/>关闭 ffmpeg 自家透明差分压缩,<br/>否则输出仍含多种帧尺寸 + 偏移帧"]
  Note1 --> GS["gifsicle -O0<br/>--no-extensions --no-comments --no-names<br/>--lossy=80"]
  GS --> Note2["关键:-O0 不是 -O3 不是 -O1<br/>因为 -O3 / -O1 都会重新引入 diff-frame"]
  Note2 --> Out["输出干净 GIF<br/>frames ≤ 300 / variants=1 / offset=0<br/>local-CT=0 / comments=0"]

  classDef hot fill:#ffebee,stroke:#c62828;
  classDef ok  fill:#e8f5e9,stroke:#2e7d32;
  classDef pin fill:#fff3e0,stroke:#e65100;
  class Src hot;
  class Out ok;
  class Note1,Note2 pin;
```

判定 GIF 是否需要走这条管线,由 [scripts/diagnose-gif.mjs](file:///Users/guoshuyu/workspace/gif-toolkit/scripts/diagnose-gif.mjs) 给出 9 类 finding:

| Finding | 严重度 | 触发条件 |
|---|---|---|
| FRAMES_OVER_300 | high | 帧数 > 300(公众号必拒) |
| FRAMES_NEAR_300 | mid | 290 ≤ 帧数 ≤ 300(留 margin) |
| COMMENT_BLOCK | high | 含 comment block(如 ezgif 水印) |
| DIFF_FRAMES | mid | 多种帧尺寸 / 偏移帧(diff-frame 压缩) |
| LOCAL_CT_PLUS_TRANSP | mid | 含 local color table 且有透明帧 |
| TOO_LARGE_WECHAT | mid | > 5 MB(公众号经验上限) |
| TOO_LARGE_5MB | low | > 5 MB(其它平台经验上限) |
| OVERSIZE_DIM | low | 任意边 > 1280 px |
| LONG_RECORDING | low | 总时长 > 60 s |

只要任一 high 或 mid finding 命中,就必须走 wechat-safe 子管线;low finding 用户决定。

---

## 9. R-COMPRESS-V1 体验加速包(工具箱 / 历史卡 6 件 P0)

> 详细规则文件:[harness/rules/R-COMPRESS-V1-six-quick-wins.md](../harness/rules/R-COMPRESS-V1-six-quick-wins.md)

四阶段压缩管线本身没改;这一版改的是"用户能不能找到正确的入口设对参数"。六处零回归改动:

### 9.1 #1 GIF Optimize 顶部目标体积 chip 条
- ParamForm 顶部 `< 2 MB / < 5 MB / < 10 MB / 自定义` chip,点一下即设 `method='budget'` + `maxBytes`。
- "自定义" chip 是非破坏性的:`prev.method='budget' && maxBytes=5MB` 时点自定义 → 5MB chip **仍然点亮**(语义是"已经是 5MB 自定义,你想再调"),只把光标聚焦到自定义输入框。

### 9.2 #2 smart fps 默认值
- Video → GIF / WebP 拖入文件后,默认 fps 从固定 12 改为 `min(srcFps, 24)`。
- ffprobe 拿到的源 fps 通过 useToolbox.applyFile 写入 paramsByKind[kind].fps,**不**强行 clamp 用户已显式输入的值。

### 9.3 #3 video → gif engine 切换 (fast↔gifski)
- `ToolboxParams.engine?: 'ffmpeg' | 'gifski'`,默认 `'ffmpeg'`(零行为变更)。
- main 通过 `getGifskiPath()` 解析 `node_modules/gifski/bin/{macos|windows|debian}/gifski`(per platform),`videoToGifGifski()` 构造与 palette 同 `setpts/fps/crop/scale` 链 + tmp PNG seq + finally 清理 + AbortSignal:
  ```
  ffmpeg -i src ... -filter:v "fps=8,scale=480:-2,..." -f image2 \
      $tmp/giftk-gifski-<stamp>/frame-%06d.png
  gifski --fps 8 --quality 90 --repeat 0 -o out.gif $tmp/.../*.png
  ```
- 选择是 per-kind 隔离的:`video-to-gif` paramsByKind 切完后切到 `gif-optimize` 再切回来,`engine` 会回到 default `'ffmpeg'`(防 gifski 泄漏到下个 batch)。
- gifski 不在系统时按钮 disabled + tooltip 解释,**不许**静默 fallback 到 ffmpeg。

### 9.4 #4 lineage modal 「试跑 0.5s」预览
- 不入历史 / 不发 progress / 不抢 p-queue,三隔离写在 R-COMPRESS-V1.2。
- IPC 走独立通道 `toolbox:trialRun` / `toolbox:trialCleanup`(与 batch 的 `startToolboxChain` / `cancelToolboxChain` 完全分离)。
- 输入剥离:lineage 可能带 `startSec / endSec`,trial 必须先 `stripTimeRangeForTrial` 再用 `toolboxTrim -ss 0 -t 0.5` 截前 0.5s,否则 trim clamp 会抛错。
- 输出 basename 必须 `giftk-trial-` 前缀 + `os.tmpdir()` 子树;`toolbox:trialCleanup` 严格白名单校验;R-87 sweep 兜底。
- preload 走 `window.giftk.toolbox.{trialRun,trialCleanup}` 子命名空间,与现有 `window.giftk.toolbox.startChain` 同源。

### 9.5 #5 历史卡推荐预设 chip 行
- 按 first-done-output 扩展名挑 chip(逻辑在 `pickPresetChipsForPath`):
  - `.mp4/.mov/.webm/.mkv/.m4v` → `转 GIF · 快速` (kind=video-to-gif, engine=ffmpeg) / `转 GIF · 高质量` (kind=video-to-gif, engine=gifski)
  - `.gif/.webp` → `压到 <5MB` / `压到 <2MB` (kind=gif-optimize, method=budget, maxBytes=5/2 MB)
- 点 chip 走 useToolbox.applyPreset,**原子**地:`setJobs([])` + `setProgressByJobId({})` + `setLastOutputDir(null)` + `setKind(nextKind)` + `setParamsByKind(prev → prev with [nextKind] entirely replaced)` + `enqueueFile(inputPath)`。
- 跨 5 文件 wiring:HistoryPanel → SecondaryViews → App.tsx → ToolboxPanel(`pendingPreset` prop + key-effect) → useToolbox.applyPreset。

### 9.6 #6 嗅探卡 → 上传历史一键跳转(加速项)
- HistoryPanel 嗅探卡顶部 `☁ 已上传 N` 胶囊从展示改为可点击;App.tsx setView('uploads') + 让 UploadHistoryPanel 滚到对应 record。

---

每件功能都跟有真实 UI-driven Playwright e2e:

| SUITE | 验证点 | 文件 |
|---|---|---|
| RCV1-A | #6 上传胶囊跳转 | [tests/e2e/realPipeline/suite-r-compress-v1-ui.ts](../tests/e2e/realPipeline/suite-r-compress-v1-ui.ts) |
| RCV1-B | #1 目标体积 chip | 同上 |
| RCV1-C | #2 smart fps | 同上 |
| RCV1-D | #3 engine segmented(同 kind toggle 而非跨 kind round-trip) | 同上 |
| RCV1-E | #4 trial-run 真实 ffmpeg + 真实 gif on disk + cleanup | 同上 |
| RCV1-F | #5 推荐预设 chip 全链路 | 同上 |

测试范式:**绝不 mock window.giftk** —— 全部走真实 preload bridge + 真实 main IPC + 真实 ffmpeg/sqlite。


