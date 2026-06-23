/**
 * R-REC-DESKTOP-AREA — 区域桌面录屏 → GIF 共享类型。
 *
 * 设计：录屏走主进程 ffmpeg avfoundation (mac) / gdigrab (win) / x11grab
 * (linux)，区域选择走 transparent BrowserWindow + 拖框（renderer 自行渲
 * 染）。**所有真正的 IO（spawn ffmpeg / 落 tmp / videoToGif）都在主进程**
 * (R-10)，渲染端只发参数和接进度。
 *
 * 录制完成后产物是一个 mp4，统一塞到 toolbox chain 走 video-to-gif → 复
 * 用 compressLoop 的 Phase A-D + 双层目标（R-04 / R-05），不另起一套压缩
 * 链路。
 */

/** 录屏 fps 预设；自定义走 number 通道。 */
export const RECORDER_FPS_PRESETS: readonly number[] = [5, 10, 15, 24] as const;

/**
 * 录屏输出模式（R-REC-DESKTOP-AREA #双模式）。
 *
 *   - 'mp4-then-gif'（默认）— ffmpeg 录 mp4 → renderer 自动串
 *     `video-to-gif` chain → 复用 Phase A-D 双层目标压缩。
 *     用户视角"直接出 GIF"，质量最好。
 *
 *   - 'gif-direct'           — ffmpeg single-pass
 *     `palettegen=stats_mode=single + paletteuse=new=1` 直出 GIF。
 *     不进 compressLoop，没有软硬目标二分；录完即拿，CPU 占用更高、
 *     文件偏大，但延迟最低。显式开关，不静默 fallback（R-COMPRESS-V1.5）。
 */
export type RecorderMode = 'mp4-then-gif' | 'gif-direct';

export const RECORDER_DEFAULT_MODE: RecorderMode = 'mp4-then-gif';

/** 最大单次录制时长上限（秒）。沿用 R-22 maxSegmentSec 哲学避免误录天荒地老。 */
export const RECORDER_MAX_DURATION_SEC = 60;
export const RECORDER_DEFAULT_DURATION_SEC = 20;

/** 区域最小/最大尺寸（像素），过小没意义，过大用全屏。 */
export const RECORDER_MIN_REGION_PX = 50;

export interface RecorderDisplay {
  /** Electron display id，跨进程稳定。 */
  id: number;
  label: string;
  /** 物理边界（含 dpi 缩放后的逻辑像素）。 */
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  isPrimary: boolean;
}

/** 用户在 overlay 拖出的区域；坐标已经转换为该 display 内的 0-based 像素。 */
export interface RecorderRegion {
  displayId: number;
  /** 相对 display.bounds.{x,y} 的偏移，单位为逻辑像素（renderer 给的）。 */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RecorderParams {
  region: RecorderRegion;
  /** 输出模式。见 RecorderMode。默认 'mp4-then-gif'。 */
  mode: RecorderMode;
  /** 帧率：5/10/15/24/自定义。 */
  fps: number;
  /** 最长录制时长（秒），到点自动停止。 */
  maxDurationSec: number;
  /** 是否录入鼠标光标。 */
  captureCursor: boolean;
  /** 是否录入系统音频（产物 mp4 保留；GIF 抛弃音轨，仅为可选导出 mp4 备用）。 */
  captureAudio: boolean;
  /** GIF 输出软上限字节，沿用 R-05 命名。 */
  softMaxBytes: number;
  /** GIF 输出硬上限字节，沿用 R-05 命名。 */
  maxBytes: number;
  /** GIF 最长边像素上限，沿用 ProcessOptions.maxWidth 命名。 */
  maxWidth: number;
}

/** macOS 屏幕录制权限三态。其它平台稳定返回 'granted'（无需权限）。 */
export type RecorderPermission = 'granted' | 'denied' | 'not-determined' | 'unsupported';

export interface RecorderPermissionStatus {
  status: RecorderPermission;
  /** 平台原始描述，供 toast 显示。 */
  message: string;
  /** mac 时是 `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`；其它平台空字符串。 */
  systemPrefsUrl: string;
}

export interface RecorderStartResult {
  /** 录制会话 id，cancel / progress 用它定位。 */
  sessionId: string;
  /** 落 tmp 的中间 mp4 绝对路径（录制完成时填）。 */
  outputPath: string;
}

/** 录屏阶段进度。沿用 R-08：必须有 substep / detail / elapsedMs。 */
export type RecorderSubstep =
  | 'permission-check'
  | 'spawn-ffmpeg'
  | 'recording'
  | 'stopping'
  | 'encoding-gif'
  | 'done'
  | 'cancelled'
  | 'error';

export interface RecorderProgress {
  sessionId: string;
  substep: RecorderSubstep;
  /** 0-100；recording 阶段按 elapsed/maxDurationSec 线性给。 */
  percent: number;
  elapsedMs: number;
  /** 用户可读的一行 detail（中文）。 */
  detail: string;
  /** done 时填 GIF 最终路径；cancelled / error 时不填。 */
  gifPath?: string;
  /** error 时填错误消息。 */
  error?: string;
}
