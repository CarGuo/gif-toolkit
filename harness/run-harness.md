# harness/run-harness.md

> 怎么跑一遍 harness 回归。**本仓库当前不引入 vitest / jest**(避免和 Electron 主/渲双进程的复杂性纠缠),所以这套 harness 是**半自动**的:
>
> - **静态部分**(类型 / lint / 构建)→ 命令一键跑
> - **动态部分**(每个 SC 的"输入 → 实际输出 → 期望输出 是否匹配")→ 由人按 SC 文档手动复演,**输出对照 fixture**

---

## 1. 静态门禁(每次提交必跑,1-2 分钟)

```bash
cd gif-toolkit
npm run typecheck   # 主+渲 tsc --noEmit
npm run lint        # eslint 0 warning
npm run build       # 主+渲全量构建
```

三个全部退出 0 才算静态门禁通过。**任何一项红 → 不允许进入下面的动态回归**。

---

## 2. 动态回归(按改动影响的 SC 集跑)

每个 SC 都有"复演步骤 + 期望产物"。按下面这张映射表,**找到你这次改动影响哪些规则,把对应的 SC 全跑一遍**。

| 你改了… | 必跑场景 |
|---|---|
| [src/main/sniffer.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/sniffer.ts) | SC-01 / SC-04 |
| [src/main/processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) | SC-02 / SC-03 / SC-05 / SC-06 |
| [src/shared/types.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types.ts) | **全部**(共享类型变化波及面最大) |
| [src/preload/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/index.ts) | 全部(白名单挂错,前端就空白) |
| [src/renderer/components/OptionsForm.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/OptionsForm.tsx) | SC-03 / SC-06 |
| [src/renderer/components/MediaGrid.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/MediaGrid.tsx) | SC-04 |
| [src/renderer/App.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/App.tsx) | SC-04 / SC-05 |

---

## 3. SC 单条复演法

每个 SC 文件结构:

```
## 触发条件     ← 输入是什么
## 期望行为     ← 应该输出什么
## 反向断言     ← 不应该输出什么(关键!防止"碰巧通过")
## 复演步骤     ← 你照着点就行
## 关联规则     ← 出问题时回去查的总规约
```

**手工跑一条 SC 时**:

1. 启动 `npm run dev`
2. 复演 "复演步骤" 里的输入(可能是粘 URL / 上传文件 / 调参数)
3. 对照 "期望行为" 看 UI / 日志 / 输出文件
4. **再** 对照 "反向断言" — 比如 SC-02 不能仅看到"早 fail"就过,还要确认**没有产出畸变文件**
5. 都符合 → 标 `PASS`(在 PR 描述写 `SC-02: PASS`)
6. 不符合 → **不要修测试,改代码** (R-12)

---

## 4. 运行结果记录(在 PR 里贴)

复制下面的模板到 PR 描述:

```
## Harness 回归

### 静态
- [x] npm run typecheck
- [x] npm run lint
- [x] npm run build

### 动态(根据改动影响的 SC)
- [x] SC-01 dedup-key-generic (PASS)
- [x] SC-02 aspect-ratio-early-fail (PASS)
- [ ] SC-03 soft-vs-hard-target (N/A 本次未触及压缩管线)
- [x] SC-04 iframe-embed-vimeo (PASS)
- [ ] SC-05 progress-richness (N/A)
- [ ] SC-06 concurrency-default-3 (N/A)
```

**N/A 的项必须给出"为什么没跑"的理由**,不能空着。

---

## 5. 当 SC 失败时

1. **首要假设是代码错了,不是测试错了**(R-12)
2. 重读对应的 R-XX 规则文档
3. 看是否触发了某个边界条件 → 修代码
4. 修完再跑一次该 SC + 它强相关的两个 SC(防止"修一个引出三个")

---

## 6. 为什么不直接接 vitest?

**短期内不接**,因为:

- Electron 主/渲双进程下跑单测要 mock IPC,投资回报比一般
- 视频/GIF 编解码涉及二进制比对,fixtures 体积大不适合上 Git
- 当前 harness 的痛点是"规则不被记住",不是"测试不被跑"
- 加 vitest 会让"门槛"变高,反而压低了 Agent 沉淀新 SC 的意愿

**但长期会接**。当 SC 数量超过 ~20 个时,把 SC 复演步骤里"调用 sniffer.ts"这种纯函数路径自动化是高 ROI 的。届时:

```
harness/
└── runner/         ← 新增,vitest 跑 sniffer / compressLoop 这种纯函数
    ├── vitest.config.ts
    └── *.test.ts
```
