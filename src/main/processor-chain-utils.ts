/**
 * R-TB-CHAIN — Pure helpers for the toolbox chain runner.
 *
 * Split out of [processor.ts](./processor.ts) so unit tests can import
 * just the cross-step compatibility math without dragging in the
 * Electron / native ffmpeg / better-sqlite3 module graph. processor.ts
 * still re-exports both functions for backwards compatibility.
 *
 * What lives here:
 *   - chainStepOutputExt: maps (kind, params, inputExt) → output ext.
 *   - validateChainCompatibility: walks a chain step-by-step and
 *     throws on the first incompatible boundary.
 *
 * What does NOT live here: the runner itself (startToolboxChain) —
 * that one needs taskAborts/activeAborts/processToolboxJob and
 * therefore stays inside processor.ts.
 */

import type {
  ToolboxKind,
  ToolboxParams,
  ToolboxChainStep
} from '../shared/types';
import { TOOLBOX_INPUT_EXTENSIONS } from '../shared/types';

/**
 * Return the file extension a given toolbox kind will produce. Used
 * by validateChainCompatibility to confirm step N+1 can ingest the
 * artefact step N writes. The mapping mirrors processToolboxJob's
 * output-naming rules (which themselves derive from the kind+params).
 *
 * For `gif-webp-convert` the output extension follows the targetFormat
 * field (defaulting to the OPPOSITE of the input ext) so chain-time
 * compatibility checks must be parametric in `params.targetFormat`.
 */
export function chainStepOutputExt(
  kind: ToolboxKind,
  params: ToolboxParams,
  inputExt: string
): string {
  switch (kind) {
    case 'video-to-gif':
      return '.gif';
    case 'video-to-webp':
      return '.webp';
    case 'gif-webp-convert': {
      const tgt = params.targetFormat;
      if (tgt === 'gif') return '.gif';
      if (tgt === 'webp') return '.webp';
      return inputExt === '.gif' ? '.webp' : '.gif';
    }
    // gif-resize / gif-optimize / trim / speed / reverse / rotate / crop
    // all preserve the input format (sharp/gifsicle/ffmpeg in-place).
    default:
      return inputExt;
  }
}

/**
 * Verify that each step's kind accepts the previous step's output
 * extension. Throws on the first incompatible boundary with a
 * structured message that names BOTH ends of the boundary so the
 * renderer (or test) can surface it. The first step is checked
 * against the chain's source file extension.
 */
export function validateChainCompatibility(
  steps: ToolboxChainStep[],
  sourceExt: string
): void {
  if (steps.length === 0) throw new Error('chain has no steps');
  let cursorExt = sourceExt.toLowerCase();
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const accepted = TOOLBOX_INPUT_EXTENSIONS[step.kind];
    if (!accepted || !accepted.includes(cursorExt)) {
      throw new Error(
        `chain step ${i + 1} (${step.kind}) does not accept input extension ${cursorExt}; ` +
        `accepted=${accepted ? accepted.join('/') : '(unknown)'}`
      );
    }
    cursorExt = chainStepOutputExt(step.kind, step.params, cursorExt).toLowerCase();
  }
}
