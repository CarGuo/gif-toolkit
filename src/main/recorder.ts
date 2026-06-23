/**
 * R-REC-DESKTOP-AREA — 区域桌面录屏（主进程独占）。
 *
 * 设计：纯函数 buildRecorderArgs 抽 argv（可测）；spawn ffmpeg 落盘；
 * cancel 走 stdin 'q' graceful flush，2s SIGKILL 兜底；mp4 由 caller 续接
 * video-to-gif chain。**不**写 host whitelist，**不**直接读渲染路径（R-02/R-10）。
 *
 * 平台 ffmpeg 设备：
 *   - darwin: `-f avfoundation -i "<displayIndex>:<audioIndex|none>"`
 *   - win32 : `-f gdigrab -offset_x X -offset_y Y -video_size WxH -i desktop`
 *   - linux : `-f x11grab -video_size WxH -i :0.0+X,Y`
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { promises as fsp, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { systemPreferences } from 'electron';
import { getFfmpegPath } from './binaries';
import { log } from './logger';
import { formatFfmpegExitError } from './recorderStderr';
import { sessionTmpRegistry } from './tmpCleanup';
import type {
  RecorderParams,
  RecorderPermissionStatus,
  RecorderProgress,
  RecorderSubstep,
} from '../shared/types/recorder';

/* ------------------------------------------------------------------ */
/*  Pure: argv builder                                                 */
/* ------------------------------------------------------------------ */

export interface BuildRecorderArgsInput {
  platform: NodeJS.Platform;
  params: RecorderParams;
  /** 当前 region.displayId 对应的 avfoundation device 索引（mac 专用）。 */
  avfoundationDeviceIndex?: number;
  /**
   * R-REC-DESKTOP-AREA #dpr-scale — region 是 CSS 逻辑像素，mac avfoundation
   * 抓帧是设备像素（Retina dpr=2 时 1512×982 实际 3024×1964）。crop 必须
   * 按 scaleFactor 换算成 device px，否则 Retina + 多屏会录到 menu bar。
   * darwin 必传该屏 scaleFactor；win/linux 已是 device px 输入，传 1.0 即可。
   * 多显示器场景下每屏 dpr 可能不同（外接 1x + 内屏 2x），必须按 displayId 现场查。
   */
  regionScaleFactor?: number;
  outputPath: string;
}

/**
 * 跨平台 ffmpeg argv builder（纯函数，可直接 unit-test）。
 *
 * 关键不变量：
 *   - 一定带 `-y`（tmp 路径 unique，不冲用户文件）
 *   - mac：avfoundation 抓整屏 + `-vf crop=W:H:X:Y` 取区域
 *   - win：`gdigrab -offset_x / -video_size` 原生区域
 *   - linux：`x11grab -video_size + -i :0.0+X,Y` 原生区域
 *   - fps 走 `-framerate`（capture 侧准；filter 侧只对 GIF 有意义）
 *   - mode='mp4-then-gif'：libx264 ultrafast mp4，GIF 编码由 caller 走 toolbox chain
 *   - mode='gif-direct'：尾部换成 single-pass GIF filter graph
 *     `split[a][b];[a]palettegen=stats_mode=single[p];[b][p]paletteuse=new=1` + `-f gif`
 */

/**
 * R-REC-DESKTOP-AREA #even-pixel — yuv420p/libx264 要求宽高 + crop offset 都偶数
 * （奇数会触发 "width not divisible by 2" 直接 exit 1，三平台都受影响）。
 * 这里在 builder 里统一向下取偶。
 */
export function toEvenSize(n: number): number {
  const i = Math.max(2, Math.floor(n));
  return i - (i % 2);
}

/** crop offset 也要偶数；但允许 0（offset=0 是合法的）。 */
export function toEvenOffset(n: number): number {
  const i = Math.max(0, Math.floor(n));
  return i - (i % 2);
}

// ffmpeg stderr 关键行抽取已抽到独立模块（R-82 抽纯模块单测 + 600 行
// 上限）。re-export 让既有 import 路径 `from './recorder'` 不破，同时
// close handler 也直接用 formatFfmpegExitError。
export { extractFfmpegStderrSummary, formatFfmpegExitError } from './recorderStderr';

export function buildRecorderArgs(input: BuildRecorderArgsInput): string[] {
  const { platform, params, avfoundationDeviceIndex, outputPath } = input;
  const { region, fps, maxDurationSec, captureCursor, captureAudio, mode } = params;
  // R-REC-DESKTOP-AREA #dpr-scale — 仅 darwin avfoundation 需要把 CSS px
  // 换算成 device px；win/linux 抓帧本身就是 device px，传 1.0 即可。
  // 防御：sf<=0 / NaN 也强制 1.0，避免被脏数据放大成 0 触发 throw。
  const sfRaw = typeof input.regionScaleFactor === 'number' ? input.regionScaleFactor : 1;
  const sf = sfRaw > 0 && Number.isFinite(sfRaw) ? sfRaw : 1;
  // 强制 w/h 偶数 + x/y 偶数（libx264/yuv420p 硬约束）— 见 R-REC-DESKTOP-AREA #even-pixel
  const cropW = toEvenSize(region.w * sf);
  const cropH = toEvenSize(region.h * sf);
  const cropX = toEvenOffset(region.x * sf);
  const cropY = toEvenOffset(region.y * sf);
  const cropExpr = `crop=${cropW}:${cropH}:${cropX}:${cropY}`;
  const fpsArg = String(Math.max(1, Math.min(60, Math.round(fps))));
  const dur = String(Math.max(1, Math.min(600, Math.round(maxDurationSec))));
  const wantGifDirect = mode === 'gif-direct';

  // 把 loglevel 从 'error' 抬到 'warning'：libx264 width-not-divisible /
  // avfoundation device not found 这类**致命错也走 warning 通道**，以前
  // 用户截图看到的 stderr 被吃掉就是 -loglevel error 太严。
  const common = [
    '-y',
    '-hide_banner',
    '-loglevel', 'warning',
  ];

  /**
   * GIF 直出 filter graph。引用 ffmpeg 官方推荐写法（single-pass
   * palette + paletteuse new=1 让每帧重算 palette diff，色彩接近两段法
   * 但只读源一次）。stats_mode=single 比 full 更省内存，适合录屏。
   * mac 时把 crop 串到 split 之前；win/linux 直接 split。
   */
  function gifFilterComplex(cropPrefix?: string): string {
    const head = cropPrefix ? `${cropPrefix},` : '';
    return `${head}split [a][b];[a] palettegen=stats_mode=single [p];[b][p] paletteuse=new=1`;
  }

  /** mp4 编码尾参数。
   *  #faststart (SC-REC-MP4-UNPLAYABLE) — `+faststart` 把 moov 搬到文件头；
   *  `+frag_keyframe+empty_moov` 持续写 fragmented moov，让 SIGKILL 兜底
   *  后已写部分仍可播；`+genpts` 保证时间戳稳健。 */
  const mp4Tail = [
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-fflags', '+genpts',
    '-movflags', '+faststart+frag_keyframe+empty_moov',
    outputPath,
  ];

  if (platform === 'darwin') {
    if (typeof avfoundationDeviceIndex !== 'number') {
      throw new Error('avfoundationDeviceIndex required on darwin');
    }
    const audioPart = captureAudio ? `:${avfoundationDeviceIndex}` : ':none';
    const head = [
      ...common,
      '-f', 'avfoundation',
      '-framerate', fpsArg,
      '-capture_cursor', captureCursor ? '1' : '0',
      '-capture_mouse_clicks', '0',
      '-i', `${avfoundationDeviceIndex}${audioPart}`,
      '-t', dur,
    ];
    const result = wantGifDirect
      ? [...head, '-filter_complex', gifFilterComplex(cropExpr), '-f', 'gif', outputPath]
      : [...head, '-vf', cropExpr, ...mp4Tail];
    log(`recorder argv: platform=${platform} sf=${sf} region=${region.x},${region.y} ${region.w}x${region.h} crop=${cropExpr} outputPath=${outputPath}`);
    return result;
  }

  if (platform === 'win32') {
    const args = [
      ...common,
      '-f', 'gdigrab',
      '-framerate', fpsArg,
      '-draw_mouse', captureCursor ? '1' : '0',
      '-offset_x', String(cropX),
      '-offset_y', String(cropY),
      '-video_size', `${cropW}x${cropH}`,
      '-i', 'desktop',
    ];
    // 用户没装 stereo mix 时这条会失败，由 spawn 错误透出；
    // gif-direct 下保留 args 兼容 mp4-then-gif，ffmpeg 会忽略 -f gif 的音频流。
    if (captureAudio) {
      args.push('-f', 'dshow', '-i', 'audio=virtual-audio-capturer');
    }
    args.push('-t', dur);
    if (wantGifDirect) {
      args.push('-filter_complex', gifFilterComplex(), '-f', 'gif', outputPath);
    } else {
      args.push(...mp4Tail);
    }
    log(`recorder argv: platform=${platform} sf=${sf} region=${region.x},${region.y} ${region.w}x${region.h} crop=${cropExpr} outputPath=${outputPath}`);
    return args;
  }

  // linux / x11grab
  const linuxHead = [
    ...common,
    '-f', 'x11grab',
    '-framerate', fpsArg,
    '-draw_mouse', captureCursor ? '1' : '0',
    '-video_size', `${cropW}x${cropH}`,
    '-i', `:0.0+${cropX},${cropY}`,
    '-t', dur,
  ];
  const linuxResult = wantGifDirect
    ? [...linuxHead, '-filter_complex', gifFilterComplex(), '-f', 'gif', outputPath]
    : [...linuxHead, ...mp4Tail];
  log(`recorder argv: platform=${platform} sf=${sf} region=${region.x},${region.y} ${region.w}x${region.h} crop=${cropExpr} outputPath=${outputPath}`);
  return linuxResult;
}

/* ------------------------------------------------------------------ */
/*  Permission                                                          */
/* ------------------------------------------------------------------ */

export function checkScreenRecordPermission(): RecorderPermissionStatus {
  if (process.platform !== 'darwin') {
    return {
      status: 'granted',
      message: '当前平台无需屏幕录制额外授权',
      systemPrefsUrl: '',
    };
  }
  try {
    const raw = systemPreferences.getMediaAccessStatus('screen');
    const mapped: RecorderPermissionStatus['status'] =
      raw === 'granted' ? 'granted'
      : raw === 'denied' ? 'denied'
      : raw === 'not-determined' ? 'not-determined'
      : 'unsupported';
    const msgMap: Record<RecorderPermissionStatus['status'], string> = {
      'granted': '屏幕录制权限已授予',
      'denied': '已被拒绝。请在「系统设置 > 隐私与安全性 > 屏幕录制」中允许 Gif Toolkit',
      'not-determined': '尚未请求过权限。首次录制时系统会弹窗，授权后请重启 App',
      'unsupported': '当前 macOS 版本不支持此权限查询，将直接尝试录制',
    };
    return {
      status: mapped,
      message: msgMap[mapped],
      systemPrefsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    };
  } catch (e) {
    return {
      status: 'unsupported',
      message: `权限查询失败: ${(e as Error).message}`,
      systemPrefsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Mac avfoundation device probe (R-REC-DESKTOP-AREA #probe-device)    */
/* ------------------------------------------------------------------ */

/**
 * R-REC-DESKTOP-AREA #probe-device — mac avfoundation 设备索引不是常量
 * （摄像头/Continuity/OBS Virtual 会插队挪 "Capture screen N" 的索引）。
 * spawn 一次 `ffmpeg -f avfoundation -list_devices true -i ""`：ffmpeg 永远
 * exit=1（合约）+ 列表在 stderr，解析 `[N] Capture screen X`。失败 throw 让
 * UI 走 error toast；成功结果缓存 5 分钟。
 */
interface MacScreenDevice {
  index: number;
  label: string;
}
let _macDeviceCache: { ts: number; devices: MacScreenDevice[] } | null = null;
const MAC_DEVICE_CACHE_MS = 5 * 60 * 1000;

export function _resetMacDeviceCacheForTest(): void {
  _macDeviceCache = null;
}

export function parseAvfoundationScreenDevices(output: string): MacScreenDevice[] {
  // 识别 ffmpeg avfoundation `-list_devices true` 输出中 'AVFoundation video
  // devices:' / 'AVFoundation screen devices:' 段下的 'Capture screen N'(video
  // 段还要靠关键字排除 FaceTime/iPhone/OBS 摄像头)。两段都识别;audio 段忽略。
  const lines = output.split(/\r?\n/);
  type Section = 'none' | 'video' | 'screen';
  let section: Section = 'none';
  const out: MacScreenDevice[] = [];
  const seen = new Set<number>();
  for (const raw of lines) {
    if (/AVFoundation video devices:/i.test(raw)) { section = 'video'; continue; }
    if (/AVFoundation screen devices:/i.test(raw)) { section = 'screen'; continue; }
    if (/AVFoundation audio devices:/i.test(raw)) { section = 'none'; continue; }
    if (section === 'none') continue;
    const m = raw.match(/\[(\d+)\]\s+(.+?)\s*$/);
    if (!m) continue;
    const idx = Number(m[1]);
    const label = m[2].trim();
    const isScreen = section === 'screen' || /capture screen/i.test(label);
    if (isScreen && !seen.has(idx)) {
      seen.add(idx);
      out.push({ index: idx, label });
    }
  }
  return out;
}

async function listAvfoundationDevicesOnce(): Promise<MacScreenDevice[]> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(getFfmpegPath(), [
        '-hide_banner',
        '-f', 'avfoundation',
        '-list_devices', 'true',
        '-i', '',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      // R-REC-DESKTOP-AREA #probe-device — 合并 stdout + stderr：
      // 部分 ffmpeg build 把 device 列表写到 stdout，仅靠 stderr 会漏。
      let buf = '';
      proc.stdout.on('data', (d) => { buf += d.toString('utf8'); });
      proc.stderr.on('data', (d) => { buf += d.toString('utf8'); });
      proc.on('close', () => {
        resolve(parseAvfoundationScreenDevices(buf));
      });
      proc.on('error', () => resolve([]));
      // 7s 兜底：冷启 ffmpeg-static 解压 + Gatekeeper 验签可能 > 3s；
      // probe 比录制只跑一次，可宽容一些。
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 7000);
    } catch {
      resolve([]);
    }
  });
}

/**
 * R-REC-DESKTOP-AREA #probe-device — Electron display 角色 → mac avf device idx。
 * 实测 SC-MAC-AVF-MAP-MISMATCH(2026-06-18):`Capture screen 0` ≡ macOS 主屏,
 * `screen.getAllDisplays()[N]` ≠ `Capture screen N`。所以按"是否 primary"映射,
 * 不再用 ordinal。`isPrimary=true` → 取 label `Capture screen 0`;
 * `isPrimary=false` → 第 `secondaryOrdinal` 个非主屏(按 label 数字升序)。
 */
export interface PickMacScreenDeviceInput {
  isPrimary: boolean;
  secondaryOrdinal?: number;
}
export async function detectMacScreenDevice(
  inputOrLegacyOrdinal: PickMacScreenDeviceInput | number = { isPrimary: true },
): Promise<number> {
  if (process.platform !== 'darwin') return -1;
  // 兼容老调用方 number 形式:0=primary,>=1=secondary[N-1]
  const input: PickMacScreenDeviceInput = typeof inputOrLegacyOrdinal === 'number'
    ? (inputOrLegacyOrdinal === 0 ? { isPrimary: true } : { isPrimary: false, secondaryOrdinal: inputOrLegacyOrdinal - 1 })
    : inputOrLegacyOrdinal;
  const now = Date.now();
  if (!_macDeviceCache || now - _macDeviceCache.ts > MAC_DEVICE_CACHE_MS) {
    const devices = await listAvfoundationDevicesOnce();
    log(`recorder: avfoundation devices probed (${devices.length}): ${devices.map((d) => `[${d.index}]${d.label}`).join(' ')}`);
    if (devices.length > 0) _macDeviceCache = { ts: now, devices };
    else throw new Error('未探测到屏幕捕获设备（avfoundation）。请打开「系统设置 → 隐私与安全性 → 屏幕录制」为 Gif Toolkit 授权后重启 App；如已授权仍失败，请确认安装了完整的 ffmpeg。');
  }
  const devices = _macDeviceCache.devices;
  type Annotated = MacScreenDevice & { screenIdx: number };
  const annotated: Annotated[] = devices.map((d) => {
    const m = /capture screen\s+(\d+)/i.exec(d.label);
    return { ...d, screenIdx: m ? Number(m[1]) : Number.NaN };
  }).filter((a) => Number.isFinite(a.screenIdx)).sort((a, b) => a.screenIdx - b.screenIdx);
  if (annotated.length === 0) return devices[0].index;
  if (input.isPrimary) return annotated[0].index;
  const secondaries = annotated.slice(1);
  if (secondaries.length === 0) return annotated[0].index;
  return secondaries[Math.min(Math.max(0, input.secondaryOrdinal ?? 0), secondaries.length - 1)].index;
}

/* ------------------------------------------------------------------ */
/*  Session runner                                                      */
/* ------------------------------------------------------------------ */

interface ActiveSession {
  sessionId: string;
  proc: ChildProcessWithoutNullStreams;
  outputPath: string;
  startedAt: number;
  maxDurationSec: number;
  timer: NodeJS.Timeout | null;
  progressEmitter: ((p: RecorderProgress) => void) | null;
  resolved: boolean;
}

const active = new Map<string, ActiveSession>();

function mintSessionId(): string {
  return `rec-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

/** 录制文件名时间戳（本地时区，无冒号，例如 20260616-211230）。 */
function formatRecordingTimestamp(d: Date): string {
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function emit(s: ActiveSession, substep: RecorderSubstep, percent: number, detail: string, extra?: Partial<RecorderProgress>): void {
  const cb = s.progressEmitter;
  if (!cb) return;
  try {
    cb({
      sessionId: s.sessionId,
      substep,
      percent: Math.max(0, Math.min(100, Math.round(percent))),
      elapsedMs: Date.now() - s.startedAt,
      detail,
      ...(extra || {}),
    });
  } catch (e) {
    log(`recorder: emitter throw ${(e as Error).message}`);
  }
}

export interface StartRecorderArgs {
  params: RecorderParams;
  /** Mac 时由调用方通过 `avfoundation -list_devices` 解析得出。 */
  avfoundationDeviceIndex?: number;
  /** R-REC-DESKTOP-AREA #dpr-scale — region 所在 display 的 scaleFactor。 */
  regionScaleFactor?: number;
  /**
   * 录制产物目录（caller 注入，一般 = `~/Downloads/GifToolkit/recordings`）。
   * 不传 fallback `os.tmpdir()/giftk-rec`（仅兼容旧测试）。配合 index.ts
   * 注册 allowedOutputDirs 让 reveal/upload/history 链路放行。
   */
  outputDir?: string;
  onProgress: (p: RecorderProgress) => void;
}

export interface StartRecorderResult {
  sessionId: string;
  outputPath: string;
  /** 录制结束（自动停止 / cancel / error）的 Promise；resolve 时携带最终产物路径。 */
  done: Promise<{ outputPath: string; cancelled: boolean }>;
}

/**
 * 启动一次录制。立即返回 session 句柄，录制在后台进行；调用方通过
 * `onProgress` 拿阶段更新，通过 `done` Promise 等待最终落盘。
 */
export function startRecorder(args: StartRecorderArgs): StartRecorderResult {
  const sessionId = mintSessionId();
  // R-REC-DESKTOP-AREA #output-dir — 优先用 caller 注入的项目统一输出目录
  // （main/index.ts 已 mkdir + 注册 allowedOutputDirs）；缺省 fallback 到
  // os.tmpdir() 仅为兼容老 unit test 路径。生产链路始终走前者。
  const tmpDir = args.outputDir && args.outputDir.length > 0
    ? args.outputDir
    : path.join(os.tmpdir(), 'giftk-rec');
  // 防御：caller 注入的目录可能尚未创建，这里幂等 mkdir（同步、零延迟）。
  try { mkdirSync(tmpDir, { recursive: true }); } catch { /* best-effort */ }
  // R-87 — 注册到 sessionTmpRegistry，防止 tmp 清扫误删本会话产物（即便
  // 现在落在 ~/Downloads/GifToolkit/recordings，也防呆一道）。
  try { sessionTmpRegistry.registerSession(tmpDir); } catch { /* registry 可能在测试环境未初始化 */ }
  // R-REC-DESKTOP-AREA #双模式：mode 决定输出扩展名。gif-direct 直接落 .gif，
  // mp4-then-gif 落 .mp4 由 renderer 续接 video-to-gif chain。
  // 文件名带时间戳让用户在 Finder/Explorer 里一眼看出是什么时候录的。
  const ext = args.params.mode === 'gif-direct' ? 'gif' : 'mp4';
  const ts = formatRecordingTimestamp(new Date());
  const outputPath = path.join(tmpDir, `rec-${ts}-${sessionId}.${ext}`);

  const ffmpegBin = getFfmpegPath();
  const argv = buildRecorderArgs({
    platform: process.platform,
    params: args.params,
    avfoundationDeviceIndex: args.avfoundationDeviceIndex,
    regionScaleFactor: args.regionScaleFactor,
    outputPath,
  });

  log(`recorder: spawn ${ffmpegBin} ${argv.join(' ')}`);
  const session: ActiveSession = {
    sessionId,
    proc: null as unknown as ChildProcessWithoutNullStreams, // 立即赋值，下面 spawn 出来
    outputPath,
    startedAt: Date.now(),
    maxDurationSec: args.params.maxDurationSec,
    timer: null,
    progressEmitter: args.onProgress,
    resolved: false,
  };

  const done = new Promise<{ outputPath: string; cancelled: boolean }>((resolve, reject) => {
    // 先确保 tmp 目录存在再 spawn，否则 ffmpeg 自己也写不进去
    fsp.mkdir(tmpDir, { recursive: true })
      .then(() => {
        const proc = spawn(ffmpegBin, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
        session.proc = proc;
        emit(session, 'spawn-ffmpeg', 1, '已启动 ffmpeg，准备录制');

        // 进度心跳
        session.timer = setInterval(() => {
          if (session.resolved) return;
          const elapsed = (Date.now() - session.startedAt) / 1000;
          const pct = (elapsed / session.maxDurationSec) * 100;
          emit(session, 'recording', pct, `录制中 ${elapsed.toFixed(1)}s / ${session.maxDurationSec}s`);
        }, 500);

        let stderrBuf = '';
        proc.stderr.on('data', (d) => {
          stderrBuf += d.toString('utf8');
        });

        proc.on('error', (e) => {
          if (session.resolved) return;
          session.resolved = true;
          if (session.timer) clearInterval(session.timer);
          emit(session, 'error', 0, 'ffmpeg 启动失败', { error: e.message });
          active.delete(sessionId);
          reject(e);
        });

        proc.on('close', (code, signal) => {
          if (session.resolved) return;
          session.resolved = true;
          if (session.timer) clearInterval(session.timer);
          active.delete(sessionId);
          const cancelled = signal === 'SIGTERM' || signal === 'SIGKILL';
          // ffmpeg `-t` 自动停时 code=0；用户 'q' graceful stop 也 code=0；
          // SIGKILL 时 code=null。
          if (code === 0 || cancelled) {
            // R-REC-DESKTOP-AREA #双模式：gif-direct 时录制完即是 GIF 终态，
            // 直接把 outputPath 当 gifPath emit，renderer 不再走 toolbox chain；
            // mp4-then-gif 时 gifPath 留空，由 renderer 继续 video-to-gif chain
            // 再 emit 真正的 done with gifPath。
            const isGifDirect = args.params.mode === 'gif-direct';
            emit(session, cancelled ? 'cancelled' : 'done', 100, cancelled ? '已取消' : '录制完成', {
              gifPath: cancelled ? undefined : (isGifDirect ? session.outputPath : undefined),
            });
            resolve({ outputPath: session.outputPath, cancelled });
            return;
          }
          // R-REC-DESKTOP-AREA #error-msg：用 formatFfmpegExitError 抽取
          // stderr 关键行（"Permission denied" / "Capture screen 0 not
          // found" / "Selected framerate not supported"），不再裸切 last
          // 500 字符——之前用户截图复制出来的全是 fps 列表噪声，根本
          // 看不出真错。摘要纯函数已单测。
          const msg = formatFfmpegExitError({ code, signal, stderr: stderrBuf });
          emit(session, 'error', 0, '录制失败', { error: msg });
          reject(new Error(msg));
        });

        active.set(sessionId, session);
      })
      .catch((e) => {
        emit(session, 'error', 0, '准备 tmp 目录失败', { error: e.message });
        reject(e);
      });
  });

  return { sessionId, outputPath, done };
}

/**
 * 优雅停止录制：先向 ffmpeg stdin 写 'q\n'（等价于命令行按 Q），让其 flush
 * moov atom；2 秒还没退就 SIGKILL 兜底。
 */
export async function stopRecorder(sessionId: string): Promise<{ ok: boolean }> {
  const s = active.get(sessionId);
  if (!s) return { ok: false };
  try {
    if (s.proc.stdin && !s.proc.stdin.destroyed) {
      s.proc.stdin.write('q\n');
      s.proc.stdin.end();
    }
  } catch (e) {
    log(`recorder: stdin write failed ${(e as Error).message}`);
  }
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      try { s.proc.kill('SIGKILL'); } catch { /* ignore */ }
      resolve();
    }, 2000);
    s.proc.once('close', () => { clearTimeout(t); resolve(); });
  });
  return { ok: true };
}

/** 取消录制（用户主动取消 / overlay esc / before-quit 兜底）。
 *
 *  #cancel-graceful (SC-REC-MP4-UNPLAYABLE) — 原先 `SIGTERM` 让 ffmpeg 来不及
 *  flush moov，产物 mp4 不可播。改走 stopRecorder 同款 graceful：stdin `q\n`
 *  给 ffmpeg 一次写完 trailer 的机会，2s 内不退再 SIGKILL。「这是 cancel
 *  不是 stop」的语义由 caller 自己维护（dock state machine 走 cancel 分支）。 */
export async function cancelRecorder(sessionId: string): Promise<{ ok: boolean }> {
  const s = active.get(sessionId);
  if (!s) return { ok: false };
  try {
    if (s.proc.stdin && !s.proc.stdin.destroyed) {
      s.proc.stdin.write('q\n');
      s.proc.stdin.end();
    }
  } catch (e) {
    log(`recorder: cancel stdin write failed ${(e as Error).message}`);
  }
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      try { s.proc.kill('SIGKILL'); } catch { /* ignore */ }
      resolve();
    }, 2000);
    s.proc.once('close', () => { clearTimeout(t); resolve(); });
  });
  return { ok: true };
}

/** 测试 helper：reset 所有 active session（unit test 用，永不在生产路径调用）。 */
export function _resetActiveForTest(): void {
  for (const s of active.values()) {
    if (s.timer) clearInterval(s.timer);
    try { s.proc?.kill?.('SIGKILL'); } catch { /* ignore */ }
  }
  active.clear();
}
