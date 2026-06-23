# SC-31 — 录屏统一走 gif-direct + 超阈值才 recompress

> 关联规则：[R-REC-DESKTOP-AREA v2.3](../rules/R-REC-DESKTOP-AREA-recorder.md)、[R-DOCK-FLOATING](../rules/R-DOCK-FLOATING-floating-dock.md)

## 现象（修复前）

1. **panel**：用户在 [RecorderPanel](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/RecorderPanel.tsx) 上点「停止录制」后，状态条会卡在一个新的「转 GIF 中」长流程（`chainProgress` 走 toolbox `video-to-gif`），跟「录屏」体验脱节、UX 像两个独立任务。
2. **dock**：dock 球面上的「停止」按钮在 ffmpeg 收尾后又跑了一段不可见的 video-to-gif chain，产物路径来得很慢；用户怀疑 dock 卡死。
3. **代码**：[RecorderPanel](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/RecorderPanel.tsx) 维护双流（`pendingMp4Ref` + `chainIdRef` + `chainProgress`），状态机分叉、retry/cancel 难写对。

## 触发条件

- 任意平台（mac avfoundation / win gdigrab / linux x11grab）
- 录制时长 ≥ 5s（保证产物超过 2MB）
- panel 或 dock 任意入口

## 期望（修复后契约）

| 维度 | 修复前 | 修复后（v2.3） |
|---|---|---|
| [RecorderMode](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types/recorder.ts) | `'mp4-then-gif' \| 'gif-direct'` | `'gif-direct'`（单例字面量） |
| ffmpeg 输出格式 | mp4（再串 toolbox） | **gif 直出**（palettegen → paletteuse） |
| scale 控制 | 无 | `maxLongSide ∈ {0,600,800,1080}`，短边 -2 偶数对齐 |
| 超阈值处理 | 录前/录中无阈值，全靠后续 chain 压 | **录后 stat**，仅 `size > maxBytes` 时接 [maybeRecompressOversizeGif](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/dockRecording.ts) → gif-optimize chain |
| panel done | 进入第二个 chain 等待 | 直接 `setLastGif(p.gifPath)` 即结束 |
| dock chip | 无 | expanded panel idle 阶段渲染 `[600/800/1080/原]` chip |

## 自动化验证

```bash
npm run test:fast            # tests/main/recorder.test.ts + dock.test.ts 必绿
npm run typecheck
npm run lint
npm run build
```

关键断言：
- [recorder.test.ts](../../tests/main/recorder.test.ts) — `always includes -y and -f gif output, never libx264 / mp4`（所有平台分支共有断言），以及 4 个 scale 用例
- [dock.test.ts](../../tests/main/dock.test.ts) — `dockRecorderParams` 期望 `mode='gif-direct'` + `maxLongSide=800`

## 手工 smoke（v2.3 起每次涉及录屏链路必跑）

1. `npm run dev` 启动 → 点 dock 球展开
2. 在 chip 行点 `600` → 拖框 → 录 6 秒
3. 期望：
   - **没有**「转 GIF 中…」状态条
   - 终端日志最后一行是 `recorder-finished` 紧跟 `recorder:done`，**不**出现 `toolbox-chain ... gif-optimize`（除非 GIF > 4MB）
   - 产物 GIF 最长边 ≤ 600px（`identify -format "%w %h" out.gif` 验证）
4. 改 chip 为 `原` 再录 → 最长边 = 屏幕分辨率

## 不再犯的护栏

- [R-REC-DESKTOP-AREA v2.3](../rules/R-REC-DESKTOP-AREA-recorder.md#v23-起-gif-direct-only录屏只走-gif-direct超阈值再-recompress) 反向清单
- recompress 必须 `fs.stat` gate；任何「无脑接 chain」即视为回归
- `RECORDER_LONG_SIDE_PRESETS` 是白名单，PR 改值要同步 dock chip + setLongSide 校验
