/**
 * R-TB-CHAIN-V2 Phase 2.1 — useToolboxLineage.
 *
 * Why this exists (and how it differs from the reverted v1)
 * --------------------------------------------------------
 * The first attempt at the chain feature modeled it as "user
 * pre-configures N steps then submits as one batch with optional
 * pause-at-step", which mismatched the user's actual mental model:
 * they want to perform ONE step, *see the result*, and only then
 * decide what comes next, like ezgif's "edit this gif further" flow.
 *
 * useToolboxLineage owns the renderer-side state for that
 * progressive flow:
 *
 *   1. The lineage starts as a single root node holding the
 *      original input path (kind=null, params={}).
 *   2. The user picks a kind (e.g. 'gif-resize') with parameters
 *      and calls runNextStep(kind, params); the hook fires a
 *      single-step `startToolboxChain` IPC, listens on the global
 *      `process:progress` channel for that chainId's terminal
 *      emit, and appends a new LineageNode pointing at the produced
 *      artifact.
 *   3. The user can step backwards by calling focusNode(prevId);
 *      the next runNextStep then *branches* off that earlier node
 *      and discards the abandoned tail (linear breadcrumb model
 *      per the V2 spec — no tree visualisation in MVP).
 *   4. nextKindOptions is derived from the focus node's path
 *      extension matched against TOOLBOX_INPUT_EXTENSIONS, so the
 *      UI can render only chips that can actually consume the
 *      current artifact (e.g. video-to-* doesn't appear when the
 *      focus is already a .gif).
 *
 * Crop pause-at-step is intentionally NOT used here. In the
 * progressive model, the user already chose "Crop" deliberately
 * before runNextStep; the renderer collects the rect via the same
 * CropBox the batch path uses and passes it inline as params. The
 * underlying main-process pause logic stays available for the
 * legacy IPC contract but the renderer never triggers it.
 *
 * Concurrency
 * -----------
 * Only one runNextStep can be in-flight at a time; the hook
 * rejects subsequent calls with a clear "step already running"
 * error so the UI can disable the chips while a run is queued.
 * This matches the "look at result before choosing next" workflow
 * — running two steps in parallel would invalidate the lineage
 * concept anyway.
 *
 * Failure handling
 * ----------------
 * - When the IPC call rejects synchronously (e.g.
 *   validateChainCompatibility veto on a video kind against a
 *   .gif focus), `error` is set and `runNextStep` rejects with
 *   the same Error.
 * - When a step fails post-start, the terminal progress emit's
 *   error/errorCode are surfaced through `error` and the
 *   returned promise rejects. The lineage is NOT mutated — the
 *   user can simply pick a different kind/params and try again
 *   from the same focus node.
 * - cancel() walks the in-flight chainId through the existing
 *   `toolbox:cancelChain` IPC; the awaiting `runNextStep`
 *   rejects with a 'cancelled' message. Like the failure path
 *   above, no node is appended.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ToolboxKind,
  ToolboxParams,
  TaskProgress
} from '../../shared/types';
import { TOOLBOX_INPUT_EXTENSIONS } from '../../shared/types/toolbox';

export interface LineageNode {
  /** Stable identifier within this lineage instance. The first
   *  node is always 'root'; derived nodes use 'n1', 'n2', ... in
   *  arrival order so URL-style breadcrumbs are easy to encode. */
  nodeId: string;
  /** Absolute filesystem path. Root = original input; derived
   *  nodes = produced artifact (gif/webp/mp4 depending on kind). */
  path: string;
  /** Kind that produced this node. null only for the root. */
  kind: ToolboxKind | null;
  /** Snapshot of the params used at this step. {} for root. */
  params: ToolboxParams;
  /** chainId of the IPC call that produced this node. null for root. */
  chainId: string | null;
}

export interface UseToolboxLineageResult {
  nodes: readonly LineageNode[];
  focusIndex: number;
  /** Convenience accessor for `nodes[focusIndex]`. null only when
   *  the lineage has not been initialised (reset never called). */
  focus: LineageNode | null;
  /** True iff a runNextStep call is mid-flight. */
  isRunning: boolean;
  /** Last error message; cleared by reset/runNextStep/cancel. */
  error: string | null;
  /** Initialise (or re-initialise) the lineage from a single input
   *  path. Drops any previous nodes/error/in-flight state — caller
   *  must wait for cancel() before reset() if a run is queued. */
  reset: (inputPath: string) => void;
  /** Move focus to nodeId. Branching from a non-tail focus drops
   *  the abandoned tail (linear breadcrumb model). When the user
   *  clicks the current focus this is a no-op. */
  focusNode: (nodeId: string) => void;
  /** Run a single step from `nodes[focusIndex]`. Resolves with the
   *  appended node on 'done'; rejects on failure / cancel. */
  runNextStep: (kind: ToolboxKind, params: ToolboxParams) => Promise<LineageNode>;
  /** Cancel the in-flight step. No-op when idle. */
  cancel: () => Promise<void>;
  /** Compatible next-step kinds for the current focus, derived
   *  from the focus path's extension via TOOLBOX_INPUT_EXTENSIONS. */
  nextKindOptions: readonly ToolboxKind[];
  /** Latest non-terminal `process:progress` event for the in-flight
   *  step, or null when idle. The lineage modal renders this as a
   *  inline progress bar with status badge + secondary text, mirroring
   *  the home-page TaskTable. Cleared on done/failed/cancel/reset. */
  currentProgress: TaskProgress | null;
}

interface ToolboxBridge {
  startToolboxChain(payload: {
    chainId: string;
    inputPath: string;
    steps: Array<{ id: string; kind: ToolboxKind; params: ToolboxParams }>;
    outputDirOverride?: string;
  }): Promise<{ ok: boolean; chainId: string; outputDir: string }>;
  cancelToolboxChain(chainId: string): Promise<{ ok: boolean }>;
  resumeToolboxChain(
    chainId: string,
    stepIndex: number,
    paramsPatch: Partial<ToolboxParams>
  ): Promise<{ ok: boolean }>;
  onProgress(cb: (p: TaskProgress) => void): () => void;
}

function getBridge(): ToolboxBridge {
  const w = window as unknown as { giftk?: ToolboxBridge };
  if (!w.giftk) throw new Error('toolbox lineage: window.giftk preload bridge missing');
  return w.giftk;
}

function makeChainId(): string {
  return `tblineage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Lowercase extension including dot, or '' when path has none. */
function extOf(p: string): string {
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  const base = slash >= 0 ? p.slice(slash + 1) : p;
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot).toLowerCase() : '';
}

/** Compute kinds whose TOOLBOX_INPUT_EXTENSIONS includes the given ext. */
function deriveNextKinds(focusPath: string | null): ToolboxKind[] {
  if (!focusPath) return [];
  const ext = extOf(focusPath);
  if (!ext) return [];
  const out: ToolboxKind[] = [];
  for (const k of Object.keys(TOOLBOX_INPUT_EXTENSIONS) as ToolboxKind[]) {
    if (TOOLBOX_INPUT_EXTENSIONS[k].includes(ext)) out.push(k);
  }
  return out;
}

export function useToolboxLineage(): UseToolboxLineageResult {
  const [nodes, setNodes] = useState<LineageNode[]>([]);
  const [focusIndex, setFocusIndex] = useState<number>(-1);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  // R-COMPRESS-V1 #4 follow-up — capture the running progress so the
  // ToolboxLineageModal can render a real progress bar + status text
  // identical to the home-page TaskTable. Previously the modal only
  // rendered "处理中…" inside the primary button which made long
  // video-to-gif chains feel like the app had hung. Cleared whenever
  // the in-flight step terminates (done/failed/cancelled) or the
  // lineage is reset.
  const [currentProgress, setCurrentProgress] = useState<TaskProgress | null>(null);

  // chainId of the in-flight runNextStep, used by cancel() to
  // address the right IPC and by the progress listener to ignore
  // unrelated chain emits (other panels / batch pipeline).
  const inflightChainIdRef = useRef<string | null>(null);
  // Counter for derived node ids (n1, n2, ...). Reset on reset().
  const nextIdCounterRef = useRef<number>(0);
  // Stable ref to nodes[] for the global progress listener — useState
  // closure would otherwise capture a stale slice.
  const nodesRef = useRef<LineageNode[]>([]);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  // Same trick for focusIndex — runNextStep needs the latest value
  // when it appends, but the closure captured by the IPC promise
  // resolves AFTER React has potentially re-rendered.
  const focusIndexRef = useRef<number>(-1);
  useEffect(() => { focusIndexRef.current = focusIndex; }, [focusIndex]);

  // Pending step descriptor; used by the progress listener to know
  // which terminal emit to act on and which promise to settle.
  type PendingStep = {
    chainId: string;
    kind: ToolboxKind;
    params: ToolboxParams;
    branchFromIndex: number;
    resolve: (n: LineageNode) => void;
    reject: (err: Error) => void;
  };
  const pendingRef = useRef<PendingStep | null>(null);

  const reset = useCallback((inputPath: string): void => {
    // Issue R1/R6 — if a step is still in-flight (caller violated the
    // "cancel first" contract), fire-and-forget cancelToolboxChain so
    // the main process doesn't keep churning out an orphaned artifact.
    const stragglerChainId = inflightChainIdRef.current;
    const stragglerPending = pendingRef.current;
    inflightChainIdRef.current = null;
    pendingRef.current = null;
    if (stragglerChainId) {
      try {
        const bridge = getBridge();
        void bridge.cancelToolboxChain(stragglerChainId).catch(() => { /* best-effort */ });
      } catch { /* no bridge — test env */ }
    }
    if (stragglerPending) {
      stragglerPending.reject(new Error('lineage reset: in-flight step abandoned'));
    }
    setNodes([{ nodeId: 'root', path: inputPath, kind: null, params: {}, chainId: null }]);
    setFocusIndex(0);
    setIsRunning(false);
    setError(null);
    setCurrentProgress(null);
    nextIdCounterRef.current = 0;
  }, []);

  const focusNode = useCallback((nodeId: string): void => {
    setNodes((prev) => {
      const idx = prev.findIndex((n) => n.nodeId === nodeId);
      if (idx < 0) return prev;
      setFocusIndex(idx);
      return prev;
    });
  }, []);

  const cancel = useCallback(async (): Promise<void> => {
    // Issue R6 — snapshot and clear refs synchronously BEFORE awaiting
    // the IPC. This way any progress emit that arrives during the
    // await is filtered out at the listener's `if (!pending) return`
    // gate, so the chain can't append a node we've decided to abandon.
    const id = inflightChainIdRef.current;
    const pending = pendingRef.current;
    if (!id) return;
    inflightChainIdRef.current = null;
    pendingRef.current = null;
    setIsRunning(false);
    setCurrentProgress(null);
    try {
      const bridge = getBridge();
      await bridge.cancelToolboxChain(id);
    } catch {
      // best-effort
    }
    if (pending) {
      pending.reject(new Error('cancelled'));
    }
  }, []);

  // Single global subscription — one listener per hook instance,
  // filters by inflightChainIdRef so stray emits from elsewhere are
  // ignored. Mounted lazily on first render and torn down on unmount.
  useEffect(() => {
    let bridge: ToolboxBridge;
    try {
      bridge = getBridge();
    } catch {
      // No bridge (e.g. test env without preload mock) — caller will
      // see runNextStep fail with the same error when invoked.
      return;
    }
    const off = bridge.onProgress((p: TaskProgress) => {
      const pending = pendingRef.current;
      if (!pending) return;
      // Issue R7 — chain runner emits taskId === stepId === `${chainId}-s1`
      // exactly. Use strict equality instead of startsWith so a longer
      // chainId that happens to share a prefix can't ever be misrouted.
      if (typeof p.taskId !== 'string') return;
      if (p.taskId !== `${pending.chainId}-s1`) return;
      const status = p.status;
      if (status === 'done') {
        const out = (p.outputs ?? [])[0];
        if (!out) {
          pending.reject(new Error('done emit had no outputs'));
          pendingRef.current = null;
          inflightChainIdRef.current = null;
          setIsRunning(false);
          setCurrentProgress(null);
          setError('done emit had no outputs');
          return;
        }
        nextIdCounterRef.current += 1;
        const newNode: LineageNode = {
          nodeId: `n${nextIdCounterRef.current}`,
          path: out,
          kind: pending.kind,
          params: pending.params,
          chainId: pending.chainId
        };
        setNodes((prev) => {
          // Branch from pending.branchFromIndex: drop everything
          // after that index, then append the new node.
          const head = prev.slice(0, pending.branchFromIndex + 1);
          return [...head, newNode];
        });
        setFocusIndex(pending.branchFromIndex + 1);
        setIsRunning(false);
        setCurrentProgress(null);
        inflightChainIdRef.current = null;
        pendingRef.current = null;
        pending.resolve(newNode);
      } else if (status === 'failed' || status === 'cancelled') {
        const msg = p.error ?? `step ${status}`;
        pending.reject(new Error(msg));
        pendingRef.current = null;
        inflightChainIdRef.current = null;
        setIsRunning(false);
        setCurrentProgress(null);
        setError(msg);
      } else if (status === 'awaiting-input') {
        // R-TB-CHAIN-LINEAGE-RESUME-V1 — the main-process chain runner
        // pauses on PAUSING_KINDS (currently just 'crop') and waits for
        // a follow-up `toolbox:resumeChain` IPC carrying the rect.
        //
        // The lineage modal is a single-step driver: by the time the
        // user clicks "处理", the cropX/Y/W/H have already been baked
        // into the params we sent to startToolboxChain. There is no
        // additional UI gate to clear, so just resume immediately with
        // an empty patch (params already complete) and unblock ffmpeg.
        //
        // Without this hop the modal sits forever at 0% / "awaiting-
        // input" while the user thinks the app froze.
        const pendingChainId = pending.chainId;
        let bridge2: ToolboxBridge | null = null;
        try { bridge2 = getBridge(); } catch { bridge2 = null; }
        if (bridge2) {
          // stepIndex on the wire is 1-based for humans; the resume IPC
          // expects 0-based. Lineage chains are always 1 step long, so
          // 0 is correct regardless of what the wire says, but keep the
          // payload defensive in case that invariant ever loosens.
          const wireIdx = typeof p.stepIndex === 'number' ? p.stepIndex : 1;
          const zeroBased = Math.max(0, wireIdx - 1);
          bridge2.resumeToolboxChain(pendingChainId, zeroBased, {}).catch((err) => {
            // Surface the resume failure as a step-level error so the
            // modal stops spinning instead of pretending the work is
            // still progressing.
            const msg = err instanceof Error ? err.message : String(err);
            const cur = pendingRef.current;
            if (cur && cur.chainId === pendingChainId) {
              cur.reject(new Error(`resume failed: ${msg}`));
              pendingRef.current = null;
            }
            if (inflightChainIdRef.current === pendingChainId) {
              inflightChainIdRef.current = null;
            }
            setIsRunning(false);
            setCurrentProgress(null);
            setError(`resume failed: ${msg}`);
          });
        }
        // Keep the (stalled) progress visible until ffmpeg starts
        // actually emitting non-zero percents.
        setCurrentProgress(p);
      } else {
        // Intermediate status (downloading / probing / segmenting /
        // converting / compressing / pending). Store the latest snapshot
        // so the modal can render a real progress bar + secondary text.
        // We store the entire TaskProgress object so the modal can pull
        // percent / message / substep / stepIndex / segmentIndex /
        // currentSizeMB / elapsedMs without coupling to the schema here.
        setCurrentProgress(p);
      }
    });
    return () => { off(); };
  }, []);

  const runNextStep = useCallback(
    async (kind: ToolboxKind, params: ToolboxParams): Promise<LineageNode> => {
      if (pendingRef.current) {
        const e = new Error('step already running');
        setError(e.message);
        throw e;
      }
      const focus = nodesRef.current[focusIndexRef.current];
      if (!focus) {
        const e = new Error('lineage not initialised: call reset(inputPath) first');
        setError(e.message);
        throw e;
      }
      const branchFromIndex = focusIndexRef.current;
      const chainId = makeChainId();
      const stepId = `${chainId}-s1`;
      setError(null);
      setIsRunning(true);
      setCurrentProgress(null);
      inflightChainIdRef.current = chainId;
      // Issue R5 — keep local references to the promise reject + the
      // pending entry so the synchronous-IPC-failure path doesn't have
      // to re-read pendingRef (which the listener might have already
      // cleared) and doesn't need the unsound `as unknown as` cast.
      //
      // R-TB-CHAIN-V2.6 — explicit type annotation on `localReject`:
      // TypeScript's CFA does NOT know that the Promise constructor
      // callback runs synchronously, so it narrows `localReject` to
      // `null` for the entire `catch` block. The annotation widens it
      // to the full union, mirroring the actual runtime shape.
      let localReject: ((e: Error) => void) | null = null;
      const promise = new Promise<LineageNode>((resolve, reject) => {
        localReject = reject as (e: Error) => void;
        pendingRef.current = {
          chainId,
          kind,
          params,
          branchFromIndex,
          resolve,
          reject
        };
      });
      try {
        const bridge = getBridge();
        await bridge.startToolboxChain({
          chainId,
          inputPath: focus.path,
          steps: [{ id: stepId, kind, params }]
        });
      } catch (err) {
        // Synchronous IPC rejection (e.g. compatibility veto).
        const e = err instanceof Error ? err : new Error(String(err));
        // Only clear the pending entry if it's still ours — the listener
        // may have raced and already settled the same chainId for some
        // reason; in that case we just bubble the error out without
        // double-rejecting.
        const pending = pendingRef.current as PendingStep | null;
        if (pending && pending.chainId === chainId) {
          pendingRef.current = null;
        }
        if (inflightChainIdRef.current === chainId) {
          inflightChainIdRef.current = null;
        }
        setIsRunning(false);
        setCurrentProgress(null);
        setError(e.message);
        const reject = localReject as ((e: Error) => void) | null;
        if (reject) reject(e);
        throw e;
      }
      return promise;
    },
    []
  );

  const focus = focusIndex >= 0 && focusIndex < nodes.length ? nodes[focusIndex] : null;
  const nextKindOptions = useMemo(
    () => deriveNextKinds(focus ? focus.path : null),
    [focus]
  );

  return {
    nodes,
    focusIndex,
    focus,
    isRunning,
    error,
    reset,
    focusNode,
    runNextStep,
    cancel,
    nextKindOptions,
    currentProgress
  };
}
