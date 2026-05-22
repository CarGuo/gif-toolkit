/**
 * R-TB-CHAIN Phase 2 — useChainDrafts.
 *
 * Owns the renderer-side ChainStepDraft[] list that ToolboxPanel feeds
 * to useToolboxChain when the user submits a chain run. Kept as a
 * standalone hook (no IPC, no progress) so it stays trivially testable
 * with happy-dom + renderHook and so the panel can compose it with
 * useToolboxChain without either side leaking state into the other.
 *
 * Validity is delegated to isChainStepDraftValid from
 * shared/types/toolbox: pausing kinds (crop) are always valid because
 * the chain runner asks for the missing rect via the awaiting-input
 * flow, while gif-resize / gif-optimize have explicit per-field rules.
 */
import { useCallback, useMemo, useState } from 'react';
import type {
  ChainStepDraft,
  ToolboxKind,
  ToolboxParams
} from '../../shared/types';
import { isChainStepDraftValid } from '../../shared/types/toolbox';

export interface UseChainDraftsResult {
  drafts: ChainStepDraft[];
  /** Append a new step with the given kind and empty params. Returns the new draftId. */
  addStep: (kind: ToolboxKind) => string;
  /** Remove step by draftId. Allows removing the last step (caller decides whether to disable Run). */
  removeStep: (draftId: string) => void;
  /** Update params for one step. Recomputes `valid` via isChainStepDraftValid. */
  updateStep: (draftId: string, patch: Partial<ToolboxParams>) => void;
  /** Replace the whole params object for a step. Also recomputes `valid`. */
  setStepParams: (draftId: string, params: ToolboxParams) => void;
  /** Change a step's kind. Resets params to {}, recomputes `valid`. */
  setStepKind: (draftId: string, kind: ToolboxKind) => void;
  /** Move a step up (toward index 0). No-op when already at top. */
  moveStepUp: (draftId: string) => void;
  /** Move a step down (toward end). No-op when already at bottom. */
  moveStepDown: (draftId: string) => void;
  /** Drop all drafts. */
  clear: () => void;
  /** True iff drafts.length >= 1 AND every draft.valid === true. */
  allValid: boolean;
}

function makeDraftId(): string {
  return `draft_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildDraft(kind: ToolboxKind, params: ToolboxParams = {}): ChainStepDraft {
  return {
    draftId: makeDraftId(),
    kind,
    params,
    valid: isChainStepDraftValid(kind, params)
  };
}

export function useChainDrafts(initialKind?: ToolboxKind): UseChainDraftsResult {
  const [drafts, setDrafts] = useState<ChainStepDraft[]>(() =>
    initialKind ? [buildDraft(initialKind)] : []
  );

  const addStep = useCallback((kind: ToolboxKind): string => {
    const next = buildDraft(kind);
    setDrafts((prev) => [...prev, next]);
    return next.draftId;
  }, []);

  const removeStep = useCallback((draftId: string): void => {
    setDrafts((prev) => prev.filter((d) => d.draftId !== draftId));
  }, []);

  const updateStep = useCallback(
    (draftId: string, patch: Partial<ToolboxParams>): void => {
      setDrafts((prev) =>
        prev.map((d) => {
          if (d.draftId !== draftId) return d;
          const params: ToolboxParams = { ...d.params, ...patch };
          return { ...d, params, valid: isChainStepDraftValid(d.kind, params) };
        })
      );
    },
    []
  );

  const setStepParams = useCallback(
    (draftId: string, params: ToolboxParams): void => {
      setDrafts((prev) =>
        prev.map((d) =>
          d.draftId === draftId
            ? { ...d, params, valid: isChainStepDraftValid(d.kind, params) }
            : d
        )
      );
    },
    []
  );

  const setStepKind = useCallback((draftId: string, kind: ToolboxKind): void => {
    setDrafts((prev) =>
      prev.map((d) =>
        d.draftId === draftId
          ? { ...d, kind, params: {}, valid: isChainStepDraftValid(kind, {}) }
          : d
      )
    );
  }, []);

  const moveStepUp = useCallback((draftId: string): void => {
    setDrafts((prev) => {
      const i = prev.findIndex((d) => d.draftId === draftId);
      if (i <= 0) return prev;
      const next = prev.slice();
      [next[i - 1], next[i]] = [next[i], next[i - 1]];
      return next;
    });
  }, []);

  const moveStepDown = useCallback((draftId: string): void => {
    setDrafts((prev) => {
      const i = prev.findIndex((d) => d.draftId === draftId);
      if (i < 0 || i >= prev.length - 1) return prev;
      const next = prev.slice();
      [next[i], next[i + 1]] = [next[i + 1], next[i]];
      return next;
    });
  }, []);

  const clear = useCallback((): void => {
    setDrafts([]);
  }, []);

  const allValid = useMemo(
    () => drafts.length >= 1 && drafts.every((d) => d.valid === true),
    [drafts]
  );

  return {
    drafts,
    addStep,
    removeStep,
    updateStep,
    setStepParams,
    setStepKind,
    moveStepUp,
    moveStepDown,
    clear,
    allValid
  };
}
