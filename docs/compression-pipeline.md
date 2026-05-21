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
  Hit1 -- "是" --> DoneSoft(["✅ 落 best target<br/>'X.XX MB ≤ 2.0MB (best)'"])
  Hit1 -- "否" --> C["Phase C: 几何缩长边 × 0.85<br/>守 longSideFloor"]
  C --> Hit2{"≤ softMaxBytes?"}
  Hit2 -- "是" --> DoneSoft
  Hit2 -- "否" --> D["Phase D: finalSide + lossy=200"]
  D --> Hit3{"≤ maxBytes?"}
  Hit3 -- "是" --> DoneHard(["⚠️ 落 fallback target<br/>'X.XX MB ≤ 4.0MB (fallback)'<br/>R-79 warning toast"])
  Hit3 -- "否" --> Skip(["❌ skipped<br/>'gif over 4.0MB, marking skipped'<br/>**不输出文件**"])

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
longestSide  = max(width, height)
shortestSide = min(width, height)
if (longestSide <= maxSide) skip Phase A;
else cap = maxSide
     newShort = round(shortestSide * cap / longestSide)
     if (newShort < minSide) throw AspectRatioConstraintError(...)
     resize to (cap on long side, newShort on short side)
```

**早 fail**(R-06):若按 maxSide 缩之后短边会 < minSide(典型场景:9:1 长条图 + minSide=240),**直接抛异常**,UI 把这条任务标 skipped。绝不能压扁出畸变图。

---

## 3. Phase B — Adaptive lossy 二分(R-04)

**目的**:在不动尺寸的前提下,用 gifsicle `--lossy` 把体积压到 softMaxBytes。

**关键设计**:

1. **自适应起点 startLossy**:根据 currentSize/softTarget 比值取
   ```
   ratio < 1.2  →  startLossy = 30
   ratio < 1.6  →  startLossy = 60
   ratio < 2.2  →  startLossy = 90
   ratio < 3.0  →  startLossy = 120
   ratio < 4.5  →  startLossy = 150
   ratio ≥ 4.5  →  startLossy = 180
   ```
   不像最早那样从 0 一路跑到 200(245 次穷举),现在 ~12 次以内基本收敛。
2. **二分搜索**:`lo=0`,`hi=startLossy*2`,每次取 mid 调 gifsicle,根据是否达标更新区间。
3. **Phase B 内只动 lossy,不动尺寸/帧率**。

---

## 4. Phase C — 几何缩边 + longSideFloor(R-06)

**目的**:Phase B 没把体积压到 softMax 时,**等比缩长边**(每次 ×0.85),并保证短边 ≥ minSide。

**关键不变量(longSideFloor 推导)**:

```
fromShort   = ceil(longestSide * minSide / shortestSide)
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
