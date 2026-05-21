/**
 * usePreviewState — co-locates the three pieces of "preview modal"
 * state that previously lived as siblings near the top of App.tsx:
 *
 *   - `preview` (`PreviewResult | null`) — last preview render result,
 *     reset to null when (a) a different media is opened, (b) the
 *     modal is closed, or (c) the start of a new `onPreview()` call.
 *   - `previewing` (`boolean`)            — true while a preview render
 *     is in flight; flipped to false when the matching `previewReqId`
 *     resolves / rejects.
 *   - `previewOverride` (`PreviewOverride`) — per-modal-session crop
 *     and time-range override. Lives outside the global `options`
 *     state so opening the preview modal can never leak its
 *     auto-defaults into the next batch run. Reset to `{}` on modal
 *     close (and re-seeded by PreviewModal's `useEffect[media.id]`
 *     when the user switches media within the modal).
 *
 * Why bundle them
 * ---------------
 * The three pieces transition together:
 *   - "open card" / "close modal"  → setPreview(null) (+ override
 *     reset on close).
 *   - new preview run              → setPreviewing(true) +
 *     setPreview(null) → setPreview(result) + setPreviewing(false).
 *   - sniff lifecycle              → setPreview(null) at every state
 *     transition that swaps the active result (so a stale preview
 *     can't render against a freshly-sniffed media list).
 *
 * Pulling them into one hook lets future readers see the contract at a
 * glance and keeps App.tsx free of three near-adjacent useState
 * declarations whose only difference is which slice of the modal they
 * back. The hook owns just the state — the orchestration (the
 * `onPreview` callback, the closeModal handler) stays in App.tsx
 * because it cuts across `activeMedia`, `options`, `outputDir`,
 * `previewReqId` and the `giftk.preview` IPC; that's App-level
 * coordination, not preview-state ownership.
 *
 * Stable identities
 * -----------------
 * The setters returned from `useState` are reference-stable across
 * renders, so consumers (useSniffSession, ModalsHost) that capture
 * `setPreview` once during render keep working without any
 * `useCallback` wrapping.
 */
import { useState } from 'react';
import type { PreviewResult } from '../../shared/types';
import type { PreviewOverride } from './PreviewModal';

export interface PreviewStateApi {
  preview: PreviewResult | null;
  setPreview: React.Dispatch<React.SetStateAction<PreviewResult | null>>;
  previewing: boolean;
  setPreviewing: React.Dispatch<React.SetStateAction<boolean>>;
  previewOverride: PreviewOverride;
  setPreviewOverride: React.Dispatch<React.SetStateAction<PreviewOverride>>;
}

/**
 * Owns the preview modal's transient state triplet
 * (`preview` / `previewing` / `previewOverride`). See file docblock for
 * the reset contract.
 */
export function usePreviewState(): PreviewStateApi {
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  // P1.2 — per-preview-session crop / time-range overrides. Lives entirely
  // outside the global `options` state so that just opening the preview modal
  // (or letting onLoadedMetadata auto-set a default time window) cannot leak
  // into the next batch run. Reset on every media switch by PreviewModal.
  const [previewOverride, setPreviewOverride] = useState<PreviewOverride>({});
  return {
    preview,
    setPreview,
    previewing,
    setPreviewing,
    previewOverride,
    setPreviewOverride
  };
}
