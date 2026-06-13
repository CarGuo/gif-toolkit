import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  TaskProgress,
  PreviewResult,
  SniffedMedia,
  ResolvedMedia,
  UploadConfigs
} from '../shared/types';
import { type BatchSegmentEntry } from './components/BatchSegmentModal';
import {
  useHistory,
  makeHistoryRecord,
  type HistoryRecord
} from './components/useHistory';
import { useSniffHistory } from './components/useSniffHistory';
import { type ManualOptimizeRequest } from './components/ManualOptimizeModal';
import { useUploadHistory } from './components/useUploadHistory';
import { useToaster } from './components/Toast';
import { useWebviewMenu } from './components/useWebviewMenu';
import { useBottomResize } from './components/useBottomResize';
import { useEmbedResolve } from './components/useEmbedResolve';
import { useSniffSession } from './components/useSniffSession';
import { useSniffPanelController } from './components/useSniffPanelController';
import { useIpcEvents } from './components/useIpcEvents';
import { useUploadDispatch } from './components/useUploadDispatch';
import { useUploadOrchestrator } from './components/useUploadOrchestrator';
import { useProcessDispatch } from './components/useProcessDispatch';
import { useWorkspaces, type Workspace } from './components/useWorkspaces';
import { useBootstrapEffects } from './components/useBootstrapEffects';
import { useGlobalDropZone } from './components/useGlobalDropZone';
import { usePreviewState } from './components/usePreviewState';
import { WorkspaceTabs } from './components/WorkspaceTabs';
import { ModalsHost } from './views/ModalsHost';
import { TopBar } from './views/TopBar';
import { UpdateModal } from './components/UpdateModal';
import type { UpdateCheckResult, ToolboxKind, ToolboxParams } from '../shared/types';
import { SecondaryViews } from './views/SecondaryViews';
import { pickFirstDoneOutput } from './components/HistoryPanel';
import { SniffSection } from './views/SniffSection';
import { MediaGridPane } from './views/MediaGridPane';
import { OptionsSection } from './views/OptionsSection';
import { StartBatchFab } from './views/StartBatchFab';

const giftk = (typeof window !== 'undefined' ? window.giftk : undefined);

const SNIFF_TIMEOUT_MS = 60_000;

const App: React.FC = () => {
  // R-Workspaces — multi-tab session container. Each tab owns its own
  // (url, result, selected, options, progress, processingOne, logs,
  // sniffing, …) so flipping between two pending sniffs no longer
  // overwrites each other's state. The shim setters below preserve the
  // original `setX` call shape so the ~hundred existing call sites do
  // not need touching — they all forward to `ws.patchActive`, which
  // targets whichever tab the user is currently on.
  const ws = useWorkspaces();
  // Helper that builds a `setX`-shaped shim from a Workspace key. The
  // updater value can be either a raw value or a (prev) => next callback,
  // matching React's useState dispatcher contract. We deliberately do
  // NOT memoise these — the consumer hooks (useIpcEvents,
  // useUploadDispatch) mirror their deps in a ref so unstable
  // setter references do not trigger re-subscriptions.
  function makeWsSetter<K extends keyof Workspace>(key: K): React.Dispatch<React.SetStateAction<Workspace[K]>> {
    return (v) =>
      ws.patchActive((prev) => ({
        [key]: typeof v === 'function'
          ? (v as (p: Workspace[K]) => Workspace[K])(prev[key])
          : v
      } as Partial<Workspace>));
  }
  const url = ws.activeWs.url;
  const setUrl = makeWsSetter('url');
  // R-WS-90 P5 — SniffPanel-自治 state 现在由 useSniffPanelController
  // 持有(see [useSniffPanelController.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/useSniffPanelController.ts)).
  // 这 4 个 state 与 active workspace 没有耦合,搬到独立 hook 后
  // App.tsx 不再持有任何"嗅探侧" state,符合 spec §2.1。
  const sniffPanel = useSniffPanelController();
  const urlError = sniffPanel.urlError;
  const setUrlError = sniffPanel.setUrlError;
  // R-62 — Toaster for cross-platform capability issues + ad-hoc
  // notifications. The hook returns a stable `pushCapability`
  // imperative we wire into the bottom-right Toaster instance.
  const toaster = useToaster();
  // Step 11A — bootstrap-time side effects (legacy localStorage →
  // SQLite import + reload, dbErrorBus toast bridge, capability
  // probe, pre-quit flush ack) are now consolidated into
  // `useBootstrapEffects` and invoked once below (after the
  // family hooks supply `reload*` / `flushPending`). See
  // [useBootstrapEffects.ts] for the full R-80 / R-62 contract.
  const sniffing = ws.activeWs.sniffing;
  const setSniffing = makeWsSetter('sniffing');
  // R-WS-90 P5 — sniffProgress / activeSniffMode / useRealChromeProfile
  // 由 useSniffPanelController 持有(见上文 sniffPanel)。下面三组
  // 解构是为了让原 ~52 处引用 setX 的代码完全不变,继续按原 setter 名字
  // 调用即可。
  // R-55 Fix #2 — current sniff backend; non-null only while sniffing.
  // Drives whether the「✓ 完成嗅探」button shows up at the 60% stage
  // (only meaningful for system-chrome which waits for child exit).
  // R-59 — useRealChromeProfile persisted in localStorage by the
  // controller's useEffect; surfaced here as a renamed alias.
  const sniffProgress = sniffPanel.sniffProgress;
  const setSniffProgress = sniffPanel.setSniffProgress;
  const activeSniffMode = sniffPanel.activeSniffMode;
  const setActiveSniffMode = sniffPanel.setActiveSniffMode;
  const useRealChromeProfile = sniffPanel.useRealChromeProfile;
  const setUseRealChromeProfile = sniffPanel.setUseRealChromeProfile;
  const result = ws.activeWs.result;
  const setResult = makeWsSetter('result');
  const selected = ws.activeWs.selected;
  const setSelected = makeWsSetter('selected');
  const [activeId, setActiveId] = useState<string | null>(null);
  const options = ws.activeWs.options;
  const setOptions = makeWsSetter('options');
  // Step 11C — preview modal state triplet (`preview` / `previewing`
  // / `previewOverride`). The override lives outside the global
  // `options` state so opening the preview modal can never leak its
  // auto-defaults into the next batch run; PreviewModal resets it on
  // every media switch and `closeModal` resets it on dismiss. See
  // [usePreviewState.ts] for the full reset contract.
  const {
    preview, setPreview,
    previewing, setPreviewing,
    previewOverride, setPreviewOverride
  } = usePreviewState();
  const [outputDir, setOutputDir] = useState<string>('');
  const [baseOutputDir, setBaseOutputDir] = useState<string>('');
  const [lastBatchDir, setLastBatchDir] = useState<string>('');
  const progress = ws.activeWs.progress;
  const setProgress = makeWsSetter('progress');
  const logs = ws.activeWs.logs;
  const setLogs = makeWsSetter('logs');
  // R-43.1 — 日志面板默认折叠。原先 `.bottom` grid 用 1fr/240px 双栏强行
  // 把 LogBox 钉在底部右侧,挤占 TaskTable 视觉空间,且大多数情况下用户
  // 不需要看日志输出。改为按钮 toggle:点 "📋 日志 (N)" 才显示。
  // 用 localStorage 记忆用户偏好,避免每次启动重置。
  const LOGS_VISIBLE_KEY = 'giftk.logsVisible';
  const [logsVisible, setLogsVisible] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(LOGS_VISIBLE_KEY) === '1';
  });
  const toggleLogs = useCallback(() => {
    setLogsVisible((prev) => {
      const next = !prev;
      try { window.localStorage.setItem(LOGS_VISIBLE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const processingOne = ws.activeWs.processingOne;
  const setProcessingOne = makeWsSetter('processingOne');
  // R-43.2 — batch modal carries a `mode` + a snapshot of the media
  // list that the modal's confirm should dispatch. This generalises
  // the original "fresh start" path to also cover "append while
  // running":
  //   - mode 'fresh':  list = processable at click time (full selection)
  //   - mode 'append': list = appendable at click time (only new rows)
  // We snapshot the list so that grid checkbox edits during the modal
  // session don't shift the dispatch target.
  const [batchModal, setBatchModal] = useState<{
    entries: BatchSegmentEntry[];
    list: SniffedMedia[];
    mode: 'fresh' | 'append';
  } | null>(null);
  // R-28 #2: which history record (if any) is currently shown in the
  // detail modal. A non-null value mounts <HistoryDetailModal /> over
  // the rest of the app. We only hold the record reference here — all
  // re-run plumbing routes back through App's normal handlers (pinned
  // to the record via taskRecordMapRef) so events update this record
  // and not the active home record.
  const [historyDetail, setHistoryDetail] = useState<HistoryRecord | null>(null);

  // R-27 — persistent history of every sniff round and its associated
  // batch outputs. The hook owns the localStorage layer; App owns the
  // life-cycle hooks that create/append records. We track the *current*
  // record id in a ref so progress events can locate the right record
  // without forcing a re-render or recreating any callback.
  const { history, isLoading: isHistoryLoading, pushOrReplace, patch: patchHistory, remove: removeHistory, clear: clearHistory, reload: reloadHistory, flushPending: flushHistoryPending } = useHistory();
  // R-32 — independent LRU of *URLs the user has sniffed* (capped at 30).
  // This is intentionally orthogonal to useHistory above — that hook
  // remembers full batch sessions, this one is the "address book" of
  // recently-visited pages so we can offer a quick picker on the URL
  // input. Sniff history is fed by the success branch of onSniff
  // below; the picker reads it via the popover state.
  const {
    entries: sniffHistory,
    isLoading: isSniffHistoryLoading,
    addOrPromote: addSniffHistory,
    remove: removeSniffHistory,
    clear: clearSniffHistory,
    reload: reloadSniffHistory
  } = useSniffHistory();
  const [sniffHistoryOpen, setSniffHistoryOpen] = useState(false);
  // R-51/R-52 — split-button state for the「网页嗅探」entry. Three
  // backends are available and the user's choice is remembered in
  // localStorage:
  //   ① embed         : embedded WebContentsView (fast, fails on heavy CF)
  //   ② system-chrome : spawn user's real Chrome+CDP (clears CF Turnstile)
  //   ③ ytdlp-direct  : no webview at all, hand URL to yt-dlp's 1900+
  //                     extractors (YouTube / X / Bilibili / TikTok / …)
  // R-53 — split-button "网页嗅探" menu: open/close, persisted preferred
  // mode (localStorage key 'giftk:preferredWebviewMode'), viewport-edge
  // anchoring, focus-on-open, click-outside dismissal, Escape to close,
  // ArrowUp/ArrowDown/Home/End on the radio items. The full a11y bundle
  // lives in `useWebviewMenu` so this file can stay focused on data flow.
  const webviewMenu = useWebviewMenu();
  const preferredWebviewMode = webviewMenu.preferredMode;
  // R-33A — manual two-stage optimize modal state. Stores the row the user
  // clicked "手动优化" on so we can pass its current size + warning + the
  // first output path into ManualOptimizeModal. Cleared back to null on
  // close / confirm.
  const [manualOpt, setManualOpt] = useState<{
    media: SniffedMedia;
    progress: TaskProgress;
    gifPath: string;
  } | null>(null);
  const activeHistoryIdRef = useRef<string | null>(null);
  // R-Workspaces — keep `activeHistoryIdRef` in sync with the active
  // workspace so legacy code paths that read the ref still see the
  // correct record id after the user switches tabs. Writes still go
  // through both the ref AND `ws.patchActive({ historyId })` (double
  // write) so cross-tab routing via `patchByHistoryId` keeps working.
  useEffect(() => {
    activeHistoryIdRef.current = ws.activeWs.historyId;
  }, [ws.activeWs.historyId]);
  // Embed direct-link resolution (Vimeo / YouTube / Bilibili / …) lives
  // in `useEmbedResolve`. The hook owns three state buckets — resolvedMap
  // / resolvingSet / resolveErrorMap — and the auto-trigger effect that
  // fires whenever `result` changes. App.tsx wires only the workspace-
  // shaped callbacks (log buffer, selection set, history+result double
  // write for P1 #5) and consumes the read-only state for rendering.
  const embedAppendLog = useCallback(
    (line: string) => setLogs((prev) => [...prev, line].slice(-300)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const embedAddSelected = useCallback(
    (id: string) =>
      setSelected((prev) => {
        const n = new Set(prev);
        n.add(id);
        return n;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  // P1 (#5) FIX — single-source double write. The hook fires this
  // exactly once on a successful resolve; we split it into the
  // history-record patch (so "重跑" / "下载" survives an app restart)
  // and the live `result.items` patch (so the home-page TaskTable
  // sees the resolved media within the same session) in one render.
  const patchItemResolved = useCallback(
    (id: string, r: ResolvedMedia) => {
      const recId = activeHistoryIdRef.current;
      const patchItems = (list: SniffedMedia[]): SniffedMedia[] =>
        list.map((it) => (it.id === id ? { ...it, resolved: r } : it));
      if (recId) {
        patchHistory(recId, (rec) => ({ ...rec, items: patchItems(rec.items) }));
      }
      setResult((prev) => (prev ? { ...prev, items: patchItems(prev.items) } : prev));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [patchHistory]
  );
  const {
    resolvedMap,
    resolveErrorMap,
    isResolving,
    onResolveEmbedById,
    reset: resetEmbedResolve
  } = useEmbedResolve({
    items: result?.items ?? [],
    result,
    resolveEmbed: giftk?.resolveEmbed,
    appendLog: embedAppendLog,
    addSelected: embedAddSelected,
    patchItemResolved
  });
  // Step 6 — sniff lifecycle (`giftk.sniff` / `sniffWith*` /
  // `importOfflinePage`) lives in `useSniffSession`. The hook owns the
  // ~200 lines of duplicated lifecycle skeleton (urlError → claimForSniff
  // → setSniffing → … → finally clear flags) shared by all three entry
  // points; App.tsx only wires the active-workspace setter shims, the
  // history mutators, and the reqId-bumping watchdog constant. The
  // returned `sniffReqId` ref is the same one `onCancel` could bump to
  // pre-empt an in-flight sniff (currently the cancel path delegates to
  // `giftk.cancelSniff()` instead, but we keep the ref accessible via
  // `sniffSession.sniffReqId` in case a future cancel needs it).
  const sniffSession = useSniffSession({
    giftk,
    ws,
    url,
    result,
    useRealChromeProfile,
    options,
    setUrlError,
    setSniffing,
    setSniffProgress,
    setResult,
    setSelected,
    setActiveId,
    setPreview,
    setLogs,
    setActiveSniffMode,
    resetEmbedResolve,
    activeHistoryIdRef,
    makeHistoryRecord,
    pushOrReplace,
    addSniffHistory,
    SNIFF_TIMEOUT_MS
  });
  // R-27 (post-review #4.1): per-task → record mapping. The renderer
  // historically pointed `activeHistoryIdRef` at the "current" record
  // and folded every progress event into it; this broke the moment a
  // history-reprocess flipped the pointer while a previous batch was
  // still streaming events (race C in the review). The map is the
  // source of truth: it's populated at dispatch time (dispatchBatch /
  // onProcessOne / onReprocessFromHistory) with the record id that
  // owns each task, and onProgress looks up taskId here first before
  // falling back to activeHistoryIdRef. Terminal events also clear
  // the entry so a stale taskId can't accidentally re-bind to a
  // different record on a yt-dlp id collision.
  const taskRecordMapRef = useRef<Map<string, string>>(new Map());
  // R-29 (dirfix): per-record cached batch sub-directory. The first
  // dispatch for a record (single-process / batch / re-run) lets main
  // mint a fresh timestamped subDir; we cache it here so every
  // subsequent dispatch for the same record (additional single, retry,
  // batch over the same items) reuses that exact directory instead of
  // letting main mkdir a new one each call. This is what fixes the
  // user-visible "我四个任务最后落进了两个目录" bug.
  const recordOutputDirRef = useRef<Map<string, string>>(new Map());
  const [view, setView] = useState<'home' | 'history' | 'toolbox' | 'uploads'>('home');

  // R-COMPRESS-V1 #5 — sniff-history「推荐预设」chip → toolbox prefill.
  // useToolbox is instantiated INSIDE ToolboxPanel (not here), so we
  // can't call applyPreset directly. Instead we publish a synthetic
  // prop with a monotonically-increasing key; ToolboxPanel listens to
  // key transitions and forwards to tb.applyPreset. Two consecutive
  // clicks on the SAME chip both bump the key (so the queue is re-
  // seeded each time), while a remount of ToolboxPanel — e.g. after
  // tab-flipping back from 'home' — will see the latest pendingPreset
  // and re-apply once because lastAppliedPresetKey starts null.
  const [pendingPreset, setPendingPreset] = useState<{
    key: string;
    inputPath: string;
    kind: ToolboxKind;
    params: ToolboxParams;
  } | null>(null);
  const onApplyPresetFromHistory = useCallback(
    (rec: HistoryRecord, preset: { kind: ToolboxKind; params: ToolboxParams }): void => {
      const inputPath = pickFirstDoneOutput(rec);
      if (!inputPath) return;
      setView('toolbox');
      setPendingPreset({
        key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        inputPath,
        kind: preset.kind,
        params: preset.params
      });
    },
    []
  );

  // R-TB-OPEN-FROM-PROGRESS — 主页处理进度行的「🛠 工具箱」按钮。
  // 流程与 onApplyPresetFromHistory 类似:
  //   1. 取该任务的第一个产物作为工具箱的 input。
  //   2. 按产物扩展名挑一个最合适的默认 ToolboxKind:
  //        .gif / .webp → gif-resize  (最常见的二次需求是改尺寸/再压缩)
  //        .mp4 / .mov / .webm / ... → video-to-gif
  //      未识别的扩展名直接放弃,避免把不兼容的文件丢进队列。
  //   3. 切到 toolbox tab + 推一个新的 pendingPreset。
  // 参数与 useToolbox#defaultParamsFor 保持同步;这里直接内联避免 App
  // 多一次跨模块依赖,defaultParamsFor 改了的话两边一并更新即可。
  const onOpenInToolboxFromProgress = useCallback(
    (_m: { url: string }, p: { outputs?: string[] }): void => {
      const out = Array.isArray(p.outputs) && p.outputs.length > 0 ? p.outputs[0] : null;
      if (!out) return;
      const dot = out.lastIndexOf('.');
      if (dot < 0) return;
      const ext = out.slice(dot).toLowerCase();
      let kind: ToolboxKind | null = null;
      let params: ToolboxParams = {};
      if (ext === '.gif' || ext === '.webp') {
        // 最高频的二次处理:对成品 GIF 调尺寸/再压。用户进入面板后还能
        // 自由切到 gif-optimize / trim / speed 等其它 kind。
        kind = 'gif-resize';
        params = { targetWidth: 480 };
      } else if (ext === '.mp4' || ext === '.mov' || ext === '.webm' || ext === '.mkv' || ext === '.avi') {
        kind = 'video-to-gif';
        params = { fps: 12, width: 800, engine: 'ffmpeg' };
      }
      if (!kind) return;
      setView('toolbox');
      setPendingPreset({
        key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        inputPath: out,
        kind,
        params
      });
    },
    []
  );

  // R-UPDATE — Update-check modal state. Three pieces:
  //   - `updateOpen` controls visibility of UpdateModal.
  //   - `updateResult` is the latest probe payload (from manual recheck
  //     or the silent startup push). null while a manual recheck is in
  //     flight to render the "loading" branch.
  //   - `updateLoading` mirrors the in-flight IPC roundtrip so the
  //     primary CTAs disable correctly without flicker.
  // The startup-push event is wired below in a useEffect that calls
  // `window.giftk.updater.onUpdateAvailable`.
  const [updateOpen, setUpdateOpen] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const [updateLoading, setUpdateLoading] = useState(false);

  // R-45 — image-host upload state. Settings are loaded once at mount via
  // ipc; the modal updates them in place. The upload-history hook owns
  // localStorage persistence; we only forward main-process progress
  // emits into it via uploadRecordRef (jobId → recordId mapping).
  const { history: uploadHistory, isLoading: isUploadHistoryLoading, start: startUploadRecord, applyProgress: applyUploadProgress, remove: removeUploadHistory, clear: clearUploadHistory, reload: reloadUploadHistory, flushPending: flushUploadHistoryPending } = useUploadHistory();
  // Step 11A — wire the four mount-once side effects (legacy import +
  // reload, dbErrorBus toast bridge, capability probe, pre-quit flush
  // ack). Deferred to here so all `reload*` / `flushPending` deps are
  // already in scope. The hook itself owns the ref mirroring trick
  // that keeps the pre-quit listener subscribed exactly once.
  useBootstrapEffects(toaster, {
    reloadHistory,
    reloadSniffHistory,
    reloadUploadHistory,
    flushHistoryPending,
    flushUploadHistoryPending
  });
  const [uploadConfigs, setUploadConfigs] = useState<UploadConfigs | null>(null);
  const [uploadSettingsOpen, setUploadSettingsOpen] = useState(false);
  const [uploadResult, setUploadResult] = useState<string | null>(null); // recordId
  const uploadJobToRecordRef = useRef<Map<string, string>>(new Map());
  const uploadInflightRef = useRef<Map<string, number>>(new Map()); // recordId → remaining-non-terminal count
  // R-54 — jobId → { sniff history recordId (if any), output filePath }.
  // Populated when 「⚡ 上传所有产物」 / 「📤」 dispatches an upload from
  // a row that originated in a HistoryRecord, so onUploadProgress can
  // patch HistoryRecord.uploadsByOutputPath in place. The `sniffRecId`
  // is intentionally optional — uploads from non-history flows (e.g.
  // toolbox manual optimize) skip the patch.
  const uploadJobToTargetRef = useRef<
    Map<string, { sniffRecId?: string; filePath: string }>
  >(new Map());

  // R-29 (P1-H): if the currently-open history detail modal's record
  // is removed (HistoryPanel "删除" / "清空") while the modal is up,
  // close the modal so the user doesn't continue editing / re-running
  // a record that no longer exists. Without this, patchHistory writes
  // for a deleted id are dropped silently and the user is editing a
  // ghost.
  useEffect(() => {
    if (!historyDetail) return;
    const stillThere = history.some((r) => r.id === historyDetail.id);
    if (!stillThere) {
      setHistoryDetail(null);
    }
  }, [history, historyDetail]);

  // R-UPDATE — Subscribe to the silent startup update push.
  // [Main process](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts)
  // fires `updater:available` exactly once, ~5s after `app.whenReady()`,
  // and ONLY when a strictly-newer release is detected. We respond by:
  //   1. caching the payload into `updateResult` so the modal renders
  //      the correct branch immediately when the user opens it (no
  //      second IPC roundtrip needed);
  //   2. auto-opening the modal — the user explicitly opted into "every
  //      launch checks once" in the AskUserQuestion round, so a popup
  //      is the contract, not a surprise.
  // The unsubscribe is critical to avoid leaking listeners across HMR
  // cycles in dev (preload's `ipcRenderer.on` would otherwise stack
  // every Fast-Refresh).
  useEffect(() => {
    if (!giftk?.updater?.onUpdateAvailable) return;
    const off = giftk.updater.onUpdateAvailable((result) => {
      setUpdateResult(result);
      if (result.hasUpdate) {
        setUpdateOpen(true);
      }
    });
    return off;
  }, []);

  // R-UPDATE — Manual recheck. Always force=true so the user gets a
  // fresh roundtrip when they explicitly tap "关于/更新" or "重新检查";
  // the 6h cache only protects the silent startup probe path. Errors
  // are surfaced via `updateResult.error` (rendered by UpdateModal),
  // never thrown.
  const onCheckForUpdates = useCallback(async () => {
    if (!giftk?.updater?.checkForUpdates) return;
    setUpdateOpen(true);
    setUpdateLoading(true);
    try {
      const r = await giftk.updater.checkForUpdates(true);
      setUpdateResult(r);
    } catch (e) {
      setUpdateResult({
        current: '',
        latest: null,
        hasUpdate: false,
        htmlUrl: null,
        publishedAt: null,
        releaseName: null,
        body: null,
        error: e instanceof Error ? e.message : String(e),
        cached: false,
        fetchedAt: Date.now(),
      });
    } finally {
      setUpdateLoading(false);
    }
  }, []);

  // Bottom panel (TaskTable + LogBox) resizable height.
  // Persisted in localStorage so the user's preference survives reloads.
  // Drag gesture + persistence + double-click-to-reset all live in
  // `useBottomResize` so this file stays focused on data flow.
  const { bottomH, onBottomResizeStart, resetBottomH } = useBottomResize();

  const previewReqId = useRef(0);

  useEffect(() => {
    if (!giftk) return;
    giftk.getDefaultOutputDir().then((d) => {
      setOutputDir(d);
      setBaseOutputDir(d);
    }).catch(() => { /* ignore */ });
    // patchHistory is stable (memoised in useHistory with empty deps);
    // we want this effect to run exactly once on mount, so the missing
    // dep is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // IPC subscription wiring (R-27/R-45/R-54): now extracted to
  // useIpcEvents. The hook reads the latest setters/refs via an
  // internal depsRef so its mount-once subscription contract is
  // preserved verbatim — same TERMINAL gates, same recId fallback,
  // same in-flight counter semantics.
  useIpcEvents({
    giftk,
    patchHistory,
    taskRecordMapRef,
    activeHistoryIdRef,
    applyUploadProgress,
    uploadJobToRecordRef,
    uploadJobToTargetRef,
    uploadInflightRef,
    setProgress,
    setLogs,
    setSniffProgress,
    setUploadResult
  });

  // R-27 — on mount, walk the persisted history and tell the main
  // process to re-allow each batch sub-dir so "打开目录" continues to
  // work for old records after a renderer restart. Best-effort: failures
  // for individual entries are swallowed (the IPC itself never throws).
  // We deliberately read `history` only once at mount time to avoid
  // re-registering on every state change; new records added after mount
  // are already in `allowedOutputDirs` because process:start put them
  // there.
  useEffect(() => {
    if (!giftk || typeof giftk.registerOutputDir !== 'function') return;
    const seen = new Set<string>();
    for (const rec of history) {
      if (rec.outputDir && !seen.has(rec.outputDir)) {
        seen.add(rec.outputDir);
        giftk.registerOutputDir(rec.outputDir).catch(() => { /* swallow */ });
      }
      // R-29 (dirfix): rehydrate the per-record dir cache so re-runs
      // after a renderer restart still share the original subDir
      // instead of minting a new one.
      if (rec.outputDir) {
        recordOutputDirRef.current.set(rec.id, rec.outputDir);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const items = useMemo(() => {
    const raw = result?.items ?? [];
    if (Object.keys(resolvedMap).length === 0) return raw;
    return raw.map((m) => (resolvedMap[m.id] ? { ...m, resolved: resolvedMap[m.id] } : m));
  }, [result, resolvedMap]);
  const activeMedia = useMemo(
    () => items.find((i) => i.id === activeId) ?? null,
    [items, activeId]
  );

  // R-57 / R-58 — The static-image filter is always-on. We previously
  // surfaced an「含静态图」toggle in the toolbar, but R-58 removed it
  // (the checkbox cluttered the URL bar and surfacing avatars / sprite
  // sheets defeats the project's GIF-focus). Renderer no longer needs
  // any state for it; the unified sniffFilters layer in the main
  // process applies the filter unconditionally for every backend.

  // Step 6 — thin wrappers around `useSniffSession`. Keep the same
  // exported names (`onSniff`, `runWebviewSniff`, `runOfflineImport`)
  // so the JSX `onClick` props don't need any churn; the actual
  // lifecycle (urlError → claimForSniff → setSniffing → … → finally
  // clear flags) lives in the hook.
  const onSniff = useCallback(
    () => sniffSession.runEmbed(),
    [sniffSession]
  );

  // R-86 — Tray bridge: when the user picks "从剪贴板嗅探 URL" from the
  // system tray (or hits the global shortcut), the main process pushes
  // a `tray:sniff-url` event with the validated URL. We re-use the EXACT
  // same code path as a manual "paste + Enter" — setUrl + onSniff —
  // so the request goes through useSniffSession's dedupe / history / ws
  // wiring AND the main-side `sniff:url` handler with its sanitize
  // chain, satisfying R-86 红线 #2.
  //
  // setUrl is a useState setter, so depsRef inside useSniffSession
  // only sees the new value after the next render. setTimeout(0)
  // defers onSniff() until React has flushed state + refreshed
  // depsRef, avoiding the "trim() against stale url" race.
  useEffect(() => {
    if (!giftk?.onTraySniffUrl) return;
    const off = giftk.onTraySniffUrl(({ url }) => {
      if (typeof url !== 'string' || !url) return;
      setUrlError(null);
      setUrl(url);
      setTimeout(() => { void onSniff(); }, 0);
    });
    return () => { try { off(); } catch { /* best-effort */ } };
  }, [onSniff, setUrl, setUrlError]);

  // R-86 — Tray toast / navigate / re-upload bridges. Toasts are
  // forwarded to the existing main-log buffer (visible in the log
  // panel) so the user has at least ONE visible surface for tray
  // feedback even before a dedicated toast UI lands.
  useEffect(() => {
    if (!giftk?.onTrayToast) return;
    const off = giftk.onTrayToast(({ level, message }) => {
      if (typeof message !== 'string' || !message) return;
      const prefix = level === 'error' ? '[tray:error]' : level === 'warn' ? '[tray:warn]' : '[tray]';
      setLogs((prev) => [...prev, `${prefix} ${message}`].slice(-300));
    });
    return () => { try { off(); } catch { /* best-effort */ } };
  }, [setLogs]);

  // R-86 — wire the tray "上次任务回看" / "一键重传最近产物" menu items.
  // Both bridges existed in preload + main since 6c521e1 but the
  // renderer never subscribed, leaving the buttons as dead letters
  // (Sub-C two-round audit: tray:navigate / tray:reupload-latest had
  // zero subscribers). We translate them into setView() so the user
  // lands on the right panel, and surface a log entry so they know
  // the click registered even if the panel itself is empty.
  useEffect(() => {
    if (!giftk?.onTrayNavigate) return;
    const off = giftk.onTrayNavigate(({ tab }) => {
      if (tab === 'history' || tab === 'home' || tab === 'toolbox' || tab === 'uploads') {
        setView(tab);
        setLogs((prev) => [...prev, `[tray] 已切换到 ${tab} 面板`].slice(-300));
      }
    });
    return () => { try { off(); } catch { /* best-effort */ } };
  }, [setView, setLogs]);

  useEffect(() => {
    if (!giftk?.onTrayReuploadLatest) return;
    const off = giftk.onTrayReuploadLatest(() => {
      // Jump to the uploads panel where the user can trigger the
      // batch re-upload. We don't auto-fire onUploadAll here because
      // (a) it would silently consume an image-host quota with no
      // confirmation, and (b) results may legitimately be empty after
      // a fresh launch. The tray menu's job is to navigate; the user
      // remains in control of the upload itself.
      setView('uploads');
      setLogs((prev) => [...prev, '[tray] 已切换到上传面板,请在 uploads 中点击批量上传以重传最近产物'].slice(-300));
    });
    return () => { try { off(); } catch { /* best-effort */ } };
  }, [setView, setLogs]);

  // R-44 — webview-assisted sniff. Opens a real Chromium window in the
  // main process so the user can sign in to gated sites. Resolves with a
  // SniffResult, which we feed into the same downstream wiring as
  // `onSniff` (selection seeding, history record, sniff URL LRU).
  //
  // R-51 — Now also handles the system-Chrome backend: when `mode ===
  // 'system-chrome'`, instead of opening our embedded WebContentsView we
  // spawn the user's actual installed Chrome / Edge / Brave so the
  // TLS/HTTP2 fingerprint comes from a real browser (mandatory for
  // Cloudflare-protected pages like OpenAI / Medium / Patreon).
  //
  // R-52 — Adds the `ytdlp-direct` mode: no webview at all, hand the
  // URL straight to yt-dlp's 1900+ extractors. Best for known video
  // platforms (YouTube / X / Bilibili / TikTok / Reddit / …) where the
  // user just wants the file and doesn't care about page exploration.
  const runWebviewSniff = useCallback(
    (mode: 'embed' | 'system-chrome' | 'ytdlp-direct') => sniffSession.runWebview(mode),
    [sniffSession]
  );
  // R-X — The previous per-mode wrappers (onWebviewSniff /
  // onSystemChromeSniff / onYtdlpDirectSniff) auto-fired a sniff the
  // moment the user picked a row from the dropdown, which was both
  // surprising and made the choice irreversible (the network call had
  // already started). The dropdown now ONLY persists the preference;
  // the actual sniff is launched via the toolbar button below, which
  // calls onPreferredWebviewSniff using the persisted mode.
  // R-51 — main-button click goes to whichever mode the user last picked
  // (or `embed` on first run); the small caret-arrow next to it opens
  // the dropdown so they can switch.
  const onPreferredWebviewSniff = useCallback(() => {
    runWebviewSniff(preferredWebviewMode);
  }, [runWebviewSniff, preferredWebviewMode]);

  const onPickDir = useCallback(async () => {
    if (!giftk) return;
    const p = await giftk.pickOutputDir();
    if (p) {
      setOutputDir(p);
      setBaseOutputDir(p);
      setLastBatchDir('');
    }
  }, []);

  const onPreview = useCallback(async () => {
    if (!activeMedia || !giftk) return;
    if (activeMedia.kind === 'image') return;
    const myId = ++previewReqId.current;
    setPreviewing(true);
    setPreview(null);
    try {
      const r = await giftk.preview(activeMedia, { ...options, outDir: outputDir });
      if (myId !== previewReqId.current) return;
      setPreview(r);
    } catch (e) {
      if (myId !== previewReqId.current) return;
      const errResult: PreviewResult = {
        taskId: activeMedia.id,
        durationSec: 0,
        width: 0,
        height: 0,
        frames: [],
        error: (e as Error).message
      };
      setPreview(errResult);
    } finally {
      if (myId === previewReqId.current) setPreviewing(false);
    }
  }, [activeMedia, options, outputDir, setPreview, setPreviewing]);

  const processable = useMemo(
     () => items.filter((m) => selected.has(m.id) && (m.kind === 'video' || m.kind === 'gif') && (!m.requiresExternalDownload || !!m.resolved)),
     [items, selected]
  );

  // R-43 — true while at least one home-batch task is in a non-terminal
  // state. We use this to:
  //   1. Disable the primary "▶ 开始批处理" button so a second click
  //      can't start a duplicate batch (prior bug: clicking twice would
  //      enqueue every selected media a second time).
  //   2. Move the "取消" button into the progress region (TaskTable
  //      header) so cancellation is co-located with the work it stops.
  //   3. Re-purpose the primary button into "▶ 追加排队" while running:
  //      newly-checked rows that aren't already in `progress` get
  //      appended to the running queue via dispatchBatch.
  const isHomeBatchProcessing = useMemo(() => {
    for (const id of Object.keys(progress)) {
      const st = progress[id]?.status;
      if (st && st !== 'done' && st !== 'failed' && st !== 'skipped' && st !== 'cancelled') {
        return true;
      }
    }
    return false;
  }, [progress]);

  // R-43 — items that the user has selected in the right-pane grid but
  // which haven't entered `progress` yet. While a batch is running,
  // these are the candidates the "追加" button will hand off to
  // dispatchBatch so they join the existing queue rather than starting
  // a fresh batch. When idle, this is just `processable`.
  const appendable = useMemo(() => {
    return processable.filter((m) => !progress[m.id]);
  }, [processable, progress]);

  /**
   * Step 7 — process-dispatch hook. The four startBatch-wrapping
   * callbacks (runDispatch / dispatchBatch / onProcessOne /
   * onReprocessFromHistory / onBatchFromRecord) used to live inline
   * here. They share a dense ritual (R-29 P1-I pin / P1-E rollback /
   * dirfix subDir reuse, R-27 effective-options patch, R-22 segment
   * fallback, R-75 size-guard preflight) that is now centralised in
   * the hook. App.tsx just passes the deps bag through and destructures
   * the resulting handlers — see useProcessDispatch.ts for the full
   * rationale.
   */
  const {
    dispatchBatch,
    onProcessOne,
    onReprocessFromHistory,
    onBatchFromRecord
  } = useProcessDispatch({
    giftk,
    options,
    baseOutputDir,
    outputDir,
    result,
    history,
    processable,
    progress,
    patchHistory,
    setLogs,
    setProgress,
    setProcessingOne,
    setLastBatchDir,
    activeHistoryIdRef,
    taskRecordMapRef,
    recordOutputDirRef
  });

  const onStart = useCallback(async () => {
    if (!giftk) return;
    if (processable.length === 0) {
      setLogs((prev) => [...prev, `[batch] 没有可处理的任务(只支持 video / gif)`].slice(-300));
      return;
    }
    // R-23: surface a confirm modal listing every long video with its own
    // segment picker BEFORE dispatching. Skip the modal when:
    //   - no video exceeds maxSegmentSec → nothing to ask
    //   - the user already set selectedSegments / startSec / endSec on the
    //     global options form (treat as "I know what I'm doing")
    const longCandidates: BatchSegmentEntry[] = processable
      .filter((m) => {
        if (m.kind !== 'video') return false;
        const dur = m.resolved?.durationSec ?? m.durationSec ?? 0;
        return dur > options.maxSegmentSec;
      })
      .map((m) => ({ media: m, durationSec: m.resolved?.durationSec ?? m.durationSec ?? 0 }));
    const userExplicitGlobal =
      options.startSec !== undefined ||
      options.endSec !== undefined ||
      (options.selectedSegments && options.selectedSegments.length > 0);
    if (longCandidates.length > 0 && !userExplicitGlobal) {
      setBatchModal({ entries: longCandidates, list: processable, mode: 'fresh' });
      return;
    }
    await dispatchBatch(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processable, options, dispatchBatch]);

  // R-43 — "▶ 追加排队" while a batch is running. Sends only the rows
  // that aren't already in `progress` so we don't double-submit.
  // R-43.2 — appendable长视频也需要走 BatchSegmentModal 让用户挑段;
  // 此前直接 dispatch 会让长视频默认只跑第 1 段(段 0),用户根本
  // 无从选择。判定逻辑与 onStart 完全对齐(全局 explicit options
  // 仍然短路 modal,这是"我知道我在做什么"的逃生口)。
  const onAppend = useCallback(async () => {
    if (!giftk) return;
    if (appendable.length === 0) {
      setLogs((prev) => [...prev, `[batch] 追加:没有新选中的可处理项`].slice(-300));
      return;
    }
    const longCandidates: BatchSegmentEntry[] = appendable
      .filter((m) => {
        if (m.kind !== 'video') return false;
        const dur = m.resolved?.durationSec ?? m.durationSec ?? 0;
        return dur > options.maxSegmentSec;
      })
      .map((m) => ({ media: m, durationSec: m.resolved?.durationSec ?? m.durationSec ?? 0 }));
    const userExplicitGlobal =
      options.startSec !== undefined ||
      options.endSec !== undefined ||
      (options.selectedSegments && options.selectedSegments.length > 0);
    if (longCandidates.length > 0 && !userExplicitGlobal) {
      setBatchModal({ entries: longCandidates, list: appendable, mode: 'append' });
      return;
    }
    setLogs((prev) => [...prev, `[batch] 追加 ${appendable.length} 个任务到当前队列`].slice(-300));
    await dispatchBatch(null, appendable);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appendable, options, dispatchBatch]);

  // R-55 Fix #2 — Cooperative finalize for the real-Chrome sniff. The
  // user clicks「✓ 完成嗅探」at the 60% stage, the main process resolves
  // the sniff promise as if the Chrome window was closed (final DOM
  // scan + cleanup), and the same `setSniffing(false)` path runs. This
  // is a separate flow from cancel because we WANT the captured media,
  // we just don't want to wait for Chrome to fully exit.
  const onFinalizeSystemChromeSniff = useCallback(async () => {
    if (!giftk?.finalizeSystemChromeSniff) return;
    try {
      await giftk.finalizeSystemChromeSniff();
      setLogs((prev) => [...prev, '[system-chrome] 用户点击「完成嗅探」,正在收尾…'].slice(-300));
    } catch { /* ignore — likely not in flight anymore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // R-55 Fix #3 — Offline import. Wraps `giftk.importOfflinePage` in
  // the same UI lifecycle hooks used by `runWebviewSniff` (sniffing
  // flag, sniffReqId guard, history pin, log line) so the result
  // grid / batch UI / upload-all flow all light up exactly as if the
  // user had run a normal online sniff. The optional `path` arg
  // lets us reuse this handler for both the toolbar button (no path
  // → main pops a picker) and drag-and-drop (renderer already has
  // the absolute path).
  //
  // R-56 — `includeStaticImages` opts the result back into accepting
  // <img>-sourced static images (.png/.jpg/.webp/.bmp/.avif). Default
  // false: the result grid was being polluted with avatars / sprites /
  // thumbnails the user couldn't actually do anything with. Also
  // removed the hard-coded `percent: 50` placeholder that the user
  // saw as "卡 60%" — main now emits real per-stage progress over
  // the existing `sniff:progress` channel and the global
  // `onSniffProgress` subscriber picks it up automatically.
  const runOfflineImport = useCallback(
    (absPath?: string, runOpts?: { includeStaticImages?: boolean }) =>
      sniffSession.runOffline(absPath, runOpts),
    [sniffSession]
  );

  // R-58 — Static-image filter is now always-on at the unified
  // sniffFilters layer. Renderer no longer carries an
  // `offlineIncludeImages` state nor passes it through the offline
  // import path; it always defaults to `false`.

  const onOfflineImport = useCallback(() => {
    void runOfflineImport(undefined, { includeStaticImages: false });
  }, [runOfflineImport]);

  // R-55 Fix #3 — Global drag-and-drop bridge for the offline import.
  // Attached to `window` instead of a specific div so the user can
  // drop anywhere on the app surface. We aggressively `preventDefault`
  // on dragover so the browser doesn't try to navigate away to the
  // dropped file. Only the FIRST file is imported because the offline
  // path is single-source-of-truth (one page → one SniffResult).
  //
  // R-68 — Tab-scoping fix. Pre-R-68 this listener fired on EVERY tab.
  // When the user dragged a file onto the Toolbox tab to add a job,
  // ToolboxPanel's own `onDrop` correctly added the job *and* this
  // window listener also fired, calling `runOfflineImport(p)` which
  // populated the home-tab "已选媒体" grid with that toolbox file.
  // Visible symptom in the user's screenshot: a toolbox-side webp
  // (`1CCA6D513B...webp`) showing up as a sniff result on the home
  // page even though the user never sniffed any URL. We now:
  //   1. Bail when the active tab isn't 'home' — toolbox / history /
  //      uploads have their own drop handling and shouldn't share
  //      the home grid.
  //   2. Honour `e.defaultPrevented` so any nested React onDrop
  //      handler that called `e.preventDefault()` already handled
  //      the drop and we shouldn't double-process it.
  useGlobalDropZone(view, runOfflineImport);

  const onCancel = useCallback(() => {
    if (!giftk) return;
    if (sniffing) {
      giftk.cancelSniff?.().catch(() => { /* ignore */ });
    }
    giftk.cancelAll().catch(() => { /* ignore */ });
    // R-29 (P0-B): sweep any locally-seeded `pending` rows that main
    // process never started (i.e. user clicked cancel during the
    // 50–200ms window between our optimistic seed and main's first
    // emit). Without this sweep those rows would stay forever at
    // "已加入队列 0%" because main never sends a `cancelled` event for
    // tasks it hadn't begun. Real running tasks will get their own
    // `cancelled` emit from main, which `mergeProgressIntoRecord`
    // routes correctly.
    setProgress((prev) => {
      let mutated = false;
      const next: Record<string, TaskProgress> = {};
      for (const id of Object.keys(prev)) {
        if (prev[id].status === 'pending') {
          mutated = true;
          continue;
        }
        next[id] = prev[id];
      }
      return mutated ? next : prev;
    });
    // The pinned task→record bindings are still valid for tasks main
    // *did* accept (it'll emit their `cancelled`); only the rows we
    // just dropped need their map entries cleaned up to avoid leaks.
    // Iterate over a snapshot of the map and only delete entries
    // whose progress was just removed.
    for (const [taskId] of taskRecordMapRef.current) {
      // We don't have `progress` here post-sweep yet (state is async)
      // — but mergeProgressIntoRecord already drops `pending` first
      // writes, so a stale map entry can't pollute history. The only
      // observable cost is a few extra Map entries until the next
      // dispatch; cheap enough to leave alone.
      void taskId;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sniffing]);

  // R-43.2 — single-row cancel from TaskTable. Calls main-side
  // cancelTask(id) and optimistically updates the local progress row
  // so the spinner stops moving even before the matching `cancelled`
  // emit lands. If main reports `cancelled === false` (the task
  // already finished or was unknown), we leave the existing progress
  // row untouched — its true terminal status will already be in there.
  const onCancelOne = useCallback(async (media: SniffedMedia) => {
    if (!giftk?.cancelTask) return;
    const id = media.id;
    try {
      const r = await giftk.cancelTask(id);
      if (r?.cancelled) {
        // Optimistic seed: stamp `cancelled` immediately. The real
        // emit from main will replace this within a tick or two; we do
        // this so the row visually "settles" in sync with the click.
        setProgress((prev) => {
          const cur = prev[id];
          if (!cur) return prev;
          if (cur.status === 'done' || cur.status === 'failed' || cur.status === 'skipped' || cur.status === 'cancelled') {
            return prev;
          }
          return {
            ...prev,
            [id]: { ...cur, status: 'cancelled', percent: 100, message: 'cancelled' }
          };
        });
        setLogs((prev) => [...prev, `[task] cancelled: ${id}`].slice(-300));
      } else {
        setLogs((prev) => [...prev, `[task] cancel skipped (already finished?): ${id}`].slice(-300));
      }
    } catch (e) {
      setLogs((prev) => [...prev, `[error] cancelTask: ${(e as Error).message}`].slice(-300));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // R-33A — open ManualOptimizeModal for a "未达标" row. We need at least
  // one output path on the progress record (TaskProgress.outputs[0]); without
  // it we have no input to feed back into the compress loop. Silently no-op
  // when the row hasn't reported an output (e.g. failed before saving).
  const onManualOptimize = useCallback((media: SniffedMedia, p: TaskProgress) => {
    const gifPath = p.outputs?.[0];
    if (!gifPath) {
      setLogs((prev) => [...prev, `[manual-opt] 跳过:任务 ${media.id} 没有可用的输出路径`].slice(-300));
      return;
    }
    setManualOpt({ media, progress: p, gifPath });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onManualOptimizeConfirm = useCallback(async (req: ManualOptimizeRequest) => {
    if (!manualOpt) return;
    const { media, gifPath, progress: p } = manualOpt;
    setManualOpt(null);
    const hadForceBypass = Array.isArray(p.phaseFailures) && p.phaseFailures.includes('aspect-ratio-bypass');
    await onProcessOne(media, {
      reoptimizeFromGifPath: gifPath,
      maxBytes: req.maxBytes,
      fps: req.fps,
      maxWidth: req.maxWidth,
      softMaxBytes: req.softMaxBytes,
      minSize: req.minSize,
      speed: req.speed,
      // R-81 — propagate gifsicle knobs from the manual modal so the
      // re-run honours user-picked lossy/colors/-O/dither overrides.
      lossyCeiling: req.lossyCeiling,
      colorsFloor: req.colorsFloor,
      optimizeLevel: req.optimizeLevel,
      dither: req.dither,
      // R-XXX — if this task was already force-allowed once (e.g. had
      // aspect-ratio-bypass in its phaseFailures), don't make the user
      // click through the spec failure again for a re-optimize.
      forceAllowSmallSide: hadForceBypass ? true : undefined,
    });
  }, [manualOpt, onProcessOne]);

  // R-45 / R-54 / P1 #4 — upload dispatch is now extracted to
  // useUploadDispatch. The hook preserves all invariants verbatim:
  //   • routing tables + in-flight counter pre-populated BEFORE
  //     the IPC roundtrip (closes the hash-cache-hit race);
  //   • items[] seeded with deterministic ${recId}-${i} jobIds;
  //   • catch branch rolls the tables back; mismatch branch remaps;
  //   • setUploadResult fires immediately on success branch (R-73).
  const { dispatchUpload } = useUploadDispatch({
    giftk,
    uploadConfigs,
    history,
    startUploadRecord,
    activeHistoryIdRef,
    uploadJobToRecordRef,
    uploadJobToTargetRef,
    uploadInflightRef,
    setLogs,
    setUploadResult,
    setUploadSettingsOpen
  });

  // R-45 / R-54 — upload-domain orchestration is now extracted to
  // useUploadOrchestrator. The hook owns:
  //   • onUploadOne / onUploadAll callbacks
  //   • uploadAllStats / uploadAllReady / uploadAllTitle derived UX
  //   • onSaveUploadSettings (push + re-pull masked secrets)
  //   • the mount-once uploadGetSettings hydration effect
  // dispatchUpload (above) stays the IPC roundtrip primitive; this
  // hook is the renderer-side glue that decides WHICH outputs go to
  // it and surfaces the reason a button is disabled.
  const {
    onUploadOne,
    onUploadAll,
    onSaveUploadSettings,
    uploadAllStats,
    uploadAllReady,
    uploadAllTitle
  } = useUploadOrchestrator({
    giftk,
    dispatchUpload,
    items,
    progress,
    uploadConfigs,
    setUploadConfigs,
    setLogs
  });

  // R-75 — 「⚡ 强制全部失败项」 derived state.
  //
  // The bottom toolbar exposes a single button that bulks per-row
  // 「强制允许」 actions for every task currently parked on
  // `errorCode === 'ASPECT_RATIO_OUT_OF_RANGE'`. Counting from the
  // live `progress` map keeps the button reactive: as soon as a
  // task fails with that code the count ticks up; when the user
  // re-runs it the count ticks back down.
  //
  // Why scope to ASPECT_RATIO_OUT_OF_RANGE only? That's the single
  // error class the per-row 「强制允许」 already covers. Mass
  // re-running unrelated runtime / network failures with
  // `forceAllowSmallSide=true` would be misleading (the flag only
  // bypasses minSide; it doesn't fix bad URLs).
  //
  // Why only `failed` and not `cancelled`? `errorCode` is closed-union
  // typed and only emitted from the `failed` branch in
  // [src/main/processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts).
  // `cancelled` rows never carry it, so adding that status here would
  // be dead-branch noise that confuses future readers.
  const forceAllowFailedMedia = items.filter((m) => {
    const p = progress[m.id];
    return p
      && p.status === 'failed'
      && p.errorCode === 'ASPECT_RATIO_OUT_OF_RANGE';
  });
  const forceAllowFailedCount = forceAllowFailedMedia.length;
  // Single source-of-truth callback for both the per-row 「强制允许」
  // button (TaskTable.onForceAllow) and the bulk
  // 「⚡ 强制全部失败项」 button. Centralising the call shape means
  // any future override (e.g. an extra log line, a confirm dialog,
  // a per-row throttle) lands in exactly one place.
  const forceAllowOne = useCallback(
    (media: SniffedMedia) => onProcessOne(media, { forceAllowSmallSide: true }),
    [onProcessOne]
  );
  const onForceAllowAllFailed = useCallback(async () => {
    if (forceAllowFailedMedia.length === 0) return;
    setLogs((prev) => [
      ...prev,
      `[batch] 一键强制重跑 ${forceAllowFailedMedia.length} 项尺寸不达标任务`
    ].slice(-300));
    // Snapshot the list before iterating: `onProcessOne` flips each
    // row to `pending`, which removes it from `forceAllowFailedMedia`
    // on the next render. Since this useCallback closes over the
    // pre-snapshot array we won't lose entries mid-loop. We also use
    // Promise.allSettled so a single transient IPC failure doesn't
    // halt the rest of the bulk operation — main-side concurrency
    // limits already cap the actual ffprobe-encode pipeline width.
    const targets = [...forceAllowFailedMedia];
    await Promise.allSettled(targets.map((m) => forceAllowOne(m)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceAllowFailedMedia, forceAllowOne]);
  const forceAllowAllTitle = forceAllowFailedCount === 0
    ? '当前没有因尺寸规格被拒的任务;一旦有任务以 ASPECT_RATIO_OUT_OF_RANGE 失败,这里就可以一键全部强制放行重跑'
    : `把 ${forceAllowFailedCount} 项因尺寸规格被拒的任务一次性全部强制重跑(等同逐项点击「强制允许」)`;

  useEffect(() => {
    if (processingOne.size === 0) return;
    let changed = false;
    const next = new Set(processingOne);
    for (const id of processingOne) {
      const st = progress[id]?.status;
      if (st === 'done' || st === 'failed' || st === 'cancelled' || st === 'skipped') {
        next.delete(id);
        changed = true;
      }
    }
    if (changed) setProcessingOne(next);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress, processingOne]);

  const isProcessingOne = useCallback((id: string): boolean => {
    if (processingOne.has(id)) return true;
    const st = progress[id]?.status;
    if (!st) return false;
    return st !== 'done' && st !== 'failed' && st !== 'cancelled' && st !== 'skipped';
  }, [processingOne, progress]);

  const onProcessOneById = useCallback((id: string) => {
    const m = items.find((i) => i.id === id);
    if (!m) return;
    void onProcessOne(m);
  }, [items, onProcessOne]);

  const onOpenOutput = useCallback(() => {
    if (!giftk) return;
    const target = lastBatchDir || outputDir;
    if (!target) return;
    giftk.openOutputDir(target).catch(() => { /* ignore */ });
  }, [outputDir, lastBatchDir]);

  // R-27 — open a *specific* historical record's output directory.
  // We invoke registerOutputDir first to handle the case where the
  // user just hydrated history but the panel is rendered before the
  // mount-time hydration effect ran (e.g. fast click on a freshly
  // reloaded app). The IPC call is idempotent and cheap.
  const onOpenHistoryDir = useCallback((dir: string) => {
    if (!giftk) return;
    if (!dir) return;
    const open = () => giftk.openOutputDir(dir).catch(() => { /* ignore */ });
    if (typeof giftk.registerOutputDir === 'function') {
      giftk.registerOutputDir(dir).then(open).catch(open);
    } else {
      open();
    }
  }, []);

  // R-27 — re-run a single SniffedMedia from a historical record using
  // the snapshotted options. Behaviour matches "逐条重跑": we do NOT
  // splice the record back into the main view; we just dispatch one
  // task and let the regular TaskTable surface progress.
  // R-27 (post-review #4.1): the previous implementation flipped
  // activeHistoryIdRef to rec.id and then setView('home'), so any
  // user action on the home view (re-sniff, single process, etc.)
  // would write back to the *historical* record instead of the live
  // one — race C in the review. We now register the per-task →
  // record mapping ONLY, leaving activeHistoryIdRef untouched, so
  // events from this re-run reach rec.id while subsequent home-view
  // dispatches keep targeting whatever record the user is currently
  // working with.
  // R-28 #2 — batch re-run from inside HistoryDetailModal. Mirrors
  // dispatchBatch (single-batch entry to startBatch) but pins every
  // task to the historical record id BEFORE awaiting startBatch so
  // the very first progress event lands in the correct record (the
  // home view's activeHistoryIdRef is unrelated). We seed `pending`
  // rows immediately for F3 parity with the home dispatch path. We
  // treat selectedSegments / forceAllowSmallSide already present on
  // the snapshotted options as authoritative — the modal's
  // OptionsForm lets the user edit globals and we don't try to
  // re-run the long-video segment-picker modal here (the user can
  // close, sniff again on home, and re-run there if they need a
  // fresh segment pick).
  // F2 (post R-27): we used to setView('home') in onReprocessFromHistory
  // so the user could watch progress in the home TaskTable. With the
  // new HistoryDetailModal the modal itself shows a record-scoped
  // TaskTable, so jumping back to home would actually *hide* the
  // user's view. Stay where we are. Both handlers now live inside
  // useProcessDispatch — see hook header for the full rationale.

  const toggleSelected = useCallback((id: string) => {
    // F1 (post R-27): an iframe-embed media (YouTube / Bilibili / Vimeo …)
    // is not actionable until yt-dlp resolves a direct stream URL — its
    // `selected` flag is meaningless because dispatchBatch / onProcessOne
    // already filter on `!requiresExternalDownload || resolved`. We block
    // the toggle at the source so users don't see a "ticked" checkbox
    // for an item that silently won't run, and so the selection counter
    // in the "开始批处理 (N / 共选 M)" badge stays truthful.
    const m = items.find((i) => i.id === id);
    if (m && m.requiresExternalDownload && !m.resolved) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const openCard = useCallback((id: string) => {
    setActiveId(id);
    setPreview(null);
  }, [setPreview]);

  const closeModal = useCallback(() => {
    setActiveId(null);
    setPreview(null);
    // P1.2 — discard the per-media preview override on close. Without this
    // the next time the modal is opened (different media or even the same
    // one) it would briefly render with a stale crop / time window before
    // PreviewModal's `useEffect[media.id]` fires the reset.
    setPreviewOverride({});
  }, [setPreview, setPreviewOverride]);

  if (!giftk) {
    return (
      <div style={{ padding: 24, color: 'var(--text)' }}>
        <h2>Preload 桥接未注入</h2>
        <p style={{ color: 'var(--muted)' }}>
          window.giftk 不可用,请通过 npm run dev 或正式打包后运行此应用,而不是直接打开 index.html。
        </p>
      </div>
    );
  }

  return (
    <div className="app" style={{ ['--bottom-h' as string]: `${bottomH}px` } as React.CSSProperties}>
      <TopBar
        view={view}
        setView={setView}
        reloadHistory={reloadHistory}
        historyCount={history.length}
        uploadHistoryCount={uploadHistory.length}
        outputDirLabel={baseOutputDir ? '根目录' : '选择输出目录'}
        outputDirTitle={
          baseOutputDir
            ? `当前根目录: ${baseOutputDir}\n点击在 Finder/资源管理器中打开`
            : '点击选择批处理输出根目录'
        }
        onPickDir={onPickDir}
        hasBaseOutputDir={!!baseOutputDir}
        onOpenCurrentDir={baseOutputDir ? () => {
          // R-WS-90 P5i — 直接在系统文件管理器中打开当前根目录;
          // 复用已有 IPC `app:openDir` (giftk.openOutputDir),与历史
          // 详情、history-card 行级「打开目录」语义一致。
          giftk.openOutputDir(baseOutputDir).catch(() => { /* ignore */ });
        } : undefined}
        onCheckForUpdates={onCheckForUpdates}
      />

      <UpdateModal
        open={updateOpen}
        result={updateResult}
        loading={updateLoading}
        onRecheck={onCheckForUpdates}
        onClose={() => setUpdateOpen(false)}
      />

      {view === 'home' ? (
      <div className="body">
        <div className="left">
          {/* Home controls only: URL/sniffing + conversion parameters.
              The processing progress dock belongs to the right-bottom
              workspace, matching the user's annotated layout. */}
          <div className="left-scroll">
          <SniffSection
            url={url}
            setUrl={setUrl}
            urlError={urlError}
            setUrlError={setUrlError}
            sniffing={sniffing}
            sniffProgress={sniffProgress}
            activeSniffMode={activeSniffMode}
            result={result}
            onSniff={onSniff}
            onCancel={onCancel}
            onPreferredWebviewSniff={onPreferredWebviewSniff}
            onFinalizeSystemChromeSniff={onFinalizeSystemChromeSniff}
            onOfflineImport={onOfflineImport}
            webviewMenu={webviewMenu}
            useRealChromeProfile={useRealChromeProfile}
            setUseRealChromeProfile={setUseRealChromeProfile}
            sniffHistoryOpen={sniffHistoryOpen}
            setSniffHistoryOpen={setSniffHistoryOpen}
            sniffHistory={sniffHistory}
            removeSniffHistory={removeSniffHistory}
            clearSniffHistory={clearSniffHistory}
            isSniffHistoryLoading={isSniffHistoryLoading}
          />

          <OptionsSection
            options={options}
            setOptions={setOptions}
            sniffing={sniffing}
            lastBatchDir={lastBatchDir}
            activeSniffMode={activeSniffMode}
            onCancel={onCancel}
            onFinalizeSystemChromeSniff={onFinalizeSystemChromeSniff}
          />
          </div>
        </div>

        <MediaGridPane
          items={items}
          selected={selected}
          toggleSelected={toggleSelected}
          openCard={openCard}
          onProcessOneById={onProcessOneById}
          isProcessingOne={isProcessingOne}
          onResolveEmbedById={onResolveEmbedById}
          isResolving={isResolving}
          resolveErrorMap={resolveErrorMap}
          onOpenOutput={onOpenOutput}
          lastBatchDir={lastBatchDir}
          outputDir={outputDir}
          onForceAllowAllFailed={onForceAllowAllFailed}
          forceAllowFailedCount={forceAllowFailedCount}
          forceAllowAllTitle={forceAllowAllTitle}
          onUploadAll={onUploadAll}
          uploadAllReady={uploadAllReady}
          uploadAllTitle={uploadAllTitle}
          uploadAllStats={uploadAllStats}
          setUploadSettingsOpen={setUploadSettingsOpen}
          onBottomResizeStart={onBottomResizeStart}
          resetBottomH={resetBottomH}
          isHomeBatchProcessing={isHomeBatchProcessing}
          progress={progress}
          onProcessOne={onProcessOne}
          forceAllowOne={forceAllowOne}
          onManualOptimize={onManualOptimize}
          onCancelOne={onCancelOne}
          onUploadOne={onUploadOne}
          onOpenInToolbox={onOpenInToolboxFromProgress}
          logs={logs}
          logsVisible={logsVisible}
          toggleLogs={toggleLogs}
          onCancel={onCancel}
          /* R-WS-2026-05-21 — Workspace tabs strip belongs WITH the
             right-column work surface (selected media + per-task
             progress). Switching tabs visibly swaps both at once;
             the left column (sniff URL / OptionsForm) follows via
             ws.activeWs data binding. The "+" button is intentionally
             not provided — workspaces are created exclusively by
             嗅探 → claimForSniff. Closed workspaces remain
             recoverable through the 历史 panel. */
          tabs={
            <WorkspaceTabs
              workspaces={ws.workspaces}
              activeId={ws.activeWsId}
              isBusy={ws.isBusy}
              onSwitch={ws.switchTo}
              onClose={(id) => {
                const w = ws.workspaces.find((x) => x.id === id);
                if (w && ws.isBusy(w) && typeof window !== 'undefined') {
                  const ok = window.confirm('该工作区有任务进行中,确定关闭?');
                  if (!ok) return;
                }
                ws.close(id);
              }}
            />
          }
        />
      </div>
      ) : (
        <SecondaryViews
          view={view as 'history' | 'toolbox' | 'uploads'}
          history={history}
          setHistoryDetail={setHistoryDetail}
          onOpenHistoryDir={onOpenHistoryDir}
          removeHistory={removeHistory}
          clearHistory={clearHistory}
          isHistoryLoading={isHistoryLoading}
          uploadHistory={uploadHistory}
          removeUploadHistory={removeUploadHistory}
          clearUploadHistory={clearUploadHistory}
          isUploadHistoryLoading={isUploadHistoryLoading}
          setView={setView}
          setUploadResult={setUploadResult}
          pendingPreset={pendingPreset}
          onApplyPreset={onApplyPresetFromHistory}
        />
      )}

      {view === 'home' ? (
        <StartBatchFab
          isHomeBatchProcessing={isHomeBatchProcessing}
          processable={processable}
          appendable={appendable}
          selected={selected}
          onStart={onStart}
          onAppend={onAppend}
        />
      ) : null}

      <ModalsHost
        activeMedia={activeMedia}
        options={options}
        previewOverride={previewOverride}
        setPreviewOverride={setPreviewOverride}
        setOptions={setOptions}
        onPreview={onPreview}
        previewing={previewing}
        preview={preview}
        closeModal={closeModal}
        onProcessOne={(m, ov) => onProcessOne(m, ov)}
        isProcessingOne={isProcessingOne}
        batchModal={batchModal}
        setBatchModal={setBatchModal}
        setLogs={setLogs}
        dispatchBatch={dispatchBatch}
        historyDetail={historyDetail}
        setHistoryDetail={setHistoryDetail}
        history={history}
        progress={progress}
        onReprocessFromHistory={onReprocessFromHistory}
        onBatchFromRecord={onBatchFromRecord}
        onCancel={onCancel}
        onOpenHistoryDir={onOpenHistoryDir}
        logs={logs}
        taskRecordMapRef={taskRecordMapRef}
        dispatchUpload={dispatchUpload}
        uploadConfigs={uploadConfigs}
        manualOpt={manualOpt}
        setManualOpt={setManualOpt}
        onManualOptimizeConfirm={onManualOptimizeConfirm}
        uploadSettingsOpen={uploadSettingsOpen}
        setUploadSettingsOpen={setUploadSettingsOpen}
        onSaveUploadSettings={onSaveUploadSettings}
        uploadResult={uploadResult}
        setUploadResult={setUploadResult}
        uploadHistory={uploadHistory}
        setView={setView}
        toasterHandleSetter={toaster.handleSetter}
      />
    </div>
  );
};

export default App;
