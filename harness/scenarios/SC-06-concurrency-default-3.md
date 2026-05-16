# SC-06 — 并发默认 3,可配置 1..8,clamp 防爆

> **来源**:第 16 轮 "能并行执行吗?另外有个额问题,为什么压缩那么慢?"。
> **关联规则**:[R-07](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-07-pqueue-concurrency.md)

---

## 触发条件

用户在 [OptionsForm.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/OptionsForm.tsx) 修改"并发任务数"输入框,然后开 ≥ 4 条任务的批处理。

---

## 期望行为

- **默认值** = 3(打开 App,OptionsForm 显示 `concurrency: 3`)
- **范围** clamp 到 [1, 8]:
  - 输入 0 / 负数 → 自动回到 1
  - 输入 999 → 自动 clamp 到 8
  - 输入 5 → 保持 5
- **PQueue 真的并行**:开 4 条任务,concurrency=3 → 同一时刻最多 3 条 `state: 'running'`,第 4 条 `state: 'queued'` 等
- **CPU 表现合理**:concurrency=3 时 ffmpeg 进程数 ≤ 3 × 单 ffmpeg 内部线程数
- **取消时**:`cancel:all` 把 PQueue 里 pending 的任务全部清掉,running 的任务也 kill

---

## 反向断言

- ❌ **不允许** PQueue 硬编码 `new PQueue({ concurrency: 1 })`
- ❌ **不允许**接受 `concurrency: 100`(直接打爆机器)
- ❌ **不允许**接受 `concurrency: 0` 或负数(让任务永远不开始)
- ❌ **不允许**修改并发后老的 PQueue 还是旧值(要么重建 PQueue,要么调用 `queue.concurrency = n`)
- ❌ **不允许**为了"看起来快"把 concurrency 默认值开到 8(单机性能差/手机模式发烫)

---

## 复演步骤

1. 打开 App,确认 OptionsForm 上"并发任务数"显示 **3**
2. 嗅探一个有 4 个 GIF 的页面,全选
3. 点"开始批处理"
4. 看 [TaskTable](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/TaskTable.tsx):**同一时刻**最多 3 条 running,第 4 条等待
5. 把并发改成 **1**,再跑一次:**同一时刻**只 1 条 running
6. 把并发改成 **999**:输入框立即跳到 **8**
7. 把并发改成 **0**:输入框立即跳到 **1**

---

## 关联规则

- [R-07 pqueue-concurrency](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-07-pqueue-concurrency.md)
- [src/main/index.ts sanitizeOptions](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) — clamp 入口

---

## 历史 PASS 记录

| 日期 | 提交 | 结果 | 备注 |
|---|---|---|---|
| 初版沉淀 | concurrency 1→3,加 clamp | PASS | 配 OptionsForm |
