// @vitest-environment happy-dom
/**
 * R-TB-CHAIN Phase 2 — useChainDrafts hook unit tests.
 *
 * Coverage matrix
 * ---------------
 * 1.  Initial state (no initialKind) is empty + allValid=false.
 * 2.  initialKind seeds one draft with empty params and recomputed valid.
 * 3.  addStep appends and returns a unique draftId.
 * 4.  updateStep merges params and toggles valid for gif-resize
 *     (targetWidth < 64 → false, >= 64 → true).
 * 5.  setStepParams replaces params wholesale and recomputes valid.
 * 6.  setStepKind resets params to {} and recomputes valid for the new kind.
 * 7.  removeStep removes only the matching draft.
 * 8.  moveStepUp / moveStepDown reorder; both are no-ops at the boundary.
 * 9.  clear() empties the list.
 * 10. allValid: empty → false; any-invalid → false; all valid → true.
 * 11. crop step (a pausing kind) is valid even with empty params.
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useChainDrafts } from '../../src/renderer/components/useChainDrafts';

describe('useChainDrafts (R-TB-CHAIN Phase 2)', () => {
  it('starts empty and reports allValid=false when no initialKind is supplied', () => {
    const { result } = renderHook(() => useChainDrafts());
    expect(result.current.drafts).toEqual([]);
    expect(result.current.allValid).toBe(false);
  });

  it('seeds one draft when initialKind is supplied', () => {
    const { result } = renderHook(() => useChainDrafts('crop'));
    expect(result.current.drafts).toHaveLength(1);
    expect(result.current.drafts[0].kind).toBe('crop');
    expect(result.current.drafts[0].params).toEqual({});
    // crop is a pausing kind → valid even with empty params.
    expect(result.current.drafts[0].valid).toBe(true);
    expect(result.current.allValid).toBe(true);
  });

  it('addStep appends a draft and returns a unique draftId', () => {
    const { result } = renderHook(() => useChainDrafts());
    let firstId = '';
    let secondId = '';
    act(() => {
      firstId = result.current.addStep('gif-resize');
    });
    expect(result.current.drafts).toHaveLength(1);
    expect(result.current.drafts[0].draftId).toBe(firstId);
    expect(firstId.startsWith('draft_')).toBe(true);
    act(() => {
      secondId = result.current.addStep('gif-optimize');
    });
    expect(result.current.drafts).toHaveLength(2);
    expect(secondId).not.toBe(firstId);
    expect(result.current.drafts[1].draftId).toBe(secondId);
  });

  it('updateStep merges params and toggles valid for gif-resize at the 64 floor', () => {
    const { result } = renderHook(() => useChainDrafts());
    let id = '';
    act(() => {
      id = result.current.addStep('gif-resize');
    });
    // Default empty params → invalid (no targetWidth).
    expect(result.current.drafts[0].valid).toBe(false);

    act(() => {
      result.current.updateStep(id, { targetWidth: 32 });
    });
    expect(result.current.drafts[0].params.targetWidth).toBe(32);
    expect(result.current.drafts[0].valid).toBe(false);

    act(() => {
      result.current.updateStep(id, { targetWidth: 64 });
    });
    expect(result.current.drafts[0].params.targetWidth).toBe(64);
    expect(result.current.drafts[0].valid).toBe(true);

    act(() => {
      result.current.updateStep(id, { targetWidth: 320 });
    });
    expect(result.current.drafts[0].params.targetWidth).toBe(320);
    expect(result.current.drafts[0].valid).toBe(true);
  });

  it('setStepParams replaces the whole params object and recomputes valid', () => {
    const { result } = renderHook(() => useChainDrafts());
    let id = '';
    act(() => {
      id = result.current.addStep('gif-resize');
    });
    act(() => {
      result.current.updateStep(id, { targetWidth: 200, fps: 12 });
    });
    expect(result.current.drafts[0].params.fps).toBe(12);

    // Replace wholesale: fps drops, targetWidth removed → invalid again.
    act(() => {
      result.current.setStepParams(id, {});
    });
    expect(result.current.drafts[0].params).toEqual({});
    expect(result.current.drafts[0].valid).toBe(false);

    act(() => {
      result.current.setStepParams(id, { targetWidth: 128 });
    });
    expect(result.current.drafts[0].params).toEqual({ targetWidth: 128 });
    expect(result.current.drafts[0].valid).toBe(true);
  });

  it('setStepKind resets params to {} and recomputes valid for the new kind', () => {
    const { result } = renderHook(() => useChainDrafts());
    let id = '';
    act(() => {
      id = result.current.addStep('gif-resize');
    });
    act(() => {
      result.current.updateStep(id, { targetWidth: 256 });
    });
    expect(result.current.drafts[0].valid).toBe(true);

    act(() => {
      result.current.setStepKind(id, 'crop');
    });
    expect(result.current.drafts[0].kind).toBe('crop');
    expect(result.current.drafts[0].params).toEqual({});
    // crop is a pausing kind → valid with empty params.
    expect(result.current.drafts[0].valid).toBe(true);

    act(() => {
      result.current.setStepKind(id, 'gif-resize');
    });
    expect(result.current.drafts[0].kind).toBe('gif-resize');
    expect(result.current.drafts[0].params).toEqual({});
    // gif-resize with empty params → invalid (no targetWidth).
    expect(result.current.drafts[0].valid).toBe(false);
  });

  it('removeStep removes only the matching draft', () => {
    const { result } = renderHook(() => useChainDrafts());
    const ids: string[] = [];
    act(() => {
      ids.push(result.current.addStep('gif-resize'));
      ids.push(result.current.addStep('crop'));
      ids.push(result.current.addStep('gif-optimize'));
    });
    expect(result.current.drafts).toHaveLength(3);
    act(() => {
      result.current.removeStep(ids[1]);
    });
    expect(result.current.drafts).toHaveLength(2);
    expect(result.current.drafts.map((d) => d.draftId)).toEqual([ids[0], ids[2]]);
  });

  it('moveStepUp / moveStepDown reorder and no-op at the boundary', () => {
    const { result } = renderHook(() => useChainDrafts());
    const ids: string[] = [];
    act(() => {
      ids.push(result.current.addStep('gif-resize'));
      ids.push(result.current.addStep('crop'));
      ids.push(result.current.addStep('gif-optimize'));
    });
    // Boundary: moving the top step up is a no-op.
    act(() => {
      result.current.moveStepUp(ids[0]);
    });
    expect(result.current.drafts.map((d) => d.draftId)).toEqual([ids[0], ids[1], ids[2]]);

    // Boundary: moving the last step down is a no-op.
    act(() => {
      result.current.moveStepDown(ids[2]);
    });
    expect(result.current.drafts.map((d) => d.draftId)).toEqual([ids[0], ids[1], ids[2]]);

    // Move middle up.
    act(() => {
      result.current.moveStepUp(ids[1]);
    });
    expect(result.current.drafts.map((d) => d.draftId)).toEqual([ids[1], ids[0], ids[2]]);

    // Move the now-middle step down.
    act(() => {
      result.current.moveStepDown(ids[0]);
    });
    expect(result.current.drafts.map((d) => d.draftId)).toEqual([ids[1], ids[2], ids[0]]);
  });

  it('clear() empties the draft list', () => {
    const { result } = renderHook(() => useChainDrafts('crop'));
    act(() => {
      result.current.addStep('gif-resize');
    });
    expect(result.current.drafts).toHaveLength(2);
    act(() => {
      result.current.clear();
    });
    expect(result.current.drafts).toEqual([]);
    expect(result.current.allValid).toBe(false);
  });

  it('allValid: empty=false, any-invalid=false, all-valid=true', () => {
    const { result } = renderHook(() => useChainDrafts());
    expect(result.current.allValid).toBe(false);

    let resizeId = '';
    act(() => {
      resizeId = result.current.addStep('gif-resize');
      result.current.addStep('crop');
    });
    // gif-resize starts invalid (no targetWidth) → allValid false.
    expect(result.current.allValid).toBe(false);

    act(() => {
      result.current.updateStep(resizeId, { targetWidth: 128 });
    });
    expect(result.current.allValid).toBe(true);
  });

  it('crop step is valid with empty params (pausing kind)', () => {
    const { result } = renderHook(() => useChainDrafts());
    act(() => {
      result.current.addStep('crop');
    });
    expect(result.current.drafts[0].kind).toBe('crop');
    expect(result.current.drafts[0].params).toEqual({});
    expect(result.current.drafts[0].valid).toBe(true);
    expect(result.current.allValid).toBe(true);
  });
});
