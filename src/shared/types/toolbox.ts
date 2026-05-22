/* ----------------------- R-35 Toolbox ----------------------- */

import type { GifOptimizeLevel, GifDither } from './process';

/**
 * R-35 — local Toolbox (Ezgif-style). MVP shipped 4 tools (video↔gif/webp,
 * gif-resize, gif-optimize). R-37 adds the next 4: Trim / Speed / Reverse
 * / Rotate. Each tool accepts both video and gif inputs (the processor
 * branches on file extension), so a user can e.g. trim a clip OR a gif
 * with the same UI panel.
 */
export type ToolboxKind =
  | 'video-to-gif'
  | 'video-to-webp'
  | 'gif-resize'
  | 'gif-optimize'
  | 'trim'
  | 'speed'
  | 'reverse'
  | 'rotate'
  | 'crop'
  // R-42 — Bidirectional GIF ↔ WebP converter. Accepts either format
  // and re-encodes to the user-chosen target via sharp (animated mode).
  // Default `targetFormat` is the *opposite* of the input extension, so
  // dropping `loop.gif` defaults to `webp` and vice versa.
  | 'gif-webp-convert';

/** Allowed input extensions per tool. Used both in main-process input
 *  validation AND in the renderer's drag-and-drop / file picker filter.
 *  R-41 — Final tool-input policy: the *first two* tools (Video → GIF /
 *  Video → WebP) are dedicated converters and only accept video
 *  containers. The other seven tools all operate on already-animated
 *  bitmaps, so they accept .gif AND .webp. (gifsicle natively only
 *  understands .gif, so the main-process gif-resize / gif-optimize
 *  paths transparently wrap webp inputs via ffmpeg decode → gifsicle
 *  → ffmpeg re-encode back to .webp; the user-facing rule is simply
 *  "input format == output format".) */
const VIDEO_EXTS = ['.mp4', '.mov', '.webm', '.mkv', '.m4v'] as const;
const GIF_EXTS = ['.gif'] as const;
const GIF_OR_WEBP: readonly string[] = ['.gif', '.webp'];

export const TOOLBOX_INPUT_EXTENSIONS: Record<ToolboxKind, readonly string[]> = {
  'video-to-gif': VIDEO_EXTS,
  'video-to-webp': VIDEO_EXTS,
  // R-41 — gif-resize / gif-optimize accept webp via a transparent
  // gif round-trip in the main process. From the renderer's POV they
  // are "animated-bitmap" tools just like trim/speed/etc.
  'gif-resize': GIF_OR_WEBP,
  'gif-optimize': GIF_OR_WEBP,
  'trim': GIF_OR_WEBP,
  'speed': GIF_OR_WEBP,
  // R-40 / R-41 — Reverse stays GIF-family-only (excludes raw video
  // because ffmpeg's -vf reverse buffers every decoded frame in RAM).
  'reverse': GIF_OR_WEBP,
  'rotate': GIF_OR_WEBP,
  // R-38 — Crop is single-file only. The single-file constraint is
  // enforced in the renderer (the panel requires the queue length to
  // be exactly 1 before enabling Start) because the visual crop rect
  // comes from one preview frame and there is no general way to map
  // one rect onto N heterogeneous inputs.
  'crop': GIF_OR_WEBP,
  // R-42 — GIF ↔ WebP converter accepts either format and the
  // renderer's targetFormat picker decides the output extension.
  'gif-webp-convert': GIF_OR_WEBP
};

// Preserve the legacy union token in case future tools want it back;
// no current tool uses it but the constant is referenced by docs.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const VIDEO_OR_GIF: readonly string[] = [...VIDEO_EXTS, ...GIF_EXTS];

/**
 * R-35 (#2) — gif-optimize sub-strategies, mirrors ezgif's "Optimization
 * method" picker. Each method maps to a different gifsicle invocation:
 *
 *   - lossy            : gifsicle --lossy=N
 *   - color-reduction  : gifsicle --colors=K --color-method=blend-diversity
 *   - color-dither     : gifsicle --colors=K --dither
 *   - drop-every-nth   : gifsicle --delete "#0n,#1n,..." then --optimize
 *   - drop-duplicates  : gifsicle --optimize=3 (frame-dedupe pass)
 *   - optimize-transp  : gifsicle --optimize=3 --transparent (transparency)
 *   - wechat-safe      : ffmpeg full-frame re-encode (palettegen+paletteuse new=0,
 *                        -gifflags -transdiff-offsetting) + gifsicle -O0
 *                        --no-extensions/--no-comments/--no-names + auto frame
 *                        downsample to ≤ 300 frames. Targets the WeChat editor's
 *                        twin hard limits ("帧数超过 300 帧" + "来源信息无法识别").
 *   - budget           : run the full 4-Phase compressLoop (size-target).
 *
 * Note: the existing single-pass gifsicleOptimize(file, lossy, colors)
 * still drives the explicit lossy + colors path; budget hits compressLoop.
 */
export type ToolboxOptimizeMethod =
  | 'lossy'
  | 'color-reduction'
  | 'color-dither'
  | 'drop-every-nth'
  | 'drop-duplicates'
  | 'optimize-transparency'
  | 'wechat-safe'
  | 'budget';

/** Per-tool params. All fields are optional — sanitiseToolboxOptions in
 *  main/index.ts fills in safe defaults derived from DEFAULT_OPTIONS. */
export interface ToolboxParams {
  /* video → gif / webp */
  fps?: number;            // 1..60, default 12
  width?: number;          // 64..4096, default 0 (keep source width capped at maxWidth)
  startSec?: number;       // optional clip start
  endSec?: number;         // optional clip end
  /* video → webp specific */
  quality?: number;        // 0..100, default 75
  loop?: number;           // 0=infinite, n=loops, default 0
  /* gif-resize / gif-optimize */
  targetWidth?: number;    // 64..4096, used by gif-resize
  lossy?: number;          // 0..200 (gifsicle), used by gif-optimize
  colors?: number;         // 2..256, used by gif-optimize
  maxBytes?: number;       // size budget for gif-optimize (compressLoop hard target)
  softMaxBytes?: number;   // size soft budget for gif-optimize
  /* gif-optimize method picker (R-35 #2) */
  method?: ToolboxOptimizeMethod;
  /** every-Nth frame drop step, used when method === 'drop-every-nth' (2..10). */
  dropEveryN?: number;
  /* ----------- R-81 Manual / Toolbox gifsicle knobs ----------- */
  /** Mirror of ProcessOptions.lossyCeiling — caps every adaptive lossy
   *  pass inside compressLoop / gifsicleOptimize. 0..200 integer. */
  lossyCeiling?: number;
  /** Mirror of ProcessOptions.colorsFloor — floors every adaptive palette
   *  pass. 2..256 integer. */
  colorsFloor?: number;
  /** Mirror of ProcessOptions.optimizeLevel — gifsicle -O1/2/3 lock. */
  optimizeLevel?: GifOptimizeLevel;
  /** Mirror of ProcessOptions.dither — gifsicle dither lock when palette
   *  reduction kicks in (colors < 256). */
  dither?: GifDither;
  /* ----------- R-37 Trim / Speed / Reverse / Rotate ----------- */
  /** Speed multiplier, used by 'speed'. 0.25..4.0; 1.0 = no-op.
   *  For video tracks we apply setpts=PTS/N + atempo (audio); for gifs
   *  it scales every frame's delay (gifsicle --delay). */
  speedFactor?: number;
  /** Rotation in degrees, used by 'rotate'. Allowed: 0 / 90 / 180 / 270.
   *  90 / 270 swap width and height. */
  rotateDegrees?: number;
  /** Horizontal flip, used by 'rotate'. Applied AFTER rotateDegrees. */
  flipH?: boolean;
  /** Vertical flip, used by 'rotate'. */
  flipV?: boolean;
  /** Audio handling for 'reverse' on video. 'mute' drops audio entirely;
   *  'reverse' applies areverse so audio plays back too; 'keep' leaves
   *  the original (forward) audio over the reversed video. Defaults to
   *  'mute' since most reverse-clip use cases don't need backward speech. */
  reverseAudioMode?: 'mute' | 'reverse' | 'keep';
  /* ----------- R-38 Crop ----------- */
  /** Crop rectangle in *natural* (source-pixel) coordinates. The renderer
   *  reads probeMedia → naturalSize, the user drags a CropBox over the
   *  preview, and the resulting (x, y, w, h) lands here. ffmpeg consumes
   *  it as `crop=w:h:x:y`. Half-pixel values are clamped to integers in
   *  sanitizeToolboxParams. */
  cropX?: number;
  cropY?: number;
  cropW?: number;
  cropH?: number;
  /* ----------- R-COMPRESS-V1 #3 video→gif engine switch ----------- */
  /** Encoder engine for the `video-to-gif` tool. Two paths supported:
   *
   *   - 'ffmpeg' (default) — single-pass split → palettegen →
   *     paletteuse via the bundled ffmpeg-static. Fast, palette
   *     limited to 256 colours per frame, low memory.
   *   - 'gifski'           — extract source frames as PNG via ffmpeg,
   *     then encode with gifski (pngquant-based). Much higher visual
   *     quality on full-colour clips (thousands of effective colours
   *     per frame via temporal dithering) at the cost of disk I/O
   *     for the PNG sequence and a slower encode.
   *
   * Only consulted by the 'video-to-gif' branch in processor.ts; the
   * field is ignored for every other tool kind. sanitizeToolboxParams
   * clamps unknown values to undefined (the renderer + processor
   * fall back to 'ffmpeg' when absent). */
  engine?: 'ffmpeg' | 'gifski';
  /* ----------- R-42 GIF ↔ WebP convert ----------- */
  /** Target output container for the gif-webp-convert tool. The
   *  renderer initialises this to the *opposite* of the input
   *  extension so the default action is always a real conversion
   *  (uploading `loop.gif` defaults to `webp`; uploading `loop.webp`
   *  defaults to `gif`). The main process trusts whatever value is
   *  here — sanitizeToolboxParams clamps it to one of the two known
   *  literals. */
  targetFormat?: 'gif' | 'webp';
}

/**
 * R-35 — single user-submitted local job. The shape mirrors ProcessTask
 * but carries a local input path instead of a SniffedMedia (no
 * download phase). The main process re-validates `inputPath` against
 * a strict whitelist before reading it (mirrors the reoptimizeFromGifPath
 * path-inside guard).
 */
export interface ToolboxJob {
  /** Renderer-side stable id (e.g. crypto.randomUUID()). */
  id: string;
  kind: ToolboxKind;
  /** Absolute path on the user's disk. Validated in main/index.ts. */
  inputPath: string;
  params: ToolboxParams;
}

export interface ToolboxStartResult {
  ok: boolean;
  outputDir: string;
}

/* --------------------- R-TB-CHAIN: single-input chain --------------------- */

/**
 * R-TB-CHAIN — one step inside a chain. Parallel to ToolboxJob but with
 * NO inputPath: the input is resolved at runtime by the chain runner
 * (step 1 reads from the chain's source file; step N+1 reads step N's
 * primary output). Each step still carries its own kind+params so the
 * runner can sanitize/process each independently.
 *
 * Crop semantics: crop steps carry whatever cropX/Y/W/H the renderer
 * could pre-fill (often zeros), but the runner emits an
 * `awaiting-input` progress event for crop steps and pauses until the
 * renderer calls `toolbox:resumeChain` with the rect drawn over the
 * previous step's actual output frame. The patch overrides the
 * persisted params before the step runs. Non-crop steps never pause.
 */
export interface ToolboxChainStep {
  /** Stable id used as the taskId when the runner emits progress for
   *  this step. Chain progress is keyed by stepId so the renderer can
   *  show per-step state inside one chain. */
  id: string;
  kind: ToolboxKind;
  params: ToolboxParams;
}

/**
 * R-TB-CHAIN — full chain submission. The runner allocates one
 * sub-directory `<root>/toolbox/chain-<YYYYMMDD>/<chainId>/` and
 * deposits step-i-<kind>.<ext> files there. Failed steps abort the
 * chain but PRESERVE intermediate files so the user can inspect where
 * the chain broke (decision: "保留中间产物").
 */
export interface ToolboxChainRequest {
  /** Stable chain id. Doubles as the leaf directory name. */
  chainId: string;
  /** Single source file. Same path-validation rules as ToolboxJob.inputPath. */
  inputPath: string;
  /** ≥1 steps. Each step's kind must accept the previous step's output
   *  extension (validated by validateChainCompatibility in main). */
  steps: ToolboxChainStep[];
}

export interface ToolboxChainStartResult {
  ok: boolean;
  outputDir: string;
  chainId: string;
}

/**
 * R-TB-CHAIN — patch sent by the renderer when resuming a paused step.
 * Currently only crop steps pause, so the patch is a partial
 * ToolboxParams (cropX/Y/W/H). The runner merges the patch on top of
 * the original step params before executing.
 */
export interface ToolboxChainResumePatch {
  chainId: string;
  /** 0-based index of the paused step. The runner rejects mismatched
   *  indices to prevent double-resume races. */
  stepIndex: number;
  /** Subset of ToolboxParams to merge in. Same sanitiser as startChain. */
  paramsPatch: Partial<ToolboxParams>;
}

/**
 * R-TB-CHAIN — terminal status of a chain run. Mirrors TaskStatus's
 * settled subset; `awaiting-input` is in-flight only and never appears
 * in history.
 */
export type ToolboxChainStatus = 'done' | 'failed' | 'cancelled';

/**
 * R-TB-CHAIN — one persisted chain run. Stored in the dedicated
 * `toolbox_chain_history` table (decision: "独立 SQLite 表"). The list
 * of steps is kept verbatim with per-step output paths so the renderer
 * can reveal step-N intermediates from history, not just the final.
 */
export interface ToolboxChainHistoryStep {
  kind: ToolboxKind;
  params: ToolboxParams;
  status: 'done' | 'failed' | 'cancelled' | 'skipped';
  /** Output paths produced by this step (typically 1; gif-optimize may
   *  emit aux files). Empty for steps that never ran. */
  outputs: string[];
  error?: string;
}

export interface ToolboxChainHistoryEntry {
  /** Mirrors ToolboxChainRequest.chainId. */
  id: string;
  /** Original source file. */
  inputPath: string;
  /** Display-only filename derived from inputPath. */
  displayName: string;
  /** Final status after the runner settled. */
  status: ToolboxChainStatus;
  /** Per-step audit trail. */
  steps: ToolboxChainHistoryStep[];
  /** Chain output sub-directory (`<root>/toolbox/chain-<date>/<chainId>/`). */
  outputDir: string;
  /** Unix epoch ms when the chain settled. */
  finishedAt: number;
  /** First-failure error string when status='failed', else absent. */
  error?: string;
}

/* --------------------- R-TB-CHAIN: renderer-side draft state --------------------- */

/**
 * R-TB-CHAIN Phase 2 — Toolbox panel mode toggle.
 *
 * - 'batch': the legacy mode. ToolboxPanel collects N input files and
 *   submits one parallel batch via `toolbox:start` (PQueue inside
 *   processor.ts). Same kind for every input.
 * - 'chain': single-input multi-step pipeline. ToolboxPanel collects
 *   exactly ONE input file plus an ordered list of ChainStepDraft
 *   entries. The renderer hard-locks the mode back to 'batch' the
 *   moment the queue length goes above 1, because chain semantics are
 *   undefined for multiple heterogeneous inputs (decision: "只在单个
 *   图片有效，批量不行").
 */
export type ToolboxMode = 'batch' | 'chain';

/**
 * R-TB-CHAIN Phase 2 — renderer-only draft for one chain step.
 *
 * Distinct from {@link ToolboxChainStep} (which is the IPC contract
 * shape that crosses the preload bridge): a draft carries UI-only
 * metadata that has no place in the main process — most importantly a
 * separate `id` (a stable React key) and a `valid` flag computed by
 * the panel from the user's current params (e.g. crop steps don't
 * need cropX/Y/W/H to be valid yet because the chain runner pauses
 * and asks via {@link ToolboxChainResumePatch}; gif-resize on the
 * other hand requires `targetWidth >= 64`).
 *
 * The renderer maps drafts → ToolboxChainStep[] right before invoking
 * `startToolboxChain`: a fresh per-step id is allocated there
 * (typically `${chainId}-s${i+1}`) so the chain runner's progress
 * `taskId === step.id` invariant holds.
 */
export interface ChainStepDraft {
  /** Stable React key for the draft row. NOT the IPC step id — that
   *  one is allocated when the chain is submitted. */
  draftId: string;
  /** The toolbox kind this step will run. */
  kind: ToolboxKind;
  /** Current user-edited params for this step. May be incomplete for
   *  pausing kinds (crop) — the chain runner asks for the missing
   *  fields via the awaiting-input flow. */
  params: ToolboxParams;
  /** Whether this draft can be submitted as-is. The panel uses this
   *  to enable / disable the Run button; pausing kinds are 'true'
   *  even with empty rect because the runner will pause and ask. */
  valid: boolean;
}

/**
 * R-TB-CHAIN Phase 2 — kinds whose ChainStepDraft is allowed to ship
 * with empty / partial rect-style params because the chain runner
 * pauses and asks the renderer for the missing fields. Kept in sync
 * with the main-process PAUSING_KINDS set in [processor.ts].
 *
 * Exporting this from shared/types means renderer code (the hook,
 * the panel, unit tests) and renderer-side validation can decide
 * "submit as-is vs require user input" without re-importing main
 * process modules into the renderer bundle.
 */
export const CHAIN_PAUSING_KINDS: ReadonlySet<ToolboxKind> = new Set<ToolboxKind>(['crop']);

/**
 * R-TB-CHAIN Phase 2 — renderer-side draft validity check. Pure,
 * synchronous, no IPC. The panel calls this on every keystroke to
 * recompute ChainStepDraft.valid; tests assert behaviour per kind.
 *
 * Rules
 * -----
 * - gif-resize: targetWidth must be >= 64 (the same floor enforced
 *   by sanitizeToolboxParams; below that gifsicle/sharp would be
 *   asked to upscale tiny widths and the result is unusable).
 * - gif-optimize: when method is set it must be a known method; when
 *   method is omitted the runner falls back to lossy with defaults
 *   so an empty params object is valid.
 * - crop: ALWAYS valid in chain mode — the rect comes from the
 *   pause-resume flow, not the draft.
 * - all other kinds: valid by default; missing fields fall back to
 *   sanitizeToolboxParams defaults.
 */
export function isChainStepDraftValid(kind: ToolboxKind, params: ToolboxParams): boolean {
  if (CHAIN_PAUSING_KINDS.has(kind)) return true;
  switch (kind) {
    case 'gif-resize':
      return typeof params.targetWidth === 'number' && params.targetWidth >= 64;
    case 'gif-optimize':
      if (params.method === undefined) return true;
      return (
        params.method === 'lossy' ||
        params.method === 'color-reduction' ||
        params.method === 'color-dither' ||
        params.method === 'drop-every-nth' ||
        params.method === 'drop-duplicates' ||
        params.method === 'optimize-transparency' ||
        params.method === 'wechat-safe' ||
        params.method === 'budget'
      );
    default:
      return true;
  }
}

