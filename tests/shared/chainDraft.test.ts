/**
 * R-TB-CHAIN Phase 2.0 — unit tests for the renderer-side chain draft
 * helpers exported from [src/shared/types/toolbox.ts]. These are pure
 * functions (no IPC, no React, no DOM) so they belong in the shared
 * vitest tier alongside DEFAULT_OPTIONS.
 *
 * The two invariants under test
 * -----------------------------
 * 1. CHAIN_PAUSING_KINDS must stay in lockstep with the main-process
 *    PAUSING_KINDS set in processor.ts. Today both are exactly
 *    {'crop'}; this test fails loudly the day a new kind is added on
 *    one side and forgotten on the other.
 * 2. isChainStepDraftValid() implements the per-kind UI gate the
 *    ToolboxPanel relies on to enable / disable the Run button. The
 *    cases below pin the documented rules: pausing kinds bypass param
 *    checks (the chain runner asks via awaiting-input), gif-resize
 *    requires targetWidth >= 64, gif-optimize accepts an empty params
 *    object but rejects unknown methods, and every other kind is
 *    valid by default because sanitizeToolboxParams fills defaults.
 */
import { describe, expect, it } from 'vitest';
import {
  CHAIN_PAUSING_KINDS,
  isChainStepDraftValid
} from '../../src/shared/types/toolbox';

describe('R-TB-CHAIN Phase 2.0 — chain draft helpers', () => {
  describe('CHAIN_PAUSING_KINDS', () => {
    it('contains exactly {crop} today', () => {
      expect([...CHAIN_PAUSING_KINDS]).toEqual(['crop']);
    });

    it('reports has() correctly for crop and a non-pausing kind', () => {
      expect(CHAIN_PAUSING_KINDS.has('crop')).toBe(true);
      expect(CHAIN_PAUSING_KINDS.has('gif-resize')).toBe(false);
    });
  });

  describe('isChainStepDraftValid', () => {
    it('treats crop as valid even with empty params (rect comes from pause-resume)', () => {
      expect(isChainStepDraftValid('crop', {})).toBe(true);
    });

    it('gif-resize requires targetWidth >= 64', () => {
      expect(isChainStepDraftValid('gif-resize', {})).toBe(false);
      expect(isChainStepDraftValid('gif-resize', { targetWidth: 32 })).toBe(false);
      expect(isChainStepDraftValid('gif-resize', { targetWidth: 64 })).toBe(true);
      expect(isChainStepDraftValid('gif-resize', { targetWidth: 800 })).toBe(true);
    });

    it('gif-optimize accepts empty params (runner falls back to defaults)', () => {
      expect(isChainStepDraftValid('gif-optimize', {})).toBe(true);
    });

    it('gif-optimize accepts every documented method', () => {
      const methods = [
        'lossy',
        'color-reduction',
        'color-dither',
        'drop-every-nth',
        'drop-duplicates',
        'optimize-transparency',
        'wechat-safe',
        'budget'
      ] as const;
      for (const method of methods) {
        expect(isChainStepDraftValid('gif-optimize', { method })).toBe(true);
      }
    });

    it('gif-optimize rejects an unknown method (defends against IPC payload drift)', () => {
      expect(
        isChainStepDraftValid('gif-optimize', {
          // @ts-expect-error — deliberately invalid string to test the guard
          method: 'turbo-mode'
        })
      ).toBe(false);
    });

    it.each([
      ['video-to-gif'],
      ['video-to-webp'],
      ['trim'],
      ['speed'],
      ['reverse'],
      ['rotate'],
      ['gif-webp-convert']
    ] as const)('non-gated kind %s is valid by default', (kind) => {
      expect(isChainStepDraftValid(kind, {})).toBe(true);
    });
  });
});
