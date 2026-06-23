# SC-28 — 桌面区域录屏功能落地

## 触发场景

用户提需求："增加一个功能，支持类似截取某个区域进行录屏，选择区域时支持选择帧率等我们支持配置的参数，录制后直接导出 gif"。

## 关联规则

- **R-REC-DESKTOP-AREA**（本场景沉淀的新规则）— 主进程独占 ffmpeg + 跨平台 argv 分支 + 权限兜底 + 复用 compressLoop
- R-02（不为某 host / 某抓帧方案加白名单）
- R-04 / R-05（复用四阶段压缩 + 双层目标）
- R-08（progress 必须有 substep / detail / elapsedMs / sessionId）
- R-10（renderer 永远不直接做重 IO）
- R-11（preload 新增方法须挂白名单 + 同步 global.d.ts）
- R-22（maxDurationSec 兜底，沿用 60s/默认 20s）
- R-82（recorder 共享类型直接 import 源文件 + barrel 同步挂载）
- R-87（tmp 清扫白名单加 `giftk-rec`，sessionTmpRegistry 防误删本会话产物）

## 现象 → 根因 → 修复

| 现象 | 根因 | 修复 |
|---|---|---|
| 录屏后端有多种实现（Electron `getDisplayMedia` / desktopCapturer + MediaRecorder / 主进程 ffmpeg），选错会让 renderer 干重活 | 决策点没固化 | 强制走 **主进程 ffmpeg（avfoundation/gdigrab/x11grab）**，desktopCapturer 不参与抓帧；renderer 只发参数 + 接进度 |
| ffmpeg argv 跨 3 个平台差异大，散在主进程容易回归 | 没有契约测试 | 把构造逻辑抽成纯函数 `buildRecorderArgs`，10 个 vitest case 锁住 darwin/win32/linux 三条路径 + 边界 clamp |
| macOS 屏幕录制权限默认不给，ffmpeg 直接 spawn 会得到全黑帧 | 没有权限探测 | `recorder:checkPermission` 走 `systemPreferences.getMediaAccessStatus('screen')`，三态映射 + 一键深链到系统设置 |
| 录制取消若 SIGKILL，mp4 没写 moov atom，文件不可播 | cancel 路径粗暴 | `stopRecorder` 先向 stdin 写 `q\n` graceful flush，2 秒还没退再 SIGKILL 兜底 |
| 区域选择需要全屏覆盖任意应用（含浏览器全屏视频） | overlay 不够"硬" | `setAlwaysOnTop(true, 'screen-saver')` + `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`，mac 在全屏 app 上方仍能拖框 |
| overlay 注入完整 preload 等于把所有 IPC 暴露给一个临时窗口 | 攻击面 | overlay 专用 preload 只暴露 3 个最小方法：`onConfig / finish / cancel`，零 `giftk.*` |
| 录到 mp4 后想转 GIF，第一反应是再写一套压缩 | 重复管线 | 不写。录完 mp4 路径回 renderer，由 panel 引导用户走 `toolbox.startChain('video-to-gif')` 复用 Phase A-D + 双层目标 |
| 多 entry 改 vite.config.ts 后 dev 模式 loadURL 路径不一致 | dev/prod 双轨没对齐 | dev 模式 `http://localhost:5173/recorderOverlay.html`，prod 模式 `loadFile(dist/renderer/recorderOverlay.html)`；build 已验证文件名稳定 |

## 验证脚印

```
$ npm run typecheck      # 绿
$ npm run lint           # 绿
$ npm run test:fast      # 61 files / 897 tests 全绿（含新增 tests/main/recorder.test.ts 10 case）
$ npm run build          # 绿；dist/renderer/recorderOverlay.html + dist/preload/recorderOverlay.js + dist/main/recorder.js 均产出
```

## 留给下一轮的事

- 真机端到端 e2e：mac smoke 需要授权弹窗，没法跑 headless；建议把 `tests/e2e/realPipeline.spec.ts` 的录屏分支跳过权限走 mock spawn，仅验证 panel → IPC → progress 桥。
- ~~录到 mp4 后**自动**串到 `toolbox.startChain('video-to-gif')`：当前 panel 只显示 mp4 路径让用户手动去工具箱。下一轮可以加「直接转 GIF」按钮联调。~~ **v2 已落地**，见下节。
- Windows dshow 音频名（virtual-audio-capturer）是 ffmpeg 的虚拟设备，用户机器未必装；当前是"试到失败就告知"，下一轮可以加 `-list_devices` 探测后给 select 下拉。

---

## v2 follow-up — 双模式（mp4-then-gif / gif-direct）

### 触发问题

用户反馈：「为什么要有视频呢？？不能直接处理吗？？直接录制 GIF」

### 答复 + 落地

三段论解释为何 mp4 中间产物有保留价值（palettegen 二次扫描质量 / 双层目标管线只接 mp4 / 中断后可从 mp4 二次处理），但同时承认**短录 / 即录即用**场景下 mp4→gif 二次转码是浪费。

最终方案：**双模式 segmented control**，详见 [R-REC-DESKTOP-AREA #双模式契约](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-REC-DESKTOP-AREA-recorder.md#双模式契约v2-follow-up)。

- 默认 `mp4-then-gif`：录 mp4 后**自动**派发 `startToolboxChain` 走 video-to-gif，用户视角=直接出 GIF；保留中断恢复优势。
- 新增 `gif-direct`：ffmpeg single-pass `palettegen + paletteuse + -f gif` 直出，跳过双层目标 / maxWidth / 音轨（UI 显式 disable + tooltip，不静默 fallback，沿用 R-COMPRESS-V1.5 精神）。

### v2 验证（2026-06-16）

```
$ npm run typecheck      # 绿
$ npm run lint           # 绿
$ npm run test:fast      # 61 files / 902 tests 全绿（recorder.test.ts 15/15：10 旧 + 5 新 gif-direct 跨平台契约）
$ npm run build          # 绿
```

### 触雷记录

1. `ToolboxParams` 不带 `kind` 字段（kind 在 `ToolboxChainStep` 顶层）—— 第一次写漏了，typecheck 抓出。
2. `TaskStatus` 没有 `'queued'` 字面量（只有 `'pending' | 'downloading' | 'probing' | ...`）—— 第一次用了 `queued` typecheck 抓出。
3. `ToolboxParams` 用 `width` 而不是 `maxWidth` —— 第一次混了别处的字段名，typecheck 抓出。

### 留给下一轮（v2 后）

- Windows gdigrab 在某些显卡驱动下 single-pass palettegen 会因为色彩空间问题闪烁，需要在 gif-direct 分支额外加 `-pix_fmt rgb24` 探针（已挂 TODO，没复现到坚实样本前不动）。
- gif-direct 模式当前最大时长沿用 `RECORDER_MAX_DURATION_SEC = 60s`，single-pass 内存占用约是 mp4-then-gif 的 2-3 倍，若用户报 OOM 再加单独 cap。
