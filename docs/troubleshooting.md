# docs/troubleshooting.md

> 用户报障 / Agent 自查时的"症状 → 根因 → 对应规则/场景"对照表。
> 看到现象先来这查,**别直接动代码**。

---

## 1. 嗅探类

| 现象 | 可能根因 | 对应规则 / 场景 |
|---|---|---|
| 一个 URL 的同一资源出现多份(只是尺寸/裁剪不同) | dedupKey 没归一化新型展示参数 | [R-02](file:///Users/guoshuyu/workspace/gif-toolkit/AGENTS.md) / [SC-01](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-01-dedup-key-generic.md) |
| 页面里明明有视频但嗅不到,且页面是 Vimeo / YouTube iframe | 命中规则 6 但被禁用处理(预期行为) | [R-09](file:///Users/guoshuyu/workspace/gif-toolkit/AGENTS.md) / [SC-04](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-04-iframe-embed-vimeo.md) |
| 嗅不到任何东西 | 1) 网站 SSR 有反爬;2) 页面是 SPA,首屏 HTML 没数据;3) 视频走 blob:/MSE | [SC-04](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-04-iframe-embed-vimeo.md) |
| 给 file:// 路径报错 | `sniff:url` 拒绝非 http(s) 协议(预期) | [docs/ipc-contract.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/ipc-contract.md) §2.1 |

---

## 2. 压缩类

| 现象 | 根因 | 对应规则 / 场景 |
|---|---|---|
| 输出文件畸变(很扁/很瘦) | 没走 longSideFloor 守护就缩边了 | [R-06](file:///Users/guoshuyu/workspace/gif-toolkit/AGENTS.md) / [SC-02](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-02-aspect-ratio-early-fail.md) |
| Phase A 抛 `AspectRatioConstraintError` | 长条图 + minSide 太大,无法满足"长边≤maxSide 同时 短边≥minSide" | [R-06](file:///Users/guoshuyu/workspace/gif-toolkit/AGENTS.md) / [SC-02](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-02-aspect-ratio-early-fail.md) |
| 压缩巨慢(几百次 gifsicle) | startLossy 没自适应,从 0 一路硬试 | [R-04](file:///Users/guoshuyu/workspace/gif-toolkit/AGENTS.md) / [docs/compression-pipeline.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/compression-pipeline.md) §3 |
| 输出体积忽大忽小 | softMax 与 maxBytes 没分级,被 fallback 路径误判为 best | [R-05](file:///Users/guoshuyu/workspace/gif-toolkit/AGENTS.md) / [SC-03](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-03-soft-vs-hard-target.md) |
| `gif over 4.0MB, marking skipped` | Phase D 兜底也压不下,**这是预期行为** | [docs/compression-pipeline.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/compression-pipeline.md) §5 |

---

## 3. 进度 / 并发类

| 现象 | 根因 | 对应规则 / 场景 |
|---|---|---|
| UI 看起来"卡住"了几十秒 | TaskProgress 没带 substep / elapsedMs,只发了一次 percent=50 | [R-08](file:///Users/guoshuyu/workspace/gif-toolkit/AGENTS.md) / [SC-05](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-05-progress-richness.md) |
| 任务串行,即使有 4 个核 | concurrency 硬编码=1 没读 options | [R-07](file:///Users/guoshuyu/workspace/gif-toolkit/AGENTS.md) / [SC-06](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-06-concurrency-default-3.md) |
| concurrency=20 直接打爆机器 | 没 clamp 1..8 | [R-07](file:///Users/guoshuyu/workspace/gif-toolkit/AGENTS.md) / [SC-06](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-06-concurrency-default-3.md) |
| 取消按钮按了不停 | `cancel:all` 没把 PQueue 的 pending tasks clear | [src/main/processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) `cancelAll` |

---

## 4. 安全 / Electron 类

| 现象 | 根因 |
|---|---|
| `window.giftk.foo is not a function` | preload 漏 expose,或 global.d.ts 没声明 → R-11 |
| 打包后 ffmpeg 找不到(`spawn ENOENT`) | asarUnpack 漏配 → [package.json#L61-L68](file:///Users/guoshuyu/workspace/gif-toolkit/package.json#L61-L68) |
| renderer 直接拼了一个 `file://` 路径加载 | 违反 R-10,要走 IPC 把数据传过来 |

---

## 5. 当上面的表都查不到

1. 看 [harness/scenarios/](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/) 有没有同类
2. 把现象复盘成"输入是什么,期望输出是什么,实际输出是什么"
3. **修完后,把它沉淀成一个新的 SC-XX**,这是对未来的你最好的礼物。
