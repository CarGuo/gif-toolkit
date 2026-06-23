# R-REC-DESKTOP-AREA — 桌面区域录屏（主进程独占 ffmpeg + 跨平台分支）

## 一句话

桌面"框选→录制→转 GIF"功能，**所有 IO（spawn ffmpeg / fs / desktopCapturer）都在主进程**，区域选择走 transparent BrowserWindow 拖框，复用工具箱 video-to-gif 链路 + R-04/R-05 双层目标压缩 — renderer 永远不直接抓帧。

## 反向清单（这些事情**禁止**做）

1. **禁止**在 renderer 里调 `navigator.mediaDevices.getDisplayMedia()` 抓帧后再 PostMessage 给主进程编码。  
   理由：违反 R-10（renderer 不许直接做重 IO），且 Electron 的 MediaRecorder 出来的 webm/vp8 还得二次转码，链路更脏。

2. **禁止**为某个 host 加白名单（"只支持 Chrome 的录屏 API"），同 R-02 精神。  
   ffmpeg 的 avfoundation/gdigrab/x11grab 是 OS 级捕获，本来就跨任意来源。

3. **禁止**在 `buildRecorderArgs` 里夹副作用（fs.mkdir / spawn）。  
   这把函数是**纯**的，单测靠它验证 platform 分支契约不被破坏。

4. **禁止**忽略 macOS 屏幕录制权限。  
   必须在 panel 进入时调 `recorder:checkPermission`，denied 时显示 toast + 「打开系统设置」按钮（深链到 `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`）。

5. **禁止**录制超过 `RECORDER_MAX_DURATION_SEC = 60s` 的兜底。  
   沿用 R-22 maxSegmentSec 哲学，避免误录天荒地老把磁盘写炸。

6. **禁止**让 overlay BrowserWindow 注入完整 preload。  
   overlay 只暴露 `onConfig / finish / cancel` 三件套，零 `giftk.*` API、零 fs、零 shell。攻击面最小化。

7. **禁止**在 cancel 时直接 SIGKILL。  
   先向 ffmpeg stdin 写 `q\n` 让它 flush moov atom，2 秒还没退再 SIGKILL，否则 mp4 尾巴帧全丢。

8. **禁止**在 renderer 里复刻一套 GIF 压缩。  
   录到 mp4 后路径回给 renderer，由 renderer 走 `toolbox.startChain('video-to-gif')` 复用现成的 Phase A/B/C/D + 双层目标。一处管线一处维护。

## 跨平台 ffmpeg argv 契约

| 平台 | 设备 | 区域映射 |
|---|---|---|
| darwin | `-f avfoundation -i "<deviceIdx>:<audioIdx\|none>"` | `-vf "crop=W:H:X:Y"`（avfoundation 只能按 device 抓整屏，区域是 filter） |
| win32 | `-f gdigrab -i desktop` | `-offset_x X -offset_y Y -video_size WxH`（原生支持） |
| linux | `-f x11grab` | `-video_size WxH -i :0.0+X,Y`（原生支持） |

所有平台共享：
- `-y` 覆盖（tmp 路径已 unique）
- `-framerate N` 走 capture 侧（不是 `-r`）
- `-c:v libx264 -preset ultrafast -pix_fmt yuv420p`（录制阶段不丢帧，GIF 留给后续 stage 压）

## 验证步骤

1. `npm run test:fast` — `tests/main/recorder.test.ts` 必须 10/10 绿（argv builder 跨平台 contract 锁定）。
2. `npm run typecheck` + `npm run lint` — 零错。
3. `npm run build` — `dist/renderer/recorderOverlay.html` + `dist/main/recorder.js` + `dist/main/recorderOverlay.js` + `dist/preload/recorderOverlay.js` 均产出。
4. 改了 recorder.ts / recorderOverlay.ts / preload/recorderOverlay.ts → 跑 `npm run test:e2e:smoke`（IPC 变化）。
5. mac 真机 smoke：第一次开 panel 应该弹系统屏幕录制授权；授权后能拖框、录到 mp4 落到 `<tmpdir>/giftk-rec/rec-*.mp4`。

## 文件清单

- 主进程：[src/main/recorder.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/recorder.ts)、[src/main/recorderOverlay.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/recorderOverlay.ts)
- preload：[src/preload/recorderOverlay.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/recorderOverlay.ts) + recorder 命名空间挂到 [src/preload/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/index.ts)
- 共享类型：[src/shared/types/recorder.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types/recorder.ts)（barrel 已挂 [src/shared/types/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types/index.ts)）
- overlay 渲染：[src/renderer/recorderOverlay.html](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/recorderOverlay.html) + [src/renderer/recorderOverlay.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/recorderOverlay.tsx)
- panel：[src/renderer/components/RecorderPanel.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/RecorderPanel.tsx)（接入 [SecondaryViews](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/views/SecondaryViews.tsx) + [TopBar](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/views/TopBar.tsx) 「录屏」tab）
- tmp 守卫：`giftk-rec` 已加进 [ALLOWED_PREFIXES](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/tmpCleanup.ts#L42-L61)（R-87）
- vite multi entry：[vite.config.ts](file:///Users/guoshuyu/workspace/gif-toolkit/vite.config.ts) `rollupOptions.input.{main,recorderOverlay}`
- 测试：[tests/main/recorder.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/recorder.test.ts) — 10 case 锁住 darwin/win32/linux argv 契约 + clamp 行为 + cursor/audio 开关

## 双模式契约（v2 follow-up）

为回应用户「为什么要有视频？不能直接出 GIF 吗？」的质疑，录屏新增**双模式 segmented control**，二选一不静默 fallback：

| mode | 用户视角 | 链路 | 适用场景 |
|---|---|---|---|
| `mp4-then-gif`（默认） | 「质量优先」 | 录 mp4 → 主进程 emit `done` + `gifPath=undefined` → renderer 拿 `mp4Path` **自动**派发 `startToolboxChain({ steps: [{ kind: 'video-to-gif', params: { fps, width, softMaxBytes, maxBytes } }] })` → 走 R-04 四阶段 + R-05 软/硬目标 → 最终 GIF | 长录、需要双层目标精控、需要中断后从 mp4 二次处理 |
| `gif-direct`（极速直出） | 「极速直出」 | ffmpeg single-pass `split[a][b];[a]palettegen=stats_mode=single[p];[b][p]paletteuse=new=1` + `-f gif` 直出 GIF；`outputPath` 扩展名 = `.gif`；close handler emit `gifPath = session.outputPath` | 短录、即录即用、不需要严格控大小 |

### 反向清单（gif-direct 专属）

1. **禁止**让 gif-direct 模式静默 fallback 到 mp4-then-gif —— 违反 R-COMPRESS-V1.5 精神（gifski 不存在禁用而非静默 fallback 同款）。若用户切到 gif-direct，UI **必须**显式禁用 `softMaxBytes` / `maxBytes` / `maxWidth` / `captureAudio` 四个字段（`disabled + opacity 0.4`）并附 tooltip 解释「极速模式 single-pass palettegen，不支持双层目标 / 缩边 / 音轨」。

2. **禁止**在 gif-direct 模式输出 `.mp4` 扩展名。`startRecorder` 必须 `const ext = mode === 'gif-direct' ? 'gif' : 'mp4'`，否则 tmp 清理 / sessionTmpRegistry 白名单匹配会错。

3. **禁止**在 mac 的 gif-direct 模式把 crop 放到 `-vf`。avfoundation 只能整屏抓，crop 必须合并进 `-filter_complex` 头部（`crop=W:H:X:Y,split[a][b];...`）；win/linux 的 gdigrab/x11grab 抓帧本就带区域，filter_complex 头部**不**带 crop。

4. **禁止**让 mp4-then-gif 模式跳过 `startToolboxChain` 而 renderer 自己调 `toolbox.run`。chainId 必须**唯一**且贯通 `chainIdRef.current`；`process:progress` 必须按 `p.taskId.startsWith(chainId)` 过滤，否则会被其他 toolbox 任务的进度污染。

### 跨平台 filter_complex 契约

| 平台 | gif-direct filter_complex 头部 | 说明 |
|---|---|---|
| darwin | `crop=W:H:X:Y,split[a][b];[a]palettegen=stats_mode=single[p];[b][p]paletteuse=new=1` | avfoundation 整屏抓，crop 必须在 filter graph 内 |
| win32 / linux | `split[a][b];[a]palettegen=stats_mode=single[p];[b][p]paletteuse=new=1` | gdigrab/x11grab 已在 input 侧定区域，filter graph 不重复 crop |

所有平台 gif-direct 共享：替换 `-c:v libx264 ... outputPath.mp4` 尾巴为 `-filter_complex <fc> -f gif outputPath.gif`。

### 验证步骤（双模式新增）

1. `tests/main/recorder.test.ts` 必须 **15/15** 绿（10 旧 + 5 新 gif-direct 跨平台 + clamp + mp4-then-gif 回归）。
2. UI 切到 gif-direct：`softMaxBytes` / `maxBytes` / `maxWidth` / `captureAudio` 必须 `disabled`。
3. UI 切回 mp4-then-gif：四字段恢复可编辑。
4. mp4-then-gif 录完 → 立刻看到「转 GIF 中…」chip + `lastGif` 最终出来（chainId 前缀过滤生效）。
5. gif-direct 录完 → `lastGif = session.outputPath`（扩展名 `.gif`），无 chain 派发。

---

## v2.1 — #probe-device / #even-pixel / #loglevel-warning

用户截图反馈：**首次启动录屏直接 `ffmpeg exit code=1`**。
根因三连：

1. **avfoundation device index 硬编 1**  
   mac 上 `-f avfoundation -i 1:none` 等于"第 2 个设备"。默认机器是 `[0] FaceTime / [1] Capture screen 0`，但**只要插上 iPhone Continuity Camera / OBS Virtual / 外接 USB Camera**，"Capture screen 0" 就会被挤到 `[2]` 甚至 `[3]`，再硬编 1 录到的是摄像头（且很可能 ffmpeg init 失败 → exit 1）。
   
2. **crop 宽高奇数**  
   `libx264` + `yuv420p` 要求宽高必须能被 2 整除；用户选区拖出来很容易得到 `275×223` 这种奇数，ffmpeg 在 init 阶段就 throw `width not divisible by 2 (275x223)` → exit 1。
   
3. **`-loglevel error` 把致命 init 错误也吞掉**  
   ffmpeg 在 device probe / x264 init 这一步的错误是 warning 级别，`-loglevel error` 看不到，stderr 一片空，UI 只能 surface 个空错误，难以诊断。

### 反向条款（禁止做）

1. **禁止**在 mac 平台上对 avfoundation 录屏硬编 `-i N:none`（无论是 `1`、`'default'`、`'screen:0'` 等）。必须先调 [detectMacScreenDevice(displayOrdinal)](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/recorder.ts) 拿到真实索引；探测失败再 fallback 1（最后保底，**禁止**抛错让录屏不可用）。

2. **禁止**把 `region.w` / `region.h` 直接拼进 ffmpeg 的 `-vf crop=…` / `-video_size WxH`。必须先过 [toEvenSize(n)](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/recorder.ts) 向下取偶（min=2）。三处都要改：darwin `crop=W:H:X:Y` / win32 `-video_size` / linux `-video_size`。

3. **禁止**用 `-loglevel error` 跑 recorder（spawn 时）；最低 `-loglevel warning`，否则 init 致命错被吞、用户只看到空错误。

### 实现锁

- [detectMacScreenDevice](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/recorder.ts) 必须带 5min cache（避免每次录制都 spawn 一次 `ffmpeg -list_devices`，单次 list 在某些机型耗时 1-3s）；cache key = `displayOrdinal`；cache miss 时 spawn + 解析 stderr（`-list_devices true` 在 ffmpeg 中**永远 exit 1**，输出在 stderr）
- [parseAvfoundationScreenDevices(stderr)](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/recorder.ts) 必须是**纯函数**（无 IO），便于单测；状态机扫行：进入 `AVFoundation video devices:` 段、退出于 `audio devices:` 段、行内 `[N] Capture screen X` 提取 `index=N` + `ordinal=X`
- 调用方有三个：[recorder:start](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) handler、[startDockRecording](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/dock.ts)、未来任何主进程 startRecorder 入口；**任何**新入口都不能硬编
- 单测必锁三 case：纯 FaceTime+Capture screen 0、插 iPhone 后 ordinal 移到 2、无 video 段（fallback 1）
- [tests/main/recorder.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/recorder.test.ts) 必须有一组 case 锁定 odd-region → `cropW/cropH` 取偶（如 `region.w=275 → cropExpr=crop=274:...`）

---

## v2.2 — #overlay-workarea-vs-display（SC-30 沉淀）

用户截图反馈：**dock 录屏产物比红框向上偏移 ≈ 一条 menu bar 高度**，
顶部多了一条主窗 title bar / Gif Toolkit logo 行，底部对应内容被截。

根因：
mac `transparent + frame:false` BrowserWindow 即便 frame bounds 设到 `display.bounds`
（含 menu bar 区域），**webContents 渲染区域仍会被系统自动避开 menu bar / notch**，
overlay-renderer 拿到的 viewport CSS `(0, 0)` ≈ `display.workArea` 顶，不是 `display.bounds` 顶。
selector 直接把 `e.clientX/Y` 当 display-local 发回主进程，主进程再 ×scaleFactor 转 device px crop，
offset.y 比真实小了 menu bar 那么多 → ffmpeg avfoundation `-i N` 抓帧整体向上漂移。

**第一轮尝试用 [win.getContentBounds()](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/recorderOverlay.ts) 算 delta 不起作用** —— mac
transparent + frameless 窗口的 `getContentBounds()` 返回的就是 frame bounds（= display.bounds），
delta 永远算成 0，等于没修。

### 反向条款（禁止做）

1. **禁止**用 `win.getContentBounds()` 算 overlay → display 坐标偏移（mac transparent 窗口失效）；
   必须用 [Electron `display.workArea`](https://www.electronjs.org/zh/docs/latest/api/structures/display)
   —— 文档契约保证 workArea = bounds 减去 menu bar / dock，**不依赖任何窗口运行时状态**。

2. **禁止**只在 mac 平台加 delta；表达式必须跨平台对称
   （[applyOverlayContentDelta(raw, display.workArea, display.bounds)](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/recorderOverlay.ts)），
   win/linux workArea==bounds 时 delta 自然退化为 0。

3. **禁止**在 selector renderer 里手动减 menu bar；renderer 视角内 viewport (0,0) 就是干净 0 起点，
   坐标系翻译只在主进程统一做一次（边界一致性）。

4. **禁止**忘了反向校正 [showStaticOverlayForRegion](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/recorderOverlay.ts)：
   输入是 display-local CSS（已被 selector 端 +delta 修过），要 -delta 才能在 static overlay 渲染端画到正确位置，
   否则用户看到的红框位置与实际抓帧位置错位，更困惑。

### 实现锁

- [applyOverlayContentDelta](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/recorderOverlay.ts) 必须是**纯函数**：`(raw, workArea, displayBounds) → corrected`，
  便于单测；不可访问 `screen` / `BrowserWindow`
- [correctRegionFromOverlayLocal](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/recorderOverlay.ts) 只接收 `display: Electron.Display`（不要传 win），
  内部直接读 `display.workArea`
- [tests/main/recorderOverlayCoord.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/recorderOverlayCoord.test.ts) 必须锁 6 case：
  mac 主屏 menu bar=24 / mac notch 屏=37 / win/linux delta=0 / 外接副屏起点 / w-h-displayId 透传 / 反向校正
- dev 模式必须 [log](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/logger.ts) 出
  `displayBounds / workArea / raw / corrected` 四组值，方便后续排查（不要在 prod 跑日志噪音）

### 排查记忆点（一句话定位）

**产物上多了一条 macOS title bar / 主窗 logo 行 + 底部被截一段 ≈ menu bar 高度的内容**
= ffmpeg crop offset y 偏小
= `correctRegionFromOverlayLocal` 没正确算出 delta
→ 第一时间打印 `display.bounds / display.workArea` 两组值，看 `workArea.y - bounds.y` 是不是 ≥ 24

---

## v2.3 起 #gif-direct-only：录屏只走 gif-direct，超阈值再 recompress

**触发原因**：原 `mp4-then-gif` 模式让 dock / panel 在 ffmpeg 录完 mp4 之后必须再串一段 `video-to-gif` toolbox chain，链路长、UI 状态机复杂（chainProgress / pendingMp4Ref 两条流），用户在 dock 上等的不是真录屏而是后续转码。  
v2.3 起统一收敛为 **gif-direct**：

1. **类型**：[RecorderMode](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types/recorder.ts) 收敛为 `'gif-direct'` 单例字面量；新增 `maxLongSide: number`（0=不缩放）+ `RECORDER_LONG_SIDE_PRESETS = [600, 800, 1080]` + `RECORDER_DEFAULT_LONG_SIDE = 800`。**不要**再加回 `'mp4-then-gif'`/`'gif-via-mp4'` 等任何分支。
2. **buildRecorderArgs**：必须 `-f gif` 输出、ext='gif'；`gifFilterComplex` 滤镜顺序固定为 `crop → scale → split → palettegen → paletteuse`；scale 只在 `maxLongSide > 0` 时插入，公式：`scale='if(gte(iw,ih),min(L,iw),-2)':'if(lt(iw,ih),min(L,ih),-2)'`（短边自动 -2 偶数对齐）。**禁止**出现 libx264 / `-c:v` / mp4 任何字符串。
3. **recompress 兜底**：[maybeRecompressOversizeGif](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/dockRecording.ts) 在录完后 `fs.stat` 拿到 size > `maxBytes` 才接 toolbox `gif-optimize` chain；≤maxBytes 直接返回原 gif，**不要**无脑接 chain。
4. **dock chip UI**：[dockOverlay.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/dockOverlay.tsx) 在 expanded panel idle 阶段渲染 `[600, 800, 1080, 原]` chip，点击走 `window.giftkDock.setLongSide(n)` → `dock:setLongSide` IPC → [setDockLongSide](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/dockRecording.ts) 白名单校验（`RECORDER_LONG_SIDE_PRESETS ∪ {0}`，其余 reject）。
5. **panel UI**：[RecorderPanel.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/RecorderPanel.tsx) 删除模式卡片 / `pendingMp4Ref` / `dispatchVideoToGifChain` / `chainIdRef` / `chainProgress`；done handler 简化为 `if (p.gifPath) setLastGif(p.gifPath); setSessionId(null)`。
6. **handler 兜底**：[src/main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) `recorder:start` 必须强制 `params.mode = 'gif-direct'` + 兜底 `maxLongSide = RECORDER_DEFAULT_LONG_SIDE`，防 IPC 入参缺失炸。

### 反向清单（v2.3 起绝对禁止）

- 任何 PR 再引入 `mode: 'mp4-then-gif'` / `'gif-via-mp4'` 字面量 → block
- 任何 `dispatchVideoToGifChain` / `pendingMp4Ref` / `chainProgress` 出现在 [RecorderPanel.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/RecorderPanel.tsx) → block
- recompress 写成「无条件接 gif-optimize chain」（不看 stat） → 浪费 CPU + 多次有损量化
- chip 接受 `RECORDER_LONG_SIDE_PRESETS ∪ {0}` 之外的值（如 720 / 1440） → 违反白名单契约

### 验证

- [tests/main/recorder.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/recorder.test.ts) — `mode: 'gif-direct'` + 4 个 scale 用例 + 「never libx264 / mp4」断言
- [tests/main/dock.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/dock.test.ts) — `dockRecorderParams` 期望 `mode='gif-direct'` + `maxLongSide=800`
- 见 [SC-31-recorder-direct-gif-and-recompress.md](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-31-recorder-direct-gif-and-recompress.md) 回归场景

