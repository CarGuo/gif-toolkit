import type { TaskProgress, ToolboxJob, ToolboxKind, ToolboxParams } from '../../shared/types';

/**
 * useToolbox 内聚助手模块。
 *
 * 拆分动机:[useToolbox.ts](./useToolbox.ts) 在 R-COMPRESS-V1 / R-88
 * sticky cache / R-COMPRESS-V1.5 applyPreset 一连串加码后突破了
 * `max-lines: 600` 的 eslint 红线(655 行 → lint 退化为 PR-block 状态)。
 * 把跨调用方且与具体 state 无关的纯函数 / 常量 / 接口下沉到这里, 既
 * 让 useToolbox.ts 重回 <600 行, 也让单元测试可以直接 import 这些
 * helper 而不必 mount 整个 hook。
 *
 * 本文件刻意不引入 React, 全部都是平台无关的 pure / module-scope 代码。
 */

export interface ToolboxJobView extends ToolboxJob {
  /** Display-only filename derived from inputPath. */
  displayName: string;
}

/** R-39 — A single completed (or failed) toolbox run. */
export interface ToolboxHistoryEntry {
  id: string;
  kind: ToolboxKind;
  inputPath: string;
  /** Display-only filename derived from inputPath. */
  displayName: string;
  /** Output file paths (typically 1; gif-optimize may emit aux files). */
  outputs: string[];
  /** Snapshot of params at run-time (drives "GIF Resize · 480px" rows). */
  params: ToolboxParams;
  /** Final status; non-`done` entries kept as failure audit log. */
  status: 'done' | 'failed' | 'cancelled' | 'skipped';
  /** Optional human-readable error string for non-`done` entries. */
  error?: string;
  /** Unix epoch ms when the job settled. */
  finishedAt: number;
}

export const TOOLBOX_HISTORY_STORAGE_KEY = 'giftk.toolbox.history.v1';
export const TOOLBOX_HISTORY_LIMIT = 200;

/**
 * R-79b — see [storageSchema.ts](./storageSchema.ts). v1 with no
 * migrations; legacy bare-array blobs are accepted as v0.
 */
export const TOOLBOX_HISTORY_SCHEMA_VERSION = 1;

/** Default params per kind. Mirrors processor.ts defaults so the renderer
 *  preview values match what main will actually use. */
export function defaultParamsFor(kind: ToolboxKind): ToolboxParams {
  switch (kind) {
    case 'video-to-gif':
      // R-COMPRESS-V1 #3 — default to the fast ffmpeg engine so
      // existing users get the same single-pass palettegen path. The
      // ToolboxPanel exposes a segmented picker to flip to 'gifski'
      // for higher visual quality.
      return { fps: 12, width: 800, engine: 'ffmpeg' };
    case 'video-to-webp':
      return { fps: 15, width: 800, quality: 75, loop: 0 };
    case 'gif-resize':
      return { targetWidth: 480 };
    case 'gif-optimize':
      return { method: 'lossy', lossy: 80, colors: 128, dropEveryN: 2 };
    case 'trim':
      // No defaults — leaving startSec/endSec undefined lets the user
      // pick the range explicitly. Main-side falls back to (0, EOF).
      return {};
    case 'speed':
      return { speedFactor: 1 };
    case 'reverse':
      // 'mute' is the safest default: most reverse-clip use-cases don't
      // want backwards-talking audio, and this avoids the corner case
      // where the source has no audio stream at all.
      return { reverseAudioMode: 'mute' };
    case 'rotate':
      return { rotateDegrees: 90, flipH: false, flipV: false };
    case 'crop':
      // Crop has no defaults — the rect comes from the user's drag on the
      // preview canvas. Until they draw, the panel's Start button stays
      // disabled (renderer enforces single-file + cropX/Y/W/H presence).
      return {};
    case 'gif-webp-convert':
      // R-42 — When entering the tool with no queued file, default the
      // target to 'webp' (the most common ezgif use-case is "shrink my
      // gif to webp"). Once a file is queued the ToolboxPanel flips
      // this default to the *opposite* of the input extension via a
      // dedicated effect, so dropping a .webp re-defaults to 'gif'.
      return { targetFormat: 'webp' };
    default:
      return {};
  }
}

export function basenameFromPath(p: string): string {
  const m = /[^/\\]+$/.exec(p);
  return m ? m[0] : p;
}

let counter = 0;
export function genJobId(): string {
  counter += 1;
  return `tb_${Date.now().toString(36)}_${counter}_${Math.random().toString(36).slice(2, 8)}`;
}

/** R-39 — best-effort parse of one row from the DB. Treats every
 *  shape error as "drop the row" so a corrupted blob never blocks
 *  the panel from booting. */
export function parseHistoryEntry(e: unknown): ToolboxHistoryEntry | null {
  if (!e || typeof e !== 'object') return null;
  const x = e as Record<string, unknown>;
  if (typeof x.id !== 'string' || typeof x.kind !== 'string' ||
      typeof x.inputPath !== 'string' || typeof x.displayName !== 'string' ||
      !Array.isArray(x.outputs) || typeof x.finishedAt !== 'number') return null;
  if (x.status !== 'done' && x.status !== 'failed' && x.status !== 'cancelled' && x.status !== 'skipped') return null;
  return e as ToolboxHistoryEntry;
}

export const TERMINAL_STATUSES: ReadonlySet<TaskProgress['status']> = new Set([
  'done', 'failed', 'cancelled', 'skipped'
]);
