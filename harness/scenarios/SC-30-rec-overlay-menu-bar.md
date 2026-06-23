# SC-30 — 录制区域比红框向上偏移一条 title bar 高度

## 触发场景

用户在 macOS 主屏用 dock 悬浮球就地录屏，**红框框在主窗中段（"输入文章 URL → 高级 GIF 优化"那一段）**，
但产物 mp4 / gif 出来：

- **顶部**多了一条 macOS title bar + Gif Toolkit logo 行（红框上方区域）
- **底部**"高级 GIF 优化"那行被截掉

整体看就像产物相对红框向上偏移了 ≈ **一条 menu bar 的高度**。
用户连续 3 轮反馈："我只是想我圈住哪里就录制哪里，现在出来的偏上方"。

## 关联规则

- **R-REC-DESKTOP-AREA** #overlay-workarea-vs-display（本场景沉淀的新锚点）
- R-REC-DESKTOP-AREA #dpr-scale（CSS → device px 换算）
- R-DOCK-FLOATING（dock 自治录屏链路）
- R-10（renderer 不直接读本地路径 / 不直接调 ffmpeg）
- R-16（修 bug 必须先写会失败的回归测试）

## 现象 → 根因 → 修复

| 现象 | 根因 | 修复 |
|---|---|---|
| 产物比红框向上偏移 ≈ menu bar 高度 | mac `transparent + frame:false` BrowserWindow 把 frame bounds 设到 `display.bounds`（含 menu bar）后，**webContents 渲染区域仍会被系统自动避开 menu bar / notch**。renderer 拿到的 viewport CSS (0,0) ≈ workArea 顶，不是 bounds 顶。selector 直接把 `e.clientX/Y` 当 display-local 坐标发回主进程，主进程 ×scaleFactor 转 device px crop 时，offset.y 比真实小了 menu bar 那么多 → ffmpeg 抓帧整体向上漂移 | 主进程收 region 后，加 `(display.workArea - display.bounds)` 偏移把 overlay-local CSS 抬成 display-local CSS，再交给 `buildRecorderArgs` |
| 第一轮尝试用 `win.getContentBounds()` 算 delta 不起作用 | mac `transparent + frameless` BrowserWindow 的 `getContentBounds()` 返回的就是 frame bounds（= display.bounds），delta 永远算成 0 | 改用 `display.workArea` —— [Electron Display 文档](https://www.electronjs.org/zh/docs/latest/api/structures/display)契约保证 workArea = bounds 减去 menu bar / dock，**不依赖任何窗口运行时状态** |
| 「录制中」红框 overlay（static read-only）也会出现同样偏移 | 同一个根因：static overlay 也是 transparent + frameless，渲染端 CSS 原点同样被 menu bar 推下来 | 反向校正：把 display-local region 减去 `(workArea - bounds)` 再发给渲染端，红框就能精确落到「即将被 ffmpeg 抓的同一块 device px」对应的 overlay-local CSS 位置上 |
| win/linux 没问题但跨平台契约要一致 | workArea 不在 mac 时一般 == bounds | 不分平台一律用同一表达式 `applyOverlayContentDelta(raw, display.workArea, display.bounds)`，跨平台 delta 自然退化为 0 |

## 关键代码

```ts
// src/main/recorderOverlay.ts
export function applyOverlayContentDelta(
  raw: RecorderRegion,
  workArea: { x: number; y: number },
  displayBounds: { x: number; y: number },
): RecorderRegion {
  const deltaX = workArea.x - displayBounds.x;
  const deltaY = workArea.y - displayBounds.y;
  return { ...raw, x: raw.x + deltaX, y: raw.y + deltaY };
}

// selector 回传时：+delta
function correctRegionFromOverlayLocal(display, raw) {
  return applyOverlayContentDelta(raw, display.workArea, display.bounds);
}

// static overlay 派发时：-delta
const deltaY = target.workArea.y - target.bounds.y;
const renderRegion = { ...input.region, y: input.region.y - deltaY };
```

## 排查记忆点（一句话定位）

**如果产物上多了一条 macOS title bar / 主窗 logo 行 + 底部被截一段 ≈ menu bar 高度的内容**，
= ffmpeg crop offset y 偏小，= `correctRegionFromOverlayLocal` 没正确算出 delta。
**第一时间打印 `display.bounds / display.workArea / win.getContentBounds()` 三组值**，
看 workArea.y 是不是 ≥ bounds.y + 24。

## 验证脚印

```
$ npm run typecheck   # 绿
$ npm run lint        # 绿
$ npm run test:fast   # 65 files / 989 tests 全绿（含 tests/main/recorderOverlayCoord.test.ts 6 case）
$ npm run build       # 绿
```

Mac smoke（待人工补）：

1. `npm run dev` 起 app
2. dock → 点录屏小球 → 框中段红框
3. 停止录制 → 检查产物：**红框上下边缘 = 产物上下边缘（无偏移）**

## 反向清单

- [ ] **不要**用 `win.getContentBounds()` 算 overlay → display 偏移（mac transparent 窗口返回 frame bounds）
- [ ] **不要**只在 mac 加 delta；表达式必须跨平台对称，win/linux delta 自然 = 0
- [ ] **不要**忘了反向校正 static overlay（不然红框位置和实际抓帧位置错位，用户更困惑）
- [ ] **不要**改 selector renderer 去手动减 menu bar；renderer 拿到的 viewport (0,0) 视角内就是干净 0 起点，应由主进程统一校正
