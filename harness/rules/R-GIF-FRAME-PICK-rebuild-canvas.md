# R-GIF-FRAME-PICK — Animated-GIF frame-range / frame-pick operations MUST rebuild the canvas

> 沉淀于 2026-05-27,根因来自用户反馈:
> 「[源](file:///C:/Users/Asher.Guo/Desktop/ezgif-1633ddd4304013cc.gif) trim 后输出几乎全黑、只剩稀疏色点」
> 复现规模:**4 个工具(Trim / Reverse / Rotate / Crop)在 ezgif-style optimised GIF 上 100% 触发**。
> 关联场景:[SC-23-ezgif-trim-blackout.md](file:///d:/workspace/project/gif-toolkit/harness/scenarios/SC-23-ezgif-trim-blackout.md)。

---

## 0. 一句话规则

**任何对动画 GIF 的「按帧切片 / 旋转 / 翻转 / 裁剪」操作,必须保证写盘前每一帧都已展开为完整画布;不能依赖 gifsicle 的 plain frame-range selector(`#a-b`)。**

---

## 1. 背景:bug 是怎么爆的

ezgif 的 `--optimize` 输出有三大特征:
1. 帧 0 是完整画布,但帧 1..N **每一帧只是局部 diff rect**(几像素到几十像素的 sub-image)。
2. 每一帧的 `disposal` 字段被写成 `asis`(不清屏,不还原)—— 即解码器必须把当前帧的 sub-image **绘制在前一帧的累积画布之上**。
3. 每一帧带 `local color table`,且经常带 `transparent index`(把 diff rect 之外的像素标成"透明")。

旧管线对这种结构里的某一段做帧选,例如 `gifsicle -O3 src.gif #20-60 -o out.gif`:
- gifsicle 把 #20 的 sub-image 当成"出场画布"直接拷贝到 out 帧 0
- out 帧 0 = (一小块色块 in a 200×100 rect)+ (其余像素 → transparent)
- 在大多数渲染器(Electron `<img>`、macOS 预览、Chrome)看来,这是 **(R=0, G=0, B=0, A=0) — transparent black**

sharp 9 点采样:`transp = 17/25, blacks = 17/25, bri ≈ 5/255` —— 实测命中。

---

## 2. 强制管线:**两段法 + ffmpeg 兜底**

```
gifsicle --colors=255 src.gif -o tmp.q.gif
gifsicle -U tmp.q.gif <frame_selectors> [<extra_ops>] -O3 -o tmp.t.gif
fs.rename(tmp.t.gif → output)
```

- `--colors=255` 强制 GIF 走单一 256-色 global palette,**移除** local-palette + transparent 复杂度。
- `-U`(`--unoptimize`)展开每一帧 disposal 链 → 完整画布。
- 之后 `<frame_selectors>`(例如 `#3-7`)/ `<extra_ops>`(`--rotate-90` / `--crop` / 多 selector reverse)只作用在已展开的画布上,**不会再产生 transparent black**。
- `-O3` 重新 diff-encode,体积不会爆炸。

**为什么必须分两步:** gifsicle `-U` 在 local-palette + complex transparency 输入上会 **silent fall back** —— exit 0、产物字节数和**没加 -U 时一致**、stderr 留下 `GIF too complex to unoptimize. The reason was local color tables or complex transparency. Try running the GIF through 'gifsicle --colors=255' first.`。`run()` 默认不读 stderr,因此必须显式捕获,见下一节。

### 2.1 fallback ffmpeg(safety net)

如果两段法 stderr 仍然报 `too complex`(比如未来 gifsicle 升级行为变了 / 多帧 disposal 异常组合):
```
ffmpeg -y [-ss N] [-to|-t M] -i src.gif \
  -vf "[extraVf,]split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=5" \
  -loop 0 out.gif
```

- 走 ffmpeg 完全解码 → palettegen → paletteuse,**永远**不会留 transparent black。
- 帧选用 `-ss/-t` 替代 `#a-b`,旋转用 `transpose=1/2/3`,翻转用 `vflip,hflip`,裁剪用 `crop=W:H:X:Y`,反转用 `reverse`。
- 体积比 gifsicle 大 2~5×,但**正确性 > 体积**;这是 fallback,不是默认。

---

## 3. 强制实现要点(在 [src/main/ffmpeg.ts](file:///d:/workspace/project/gif-toolkit/src/main/ffmpeg.ts))

### 3.1 helpers(必须存在,不许内联)

- `class GifsicleRebuildError extends Error { name = 'GifsicleRebuildError'; }` — 区分"二段法识破自身坏掉"vs 真正失败,**只有**这个名字触发 ffmpeg fallback。其他 Error / CancelledError 透传上抛。
- `spawnGifsicleCapture(cmd, args, signal): Promise<{code, stderr}>` — 必须用 `child_process.spawn` 把 stderr 全文 collect 后返回。**不允许复用** `run()`(它丢 stderr)。
- `gifsicleRebuildFrames(input, output, frameSelectors[], signal, extraOps[])` — 串两段 gifsicle,中间产物落 `os.tmpdir()`,finally 必清。stderr 命中 `/GIF too complex to unoptimize/i` → throw `GifsicleRebuildError`。
- `ffmpegRebuildGifClip(input, output, { startSec?, endSec?, extraVf? }, signal)` — 走 split → palettegen → paletteuse 安全链,`endSec` 转 `-to`(不是 `-t`,避免误差)。

### 3.2 调用方约束

每个动画 GIF 工具函数(`toolboxTrim` / `toolboxReverse` / `toolboxRotate` / `toolboxCrop`)**MUST**:

```ts
try {
  await gifsicleRebuildFrames(input, output, [/* selectors */], signal, [/* extras */]);
} catch (e) {
  if ((e as Error).name === 'CancelledError') throw e;
  if ((e as Error).name !== 'GifsicleRebuildError') throw e;
  await ffmpegRebuildGifClip(input, output, { /* equivalent params */ }, signal);
}
```

**不许做:**
- 直接用 `run(gifsiclePath, ['-O3', input, '#a-b', '-o', output])`(原 bug 路径)
- 直接用 `-U input #a-b -O3 -o out`(silent fallback,产物仍坏)
- 在 catch 里捕 generic `Error` 然后 fallback(会吞掉 CancelledError)

### 3.3 例外:`toolboxSpeed`

`toolboxSpeed` 只改每帧 delay(`-d <n>`)、不动像素 / 不切帧 / 不改空间维度,**不必**走 rebuild。保留旧 `gifsicle -O3 input -d N -o out`。

---

## 4. 反向清单(下次评审看这里)

- [ ] 函数里**还**有 `run(gifsicle, [..., '#${a}-${b}', ...])` 或 `'#${idx}'` 这种裸帧选 → ❌
- [ ] `gifsicleRebuildFrames` 里捕到 `too complex` warning **却**没 throw `GifsicleRebuildError` → ❌
- [ ] catch 里 fallback **没**先排除 `CancelledError` → ❌(用户取消会被升级为 ffmpeg 兜底,浪费 5~30 秒)
- [ ] tmp 文件没在 finally 里 `fsp.rm(..., { force: true })` → ❌(违反 R-87)
- [ ] 二进制路径硬写 `gifsicle_x64`,不读 `process.arch` → ❌

---

## 5. 验证步骤(每次改了上述 4 个函数 / helper 后必跑)

1. **回归测试** — [tests/main/ffmpeg-gif-frame-pick.test.ts](file:///d:/workspace/project/gif-toolkit/tests/main/ffmpeg-gif-frame-pick.test.ts):

   该 suite 自己用 vendored gifsicle 合成一个 disposal=asis + 多帧 diff rect 的 fixture,然后调真实 `toolboxTrim` 起始帧 > 0 截一段,用 sharp 5×5 网格采样断言 `transp == 0`。修复前会 ~17/25 transparent samples,修复后 0/25。

2. **三档静态门禁** — `npm run typecheck && npm run lint && npm run test:fast`,**必须 0 失败**。

3. **人工 smoke**(改了 helpers 必跑) — 在 dev 环境用真实 ezgif 文件做一次 trim,**肉眼**验证输出无 transparent / black hole。

---

## 6. 历史

| 日期 | 改动 |
|---|---|
| 2026-05-27 | R-GIF-FRAME-PICK 沉淀。`toolboxTrim` / `toolboxReverse` / `toolboxRotate` / `toolboxCrop` 切换到 `gifsicleRebuildFrames` + `ffmpegRebuildGifClip` 兜底。新增回归套件 [ffmpeg-gif-frame-pick.test.ts](file:///d:/workspace/project/gif-toolkit/tests/main/ffmpeg-gif-frame-pick.test.ts)。 |
