# SC-03 — soft 2MB / hard 4MB 双层目标分级

> **来源**:第 17 轮 "最佳目标 2M 以内,降级目标 4M 这样的逻辑"。
> **关联规则**:[R-05](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-05-soft-and-hard-target.md)

---

## 触发条件

输入是一段经典的 720p 短视频(比如 10s),按默认参数转 GIF。同一输入用三个 sub-case:

| sub-case | 输入估算 | 期望路径 | 期望产物 |
|---|---|---|---|
| 3a 体积小 | 转出原始 GIF ~ 1.5MB | Phase B 一次命中 | `<= 2.0MB (best)` |
| 3b 体积中 | 转出原始 GIF ~ 3MB | Phase B 二分降到 2MB 以下 | `<= 2.0MB (best)` |
| 3c 体积超大 | 转出原始 GIF ~ 8MB | Phase B 顶不住,Phase C/D 降级到 4MB | `<= 4.0MB (fallback)` |

---

## 期望行为

- **soft 命中** → 输出体积 ≤ 2 097 152 B,日志 `gif saved (X.XX MB <= 2.0MB (best))`
- **fallback 命中** → 输出体积 ≤ 4 194 304 B,日志 `gif saved (X.XX MB <= 4.0MB (fallback))`
- **完全压不下** → 标 skipped,日志 `gif over 4.0MB, marking skipped`,**不输出文件**

UI 表单上:

- soft / hard 互相 clamp(soft ≤ hard)
- 改 soft 时上限是 hard
- 改 hard 时下限是 soft

---

## 反向断言

- No **不允许**让用户手动输入 soft > hard
- No **不允许**Phase C/D 把成功的产物 mark 成 best(只有 soft 命中才能叫 best)
- No **不允许**因为已经达到 fallback 就跳过 Phase C/D 中的 longSideFloor 守护(参考 SC-02)
- No **不允许**输出体积 > maxBytes 还把文件落到磁盘(必须 skipped)

---

## 复演步骤

### 自动验算(纯函数,可一行 node 跑)

```ts
import { compressLoop } from '../../src/main/processor';
const result = await compressLoop(/* 给一个 ~3MB 的 GIF */);
console.assert(result.bytes <= 2 * 1024 * 1024, 'should fit in soft');
console.assert(result.tier === 'best');
```

### UI 复演

1. `npm run dev`
2. 粘一个会产出 ~3MB GIF 的视频 URL
3. 默认 softMaxBytes=2MB / maxBytes=4MB
4. 看 TaskTable 进度条 + 日志最后一行
5. 检查 outputDir 里产物体积 ≤ 2MB

---

## 关联规则

- [R-05 soft-and-hard-target](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-05-soft-and-hard-target.md)
- [docs/compression-pipeline.md §1](file:///Users/guoshuyu/workspace/gif-toolkit/docs/compression-pipeline.md)

---

## 历史 PASS 记录

| 日期 | 提交 | 结果 | 备注 |
|---|---|---|---|
| 初版沉淀 | softMaxBytes / maxBytes 引入 | PASS | UI clamp |
