# SC-23 — ezgif-optimised GIF trim/reverse/rotate/crop produces transparent-black output

> 沉淀于 2026-05-27,真实生产事故。
> 关联规则:[R-GIF-FRAME-PICK](file:///d:/workspace/project/gif-toolkit/harness/rules/R-GIF-FRAME-PICK-rebuild-canvas.md)。

---

## 现象

用户 trim 一份 [ezgif-1633ddd4304013cc.gif](file:///C:/Users/Asher.Guo/Desktop/ezgif-1633ddd4304013cc.gif),输出落在 [trim-20260527/ezgif-1633ddd4304013cc.gif](file:///C:/Users/Asher.Guo/Downloads/GifToolkit/toolbox/trim-20260527/ezgif-1633ddd4304013cc.gif)。
- 源:154 帧 960×576,正常彩色 "CALIFORNIA I/O" 演示视频。
- 输出:几乎**全黑**,只在原本前景物体的轮廓位置出现稀疏色点,大面积透明黑。
- 用户原话:**「貌似也不止 trim 和 crop 会?」**(暗示是公共管线缺陷,不是单个函数 bug)

---

## 根因分析(已量化)

1. `gifsicle -I src.gif` 输出:
   - 154 帧
   - 每帧 `disposal asis`
   - 每帧带 `local color table`
   - 文件头 comment `GIF compressed with https://ezgif.com/optimize`

2. 旧管线:`gifsicle -O3 src.gif #20-60 -o out.gif`
   - sharp 9 点采样 frame 0:
     - `transp = 17/25` (samples)
     - `nearBlack = 17/25`
     - `bri ≈ 5/255`
   - 解释:出场帧 sub-image 是几像素的 diff rect,其余区域 transparent。

3. 试 `gifsicle -U src.gif #20-60 -O3 -o out.gif`(单步 unoptimize):
   - **silent fall back**:exit 0、产物字节数 879,178(与无 `-U` 时完全一致)
   - stderr 含 `GIF too complex to unoptimize. The reason was local color tables or complex transparency. Try running the GIF through 'gifsicle --colors=255' first.`
   - sharp 采样仍 transparent black —— 换言之 `-U` 没生效。

4. 两段法 `gifsicle --colors=255 src.gif -o tmp.q.gif; gifsicle -U tmp.q.gif #20-60 -O3 -o out.gif`:
   - sharp 采样:`transp = 0/25, nearBlack = 0/9, bri ≈ 80/255`
   - **完全修复**。

5. ffmpeg `-ss/-t -vf split[a][b];[a]palettegen[p];[b][p]paletteuse` 兜底:
   - 同样 `transp = 0/25`,体积 ~3× 但稳。

---

## 实测验证(2026-05-27)

写了 [scripts/verify-trim-fix.cjs](已删 — 用户私人路径)用 `Module._resolveFilename` 把 `electron` 替换为 stub 后 require dist/main/ffmpeg.js,真实跑修复后 `toolboxTrim('C:/Users/Asher.Guo/Desktop/ezgif-1633ddd4304013cc.gif', tmp, 2.8, 8.4)`:

```
[2026-05-27] gifsicle: D:\...\@343dev\gifsicle\vendor\win32\gifsicle_x64.exe
done in 2035 ms, output size: 713973, pages= 44 WxH= 960x576
frame 0: bri=78.0 nearBlack=1/25 transp=0/25
frame 22: bri=61.9 nearBlack=1/25 transp=0/25
frame 43: bri=61.7 nearBlack=0/25 transp=0/25
```

**bug 彻底消失**,`gifsicleRebuildFrames` 第一段 `--colors=255` 成功降复杂度,第二段 `-U #a-b -O3` 不再 silent fallback,ffmpeg 兜底未触发(也是预期)。

---

## 影响面(为什么用户说"不止 trim")

修复时同步检查所有 GIF 帧选 / 几何变换分支:

| 函数 | 旧调用 | 受影响 |
|---|---|---|
| `toolboxTrim` | `gifsicle -O3 src '#a-b' -o out` | ✅ |
| `toolboxReverse` | `gifsicle -O3 src '#N-0' -o out`(逆序选帧) | ✅ |
| `toolboxRotate` | `gifsicle --rotate-90 -O3 src -o out` | ✅(rotate 也读 sub-image,同样错) |
| `toolboxCrop` | `gifsicle --crop X,Y+WxH -O3 src -o out` | ✅ |
| `toolboxSpeed` | `gifsicle -d N src -o out`(只改 delay) | ❌(不动像素,不受影响) |
| compressLoop / phaseB / phaseC | 输入是已转 GIF / 已重编码,不在 ezgif disposal=asis 状态 | ❌ |

---

## 修复 / 回归路径

- 代码:[ffmpeg.ts](file:///d:/workspace/project/gif-toolkit/src/main/ffmpeg.ts) 新增 `gifsicleRebuildFrames` / `ffmpegRebuildGifClip` / `spawnGifsicleCapture` / `GifsicleRebuildError`。4 个工具函数全部切换 try-rebuild → catch GifsicleRebuildError → fallback ffmpeg。
- 测试:[tests/main/ffmpeg-gif-frame-pick.test.ts](file:///d:/workspace/project/gif-toolkit/tests/main/ffmpeg-gif-frame-pick.test.ts)(2 用例,真实 spawn gifsicle 合成 disposal=asis fixture → 调真实 toolboxTrim → sharp 采样断言 transp == 0)。
- 规则:[R-GIF-FRAME-PICK](file:///d:/workspace/project/gif-toolkit/harness/rules/R-GIF-FRAME-PICK-rebuild-canvas.md)。

---

## SOP 五闸结果(2026-05-27)

- `npm run typecheck` ✅
- `npm run lint` ✅
- `npm run test:fast` ✅ **852/852**(原 850 + 新 2)
- `npm run build` ✅
- `npm run test:e2e:smoke` ✅ 2/2

---

## 经验教训

1. **gifsicle `-U` 在复杂 GIF 上 silent fallback** —— 不读 stderr 等于没做。所有依赖外部二进制的"应该这样就行"假设都得在 stderr 上加显式校验。
2. **`run()` helper 默认丢 stderr 是真坑** —— 必要时直接 spawn,自己捕获。
3. **用户「貌似也不止」要当真** —— 这次 4 个函数都中招,只修 trim 等于半修。立刻横向扫所有同类调用。
4. **测试必须真实**(R-12 / R-16) —— 这次写的回归测试自己 spawn gifsicle 合成 disposal=asis fixture,而不是 mock,因为 mock 不会发生 silent fallback 的 bug 现象。
