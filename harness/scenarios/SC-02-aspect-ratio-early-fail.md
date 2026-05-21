# SC-02 — 长条图早 fail,不允许压扁

> **来源**:第 18 轮 "改高让宽超过最小,这就不对了,要直接提示问题"。
> **关联规则**:[R-03](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-03-maxside-applies-to-both-axes.md) / [R-06](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-06-shortside-floor.md)

---

## 触发条件

输入媒体的高宽比极端,且配置约束**互相打架**。最经典的两种:

| case | 输入尺寸 | maxSide | minSide | 结果 |
|---|---|---|---|---|
| A 极宽长条 | 4000 × 300 | 800 | 240 | 把长边 4000 缩到 800,短边变 60,**< minSide**,无法满足 |
| B 极瘦竖屏 | 300 × 4000 | 800 | 240 | 同 A 互换 |
| C 中等比例,不触发 | 1920 × 1080 | 800 | 240 | 等比缩到 800×450,**通过**,正常 Phase A |

---

## 期望行为

**Case A / B**:Phase A 抛 [AspectRatioConstraintError](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts#L46-L70),错误信息中文 + 英文混合,带:

```
origW × origH(原始尺寸)
maxSide(用户给的长边上限)
minSide(用户给的短边下限)
shortSideAtMax(按 maxSide 缩之后短边会变成多少)
```

UI 上对应任务标记 `state: 'skipped'`,在日志里写人类可读的解释("长边压到 800 后短边只剩 60,小于最小 240")。

**Case C**:正常进 Phase B/C/D,emit `gif saved (X.XX MB <= ... )`。

---

## 反向断言

- No **不允许**输出畸变的 4000×60 → 强行缩成 800×60 的扁条 GIF
- No **不允许**静默跳过(用户必须知道是参数互锁)
- No **不允许**只输出英文堆栈,要给用户讲清楚"为什么"
- No **不允许**Phase C/D 在不持守 longSideFloor 的情况下继续缩(会再次违反 R-06)

---

## 复演步骤

1. 用 ffmpeg 造一个 4000×300 的 mp4 测试视频:
   ```bash
   ffmpeg -f lavfi -i color=c=red:s=4000x300:d=2 -c:v libx264 -t 2 /tmp/long.mp4
   ```
2. App 里粘这个文件路径(或者通过 sniffer 抓一个长条 GIF)
3. 设置 `maxSide=800`、`minSide=240`
4. 点"开始批处理"
5. **期望**:任务条立即变 skipped,日志里出现 `AspectRatioConstraintError`
6. **反向**:本地输出目录里**不应当**有 long.gif 产物

---

## 关联规则

- [R-03 maxside-applies-to-both-axes](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-03-maxside-applies-to-both-axes.md)
- [R-06 shortside-floor](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-06-shortside-floor.md)
- [docs/compression-pipeline.md §2](file:///Users/guoshuyu/workspace/gif-toolkit/docs/compression-pipeline.md)

---

## 历史 PASS 记录

| 日期 | 提交 | 结果 | 备注 |
|---|---|---|---|
| 初版沉淀 | AspectRatioConstraintError 引入 | PASS | longSideFloor 推导 |
