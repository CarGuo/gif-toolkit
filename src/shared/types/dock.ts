/**
 * R-DOCK-FLOATING — 桌面悬浮控件（floating dock）共享类型。
 *
 * 设计：一个 frameless / transparent / alwaysOnTop / skipTaskbar 的
 * 小 BrowserWindow，承载一个圆球 + 展开后的快捷动作面板。所有真正的
 * 业务动作都委托给主进程已有的入口（tray.sniffClipboardURL /
 * showOrCreateMainWindow / 'tray:navigate' / app.quit），dock 自己不
 * 复刻业务逻辑（R-10 + DRY），preload 只暴露白名单方法（R-11）。
 *
 * v2 起 dock 拥有「就地录屏」能力：dock-record-region 走主进程已有
 * recorderOverlay + recorder 链路，不打开主窗也能完整录制，录制态
 * 通过 DockRecorderState 广播给 dock renderer（计时 / 停止按钮 /
 * 错误条 inline 展示）。
 */

/** dock 可触发的动作枚举。新增项必须同步主进程 [dispatchDockAction]
 *  switch + preload 白名单 + harness rule，否则触发后悄无声息。
 *
 *  分为两类：
 *  - 「跳转类」（open-*）：唤起主窗并 navigate 到对应 tab
 *  - 「就地类」（dock-* / sniff-clipboard / open-output-dir）：不
 *    打开主窗即可完成
 */
export type DockActionKind =
  // 跳转类
  | 'open-recorder'      // 打开主窗口并切到录屏 tab
  | 'open-toolbox'       // 打开主窗口并切到工具箱 tab
  | 'open-history'       // 打开主窗口并切到历史 tab
  // 就地类
  | 'sniff-clipboard'    // 主进程读剪贴板 URL 并触发嗅探（最终仍打开主窗）
  | 'dock-record-region' // 就地：弹遮罩选区 -> 直接 ffmpeg 录屏，dock 持续显示 REC 状态
  | 'dock-record-stop'   // 就地：停止当前录制（与 dock-record-region 配对）
  | 'dock-record-cancel' // 就地：取消当前录制（丢弃产物）
  | 'open-output-dir'    // 就地：直接 shell.openPath 默认输出目录
  // 窗口控制 + 退出
  | 'show-main'
  | 'hide-main'
  | 'quit-app';

/** 渲染端展示用 metadata；主进程一次性下发，避免 dock 用硬编码。 */
export interface DockActionMeta {
  kind: DockActionKind;
  /** 简短中文标签（≤6 字），按钮上展示。 */
  label: string;
  /** SVG 图标 id（dock renderer 内置 SVG 库）；后兼容旧 emoji。 */
  icon: string;
  /** hover tooltip 描述，可换行。 */
  description: string;
  /** 按钮主题色——录制类用 #ff4f4f，破坏性。其它默认。 */
  tone?: 'danger' | 'primary' | 'default';
}

/** dock 录制态状态机（dock 自治，不依赖主窗 RecorderPanel）。 */
export type DockRecorderPhase =
  | 'idle'           // 待机
  | 'selecting'      // 正在拉遮罩选区
  | 'recording'      // ffmpeg 在录制中
  | 'finalizing'     // ffmpeg 停止信号已发，等 mp4 落盘
  | 'done'           // 完成（lastOutputPath 可用，dock 显示 ✓ 几秒后自动回 idle）
  | 'error';         // 失败（errorMessage 显示在 dock 上）

export interface DockRecorderState {
  phase: DockRecorderPhase;
  /** 当前 session id（recording / finalizing 期间有效）。 */
  sessionId: string | null;
  /** 录制累计毫秒（recording 时由主进程从 progress 计算后转发）。 */
  elapsedMs: number;
  /** error 阶段的人类可读错误。 */
  errorMessage: string | null;
  /** done 阶段的最后产物路径（mp4，dock 可一键 reveal）。 */
  lastOutputPath: string | null;
  /** done 阶段产物的 region（device px，含 sf 换算后），用于 toast 一眼看出录到了哪一块。 */
  lastRegion?: { x: number; y: number; w: number; h: number } | null;
}

export const DOCK_RECORDER_IDLE_STATE: DockRecorderState = {
  phase: 'idle',
  sessionId: null,
  elapsedMs: 0,
  errorMessage: null,
  lastOutputPath: null,
  lastRegion: null,
};

/** dock 窗口状态快照，主进程 broadcast 给 dock renderer。 */
export interface DockState {
  visible: boolean;
  expanded: boolean;
  /** 主窗是否当前可见，决定 show-main / hide-main 按钮显示哪一个。 */
  mainWindowVisible: boolean;
}

/** 拖动 dock 时 renderer 上报的位置（屏幕逻辑像素，左上角原点）。 */
export interface DockDragInput {
  /** 鼠标按下时记录的 dock window 左上角屏幕坐标。 */
  startWindowX: number;
  startWindowY: number;
  /** 鼠标当前屏幕坐标。 */
  cursorScreenX: number;
  cursorScreenY: number;
}

export interface DockBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** dock 默认尺寸；折叠态 = 圆球；展开态 = 圆球 + 横向 action grid。
 *  改这两个常量需要同步 [tests/main/dock.test.ts] 的 clamp case。
 *  v2 起展开尺寸变宽以容纳 10 个按钮 + 录制态横幅。 */
export const DOCK_COLLAPSED_SIZE = { width: 52, height: 52 } as const;
export const DOCK_EXPANDED_SIZE = { width: 440, height: 104 } as const;
/** 录制态会临时展开成更宽的横幅（含 REC 计时 + 大停止按钮）。 */
export const DOCK_RECORDING_SIZE = { width: 280, height: 64 } as const;
/** error 态会变得更高，最底部铺一条 toast（独立气泡视觉），不再让
 *  圆球本身变成「全红爆炸」（看用户截图反馈，那种 UX 太凶）。 */
export const DOCK_ERROR_SIZE = { width: 440, height: 150 } as const;

/** 屏幕边缘安全 padding，防止拖到完全看不见。 */
export const DOCK_EDGE_PADDING = 4;
