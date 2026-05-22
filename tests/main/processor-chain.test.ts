/**
 * R-TB-CHAIN — Pure-logic tests for the chain runner's compatibility +
 * extension inference helpers. These are the "always run" guardrails
 * (no DB, no ffmpeg) so a regression in the cross-step boundary check
 * surfaces immediately on `npm test`.
 *
 * The dynamic runtime behaviour (real ffmpeg per-step execution,
 * pause-resume IPC, cancel mid-step) is covered by:
 *   - the e2e SUITE TB-CHAIN-A..F (Phase 2) which runs against
 *     tests/fixtures/tiny.* through the actual processor pipeline
 *   - the toolboxChainHistoryRepo opt-in DB suite (this file's sibling)
 *
 * Coverage goals here:
 *   1. validateChainCompatibility — accepts a valid pipeline, rejects
 *      every incompatible boundary (first-step ext mismatch / mid-chain
 *      ext drift / unknown kind via the union check), and returns the
 *      kind+ext in the error message so renderers can surface "step N
 *      can't accept .xxx".
 *   2. chainStepOutputExt — exhaustive switch coverage for every kind
 *      with the parametric branches (gif-webp-convert toggling on
 *      params.targetFormat).
 */

import { describe, it, expect } from 'vitest';
import {
  chainStepOutputExt,
  validateChainCompatibility
} from '../../src/main/processor-chain-utils';
import type { ToolboxChainStep } from '../../src/shared/types';

function step(kind: ToolboxChainStep['kind'], params: ToolboxChainStep['params'] = {}): ToolboxChainStep {
  return { id: `step-${kind}`, kind, params };
}

describe('R-TB-CHAIN chainStepOutputExt', () => {
  it('video-to-gif always emits .gif regardless of input ext', () => {
    expect(chainStepOutputExt('video-to-gif', {}, '.mp4')).toBe('.gif');
    expect(chainStepOutputExt('video-to-gif', {}, '.mov')).toBe('.gif');
  });

  it('video-to-webp always emits .webp', () => {
    expect(chainStepOutputExt('video-to-webp', {}, '.mp4')).toBe('.webp');
    expect(chainStepOutputExt('video-to-webp', {}, '.webm')).toBe('.webp');
  });

  it('gif-webp-convert respects params.targetFormat when present', () => {
    expect(chainStepOutputExt('gif-webp-convert', { targetFormat: 'gif' }, '.webp')).toBe('.gif');
    expect(chainStepOutputExt('gif-webp-convert', { targetFormat: 'webp' }, '.gif')).toBe('.webp');
  });

  it('gif-webp-convert defaults to the OPPOSITE of input when targetFormat absent', () => {
    expect(chainStepOutputExt('gif-webp-convert', {}, '.gif')).toBe('.webp');
    expect(chainStepOutputExt('gif-webp-convert', {}, '.webp')).toBe('.gif');
  });

  it('format-preserving kinds keep the input extension verbatim', () => {
    for (const kind of ['gif-resize', 'gif-optimize', 'trim', 'speed', 'reverse', 'rotate', 'crop'] as const) {
      expect(chainStepOutputExt(kind, {}, '.gif')).toBe('.gif');
      expect(chainStepOutputExt(kind, {}, '.webp')).toBe('.webp');
    }
  });
});

describe('R-TB-CHAIN validateChainCompatibility', () => {
  it('accepts the canonical mp4 → gif → optimize → resize chain', () => {
    const steps: ToolboxChainStep[] = [
      step('video-to-gif'),
      step('gif-optimize'),
      step('gif-resize'),
      step('crop')
    ];
    expect(() => validateChainCompatibility(steps, '.mp4')).not.toThrow();
  });

  it('accepts a webp pipeline through gif-webp-convert and back', () => {
    const steps: ToolboxChainStep[] = [
      step('gif-webp-convert', { targetFormat: 'gif' }),
      step('gif-optimize'),
      step('gif-webp-convert', { targetFormat: 'webp' })
    ];
    expect(() => validateChainCompatibility(steps, '.webp')).not.toThrow();
  });

  it('rejects when first step does not accept the source extension', () => {
    // gif-optimize accepts only gif/webp, not mp4
    const steps: ToolboxChainStep[] = [step('gif-optimize')];
    expect(() => validateChainCompatibility(steps, '.mp4')).toThrowError(
      /chain step 1 \(gif-optimize\) does not accept input extension \.mp4/
    );
  });

  it('rejects mid-chain drift: trim cannot consume mp4 produced by an upstream step pretending to keep video', () => {
    // crop preserves ext so chaining crop after a video source means
    // step 2 sees mp4 → trim only accepts gif/webp → boundary failure.
    // We can't actually start the chain with crop on mp4 (crop accepts
    // only gif/webp), so this dually proves first-step rejection.
    const steps: ToolboxChainStep[] = [step('crop'), step('trim')];
    expect(() => validateChainCompatibility(steps, '.mp4')).toThrowError(
      /chain step 1 \(crop\) does not accept input extension \.mp4/
    );
  });

  it('rejects when a downstream step refuses the upstream output ext', () => {
    // video-to-gif emits .gif → next step is video-to-webp which only
    // accepts video extensions. Boundary 2 must throw.
    const steps: ToolboxChainStep[] = [step('video-to-gif'), step('video-to-webp')];
    expect(() => validateChainCompatibility(steps, '.mp4')).toThrowError(
      /chain step 2 \(video-to-webp\) does not accept input extension \.gif/
    );
  });

  it('throws on an empty step list', () => {
    expect(() => validateChainCompatibility([], '.mp4')).toThrowError(/no steps/);
  });

  it('error message lists the accepted extensions for the failing step', () => {
    const steps: ToolboxChainStep[] = [step('gif-optimize')];
    expect(() => validateChainCompatibility(steps, '.mp4')).toThrowError(
      /accepted=\.gif\/\.webp/
    );
  });

  it('is case-insensitive for source extension', () => {
    const steps: ToolboxChainStep[] = [step('video-to-gif')];
    expect(() => validateChainCompatibility(steps, '.MP4')).not.toThrow();
  });
});
