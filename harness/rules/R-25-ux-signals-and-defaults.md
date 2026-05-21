# R-25 — UX 信号 + 默认收紧(loading overlay / 片段缩略图 / 重复嗅探确认 / minSize=450)

> **来源**:第 42 轮用户反馈四点:
> 1. "我选择带有视频的片段之后,它会消失一段时间,然后才在底部出现 Video,这个不科学啊,这个过程做了什么都不知道"
> 2. "视频片段有办法显示缩略图吗?"
> 3. "已经嗅探过的页面,再点嗅探时要弹出框确实,是否再次嗅探同一个 url"
> 4. "默认最小尺寸修改为 450,并发默认 3"
>
> **关联规则**:[R-08](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-08-progress-richness.md) [R-22](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-22-clip-segment-cap.md) [R-23](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-23-batch-confirm-modal.md) [R-16](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-16-tests-required.md)

---

## 强制约束

1. **#1 媒体加载 overlay**:[PreviewModal.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/PreviewModal.tsx) 在 `naturalSize.w === 0 && !mediaError` 期间**必须**渲染一个 `role="status"` `aria-label="media-loading"` 的覆盖层,显示 spinner + 文案"正在加载视频元数据 / 首帧…" + hint。一旦 `onLoadedMetadata` 写入非 0 尺寸或 `onError` 触发,overlay 立即消失。**反向**:不允许 modal 打开后只是一片黑(原有 bug),用户无法判断是 CORS 失败还是网络慢。
2. **#2 视频片段缩略图**:[useSegmentThumbnails](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/useSegmentThumbnails.ts) 用**单个共享 hidden `<video>`** + `<canvas>` `drawImage` + `toDataURL('image/jpeg', 0.7)` 串行 seek 到每段中点抽帧,生成 160px 宽缩略图。SegmentPicker 接受可选 `videoUrl` prop 自动启用;BatchSegmentModal 默认每条 entry 传入 `e.media.url`。CORS taint canvas → 静默 `null` 回退到无图模式,**不**阻塞 chip 选择。**反向**:不允许给每段开一个 `<video>`(GPU 内存炸裂),不允许并发 seek(浏览器 video element 不支持并发 seek,会卡死)。
3. **#3 重复嗅探确认**:[App.tsx onSniff](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/App.tsx) 派发前**必须**判断 `result?.pageUrl === trimmed && (result.items.length > 0 || result.warnings.length > 0)`,命中则 `window.confirm(...)` 询问"已嗅探过该 URL,是否再次嗅探?",取消 = 不发请求(保留当前结果),确认 = 走原流程清空重抓。**反向**:不允许在用户已经"嗅探出 30 个媒体且已勾选 5 个"的情况下,因为误触按钮就把所有选择清空,这是 R-08 的 UX 反例。
4. **#4 默认值**:[DEFAULT_OPTIONS](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types.ts) `minSize` **必须**为 450(原 240),`concurrency` **必须**为 3(原本就是 3,显式锁定)。**反向**:不允许把 `minSize` 改回 240(R-03 + R-06 仍然成立,但用户认为 240 太糊),不允许把 `concurrency` 设为 `undefined` 让 main 默认接管(必须 renderer 显式给值,IPC payload 才有审计性)。

---

## 反向断言

- No **不允许** loading overlay 用 `setTimeout` 延迟显示("等 0.5s 再展示"看似优雅,但用户感知就是"消失一段时间")。必须 modal 一打开就立即显示。
- No **不允许** 缩略图 hook 在 `videoUrl` 变化时不清空旧 thumbs(否则切换视频会短暂显示前一个视频的缩略图)。
- No **不允许** 缩略图失败一次就放弃整个视频(每段独立 `null`,不互相阻塞)。
- No **不允许** 重复嗅探 confirm 把"清空当前结果重新拉取"翻译成英文或省略。用户必须明确知道"会丢失当前选择"。
- No **不允许** 用 `prompt()` 替代 `confirm()`(`prompt` 会要求文本输入,误操作率更高)。
- No **不允许** `HARD_MIN_SIZE` 被联动改成 450(那是 [processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts#L139) 的最低安全下限,用户给的是**默认值**,不是**绝对下限**)。

---

## 测试覆盖(R-16 关卡)

- [tests/shared/defaults.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/shared/defaults.test.ts) × 4:`minSize=450` + `concurrency=3` + 不退化的其他默认值(maxWidth/fps/maxBytes)
- [tests/renderer/PreviewModal-loading.test.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/tests/renderer/PreviewModal-loading.test.tsx) × 2:overlay 在 metadata 之前可见 + metadata 后消失
- [tests/renderer/SegmentPicker.test.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/tests/renderer/SegmentPicker.test.tsx) × 11(已存在,新增 `videoUrl` 不破坏既有契约 — `useSegmentThumbnails` 在 jsdom 下 video 不会真发首帧事件,所以 thumbs 一直空,picker 退化为原 chip 行为,既有 11 用例继续通过 = 隐式回归覆盖)
- 重复嗅探 confirm 的交互依赖 `window.confirm + IPC`,留给 [SC-15-resolver-failure-fallback](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-15-resolver-failure-fallback.md) 同级人工 e2e 验证(SOP 第 5 步)。

---

## 关联文件

- [src/shared/types.ts DEFAULT_OPTIONS](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types.ts)
- [src/renderer/components/PreviewModal.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/PreviewModal.tsx)
- [src/renderer/components/SegmentPicker.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/SegmentPicker.tsx)
- [src/renderer/components/useSegmentThumbnails.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/useSegmentThumbnails.ts)
- [src/renderer/components/BatchSegmentModal.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/BatchSegmentModal.tsx)
- [src/renderer/App.tsx onSniff](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/App.tsx)
- [src/renderer/styles.css .modal-player-loading](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/styles.css)
