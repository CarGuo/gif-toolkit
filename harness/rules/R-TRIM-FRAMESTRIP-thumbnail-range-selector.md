# R-TRIM-FRAMESTRIP — Trim panel thumbnail strip + range selector

> Toolbox 的 Trim 工具必须提供「缩略图帧条 + 双拖把手 + 区间预览」的可视化选择器，光秃秃的「开始秒/结束秒」纯数字输入框是不够的（这是 ezgif.com、Capcut、QuickTime 等都默认提供的体验）。NumField 仍保留作为微调入口，但**不再是默认主入口**。

## 一、Why

`startSec` / `endSec` 用纯 NumField 写时，用户必须先反复试播原图、记下"觉得想要的开始时间是 1.3 秒"，再切换回 Toolbox 输入框，这种**眼睛—手—大脑—手**循环会让 Trim 体验远差于桌面级 GIF 工具。可视化帧条直接把"我要从这一帧到那一帧"的视觉直觉转化为像素位置，是这个工具核心功能。

## 二、硬约束（违反即 PR block）

### R-TRIM-FRAMESTRIP.1 — 主进程才能抽帧

renderer **永远不许** 直接调 `ffmpeg` / `sharp` / 也不许直接读本地文件。新 IPC `toolbox:thumbnailStrip` 在 [src/main/index.ts](file:///d:/workspace/project/gif-toolkit/src/main/index.ts) 注册，底层调用 [extractFrameStrip](file:///d:/workspace/project/gif-toolkit/src/main/ffmpeg.ts) → [extractFrameDataUrl](file:///d:/workspace/project/gif-toolkit/src/main/ffmpeg.ts)（已有的 ffmpeg 抽帧函数）。这是 [R-10](file:///d:/workspace/project/gif-toolkit/harness/rules/R-10-electron-isolation.md) 的应用。

### R-TRIM-FRAMESTRIP.2 — 帧通过 data URL 跨进程，绝不返回文件路径

`toolbox:thumbnailStrip` 返回 `{ atSec, dataUrl: 'data:image/jpeg;base64,...' }[]`。**禁止**返回临时文件路径或 `file://` URL 给 renderer。原因：
1. 跨平台：data URL 不带路径分隔符、不带驱动器号、不需要 `pathToFileURL` —— Win/POSIX 行为完全一致。
2. 安全面：renderer 拿不到主进程的文件路径，不可能借此向 `giftk-local://` 协议要任意文件。
3. 缓存简单：data URL 是 self-contained，可直接进 `<img src=...>`，由 renderer 端 React 状态管理。

### R-TRIM-FRAMESTRIP.3 — IPC 入参 count 必须 clamp 到 [2, 24]

由 [TRIM_STRIP_FRAME_COUNT_MIN/MAX/DEFAULT](file:///d:/workspace/project/gif-toolkit/src/shared/types/toolbox.ts) 强约束。下界 2 是因为 1 帧就是 firstFrame、没意义；上界 24 是 IPC payload 上限护栏（24 帧 × 480w jpeg ≈ 3-4MB，再多会让 IPC 阻塞肉眼可见）。

### R-TRIM-FRAMESTRIP.4 — 跨平台 file:// 转换走主进程

预览 `<video>` 用 `pathToGiftkLocal` 转出来的 `giftk-local://` URL，已在 [main/index.ts](file:///d:/workspace/project/gif-toolkit/src/main/index.ts) 内做 Win 路径修正（`process.platform === 'win32'` 分支）。
**不允许 renderer 自己拼 `'file://' + p.replace('\\','/')`** —— 这种写法在 Win UNC 路径、含 Unicode 文件名时会破。
新增的 `toolbox:fileUrl` IPC 提供另一条 `pathToFileURL` 安全转换的备用通道（后续场景按需使用）。

### R-TRIM-FRAMESTRIP.5 — GIF / WebP 的 ▶ 必须降级

Electron 的 `<video>` 不能直接播 GIF / WebP（HTMLMediaElement 不支持这两种动图容器）。所以：
- video 输入（`.mp4 / .mov / .webm / .mkv / .m4v`）：挂一个隐藏 `<video>`，loop 在 [startSec, endSec] 内 seek/play。
- GIF / WebP 输入：用已抽好的 N 帧缩略图按 ~125ms 节拍循环高亮一格，模拟动效。

**禁止**为了让 GIF 也走 `<video>` 而临时把它转 mp4 —— 那是给原始 trim 任务加一倍延迟、纯粹得不偿失。

### R-TRIM-FRAMESTRIP.6 — Pointer events，不许 mousedown / touchstart

为了在 macOS / Windows / Linux 三平台 + 触屏 + 触控板上一致工作，把手拖拽必须用 [PointerEvent](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events) 而非传统 mouse/touch。`setPointerCapture` 让用户拖出帧条边缘也能继续更新值。

### R-TRIM-FRAMESTRIP.7 — onChange 必须原子更新

`TrimFrameStrip.onChange` 一次 patch `{ startSec, endSec }` 两个字段。**禁止**分两次 setParams（先 patch start 再 patch end）—— 那会让父组件观察到一个 `s > e` 的中间态，Trim 任务校验会先看到非法状态、给出一闪而过的红色警告，UX 极差。

### R-TRIM-FRAMESTRIP.8 — 微调入口不许删

帧条之下两个 NumField（开始秒 / 结束秒）必须保留。原因：
1. 用户想精确到 0.05s 时，拖把手不够准。
2. 屏幕阅读器用户可能跳过帧条（虽然把手有 ARIA），NumField 是兼容兜底。
3. 现有 `data-testid="trim-duration-info"` 等测试期望 NumField 存在；删掉会破已有 e2e。

## 三、与其他规则的关系

- 父规则 [R-10](file:///d:/workspace/project/gif-toolkit/harness/rules/R-10-electron-isolation.md)（renderer 不许读本地文件）；本规则在它之上写细节。
- [R-11](file:///d:/workspace/project/gif-toolkit/harness/rules/R-11-preload-whitelist.md) — 新加的 `toolboxThumbnailStrip` / `toolboxFileUrlFor` 必须出现在 preload 白名单 [src/preload/index.ts](file:///d:/workspace/project/gif-toolkit/src/preload/index.ts)。
- [R-82](file:///d:/workspace/project/gif-toolkit/harness/rules/R-82-stale-dist-shadow.md) — 新增的 `TRIM_STRIP_FRAME_COUNT_*` 常量在 main 端必须**直 import 源文件** [src/shared/types/toolbox.ts](file:///d:/workspace/project/gif-toolkit/src/shared/types/toolbox.ts) 而非 barrel，避免 stale dist shadow。
- [R-16](file:///d:/workspace/project/gif-toolkit/harness/rules/R-16-tests-required.md) — `extractFrameStrip` 抽帧位置算法 + Renderer 帧条把手交互必须各有单测。

## 四、反向清单（绝不做这些）

- ❌ 在 renderer 里 `new Image(); img.src = 'C:/...';` —— 跨平台破。
- ❌ 通过 IPC 让 renderer 拿到 `/tmp/...jpg` 路径再自己拼 `file://` —— 违反 R-10 + R-TRIM-FRAMESTRIP.2。
- ❌ count 不做 clamp，直接信任 renderer 输入 —— 攻击者能让主进程派生 1000 个 ffmpeg 子进程。
- ❌ 抽帧失败就静默返回 `[]` —— UI 应该显示 "帧条加载失败" 而非"空帧条但能继续操作"。
- ❌ `onChange` 内 `setParams({ startSec: ns })` 再 `setParams({ endSec: ne })` —— 违反 R-TRIM-FRAMESTRIP.7。
- ❌ 把 GIF 转 mp4 只为了让 `<video>` 能播 —— 性价比极低，违反 R-TRIM-FRAMESTRIP.5。

## 五、如何验证

1. `npm run typecheck` / `npm run lint` 必绿。
2. `npm run test:fast` 包含两个新单测：
   - `tests/main/extractFrameStrip.test.ts` — 验证抽帧位置算法（mid-slot 采样、count clamp、duration<=0 抛错）。
   - `tests/renderer/TrimFrameStrip.test.tsx` — 验证 IPC mock、把手拖拽 onChange、▶ 切 playing、loadError 路径。
3. 手动 smoke：
   - mac/win/linux 三平台都跑一次：拖入 mp4 + 拖入 gif + 拖入 webp，三种 trim 都看到帧条；mp4 ▶ 能播 video，gif/webp ▶ 能看到帧条循环高亮。
   - 拖把手全程不超出帧条边界；s 永远 < e（最小 50ms 间距）。
   - 输入框（NumField）和帧条双向同步。

## 六、未来扩展（不在本次范围）

- 支持自定义抽帧密度（24 帧条用于精剪）。
- 拖整个 selection box（不只两端把手）平移区间。
- 缩略图懒加载：长视频可能需要先抽 5 帧概览、悬停某个区域再补抽该段密度。
- mp4 之外的非 GIF 视频容器（avi / wmv / flv）支持 `<video>` 预览（取决于 Chromium 解码白名单）。
