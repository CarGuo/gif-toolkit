import fsp from 'node:fs/promises';
import path from 'node:path';
import { startToolboxChain } from './processor';
import {
  RECORDER_DEFAULT_LONG_SIDE,
  RECORDER_LONG_SIDE_PRESETS,
  type RecorderParams,
  type RecorderRegion,
} from '../shared/types/recorder';
import type { ToolboxChainStep, ToolboxParams } from '../shared/types/toolbox';
import type { TaskProgress } from '../shared/types/process';

export function captureRegionInsideFrame(region: RecorderRegion, framePx = 2): RecorderRegion {
  const inset = Math.max(0, Math.round(framePx));
  if (inset <= 0 || region.w <= inset * 2 + 2 || region.h <= inset * 2 + 2) {
    return { ...region };
  }
  return {
    ...region,
    x: region.x + inset,
    y: region.y + inset,
    w: region.w - inset * 2,
    h: region.h - inset * 2,
  };
}

/** R-DOCK-FLOATING #shared-pref — dock 录制偏好 sticky cache。
 *
 *  历史上 dock 完全 hardcode `fps=15 / dur=20s / maxLongSide=800`，与主窗
 *  RecorderPanel 用户偏好（fps / max bytes / capture cursor / maxLongSide）
 *  完全脱节，等于"两套录屏 App"。这里维护一个 module-level cache：
 *
 *    - 主窗每次派发 `recorder:start` 时由 ipcMain handler 调
 *      [rememberDockRecorderParams](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/dockRecording.ts) 同步 region 之外的偏好；
 *    - dock 触发录制时调 [dockRecorderParams](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/dockRecording.ts) 读这份偏好覆盖到 region 上，
 *      未同步过则 fallback 到内置安全默认值。
 *    - dock overlay 上的「最长边」chip 通过 [setDockLongSide](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/dockRecording.ts) 单独写入
 *      lastLongSide，下次 dock 触发录制时优先于 sticky.maxLongSide。
 *
 *  region/maxDurationSec 仍由 dock 强约束（dock 用户体验是「快速 20s 段」），
 *  其他字段全部尊重用户偏好。
 *
 *  v2.3 起 mode 字段恒为 'gif-direct'（mp4-then-gif 已下线）。
 */
const DOCK_RECORDER_PARAM_DEFAULTS: Omit<RecorderParams, 'region'> = {
  mode: 'gif-direct',
  fps: 15,
  maxDurationSec: 20,
  captureCursor: true,
  captureAudio: false,
  softMaxBytes: 2 * 1024 * 1024,
  maxBytes: 4 * 1024 * 1024,
  maxWidth: 720,
  maxLongSide: RECORDER_DEFAULT_LONG_SIDE,
};

let stickyParams: Omit<RecorderParams, 'region'> | null = null;
let lastLongSide: number | null = null;

/** 主窗派发 recorder:start 时调用，把用户偏好同步到 dock 录制路径。
 *  仅保留与 region 无关的字段。mode 永远写 'gif-direct' 不依赖入参。 */
export function rememberDockRecorderParams(params: RecorderParams): void {
  stickyParams = {
    mode: 'gif-direct',
    fps: params.fps,
    maxDurationSec: params.maxDurationSec,
    captureCursor: params.captureCursor,
    captureAudio: params.captureAudio,
    softMaxBytes: params.softMaxBytes,
    maxBytes: params.maxBytes,
    maxWidth: params.maxWidth,
    maxLongSide: params.maxLongSide,
  };
}

/** dock overlay 通过 IPC 单独切换长边时调用。
 *  仅接受 [RECORDER_LONG_SIDE_PRESETS](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types/recorder.ts) ∪ {0}，0 = 原始分辨率。
 *  非法值直接返回 false，不污染 cache。 */
export function setDockLongSide(longSide: number): boolean {
  if (longSide === 0 || (RECORDER_LONG_SIDE_PRESETS as readonly number[]).includes(longSide)) {
    lastLongSide = longSide;
    return true;
  }
  return false;
}

/** dock overlay 读当前长边偏好（chip active 态用）。 */
export function getDockLongSide(): number {
  if (lastLongSide !== null) return lastLongSide;
  if (stickyParams) return stickyParams.maxLongSide;
  return RECORDER_DEFAULT_LONG_SIDE;
}

/** 测试 helper：清空 sticky cache，让 dockRecorderParams 回到默认值分支。 */
export function _resetDockRecorderParamsForTest(): void {
  stickyParams = null;
  lastLongSide = null;
}

export function dockRecorderParams(region: RecorderRegion): RecorderParams {
  const base = stickyParams ?? DOCK_RECORDER_PARAM_DEFAULTS;
  // mode 恒为 gif-direct（类型层已是单例字面量，运行时也保险一手）。
  // dock overlay 上 chip 切换的 longSide 比 sticky 优先。
  const longSide = lastLongSide ?? base.maxLongSide;
  return { region, ...base, mode: 'gif-direct', maxLongSide: longSide };
}

/**
 * R-REC-DESKTOP-AREA #recompress-oversize — 直出 GIF 体积超 maxBytes 时
 * 自动接 toolbox `gif-optimize` chain 兜底压缩。
 *
 * 流程：
 *   1. stat gifPath 拿真实 byteLength；
 *   2. ≤ maxBytes 则直接返回原 path，不动文件；
 *   3. 否则派发一个 gif-optimize step，target=maxBytes，软目标=softMaxBytes；
 *   4. chain 成功 → 用产物替换原 gifPath（rename 覆盖）后返回原 gifPath，
 *      让上层 (sessionTmpRegistry / history) 不需要变更引用；
 *   5. chain 失败 → throw，由 caller 决定要不要回退（dock.ts 不回退，
 *      把异常透到 dispatchDockAction 的 toast）。
 */
export async function maybeRecompressOversizeGif(args: {
  gifPath: string;
  outputBaseDir: string;
  params: RecorderParams;
  emit?: (p: TaskProgress) => void;
}): Promise<string> {
  let bytes: number;
  try {
    const st = await fsp.stat(args.gifPath);
    bytes = st.size;
  } catch (e) {
    throw new Error(`stat 失败：${(e as Error).message}`);
  }
  if (bytes <= args.params.maxBytes) {
    return args.gifPath;
  }
  const chainId = `dock-rec-recompress-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const stepParams: ToolboxParams = {
    softMaxBytes: args.params.softMaxBytes,
    maxBytes: args.params.maxBytes,
  };
  const step: ToolboxChainStep = {
    id: `${chainId}-s1`,
    kind: 'gif-optimize',
    params: stepParams,
  };
  let lastOutput: string | null = null;
  const result = await startToolboxChain({
    chainId,
    inputPath: args.gifPath,
    steps: [step],
    outputBaseDir: path.join(args.outputBaseDir, chainId),
    emit: (p) => {
      if (Array.isArray(p.outputs) && p.outputs.length > 0) lastOutput = p.outputs[0];
      args.emit?.(p);
    },
    chainInputName: path.basename(args.gifPath),
  });
  const output = lastOutput ?? result.steps.find((s) => s.outputs.length > 0)?.outputs[0];
  if (result.status !== 'done' || !output) {
    throw new Error(result.error || 'dock recording gif-optimize chain produced no output');
  }
  // 把压缩后的产物覆盖回原 gifPath，外部引用不变。
  try {
    await fsp.copyFile(output, args.gifPath);
  } catch (e) {
    throw new Error(`兜底压缩复制失败：${(e as Error).message}`);
  }
  return args.gifPath;
}
