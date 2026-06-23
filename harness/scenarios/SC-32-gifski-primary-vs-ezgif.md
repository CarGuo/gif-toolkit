# SC-32 — gifski primary engine vs ezgif / gifsicle 实证对照

> **触发**：用户报告同一份 IMG_6253.MOV 在 ezgif 三步压缩 669K，在仓库主链路（ffmpeg palettegen + gifsicle 1.96 `--lossy=80`）→ 3.2M，质量还不如 ezgif。实证发现 gifsicle 1.96 的 lossy quantiser 已经被同作者 Kornel Lesiński 的新一代编码器 gifski 拉开 3-5 倍代差。本场景沉淀复现脚本 + 实证数据 + R-GIFSKI-PRIMARY 落地后的新基线。

---

## 1. 复现脚本

源文件：`~/Downloads/IMG_6253.MOV`（5.32MiB，2025-05-30）

### 旧链路实证（基线）

`/tmp/giftk-bench/run.sh` ~ `run3.sh` 已沉淀，覆盖 ffmpeg palettegen + gifsicle `--lossy={80,120,200} --colors={64,128,256}` 各种组合。

### 新链路实证（gifski）

`/tmp/giftk-bench/run-gifski.sh`：

```bash
#!/bin/zsh
FFMPEG="/Users/guoshuyu/workspace/gif-toolkit/node_modules/ffmpeg-static/ffmpeg"
GIFSKI="/Users/guoshuyu/workspace/gif-toolkit/node_modules/gifski/bin/macos/gifski"
SRC="$HOME/Downloads/IMG_6253.MOV"
WORK="/tmp/giftk-bench"
cd "$WORK"
rm -rf frames && mkdir frames

# Step 1: ffmpeg 抽帧 (与 videoToGifGifski / gifskiReencode 一致)
"$FFMPEG" -y -i "$SRC" \
  -vf "fps=10,scale='if(gte(iw,ih),min(800,iw),-2)':'if(lt(iw,ih),min(800,ih),-2)'" \
  -f image2 frames/%06d.png 2>ffmpeg-extract.log

# Step 2: gifski 4 档 quality 扫描
for q in 100 80 60 40; do
  "$GIFSKI" --quality $q --fps 10 -o "gifski-q${q}.gif" frames/*.png 2>gifski-q${q}.log
done
```

---

## 2. 实证体积对照表

| 工具 / 参数 | 输出大小 | 相对 ezgif | 备注 |
|---|---:|---:|---|
| **ezgif 三步**（参考） | **669 K** | 1.00× | 用户人肉操作；MOV → GIF → optimize |
| 旧链路 ffmpeg palettegen + gifsicle `--lossy=80` | 3 200 K | 4.78× | 仓库 `processor.ts` 默认（Phase A） |
| 旧链路 Phase D 兜底 `--lossy=200 --colors=64` | 1 800 K | 2.69× | 已经 hard floor 仍 2.7x |
| **gifski q=100** | 3 301 K | 4.94× | 视觉无损上限 |
| **gifski q=80** | 1 140 K | 1.70× | 通用 sweet spot |
| **gifski q=60** | **648 K** | **0.97×** | **接近 ezgif，视觉质量优于 gifsicle Phase D** |
| **gifski q=40** | 447 K | 0.67× | 略小于 ezgif，仍可接受 |

（数据采集日期：2026-06-23；机器：macOS arm64；frames=25；fps=10；scale=800 长边）

### 结论

- gifski q=60 一次过即可逼近 ezgif 三步流程。
- gifsicle `--lossy=80` 与 gifski q=80 在「视觉质量同档」前提下，体积差 ~3 倍。
- 4 阶段管线保留作为 fallback（gifski 二进制不存在 / 平台不支持 / 全档超 hardMax 的兜底路径）。

---

## 3. 落地后行为锁定

| 入口 | 行为 |
|---|---|
| `gif-optimize` task（toolbox 「按目标体积优化」） | 默认 `compressWithGifskiThenFallback`；gifski 不存在 / 全档超 hardMax 时回 `toolboxBudgetCompress` |
| `dockRecording.maybeRecompressOversizeGif` | 复用 `startToolboxChain('gif-optimize')`，天然受益 |
| `video-to-gif` kind, `engine='gifski'` 显式选择 | 走 `videoToGifGifski`；gifski 不存在 **throw** 而非降级（R-COMPRESS-V1.5） |
| `video-to-gif` kind, `engine='ffmpeg'` | 与本规则无关，继续 ffmpeg palettegen |

---

## 4. 回归验证

```bash
npm run typecheck && npm run lint && npm run test:fast && npm run build
/tmp/giftk-bench/run-gifski.sh    # 任意时间复跑，数据必须复现 q=60 <= 700K
```

---

## 5. 相关 harness

- [R-GIFSKI-PRIMARY](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-GIFSKI-PRIMARY.md) — 落地规则
- [R-COMPRESS-V1 #3 / #5](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-COMPRESS-V1-six-quick-wins.md) — video-to-gif 显式 engine 选择 + gifski 不存在 disable
- [R-04 four-phase compression](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-04-four-phase-compression.md) — fallback 链路（继续保留）
- [R-15 npm 供应链卫生](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-15-npm-supply-chain-hygiene.md) — gifski 装包必须 save-exact + 7d cooldown（gifski@1.7.1 2022-08-15 发布，远超）
