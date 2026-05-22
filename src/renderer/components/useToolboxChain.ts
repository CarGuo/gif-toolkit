/**
 * R-TB-CHAIN Phase 2.1 — useToolboxChain.
 *
 * Companion hook to [useToolbox.ts](./useToolbox.ts). Whereas
 * useToolbox owns the *batch* (PQueue) lane — N inputs × 1 kind, no
 * pauses — this hook owns the *single-input multi-step chain* lane:
 * one inputPath, ≥1 ChainStepDraft entries that may include a crop
 * step, and an awaiting-input pause window in the middle.
 *
 * The two hooks deliberately stay independent (no shared mutable
 * state). The Toolbox panel layer decides which one to render based
 * on [ToolboxMode](../../shared/types/toolbox.ts#L314-L314); the user
 * cannot run both lanes simultaneously, so cross-coupling via shared
 * isRunning flags is unnecessary.
 *
 * Listener strategy
 * -----------------
 * Both hooks subscribe to the same `process:progress` IPC channel.
 * To avoid promoting unrelated batch progress events into chain
 * state (and vice versa), this hook filters by `taskId` against the
 * step ids it allocated at start() time, mirroring the
 * `ownedIdsRef` pattern in useToolbox. Chain step ids are
 * deterministic (`${chainId}-s${i+1}`) so the filter is exact.
 *
 * Settled vs in-flight statuses
 * -----------------------------
 * The chain runner emits 'awaiting-input' as an in-flight status
 * (never persisted to history; see TB-CHAIN-C). The hook surfaces it
 * through the dedicated `awaitingInput` field, NOT through the
 * generic `progress[id]` map, so the UI can branch cleanly between
 * "show pause modal" vs "show running spinner" without scanning
 * progress events.
 *
 * Failure mode
 * ------------
 * - IPC reject on start: returns `{ ok: false, error }`, never
 *   throws to the panel.
 * - Per-step failure: chain runner emits status='failed' with an
 *   error string and aborts the chain; the hook records both the
 *   step error and the chain-level error for the UI.
 * - Cancel: the hook calls cancelToolboxChain and trusts the runner
 *   to settle progress to 'cancelled'; no client-side timeout
 *   guards (matches the ergonomics of useToolbox.cancel).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChainStepDraft,
  TaskProgress,
  ToolboxChainStep,
  ToolboxParams
} from '../../shared/types';

/** Per-step view used by the panel. Carries the latest progress event
 *  for the step plus a normalised "did this step settle" flag so
 *  ChainStep doesn't have to know about TaskStatus details. */
export interface ChainStepView {
  /** Mirrors the step's IPC id (i.e. progress.taskId). Distinct from
   *  the draft's React-key id. */
  id: string;
  draftId: string;
  kind: ChainStepDraft['kind'];
  params: ToolboxParams;
  /** Latest progress event for this step. Undefined before the
   *  runner reaches the step. */
  progress: TaskProgress | undefined;
  /** True once this step has reached a settled status
   *  (done/failed/cancelled/skipped). Note: 'awaiting-input' is NOT
   *  settled. */
  settled: boolean;
}

/** Pending pause-resume window. Set when the runner emits
 *  'awaiting-input' for a pausing kind (today: only crop); cleared
 *  on resume / cancel. */
export interface ChainAwaitingInput {
  /** stepIndex from the progress event (1-based, matching emit). */
  stepIndex: number;
  totalSteps: number;
  /** The IPC step id, also the progress.taskId. Equals
   *  `${chainId}-s${stepIndex}`. */
  stepId: string;
  /** Latest input path the runner is asking the user to crop on
   *  (the previous step's primary output). Undefined for chains
   *  whose first step pauses. */
  previousOutput: string | undefined;
}

export interface UseToolboxChainResult {
  /** Active chainId, or null when no chain has been started yet
   *  (or after `reset()`). */
  chainId: string | null;
  /** Per-step view, in the order the user composed them. Empty
   *  before start(). */
  steps: ChainStepView[];
  /** Output directory the runner allocated. Populated synchronously
   *  by the start() return value. */
  outputDir: string | null;
  /** True between start() and the chain settling (done/failed/
   *  cancelled). 'awaiting-input' is still "running" from the user's
   *  POV — work is in flight, just paused. */
  isRunning: boolean;
  /** Final chain status. Mirrors the chain runner's terminal
   *  status; null while the chain is still running. */
  finalStatus: 'done' | 'failed' | 'cancelled' | null;
  /** First-failure error string (chain-level). */
  error: string | null;
  /** Pause window when the runner is waiting for renderer input.
   *  null when the chain is not paused. */
  awaitingInput: ChainAwaitingInput | null;
  /**
   * Submit a chain. Allocates step ids, ownership ref, and
   * subscribes to progress filtering. Resolves with the runner's
   * outputDir on success, or { ok:false, error } on IPC failure.
   * Calling start() while another chain is in flight returns an
   * error (the panel UI is responsible for not getting into that
   * state, but defending here keeps invariants).
   */
  start: (args: {
    inputPath: string;
    drafts: ChainStepDraft[];
  }) => Promise<{ ok: boolean; chainId?: string; outputDir?: string; error?: string }>;
  /**
   * Resolve the awaiting-input pause with a sanitised crop rect (or
   * any future pausing-kind patch). The chainId/stepIndex come from
   * the awaitingInput field; callers only supply the patch.
   * Resolves with the IPC result; if no pause is currently active,
   * resolves { ok:false, error } without invoking IPC.
   */
  resume: (paramsPatch: Partial<ToolboxParams>) => Promise<{ ok: boolean; error?: string }>;
  /** Cancel the running chain. No-op when no chain is active. */
  cancel: () => Promise<void>;
  /** Reset hook state back to "no chain". Does NOT cancel a running
   *  chain — call `cancel()` first. */
  reset: () => void;
}

/** Statuses the chain runner uses to mark a step as fully settled.
 *  'awaiting-input' is intentionally NOT in this set so the step
 *  view's `settled` flag stays false during the pause window. */
const SETTLED_STATUSES: ReadonlySet<TaskProgress['status']> = new Set([
  'done',
  'failed',
  'cancelled',
  'skipped'
]);

function genChainId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `chain_${t}_${r}`;
}

function stepIdFor(chainId: string, indexZeroBased: number): string {
  return `${chainId}-s${indexZeroBased + 1}`;
}

export function useToolboxChain(): UseToolboxChainResult {
  const [chainId, setChainId] = useState<string | null>(null);
  const [steps, setSteps] = useState<ChainStepView[]>([]);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [finalStatus, setFinalStatus] =
    useState<'done' | 'failed' | 'cancelled' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [awaitingInput, setAwaitingInput] = useState<ChainAwaitingInput | null>(null);

  // Owned step id set; events whose taskId is not in this set belong
  // to a different lane (batch hook, home tab, …) and must be ignored.
  const ownedIdsRef = useRef<Set<string>>(new Set());
  // Active chainId mirror so the progress listener (registered once)
  // can resolve "is this event mine" without re-subscribing on every
  // chainId change.
  const chainIdRef = useRef<string | null>(null);
  chainIdRef.current = chainId;
  // Synchronous mirror of isRunning, checked at the top of start() so
  // a second invocation racing the first (before React commits the
  // setIsRunning(true) from #1) still sees the in-flight chain.
  // Without this, useCallback's closed-over `isRunning` value is
  // stale and the guard misfires.
  const isRunningRef = useRef<boolean>(false);
  // Total step count mirror, used by the listener to decide whether
  // a 'done'/'failed' event marks the chain's terminal step.
  const totalStepsRef = useRef<number>(0);
  // Mounted guard — protects the listener's setState calls against
  // late events that fire after unmount during StrictMode reuse.
  const mountedRef = useRef<boolean>(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** Apply one progress event to the steps array and the awaiting-
   *  input field. Pure-ish: only state setters cross the boundary. */
  const applyProgress = useCallback((p: TaskProgress): void => {
    if (!ownedIdsRef.current.has(p.taskId)) return;
    if (!mountedRef.current) return;

    // Update per-step view first.
    setSteps((prev) =>
      prev.map((s) =>
        s.id === p.taskId
          ? { ...s, progress: p, settled: SETTLED_STATUSES.has(p.status) }
          : s
      )
    );

    if (p.status === 'awaiting-input') {
      // The runner sets `outputs` to the previous step's output(s)
      // on the awaiting-input event so the renderer can paint a
      // crop preview without recomputing. Empty for first-step
      // pauses (no previous output exists).
      const prev = Array.isArray(p.outputs) && p.outputs.length > 0 ? p.outputs[0] : undefined;
      setAwaitingInput({
        stepIndex: p.stepIndex ?? 0,
        totalSteps: p.totalSteps ?? totalStepsRef.current,
        stepId: p.taskId,
        previousOutput: prev
      });
      return;
    }

    // Any non-pause event clears a pending pause window — either we
    // resumed (next event will be 'pending'/'converting'), failed
    // (next is 'failed'), or were cancelled.
    setAwaitingInput((prevPause) => (prevPause && prevPause.stepId === p.taskId ? null : prevPause));

    if (p.status === 'failed') {
      const msg = p.error || 'chain step failed';
      isRunningRef.current = false;
      setError(msg);
      setFinalStatus('failed');
      setIsRunning(false);
      return;
    }
    if (p.status === 'cancelled') {
      isRunningRef.current = false;
      setFinalStatus((cur) => cur ?? 'cancelled');
      setIsRunning(false);
      return;
    }
    if (p.status === 'done') {
      // Chain done = last step done. The runner's emit always
      // carries stepIndex + totalSteps; we trust them.
      const isLast =
        typeof p.stepIndex === 'number' &&
        typeof p.totalSteps === 'number' &&
        p.stepIndex === p.totalSteps;
      if (isLast) {
        isRunningRef.current = false;
        setFinalStatus('done');
        setIsRunning(false);
      }
    }
  }, []);

  // Subscribe once to the global progress channel; filtering is per
  // event via ownedIdsRef. Mirrors the useToolbox listener pattern.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.giftk) return;
    const off = window.giftk.onProgress((p) => {
      try {
        applyProgress(p);
      } catch (e) {
        // Swallow — progress events must never crash the renderer.
        // The error is intentionally ignored; reportDbError is for
        // DB-flavoured failures (which this isn't).
        void e;
      }
    });
    return () => {
      try {
        off();
      } catch {
        /* ignore */
      }
    };
  }, [applyProgress]);

  const reset = useCallback((): void => {
    isRunningRef.current = false;
    setChainId(null);
    setSteps([]);
    setOutputDir(null);
    setIsRunning(false);
    setFinalStatus(null);
    setError(null);
    setAwaitingInput(null);
    ownedIdsRef.current = new Set();
    totalStepsRef.current = 0;
  }, []);

  const start = useCallback(
    async (args: {
      inputPath: string;
      drafts: ChainStepDraft[];
    }): Promise<{ ok: boolean; chainId?: string; outputDir?: string; error?: string }> => {
      if (typeof window === 'undefined' || !window.giftk) {
        return { ok: false, error: 'giftk bridge unavailable' };
      }
      if (!args.inputPath) return { ok: false, error: 'inputPath required' };
      if (!Array.isArray(args.drafts) || args.drafts.length === 0) {
        return { ok: false, error: 'at least one chain step required' };
      }
      // Defend against double-start. The panel disables the Run
      // button while isRunning, but the hook owns the invariant.
      if (isRunningRef.current) {
        return { ok: false, error: 'a chain is already running' };
      }

      const newChainId = genChainId();
      const ipcSteps: ToolboxChainStep[] = args.drafts.map((d, i) => ({
        id: stepIdFor(newChainId, i),
        kind: d.kind,
        params: d.params
      }));
      const view: ChainStepView[] = args.drafts.map((d, i) => ({
        id: stepIdFor(newChainId, i),
        draftId: d.draftId,
        kind: d.kind,
        params: d.params,
        progress: undefined,
        settled: false
      }));

      ownedIdsRef.current = new Set(ipcSteps.map((s) => s.id));
      totalStepsRef.current = ipcSteps.length;
      isRunningRef.current = true;
      setChainId(newChainId);
      setSteps(view);
      setOutputDir(null);
      setFinalStatus(null);
      setError(null);
      setAwaitingInput(null);
      setIsRunning(true);

      try {
        const res = await window.giftk.startToolboxChain({
          chainId: newChainId,
          inputPath: args.inputPath,
          steps: ipcSteps
        });
        if (!res || res.ok !== true) {
          // Defensive: the IPC contract says this resolves with ok=true
          // on success and rejects on failure, but a future bridge
          // change could regress to the { ok:false } shape.
          const msg = 'startToolboxChain returned ok=false';
          isRunningRef.current = false;
          setError(msg);
          setFinalStatus('failed');
          setIsRunning(false);
          return { ok: false, error: msg };
        }
        setOutputDir(res.outputDir);
        return { ok: true, chainId: res.chainId, outputDir: res.outputDir };
      } catch (e) {
        const msg = (e as Error).message || String(e);
        isRunningRef.current = false;
        setError(msg);
        setFinalStatus('failed');
        setIsRunning(false);
        return { ok: false, error: msg };
      }
    },
    []
  );

  const resume = useCallback(
    async (paramsPatch: Partial<ToolboxParams>): Promise<{ ok: boolean; error?: string }> => {
      if (typeof window === 'undefined' || !window.giftk) {
        return { ok: false, error: 'giftk bridge unavailable' };
      }
      const pause = awaitingInput;
      const id = chainIdRef.current;
      if (!pause || !id) {
        return { ok: false, error: 'no chain awaiting input' };
      }
      // The IPC stepIndex is 0-based (the chain runner stored
      // `pause.stepIndex = i`), while the awaiting-input emit's
      // stepIndex is 1-based. Translate at the bridge boundary so
      // the panel never has to care.
      const zeroBased = pause.stepIndex - 1;
      try {
        const res = await window.giftk.resumeToolboxChain(id, zeroBased, paramsPatch);
        if (!res || res.ok !== true) {
          return { ok: false, error: 'resumeToolboxChain returned ok=false' };
        }
        // Optimistically clear the pause; the runner will emit
        // 'pending' for the same step shortly which keeps state in
        // sync.
        setAwaitingInput(null);
        return { ok: true };
      } catch (e) {
        const msg = (e as Error).message || String(e);
        return { ok: false, error: msg };
      }
    },
    [awaitingInput]
  );

  const cancel = useCallback(async (): Promise<void> => {
    if (typeof window === 'undefined' || !window.giftk) return;
    const id = chainIdRef.current;
    if (!id) return;
    try {
      await window.giftk.cancelToolboxChain(id);
    } finally {
      isRunningRef.current = false;
      setIsRunning(false);
      setFinalStatus((cur) => cur ?? 'cancelled');
      setAwaitingInput(null);
    }
  }, []);

  return {
    chainId,
    steps,
    outputDir,
    isRunning,
    finalStatus,
    error,
    awaitingInput,
    start,
    resume,
    cancel,
    reset
  };
}
