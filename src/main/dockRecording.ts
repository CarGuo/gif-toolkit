import path from 'node:path';
import { startToolboxChain } from './processor';
import type { RecorderParams, RecorderRegion } from '../shared/types/recorder';
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
 *  历史上 dock 完全 hardcode `fps=15 / mp4-then-gif / dur=20s / maxWidth=720`，
 *  与主窗 RecorderPanel 用户偏好（fps / mode / max bytes / max width / capture
 *  audio / capture cursor）完全脱节，等于"两套录屏 App"。这里维护一个
 *  module-level cache：
 *
 *    - 主窗每次派发 `recorder:start` 时由 ipcMain handler 调
 *      [rememberDockRecorderParams](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/dockRecording.ts) 同步 region 之外的偏好；
 *    - dock 触发录制时调 [dockRecorderParams](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/dockRecording.ts) 读这份偏好覆盖到 region 上，
 *      未同步过则 fallback 到内置安全默认值（与历史 hardcode 一致）。
 *
 *  region/maxDurationSec 仍由 dock 强约束（dock 用户体验是「快速 20s 段」），
 *  其他 7 个字段全部尊重用户偏好。
 */
const DOCK_RECORDER_PARAM_DEFAULTS: Omit<RecorderParams, 'region'> = {
  mode: 'mp4-then-gif',
  fps: 15,
  maxDurationSec: 20,
  captureCursor: true,
  captureAudio: false,
  softMaxBytes: 2 * 1024 * 1024,
  maxBytes: 4 * 1024 * 1024,
  maxWidth: 720,
};

let stickyParams: Omit<RecorderParams, 'region'> | null = null;

/** 主窗派发 recorder:start 时调用，把用户偏好同步到 dock 录制路径。
 *  仅保留与 region 无关的字段；mode/fps/maxBytes/maxWidth 等全部 carry 过去。 */
export function rememberDockRecorderParams(params: RecorderParams): void {
  stickyParams = {
    mode: params.mode,
    fps: params.fps,
    maxDurationSec: params.maxDurationSec,
    captureCursor: params.captureCursor,
    captureAudio: params.captureAudio,
    softMaxBytes: params.softMaxBytes,
    maxBytes: params.maxBytes,
    maxWidth: params.maxWidth,
  };
}

/** 测试 helper：清空 sticky cache，让 dockRecorderParams 回到默认值分支。 */
export function _resetDockRecorderParamsForTest(): void {
  stickyParams = null;
}

export function dockRecorderParams(region: RecorderRegion): RecorderParams {
  const base = stickyParams ?? DOCK_RECORDER_PARAM_DEFAULTS;
  return { region, ...base };
}

export async function convertDockRecordingToGif(args: {
  mp4Path: string;
  outputBaseDir: string;
  params: RecorderParams;
  emit?: (p: TaskProgress) => void;
}): Promise<string> {
  const chainId = `dock-rec-chain-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const stepParams: ToolboxParams = {
    fps: args.params.fps,
    width: args.params.maxWidth,
    softMaxBytes: args.params.softMaxBytes,
    maxBytes: args.params.maxBytes,
  };
  const step: ToolboxChainStep = {
    id: `${chainId}-s1`,
    kind: 'video-to-gif',
    params: stepParams,
  };
  let lastOutput: string | null = null;
  const result = await startToolboxChain({
    chainId,
    inputPath: args.mp4Path,
    steps: [step],
    outputBaseDir: path.join(args.outputBaseDir, chainId),
    emit: (p) => {
      if (Array.isArray(p.outputs) && p.outputs.length > 0) lastOutput = p.outputs[0];
      args.emit?.(p);
    },
    chainInputName: path.basename(args.mp4Path),
  });
  const output = lastOutput ?? result.steps.find((s) => s.outputs.length > 0)?.outputs[0];
  if (result.status !== 'done' || !output) {
    throw new Error(result.error || 'dock recording video-to-gif chain produced no output');
  }
  return output;
}
