import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  SniffResult,
  ProcessOptions,
  TaskProgress,
  ProcessTask,
  PreviewResult,
  SniffProgress,
  SniffedMedia,
  ResolvedMedia,
  UploadConfigs,
  UploadHistoryItem,
  UploadProgress,
  UploadStartPayload
} from '../shared/types';
import { DEFAULT_OPTIONS } from '../shared/types';
import { MediaGrid } from './components/MediaGrid';
import { OptionsForm } from './components/OptionsForm';
import { PreviewModal } from './components/PreviewModal';
import { TaskTable } from './components/TaskTable';
import { LogBox } from './components/LogBox';
import { BatchSegmentModal, type BatchSegmentEntry } from './components/BatchSegmentModal';
import { HistoryPanel } from './components/HistoryPanel';
import { HistoryDetailModal } from './components/HistoryDetailModal';
import { ToolboxPanel } from './components/ToolboxPanel';
import {
  useHistory,
  makeHistoryRecord,
  mergeProgressIntoRecord,
  type HistoryRecord
} from './components/useHistory';
import { useSniffHistory } from './components/useSniffHistory';
import { SniffHistoryPicker } from './components/SniffHistoryPicker';
import { ManualOptimizeModal, type ManualOptimizeRequest } from './components/ManualOptimizeModal';
import { useUploadHistory } from './components/useUploadHistory';
import { UploadSettingsModal } from './components/UploadSettingsModal';
import { UploadHistoryPanel } from './components/UploadHistoryPanel';
import { UploadResultModal } from './components/UploadResultModal';

const giftk = (typeof window !== 'undefined' ? window.giftk : undefined);

const SNIFF_TIMEOUT_MS = 60_000;

const App: React.FC = () => {
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [sniffing, setSniffing] = useState(false);
  const [sniffProgress, setSniffProgress] = useState<SniffProgress | null>(null);
  const [result, setResult] = useState<SniffResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [options, setOptions] = useState<ProcessOptions>({ ...DEFAULT_OPTIONS });
  const [outputDir, setOutputDir] = useState<string>('');
  const [baseOutputDir, setBaseOutputDir] = useState<string>('');
  const [lastBatchDir, setLastBatchDir] = useState<string>('');
  const [progress, setProgress] = useState<Record<string, TaskProgress>>({});
  const [logs, setLogs] = useState<string[]>([]);
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
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [processingOne, setProcessingOne] = useState<Set<string>>(new Set());
  const [resolvedMap, setResolvedMap] = useState<Record<string, ResolvedMedia>>({});
  const [resolvingSet, setResolvingSet] = useState<Set<string>>(new Set());
  const [resolveErrorMap, setResolveErrorMap] = useState<Record<string, string>>({});
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
  const { history, pushOrReplace, patch: patchHistory, remove: removeHistory, clear: clearHistory, reload: reloadHistory } = useHistory();
  // R-32 — independent LRU of *URLs the user has sniffed* (capped at 30).
  // This is intentionally orthogonal to useHistory above — that hook
  // remembers full batch sessions, this one is the "address book" of
  // recently-visited pages so we can offer a quick picker on the URL
  // input. Sniff history is fed by the success branch of onSniff
  // below; the picker reads it via the popover state.
  const {
    entries: sniffHistory,
    addOrPromote: addSniffHistory,
    remove: removeSniffHistory,
    clear: clearSniffHistory
  } = useSniffHistory();
  const [sniffHistoryOpen, setSniffHistoryOpen] = useState(false);
  // R-51 — split-button state for the「网页嗅探」entry. The button now
  // offers two backends: the embedded WebContentsView (fast, but blocked
  // by Cloudflare on OpenAI / Medium / Patreon at the TLS layer) and a
  // spawn-the-user's-real-Chrome path that delegates the handshake to a
  // browser whose JA3 IS in CF's whitelist. The user's preferred mode is
  // remembered in localStorage so power users do not have to re-pick.
  const [webviewMenuOpen, setWebviewMenuOpen] = useState(false);
  const [preferredWebviewMode, setPreferredWebviewMode] = useState<'embed' | 'system-chrome'>(() => {
    try {
      const v = typeof localStorage !== 'undefined' ? localStorage.getItem('giftk:preferredWebviewMode') : null;
      return v === 'system-chrome' ? 'system-chrome' : 'embed';
    } catch { return 'embed'; }
  });
  const persistPreferredMode = useCallback((m: 'embed' | 'system-chrome') => {
    setPreferredWebviewMode(m);
    try { localStorage.setItem('giftk:preferredWebviewMode', m); } catch { /* ignore */ }
  }, []);
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

  // R-45 — image-host upload state. Settings are loaded once at mount via
  // ipc; the modal updates them in place. The upload-history hook owns
  // localStorage persistence; we only forward main-process progress
  // emits into it via uploadRecordRef (jobId → recordId mapping).
  const { history: uploadHistory, start: startUploadRecord, applyProgress: applyUploadProgress, remove: removeUploadHistory, clear: clearUploadHistory } = useUploadHistory();
  const [uploadConfigs, setUploadConfigs] = useState<UploadConfigs | null>(null);
  const [uploadSettingsOpen, setUploadSettingsOpen] = useState(false);
  const [uploadResult, setUploadResult] = useState<string | null>(null); // recordId
  const uploadJobToRecordRef = useRef<Map<string, string>>(new Map());
  const uploadInflightRef = useRef<Map<string, number>>(new Map()); // recordId → remaining-non-terminal count

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

  // Bottom panel (TaskTable + LogBox) resizable height.
  // Persisted in localStorage so the user's preference survives reloads.
  const BOTTOM_H_KEY = 'giftk.bottomPanelHeight';
  const BOTTOM_H_MIN = 80;
  const BOTTOM_H_DEFAULT = 180;
  const [bottomH, setBottomH] = useState<number>(() => {
    if (typeof window === 'undefined') return BOTTOM_H_DEFAULT;
    const raw = window.localStorage.getItem(BOTTOM_H_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= BOTTOM_H_MIN ? n : BOTTOM_H_DEFAULT;
  });

  const sniffReqId = useRef(0);
  const previewReqId = useRef(0);

  useEffect(() => {
    if (!giftk) return;
    giftk.getDefaultOutputDir().then((d) => {
      setOutputDir(d);
      setBaseOutputDir(d);
    }).catch(() => { /* ignore */ });
    // R-45 — load persisted upload settings (with secrets masked).
    if (typeof giftk.uploadGetSettings === 'function') {
      giftk.uploadGetSettings().then(setUploadConfigs).catch(() => { /* ignore */ });
    }
    const off1 = giftk.onProgress((p) => {
      setProgress((prev) => ({ ...prev, [p.taskId]: p }));
      // R-27 — fold the same emit into the OWNING history record so a
      // user who opens the history panel mid-batch sees outputs / status
      // accumulate live. We resolve the record id by taskId first
      // (dispatch-time mapping); fall back to activeHistoryIdRef only
      // when the task wasn't dispatched through one of our typed
      // entry points (defensive — should never happen in practice).
      const TERMINAL = ['done', 'failed', 'cancelled', 'skipped'];
      const recId =
        taskRecordMapRef.current.get(p.taskId) || activeHistoryIdRef.current;
      if (recId) {
        patchHistory(recId, (r) => mergeProgressIntoRecord(r, p));
      }
      if (TERMINAL.includes(p.status)) {
        taskRecordMapRef.current.delete(p.taskId);
      }
    });
    const off2 = giftk.onLog((line) => {
      setLogs((prev) => {
        const next = [...prev, line];
        return next.length > 300 ? next.slice(-300) : next;
      });
    });
    const off3 = giftk.onSniffProgress((p) => {
      setSniffProgress(p);
    });
    // R-45 — fold upload progress into the upload-history record that
    // owns each jobId. Terminal events decrement an in-flight counter
    // per record; when the counter reaches 0 we surface the central
    // result modal (per spec: "完成时弹中央面板").
    const off4 = typeof giftk.onUploadProgress === 'function'
      ? giftk.onUploadProgress((p: UploadProgress) => {
          const recId = uploadJobToRecordRef.current.get(p.jobId);
          if (!recId) return;
          applyUploadProgress(recId, p);
          const TERMINAL: Array<UploadProgress['status']> = ['done', 'failed', 'cancelled'];
          if (TERMINAL.includes(p.status)) {
            uploadJobToRecordRef.current.delete(p.jobId);
            const remaining = (uploadInflightRef.current.get(recId) ?? 0) - 1;
            if (remaining <= 0) {
              uploadInflightRef.current.delete(recId);
              setUploadResult(recId);
            } else {
              uploadInflightRef.current.set(recId, remaining);
            }
          }
        })
      : () => { /* noop */ };
    return () => {
      off1();
      off2();
      off3();
      off4();
    };
    // patchHistory is stable (memoised in useHistory with empty deps);
    // we want this effect to run exactly once on mount, so the missing
    // dep is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const onSniff = useCallback(async () => {
    if (!giftk) return;
    const trimmed = url.trim();
    if (!trimmed) {
      setUrlError('请先输入文章 URL');
      return;
    }
    // R-25 (#3): if the user just sniffed this same URL and the result is
    // still on screen, re-sniffing is almost always an accidental click.
    // Sniffing again throws away the current selection / resolved chips
    // and triggers another full network round-trip, so confirm first.
    if (result?.pageUrl === trimmed && (result.items.length > 0 || (result.warnings?.length ?? 0) > 0)) {
      const ok = typeof window !== 'undefined'
        ? window.confirm(`已嗅探过该 URL,是否再次嗅探?\n\n${trimmed}\n\n确认会清空当前结果重新拉取。`)
        : true;
      if (!ok) return;
    }
    setUrlError(null);
    const myId = ++sniffReqId.current;
    setSniffing(true);
    setSniffProgress({ stage: 'fetching', percent: 0 });
    setResult(null);
    setSelected(new Set());
    setActiveId(null);
    setPreview(null);
    setResolvedMap({});
    setResolvingSet(new Set());
    setResolveErrorMap({});
    // R-27 (post-review #1.1): a new sniff round invalidates the
    // previous "active" record. We clear it BEFORE the await so any
    // in-flight progress events from a still-running batch land on
    // their own record (looked up via the taskRecordMap below) rather
    // than getting silently dropped or — worse — splicing into the
    // record we're about to create.
    activeHistoryIdRef.current = null;

    let finished = false;
    const timeout = setTimeout(() => {
      if (finished) return;
      if (myId !== sniffReqId.current) return;
      finished = true;
      sniffReqId.current++;
      setSniffing(false);
      setSniffProgress(null);
      setResult({ pageUrl: trimmed, items: [], warnings: [`嗅探超时(>${SNIFF_TIMEOUT_MS / 1000}s),请稍后重试或换一个 URL`] });
    }, SNIFF_TIMEOUT_MS);

    try {
      const r = await giftk.sniff(trimmed);
      if (myId !== sniffReqId.current || finished) return;
      finished = true;
      clearTimeout(timeout);
      setResult(r);
      const auto = new Set(
        r.items
          .filter((i) => (i.kind === 'video' || i.kind === 'gif') && !i.requiresExternalDownload)
          .map((i) => i.id)
      );
      setSelected(auto);
      // R-27 — every successful sniff opens a fresh history record. We
      // create it here (with no outputDir yet) so even sniffs that
      // never get batched are surfaced — the user might just be
      // browsing what's on a page. The batch dispatcher mutates this
      // same record in place when process:start returns an outputDir.
      if (r.items.length > 0 || (r.warnings?.length ?? 0) === 0) {
        const rec = makeHistoryRecord({
          pageUrl: r.pageUrl,
          title: r.title,
          items: r.items,
          options: { ...options }
        });
        pushOrReplace(rec);
        activeHistoryIdRef.current = rec.id;
      } else {
        // A sniff with only warnings (timeout / parse error) is not
        // worth a history slot — it has no media to re-process.
        activeHistoryIdRef.current = null;
      }
      // R-32 — record the URL in the lightweight sniff-URL LRU.
      // We do this *regardless* of whether the sniff yielded any
      // items, because:
      //   - even a 0-item sniff is a valid history entry the user
      //     may want to revisit (e.g. to retry once a CDN's headers
      //     stop returning embed-only responses);
      //   - the entry's itemCount records the latest count so the
      //     picker can show "5 项" / "0 项" to hint at staleness.
      // We deliberately do NOT add on the timeout / catch branches
      // — those didn't produce a SniffResult so we have nothing
      // truthful to record.
      addSniffHistory({
        url: r.pageUrl,
        title: r.title,
        itemCount: r.items.length
      });
    } catch (e) {
      if (myId !== sniffReqId.current || finished) return;
      finished = true;
      clearTimeout(timeout);
      setResult({ pageUrl: trimmed, items: [], warnings: [(e as Error).message] });
    } finally {
      if (myId === sniffReqId.current) {
        setSniffing(false);
        setSniffProgress(null);
      }
    }
  }, [url, result, options, pushOrReplace, addSniffHistory]);

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
  const runWebviewSniff = useCallback(async (mode: 'embed' | 'system-chrome') => {
    const api = mode === 'system-chrome' ? giftk?.sniffWithSystemChrome : giftk?.sniffWithWebview;
    if (!api) return;
    const trimmed = url.trim();
    if (!trimmed) {
      setUrlError('请先输入文章 URL');
      return;
    }
    setUrlError(null);
    const myId = ++sniffReqId.current;
    setSniffing(true);
    setSniffProgress({ stage: 'fetching', percent: 0 });
    setResult(null);
    setSelected(new Set());
    setActiveId(null);
    setPreview(null);
    setResolvedMap({});
    setResolvingSet(new Set());
    setResolveErrorMap({});
    activeHistoryIdRef.current = null;
    const hint = mode === 'system-chrome'
      ? `[system-chrome] 启动系统 Chrome 打开 ${trimmed} — 登录/通过验证后,关闭 Chrome 窗口完成嗅探`
      : `[webview] 打开 ${trimmed} — 浏览到目标页面后,点击顶部「✅ 完成嗅探」`;
    setLogs((prev) => [...prev, hint].slice(-300));
    try {
      const r = await api(trimmed);
      if (myId !== sniffReqId.current) return;
      setResult(r);
      const auto = new Set(
        r.items
          .filter((i) => (i.kind === 'video' || i.kind === 'gif') && !i.requiresExternalDownload)
          .map((i) => i.id)
      );
      setSelected(auto);
      if (r.items.length > 0 || (r.warnings?.length ?? 0) === 0) {
        const rec = makeHistoryRecord({
          pageUrl: r.pageUrl,
          title: r.title,
          items: r.items,
          options: { ...options }
        });
        pushOrReplace(rec);
        activeHistoryIdRef.current = rec.id;
      }
      addSniffHistory({
        url: r.pageUrl,
        title: r.title,
        itemCount: r.items.length
      });
    } catch (e) {
      if (myId !== sniffReqId.current) return;
      setResult({ pageUrl: trimmed, items: [], warnings: [(e as Error).message] });
    } finally {
      if (myId === sniffReqId.current) {
        setSniffing(false);
        setSniffProgress(null);
      }
    }
  }, [url, options, pushOrReplace, addSniffHistory]);
  const onWebviewSniff = useCallback(() => runWebviewSniff('embed'), [runWebviewSniff]);
  const onSystemChromeSniff = useCallback(() => runWebviewSniff('system-chrome'), [runWebviewSniff]);
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
  }, [activeMedia, options, outputDir]);

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

  const dispatchBatch = useCallback(async (
    perIdSelection: Record<string, number[]> | null,
    // R-43 — override the default `processable` list. When the user
    // clicks "▶ 追加排队" while a batch is already running, we pass
    // the `appendable` subset so previously-queued rows aren't
    // double-submitted. When omitted (the original entry from
    // onStart / dispatchOnceConfirmed) we still process the full
    // selection.
    mediaListOverride?: SniffedMedia[]
  ) => {
    if (!giftk) return;
    const dir = baseOutputDir || outputDir;
    const sourceList = mediaListOverride ?? processable;
    const tasks: ProcessTask[] = sourceList.map((m) => {
      const opt: ProcessOptions = { ...options, outDir: dir };
      const dur = m.resolved?.durationSec ?? m.durationSec ?? 0;
      const tooLong = m.kind === 'video' && dur > options.maxSegmentSec;
      const userExplicit =
        opt.startSec !== undefined ||
        opt.endSec !== undefined ||
        (opt.selectedSegments && opt.selectedSegments.length > 0);
      // Priority order:
      // 1. Modal-confirmed selection wins (explicit user choice this batch).
      // 2. Per-task options.selectedSegments / startSec / endSec already set
      //    in the OptionsForm or PreviewPanel are honoured untouched.
      // 3. Long video without any explicit pick → R-22 fallback to [0].
      if (perIdSelection && perIdSelection[m.id] && perIdSelection[m.id].length > 0) {
        opt.selectedSegments = perIdSelection[m.id];
      } else if (tooLong && !userExplicit) {
        opt.selectedSegments = [0];
      }
      return { id: m.id, media: m, options: opt };
    });
    if (tasks.length === 0) return;
    // R-29 (P1-I): bind taskId → record id BEFORE awaiting startBatch
    // so the very first `process:progress` event from main is routed
    // to the right record. dispatchBatch used to set this AFTER the
    // await — fast machines / small queues could race and route the
    // first emit to the (stale) activeHistoryIdRef.
    const recId = activeHistoryIdRef.current;
    if (recId) {
      for (const t of tasks) taskRecordMapRef.current.set(t.id, recId);
    }
    // R-29 (P1-E + P1-F): seed `pending` rows MERGE-style and snapshot
    // any prior progress entry per task so a busy-rejection can put
    // the original done/failed row back instead of `delete`-ing it.
    // Replacing the whole map (the previous implementation) wiped
    // existing terminal rows and dropped progress events that arrived
    // between the seed and startBatch's resolve.
    const prevSnapshots: Record<string, TaskProgress | undefined> = {};
    for (const t of tasks) {
      prevSnapshots[t.id] = progress[t.id];
    }
    setProgress((prev) => {
      const next = { ...prev };
      for (const t of tasks) {
        next[t.id] = {
          taskId: t.id,
          status: 'pending',
          percent: 0,
          message: '已加入队列'
        };
      }
      return next;
    });
    const truncated = tasks.filter((t) =>
      t.options.selectedSegments && t.options.selectedSegments.length === 1 && t.options.selectedSegments[0] === 0 &&
      ((t.media.resolved?.durationSec ?? t.media.durationSec ?? 0) > options.maxSegmentSec)
    );
    if (truncated.length > 0) {
      setLogs((prev) => [
        ...prev,
        `[batch] ${truncated.length} 个长视频已默认只处理第 1 段(0..${options.maxSegmentSec}s);如需更多段,请在预览中勾选`
      ].slice(-300));
    }
    try {
      // R-29 (dirfix): if this record already has a sub-dir from a
      // prior dispatch (single-process / earlier batch), reuse it so
      // all sibling tasks land in the same folder.
      const existingDir = recId ? recordOutputDirRef.current.get(recId) : undefined;
      const r = await giftk.startBatch(tasks, result?.title, existingDir);
      setProcessingOne((prev) => {
        const n = new Set(prev);
        for (const t of tasks) n.add(t.id);
        return n;
      });
      if (r?.outputDir) {
        setLastBatchDir(r.outputDir);
        setLogs((prev) => [...prev, `[batch] outputs -> ${r.outputDir}`].slice(-300));
        // R-27 — pin the batch's sub-directory onto the active record
        // so the history panel can later "打开目录" without re-asking
        // the main process. R-27 (post-review #2.1/#3.1): snapshot the
        // *effective* per-task options actually dispatched (incl.
        // modal-injected selectedSegments / R-22 [0] fallback) instead
        // of the raw form `options`. We pick task[0]'s opt as the
        // representative — within one batch all tasks share the
        // same global parameters; only selectedSegments differ
        // per-task and that's already persisted on the items.
        if (recId) {
          recordOutputDirRef.current.set(recId, r.outputDir);
          const repOpt = tasks[0]?.options ?? { ...options, outDir: dir };
          patchHistory(recId, (rec) => ({
            ...rec,
            outputDir: r.outputDir,
            options: { ...repOpt }
          }));
        }
      }
    } catch (e) {
      const msg = (e as Error).message || '';
      if (msg === 'busy' || /\bbusy\b/i.test(msg)) {
        setLogs((prev) => [...prev, `[busy] 已有任务在跑,请先取消或等待`].slice(-300));
      } else {
        setLogs((prev) => [...prev, `[error] startBatch: ${msg}`].slice(-300));
      }
      // R-29 (P1-E): restore prior snapshots so a busy rejection no
      // longer wipes existing done/failed rows. Only revert entries
      // that are still our seeded `pending` (i.e. main hasn't begun
      // emitting real events for them yet).
      setProgress((prev) => {
        const next = { ...prev };
        for (const t of tasks) {
          if (next[t.id]?.status !== 'pending') continue;
          const snap = prevSnapshots[t.id];
          if (snap) {
            next[t.id] = snap;
          } else {
            delete next[t.id];
          }
        }
        return next;
      });
      // Unbind tasks we pinned up front — main rejected the batch so
      // no real events will ever come.
      for (const t of tasks) {
        taskRecordMapRef.current.delete(t.id);
      }
    }
  }, [processable, options, baseOutputDir, outputDir, result, patchHistory, progress]);

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
  }, [appendable, options, dispatchBatch]);

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
  }, []);

  const onProcessOne = useCallback(async (media: SniffedMedia, override?: {
    forceAllowSmallSide?: boolean;
    /** R-33A — opt-in to manual re-optimize. Fed straight to processor. */
    reoptimizeFromGifPath?: string;
    /** R-33A — when re-optimizing, override these three knobs only. */
    maxBytes?: number;
    fps?: number;
    maxWidth?: number;
  }) => {
    if (!giftk) return;
    if (media.kind === 'image') {
      setLogs((prev) => [...prev, `[single] 已跳过(image 不支持处理): ${media.url}`].slice(-300));
      return;
    }
    if (media.requiresExternalDownload && !media.resolved) {
      setLogs((prev) => [...prev, `[single] 已跳过(${media.embedHost || '第三方'} 嵌入,未解析直链): ${media.url}`].slice(-300));
      return;
    }
    const dir = baseOutputDir || outputDir;
    // R-22 (single): mirror onStart's auto-truncation so retry/single-process
    // long videos don't accidentally explode into N segment tasks. The user
    // can still expand to all segments by ticking checkboxes in the modal.
    const optBase: ProcessOptions = { ...options, outDir: dir };
    // R-26 — when the caller asks for the spec-bypass override (clicked the
    // failed task's "强制允许" button), inject the flag into THIS dispatch
    // only. The component-level `options` state is untouched so the next
    // batch re-uses the user's normal minSize.
    if (override?.forceAllowSmallSide) {
      optBase.forceAllowSmallSide = true;
    }
    // R-33A — manual re-optimize: redirect input to the previously saved gif
    // file, override only the user-tunable knobs (maxBytes/fps/maxWidth),
    // and force-disable skipCompress (we're re-running the compress loop on
    // purpose). Every other field of the live options form survives.
    if (override?.reoptimizeFromGifPath) {
      optBase.reoptimizeFromGifPath = override.reoptimizeFromGifPath;
      optBase.skipCompress = undefined;
      if (typeof override.maxBytes === 'number') {
        optBase.maxBytes = override.maxBytes;
        // softMaxBytes must remain ≤ maxBytes — clamp to the smaller of
        // the form's existing soft and 80% of the new hard target so the
        // compress loop's "best target" tier still has room above it.
        const softCap = Math.min(optBase.softMaxBytes, Math.round(override.maxBytes * 0.8));
        optBase.softMaxBytes = Math.max(100 * 1024, softCap);
      }
      if (typeof override.fps === 'number') optBase.fps = override.fps;
      if (typeof override.maxWidth === 'number') optBase.maxWidth = override.maxWidth;
    }
    const dur = media.resolved?.durationSec ?? media.durationSec ?? 0;
    const tooLong = media.kind === 'video' && dur > options.maxSegmentSec;
    const userPickedRange =
      optBase.startSec !== undefined ||
      optBase.endSec !== undefined ||
      (optBase.selectedSegments && optBase.selectedSegments.length > 0);
    if (tooLong && !userPickedRange) {
      optBase.selectedSegments = [0];
      setLogs((prev) => [
        ...prev,
        `[single] 长视频(${dur.toFixed(1)}s)默认只处理第 1 段(0..${options.maxSegmentSec}s);如需更多段,请在预览中勾选`
      ].slice(-300));
    }
    const tasks: ProcessTask[] = [
      { id: media.id, media, options: optBase }
    ];
    // R-29 (P1-I): pin the task → record mapping BEFORE awaiting
    // startBatch so the very first `process:progress` event lands
    // in the correct record. We snapshot any prior progress entry so
    // a busy / error rejection can put it back instead of silently
    // erasing a previous done/failed row (P1-E).
    const recId = activeHistoryIdRef.current;
    if (recId) {
      taskRecordMapRef.current.set(media.id, recId);
    }
    const prevSnapshot = progress[media.id];
    setProgress((prev) => ({
      ...prev,
      [media.id]: {
        taskId: media.id,
        status: 'pending',
        percent: 0,
        message: '已加入队列'
      }
    }));
    try {
      // R-29 (dirfix): reuse this record's existing batch sub-dir so
      // a single-process / retry doesn't carve out its own folder.
      const existingDir = recId ? recordOutputDirRef.current.get(recId) : undefined;
      const r = await giftk.startBatch(tasks, result?.title, existingDir);
      setProcessingOne((prev) => {
        const n = new Set(prev);
        n.add(media.id);
        return n;
      });
      if (r?.outputDir) {
        setLastBatchDir(r.outputDir);
        setLogs((prev) => [...prev, `[single] outputs -> ${r.outputDir}`].slice(-300));
        // R-27 — same as batch: pin the sub-dir onto the active record.
        // R-27 (post-review #2.1/#3.1): persist the *effective* opt
        // (including R-26 forceAllowSmallSide / R-22 [0] segment
        // fallback) — historically this stored the raw form options
        // and lost the override flag.
        if (recId) {
          recordOutputDirRef.current.set(recId, r.outputDir);
          patchHistory(recId, (rec) => ({
            ...rec,
            outputDir: r.outputDir,
            options: { ...optBase }
          }));
        }
      }
    } catch (e) {
      const msg = (e as Error).message || '';
      if (msg === 'busy' || /\bbusy\b/i.test(msg)) {
        setLogs((prev) => [...prev, `[busy] 已有任务在跑,请先取消或等待`].slice(-300));
      } else {
        setLogs((prev) => [...prev, `[error] startBatch(single): ${msg}`].slice(-300));
      }
      // R-29 (P1-E): restore prior snapshot so the previous
      // done/failed row survives a busy rejection.
      setProgress((prev) => {
        if (prev[media.id]?.status !== 'pending') return prev;
        const next = { ...prev };
        if (prevSnapshot) {
          next[media.id] = prevSnapshot;
        } else {
          delete next[media.id];
        }
        return next;
      });
      taskRecordMapRef.current.delete(media.id);
    }
  }, [options, baseOutputDir, outputDir, result, patchHistory, progress]);

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
  }, []);

  const onManualOptimizeConfirm = useCallback(async (req: ManualOptimizeRequest) => {
    if (!manualOpt) return;
    const { media, gifPath } = manualOpt;
    setManualOpt(null);
    await onProcessOne(media, {
      reoptimizeFromGifPath: gifPath,
      maxBytes: req.maxBytes,
      fps: req.fps,
      maxWidth: req.maxWidth
    });
  }, [manualOpt, onProcessOne]);

  // R-45 — kick off uploads for an array of (media, output-paths). Used
  // by the per-row "📤 上传" button (single output) and the global
  // "⚡ 上传所有产物" button (every "done" task with at least one output).
  // Creates ONE upload-history record for the whole batch so the
  // central result modal surfaces consolidated markdown when all jobs
  // settle.
  const dispatchUpload = useCallback(async (
    plan: Array<{ media: SniffedMedia; filePath: string }>
  ): Promise<void> => {
    if (!giftk || typeof giftk.uploadStart !== 'function') return;
    if (plan.length === 0) {
      setLogs((prev) => [...prev, `[upload] 没有可上传的产物(需要 done 状态且至少有一个输出)`].slice(-300));
      return;
    }
    if (!uploadConfigs) {
      setLogs((prev) => [...prev, `[upload] 上传后端未配置,先打开「📤 上传设置」`].slice(-300));
      setUploadSettingsOpen(true);
      return;
    }
    const backend = uploadConfigs.active;
    const items: UploadHistoryItem[] = plan.map((entry) => ({
      jobId: '', // filled in after uploadStart resolves
      backend,
      fileName: entry.filePath.split(/[\\/]/).pop() || entry.filePath,
      filePath: entry.filePath,
      status: 'pending'
    }));
    // Reserve the record id NOW so onUploadProgress can route emits.
    const recId = startUploadRecord({ backend, items });
    try {
      const payload: UploadStartPayload = {
        jobs: plan.map((entry, i) => ({
          id: `${recId}-${i}`,
          filePath: entry.filePath,
          remoteName: entry.filePath.split(/[\\/]/).pop() || undefined
        }))
      };
      const r = await giftk.uploadStart(payload);
      if (!r.ok) throw new Error('uploadStart failed');
      // Bind jobIds → record + seed in-flight counter so the central
      // modal opens when every job settles.
      uploadInflightRef.current.set(recId, r.jobIds.length);
      r.jobIds.forEach((jobId, i) => {
        uploadJobToRecordRef.current.set(jobId, recId);
        // Patch the placeholder jobId-less item so the history row can
        // be located by jobId on subsequent applyProgress calls.
        applyUploadProgress(recId, {
          jobId,
          status: 'pending',
          percent: 0
        });
        // Edge case: applyProgress can't locate a row by an empty
        // jobId, so we re-seed via a manual patch. Easier path:
        // re-set the record items via startUploadRecord-style mutation
        // would force a render. Instead, we exploit applyProgress'
        // findIndex(jobId === p.jobId): since rows have jobId='',
        // findIndex returns -1 (no match) and the call no-ops. The
        // first real progress emit from main lands on the placeholder
        // anyway because we update items[i].jobId here:
        items[i].jobId = jobId;
      });
      setLogs((prev) => [...prev, `[upload] 已派发 ${r.jobIds.length} 个上传任务`].slice(-300));
    } catch (e) {
      setLogs((prev) => [...prev, `[upload] 派发失败: ${(e as Error).message}`].slice(-300));
      uploadInflightRef.current.delete(recId);
    }
  }, [uploadConfigs, startUploadRecord, applyUploadProgress]);

  // R-45 — single-output upload for a TaskTable row. Picks the FIRST
  // output (typically the .gif). Power users wanting to upload every
  // output of a task should use 「⚡ 上传所有产物」 instead.
  const onUploadOne = useCallback(async (media: SniffedMedia, p: TaskProgress): Promise<void> => {
    const out = p.outputs?.[0];
    if (!out) {
      setLogs((prev) => [...prev, `[upload] 跳过:任务 ${media.id} 没有可用输出`].slice(-300));
      return;
    }
    await dispatchUpload([{ media, filePath: out }]);
  }, [dispatchUpload]);

  // R-45 — global "⚡ 上传所有产物". Walks every "done" row in `progress`
  // and uploads its first output. Skips rows without outputs.
  const onUploadAll = useCallback(async (): Promise<void> => {
    const plan: Array<{ media: SniffedMedia; filePath: string }> = [];
    for (const m of items) {
      const p = progress[m.id];
      if (!p || p.status !== 'done') continue;
      const out = p.outputs?.[0];
      if (!out) continue;
      plan.push({ media: m, filePath: out });
    }
    await dispatchUpload(plan);
  }, [items, progress, dispatchUpload]);

  const onSaveUploadSettings = useCallback(async (next: UploadConfigs): Promise<void> => {
    if (!giftk || typeof giftk.uploadSetSettings !== 'function') return;
    await giftk.uploadSetSettings(next);
    // Re-load to pick up the masked secrets that main now persists.
    if (typeof giftk.uploadGetSettings === 'function') {
      const fresh = await giftk.uploadGetSettings();
      setUploadConfigs(fresh);
    }
  }, []);

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

  const onResolveEmbedById = useCallback(async (id: string) => {
    if (!giftk?.resolveEmbed) return;
    const m = items.find((i) => i.id === id);
    if (!m) return;
    if (!m.requiresExternalDownload) return;
    if (resolvedMap[id]) return;
    if (resolvingSet.has(id)) return;

    setResolvingSet((prev) => {
      const n = new Set(prev); n.add(id); return n;
    });
    setResolveErrorMap((prev) => {
      if (!prev[id]) return prev;
      const n = { ...prev }; delete n[id]; return n;
    });
    setLogs((prev) => [...prev, `[resolve] ${m.embedHost} ← ${m.pageUrl}`].slice(-300));
    try {
      const r = await giftk.resolveEmbed(m);
      setResolvedMap((prev) => ({ ...prev, [id]: r }));
      // Auto-select the now-resolved item so the user can immediately batch.
      setSelected((prev) => {
        const n = new Set(prev); n.add(id); return n;
      });
      setLogs((prev) => [...prev, `[resolve] ✓ ${r.qualityLabel || ''} ${r.width || '?'}x${r.height || '?'} (${r.extractor || 'ytdlp'})`].slice(-300));
    } catch (e) {
      const msg = (e as Error).message || '';
      const display = msg === 'YT_DLP_UNAVAILABLE'
        ? 'yt-dlp 不可用(可能离线且本地无缓存),稍后再试'
        : msg;
      setResolveErrorMap((prev) => ({ ...prev, [id]: display }));
      setLogs((prev) => [...prev, `[resolve] 失败: ${display}`].slice(-300));
    } finally {
      setResolvingSet((prev) => {
        const n = new Set(prev); n.delete(id); return n;
      });
    }
  }, [items, resolvedMap, resolvingSet]);

  // Auto-batch-resolve: whenever the sniff result changes, kick off resolve
  // for every embed that still needs one. Concurrency is bounded inside the
  // main process resolver (yt-dlp is already CPU-bound), so we just fire all
  // pending IDs and let the resolver coalesce.
  useEffect(() => {
    if (!result || result.items.length === 0) return;
    const pending = result.items.filter(
      (m) => m.requiresExternalDownload && !resolvedMap[m.id] && !resolvingSet.has(m.id) && !resolveErrorMap[m.id]
    );
    for (const m of pending) {
      void onResolveEmbedById(m.id);
    }
    // Intentionally don't depend on resolvedMap/resolvingSet to avoid an
    // immediate re-fire on every state delta — onResolveEmbedById's own
    // guards are enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const isResolving = useCallback((id: string): boolean => resolvingSet.has(id), [resolvingSet]);

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
  const onReprocessFromHistory = useCallback((rec: HistoryRecord, media: SniffedMedia) => {
    if (!giftk) return;
    if (media.kind === 'image') return;
    if (media.requiresExternalDownload && !media.resolved) return;
    const dir = rec.options.outDir || baseOutputDir || outputDir;
    const optBase: ProcessOptions = { ...rec.options, outDir: dir };
    const tasks: ProcessTask[] = [{ id: media.id, media, options: optBase }];
    // F3 (post R-27): seed pending so the row appears in the TaskTable
    // immediately after the user clicks 重跑 in history. Bind the
    // task→record map up front too — otherwise a fast first
    // `process:progress` could arrive before .then() runs and would
    // be routed to the *active* (home) record.
    taskRecordMapRef.current.set(media.id, rec.id);
    // R-29 (P1-E): snapshot prior progress entry so a busy/error
    // rejection restores it instead of nuking it.
    const prevSnapshot = progress[media.id];
    setProgress((prev) => ({
      ...prev,
      [media.id]: {
        taskId: media.id,
        status: 'pending',
        percent: 0,
        message: '已加入队列'
      }
    }));
    setLogs((prev) => [
      ...prev,
      `[history] re-run "${shortDir(media.url)}" (record ${rec.id})`
    ].slice(-300));
    // R-29 (dirfix): reuse this record's batch sub-dir if known so
    // re-run outputs land alongside the original ones.
    const existingDir = recordOutputDirRef.current.get(rec.id) || rec.outputDir;
    giftk.startBatch(tasks, rec.title, existingDir)
      .then((r) => {
        setProcessingOne((prev) => {
          const n = new Set(prev); n.add(media.id); return n;
        });
        if (r?.outputDir) {
          setLastBatchDir(r.outputDir);
          recordOutputDirRef.current.set(rec.id, r.outputDir);
          patchHistory(rec.id, (cur) => ({
            ...cur,
            outputDir: r.outputDir,
            options: { ...optBase }
          }));
        }
      })
      .catch((e: Error) => {
        const msg = e?.message || '';
        if (/\bbusy\b/i.test(msg)) {
          setLogs((prev) => [...prev, `[busy] 已有任务在跑,请先取消或等待`].slice(-300));
        } else {
          setLogs((prev) => [...prev, `[error] history re-run: ${msg}`].slice(-300));
        }
        // R-29 (P1-E): restore prior snapshot + unbind so a busy /
        // error rejection doesn't leak into the record view.
        setProgress((prev) => {
          if (prev[media.id]?.status !== 'pending') return prev;
          const next = { ...prev };
          if (prevSnapshot) {
            next[media.id] = prevSnapshot;
          } else {
            delete next[media.id];
          }
          return next;
        });
        taskRecordMapRef.current.delete(media.id);
      });
    // F2 (post R-27): we used to setView('home') here so the user
    // could watch progress in the home TaskTable. With the new
    // HistoryDetailModal the modal itself shows a record-scoped
    // TaskTable, so jumping back to home would actually *hide* the
    // user's view. Stay where we are.
  }, [baseOutputDir, outputDir, patchHistory, progress]);

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
  const onBatchFromRecord = useCallback((
    rec: HistoryRecord,
    medias: SniffedMedia[],
    opts: ProcessOptions
  ) => {
    if (!giftk) return;
    if (medias.length === 0) return;
    const dir = rec.options.outDir || baseOutputDir || outputDir;
    const tasks: ProcessTask[] = medias.map((m) => {
      const opt: ProcessOptions = { ...opts, outDir: dir };
      const dur = m.resolved?.durationSec ?? m.durationSec ?? 0;
      const tooLong = m.kind === 'video' && dur > opt.maxSegmentSec;
      const userExplicit =
        opt.startSec !== undefined ||
        opt.endSec !== undefined ||
        (opt.selectedSegments && opt.selectedSegments.length > 0);
      if (tooLong && !userExplicit) {
        // Same R-22 fallback as dispatchBatch.
        opt.selectedSegments = [0];
      }
      return { id: m.id, media: m, options: opt };
    });
    // Pin all tasks to the record up front (must happen before await
    // so an early process:progress event routes correctly).
    for (const t of tasks) {
      taskRecordMapRef.current.set(t.id, rec.id);
    }
    // R-29 (P1-E): snapshot prior progress per task so a busy
    // rejection restores them instead of erasing.
    const prevSnapshots: Record<string, TaskProgress | undefined> = {};
    for (const t of tasks) {
      prevSnapshots[t.id] = progress[t.id];
    }
    setProgress((prev) => {
      const next = { ...prev };
      for (const t of tasks) {
        next[t.id] = {
          taskId: t.id,
          status: 'pending',
          percent: 0,
          message: '已加入队列'
        };
      }
      return next;
    });
    setLogs((prev) => [
      ...prev,
      `[history] batch re-run "${rec.title || rec.pageUrl}" (record ${rec.id}) ${tasks.length} 项`
    ].slice(-300));
    // R-29 (dirfix): reuse this record's existing sub-dir for the
    // batch re-run so all outputs share the original folder.
    const existingDir = recordOutputDirRef.current.get(rec.id) || rec.outputDir;
    giftk.startBatch(tasks, rec.title, existingDir)
      .then((r) => {
        if (r?.outputDir) {
          setLastBatchDir(r.outputDir);
          recordOutputDirRef.current.set(rec.id, r.outputDir);
          patchHistory(rec.id, (cur) => ({
            ...cur,
            outputDir: r.outputDir,
            options: { ...tasks[0].options }
          }));
        }
      })
      .catch((e: Error) => {
        const msg = e?.message || '';
        if (/\bbusy\b/i.test(msg)) {
          setLogs((prev) => [...prev, `[busy] 已有任务在跑,请先取消或等待`].slice(-300));
        } else {
          setLogs((prev) => [...prev, `[error] history batch re-run: ${msg}`].slice(-300));
        }
        // R-29 (P1-E): restore prior snapshots + unbind.
        setProgress((prev) => {
          const next = { ...prev };
          for (const t of tasks) {
            if (next[t.id]?.status !== 'pending') continue;
            const snap = prevSnapshots[t.id];
            if (snap) {
              next[t.id] = snap;
            } else {
              delete next[t.id];
            }
          }
          return next;
        });
        for (const t of tasks) {
          taskRecordMapRef.current.delete(t.id);
        }
      });
  }, [baseOutputDir, outputDir, patchHistory, progress]);

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
  }, [items]);

  const openCard = useCallback((id: string) => {
    setActiveId(id);
    setPreview(null);
  }, []);

  const closeModal = useCallback(() => {
    setActiveId(null);
    setPreview(null);
  }, []);

  // Drag handler for the resizable bottom panel. Computed against
  // window.innerHeight so the gesture maps 1:1 with cursor movement.
  // Persists final value to localStorage on mouseup.
  const onBottomResizeStart = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = bottomH;
    const onMove = (ev: MouseEvent) => {
      const dy = startY - ev.clientY;
      const maxH = Math.max(BOTTOM_H_MIN + 1, Math.floor(window.innerHeight * 0.7));
      const next = Math.min(maxH, Math.max(BOTTOM_H_MIN, startH + dy));
      setBottomH(next);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        // setBottomH is async; read latest from a closure-stable getter.
        // We piggy-back on next tick by reading from state on the next call.
        // Simplest: write the most recent value via a setter snapshot.
        setBottomH((v) => {
          window.localStorage.setItem(BOTTOM_H_KEY, String(v));
          return v;
        });
      } catch { /* ignore quota errors */ }
    };
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [bottomH]);

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

  const stageLabel = (s: SniffProgress['stage']): string => {
    switch (s) {
      case 'fetching': return '抓取页面';
      case 'parsing': return '解析 DOM';
      case 'probing': return '探测元数据';
      case 'done': return '完成';
    }
  };

  return (
    <div className={`app${view !== 'home' ? ' app-no-bottom' : ''}`} style={{ ['--bottom-h' as string]: `${bottomH}px` } as React.CSSProperties}>
      <div className="titlebar">
        <h1>Gif Toolkit · 网页媒体一站式抓取与转换</h1>
        <div className="tabs">
          <button
            type="button"
            className={`tab-btn ${view === 'home' ? 'active' : ''}`}
            onClick={() => setView('home')}
            aria-pressed={view === 'home'}
          >
            主页
          </button>
          <button
            type="button"
            className={`tab-btn ${view === 'history' ? 'active' : ''}`}
            onClick={() => {
              // R-34 — every click on the history tab forces a fresh
              // resync from localStorage. This handles two cases:
              //   1. in-flight progress that the 250ms debounce in
              //      useHistory hasn't yet flushed — without this we
              //      could show counts that are 1-2 emits behind the
              //      home view's TaskTable;
              //   2. external mutations (another renderer / window).
              // Calling reload unconditionally (not gated on
              // view !== 'history') makes "click again to refresh" a
              // first-class affordance: if the user wants to re-poll
              // the latest data while already on the history tab they
              // just click 历史 again.
              reloadHistory();
              setView('history');
            }}
            aria-pressed={view === 'history'}
          >
            历史 {history.length > 0 ? `(${history.length})` : ''}
          </button>
          <button
            type="button"
            className={`tab-btn ${view === 'toolbox' ? 'active' : ''}`}
            onClick={() => setView('toolbox')}
            aria-pressed={view === 'toolbox'}
          >
            工具箱
          </button>
          <button
            type="button"
            className={`tab-btn ${view === 'uploads' ? 'active' : ''}`}
            onClick={() => setView('uploads')}
            aria-pressed={view === 'uploads'}
            title="查看上传到图床的历史"
          >
            上传历史 {uploadHistory.length > 0 ? `(${uploadHistory.length})` : ''}
          </button>
        </div>
        <div className="spacer" />
        <div className="actions">
          <button onClick={onPickDir}>{baseOutputDir ? `根目录: ${shortDir(baseOutputDir)}` : '选择输出目录'}</button>
          {/* R-30 #1 — the per-batch "打开目录" button used to live
              here in the global title bar. With the history tab in
              place that placement was confusing (looked like a
              global "open the active history's dir" while it was
              actually only ever the latest *home* batch). It now
              moves into the home view's grid-header below so it's
              co-located with the media list it produced; history
              records each carry their own per-row 打开目录. */}
        </div>
      </div>

      {view === 'home' ? (
      <div className="body">
        <div className="left">
          <div className="section fixed">
            <h2>1. 输入文章 URL</h2>
            <div className="url-bar">
              <input
                type="text"
                placeholder="https://example.com/article"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  if (urlError) setUrlError(null);
                }}
                onKeyDown={(e) => e.key === 'Enter' && onSniff()}
              />
              {/* R-32 — quick picker of recently-sniffed URLs. The
                  trigger toggles the popover; the popover itself is
                  positioned absolutely inside .url-bar so it floats
                  above the rest of the page. */}
              <button
                type="button"
                className={`sniff-hist-trigger${sniffHistoryOpen ? ' open' : ''}`}
                onClick={() => setSniffHistoryOpen((v) => !v)}
                disabled={sniffHistory.length === 0}
                title={sniffHistory.length === 0 ? '暂无解析历史' : '从解析历史选择 URL'}
                aria-haspopup="dialog"
                aria-expanded={sniffHistoryOpen}
                aria-label="解析历史"
              >
                ☰
              </button>
              <button className="primary" onClick={onSniff} disabled={sniffing} style={{ whiteSpace: 'nowrap' }}>
                {sniffing ? '嗅探中…' : '嗅探'}
              </button>
              {/* R-44/R-47 — webview-assisted sniff button. Disabled
                  while any sniff (headless or webview) is in flight,
                  since both paths share `sniffing` and the same UI
                  slot for results. R-47 reframes the entry as a
                  general-purpose "网页嗅探" since users may use it for
                  bot-walled / OAuth pages, not only signed-in ones.
                  R-51 — split button: main click runs the user's last
                  preferred mode (embedded webview vs system Chrome),
                  the caret next to it opens a small menu so they can
                  switch. The system-Chrome path bypasses Cloudflare
                  TLS / HTTP/2 fingerprint checks by spawning the
                  user's actual installed Chrome. */}
              <div className="webview-sniff-split" style={{ position: 'relative', display: 'inline-flex' }}>
                <button
                  className="ghost"
                  onClick={onPreferredWebviewSniff}
                  disabled={sniffing}
                  title={preferredWebviewMode === 'system-chrome'
                    ? '在你本机 Chrome / Edge / Brave 中打开,登录或通过验证后关闭窗口完成嗅探(适合 OpenAI / Medium 等高保护站点)'
                    : '打开内置浏览器,先浏览到目标页面再嗅探(适合需要交互/登录/验证机器人的站点)'}
                  style={{ whiteSpace: 'nowrap', borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
                >
                  {sniffing
                    ? '嗅探中…'
                    : (preferredWebviewMode === 'system-chrome' ? '🚀 真 Chrome 嗅探' : '🌐 网页嗅探')}
                </button>
                <button
                  className="ghost webview-sniff-caret"
                  onClick={() => setWebviewMenuOpen((v) => !v)}
                  disabled={sniffing}
                  aria-haspopup="menu"
                  aria-expanded={webviewMenuOpen}
                  aria-label="切换网页嗅探方式"
                  title="切换嗅探方式"
                  style={{
                    whiteSpace: 'nowrap',
                    borderTopLeftRadius: 0,
                    borderBottomLeftRadius: 0,
                    borderLeft: 'none',
                    padding: '0 8px',
                    minWidth: 'auto'
                  }}
                >
                  ▾
                </button>
                {webviewMenuOpen ? (
                  <div
                    role="menu"
                    className="webview-sniff-menu"
                    style={{
                      position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 60,
                      minWidth: 280, padding: 6, borderRadius: 8,
                      background: 'var(--bg-2, #23252b)', color: 'var(--fg, #e6e7eb)',
                      border: '1px solid rgba(255,255,255,0.12)',
                      boxShadow: '0 8px 24px rgba(0,0,0,0.35)'
                    }}
                    onMouseLeave={() => setWebviewMenuOpen(false)}
                  >
                    <button
                      className="ghost"
                      role="menuitem"
                      onClick={() => {
                        setWebviewMenuOpen(false);
                        persistPreferredMode('embed');
                        onWebviewSniff();
                      }}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left',
                        padding: '8px 10px', whiteSpace: 'normal',
                        background: preferredWebviewMode === 'embed' ? 'rgba(42,170,119,0.12)' : 'transparent'
                      }}
                    >
                      <div style={{ fontWeight: 600 }}>
                        🌐 嵌入式嗅探(快){preferredWebviewMode === 'embed' ? ' ✓' : ''}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--muted, #9aa0aa)', marginTop: 2 }}>
                        在 app 内置浏览器打开,适合普通需登录/交互的站点。
                      </div>
                    </button>
                    <button
                      className="ghost"
                      role="menuitem"
                      onClick={() => {
                        setWebviewMenuOpen(false);
                        persistPreferredMode('system-chrome');
                        onSystemChromeSniff();
                      }}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left',
                        padding: '8px 10px', whiteSpace: 'normal', marginTop: 4,
                        background: preferredWebviewMode === 'system-chrome' ? 'rgba(42,170,119,0.12)' : 'transparent'
                      }}
                    >
                      <div style={{ fontWeight: 600 }}>
                        🚀 真 Chrome 嗅探(过 Cloudflare){preferredWebviewMode === 'system-chrome' ? ' ✓' : ''}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--muted, #9aa0aa)', marginTop: 2 }}>
                        启动你本机的 Chrome / Edge / Brave,真实浏览器握手,适合 OpenAI / Medium / Patreon 等高保护站点。
                      </div>
                    </button>
                  </div>
                ) : null}
              </div>
              <SniffHistoryPicker
                open={sniffHistoryOpen}
                entries={sniffHistory}
                onPick={(picked) => {
                  // Per R-32 design Q3: just fill the input. The user
                  // explicitly presses 嗅探 to actually go fetch.
                  setUrl(picked);
                  if (urlError) setUrlError(null);
                  setSniffHistoryOpen(false);
                }}
                onRemove={(picked) => removeSniffHistory(picked)}
                onClear={() => {
                  clearSniffHistory();
                  setSniffHistoryOpen(false);
                }}
                onClose={() => setSniffHistoryOpen(false)}
              />
            </div>
            {urlError ? (
              <div className="notice danger">{urlError}</div>
            ) : null}
            {sniffing && sniffProgress ? (
              <div className="sniff-progress">
                <div className="sniff-progress-row">
                  <span className="sniff-stage">{stageLabel(sniffProgress.stage)}</span>
                  <span className="sniff-counts">
                    {typeof sniffProgress.found === 'number' ? `found ${sniffProgress.found}` : ''}
                    {typeof sniffProgress.probed === 'number' && typeof sniffProgress.total === 'number'
                      ? ` · probed ${sniffProgress.probed}/${sniffProgress.total}`
                      : ''}
                  </span>
                  <span className="sniff-percent">{Math.round(sniffProgress.percent)}%</span>
                </div>
                <div className="bar-wrap">
                  <div className="bar" style={{ width: `${Math.max(0, Math.min(100, sniffProgress.percent))}%` }} />
                </div>
                {sniffProgress.message ? (
                  <div className="notice" style={{ marginTop: 4 }}>{sniffProgress.message}</div>
                ) : null}
              </div>
            ) : null}
            {!sniffing && result?.warnings.length ? (
              <div className="notice danger">{result.warnings.join('; ')}</div>
            ) : null}
            {!sniffing && result?.title ? <div className="notice">{result.title}</div> : null}
          </div>

          <div className="section fixed left-bottom">
            <h2>3. 处理参数</h2>
            <OptionsForm value={options} onChange={setOptions} />
            {/* R-50 — 旧的内嵌「▶ 开始批处理 / ▶ 追加排队」按钮已迁移到
                位于视口右下角的悬浮 FAB(见下方 .fab-start-batch)。FAB
                完整继承了原按钮的所有判断逻辑:idle vs running、
                processable.length vs appendable.length、disabled 条件、
                title 文案。这里只保留嗅探取消入口与「已输出到子目录」
                提示,因为它们与批处理按钮无关。 */}
            {(sniffing || lastBatchDir) ? (
              <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                {sniffing ? (
                  <button onClick={onCancel} title="取消嗅探">取消嗅探</button>
                ) : null}
                {lastBatchDir ? (
                  <span style={{ color: 'var(--muted)', fontSize: 11, marginLeft: 'auto' }}>
                    已输出到子目录
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <div className="right">
          <div className="grid-pane">
            <div className="grid-header">
              <h2>已选媒体 {items.length > 0 ? `(${items.length})` : ''}</h2>
              <span className="grid-tip">单击卡片打开大图预览 · 勾选后参与批处理</span>
              {/* R-30 #1 — moved here from the title bar. Disabled
                  until at least one batch (or a manually-picked
                  outputDir) exists, so the affordance is honest. */}
              <button
                type="button"
                className="grid-open-dir"
                onClick={onOpenOutput}
                disabled={!(lastBatchDir || outputDir)}
                title={
                  lastBatchDir
                    ? '在文件管理器中打开本次批处理的输出子目录'
                    : '尚未产出任何文件;先点击 ▶ 处理 / 全部处理 后再来'
                }
              >
                {lastBatchDir ? '打开本次目录' : '打开目录'}
              </button>
            </div>
            <div className="grid-scroll">
              <MediaGrid
                items={items}
                selected={selected}
                onToggle={toggleSelected}
                onOpen={openCard}
                onProcessOne={onProcessOneById}
                isProcessing={isProcessingOne}
                onRetryResolve={onResolveEmbedById}
                isResolving={isResolving}
                resolveErrorMap={resolveErrorMap}
              />
            </div>
          </div>
        </div>
      </div>
      ) : view === 'history' ? (
        <div className="body body-history" role="region" aria-label="history">
          <HistoryPanel
            history={history}
            onOpenDetail={(rec) => setHistoryDetail(rec)}
            onOpenOutputDir={onOpenHistoryDir}
            onRemove={removeHistory}
            onClear={clearHistory}
          />
        </div>
      ) : view === 'toolbox' ? (
        <div className="body body-toolbox" role="region" aria-label="toolbox">
          <ToolboxPanel />
        </div>
      ) : (
        <div className="body body-uploads" role="region" aria-label="uploads">
          <UploadHistoryPanel history={uploadHistory} onRemove={removeUploadHistory} onClear={clearUploadHistory} />
        </div>
      )}

      {view === 'home' ? (
        <>
          <div
            className="bottom-resize-handle"
            onMouseDown={onBottomResizeStart}
            onDoubleClick={() => {
              setBottomH(BOTTOM_H_DEFAULT);
              try { window.localStorage.setItem(BOTTOM_H_KEY, String(BOTTOM_H_DEFAULT)); } catch { /* ignore */ }
            }}
            title="拖动调节高度,双击恢复默认"
            role="separator"
            aria-orientation="horizontal"
          />
          <div className={`bottom${logsVisible ? '' : ' bottom-no-logs'}`}>
            {/* R-43.1 — 底部工具栏:取消批处理 + 日志开关合并到一行,
                替代之前那条独立的 "处理进度" header。空闲时仅显示日志
                toggle;运行批处理时左侧出现取消按钮。 */}
            <div className="bottom-toolbar">
              <span className="bottom-toolbar-title">
                {isHomeBatchProcessing ? '处理进度(运行中)' : '处理进度'}
              </span>
              {isHomeBatchProcessing ? (
                <button
                  className="ghost"
                  onClick={onCancel}
                  title="取消当前批处理与未开始的排队任务"
                  style={{ marginLeft: 8 }}
                >
                  ✕ 取消批处理
                </button>
              ) : null}
              <button
                className="ghost"
                onClick={toggleLogs}
                aria-pressed={logsVisible}
                title={logsVisible ? '隐藏日志面板' : '展开日志面板'}
                style={{ marginLeft: 'auto' }}
              >
                📋 日志{logs.length > 0 ? ` (${logs.length})` : ''}{logsVisible ? ' ▾' : ' ▸'}
              </button>
              {/* R-45 — 「⚡ 上传所有产物」+「📤 上传设置」按钮。
                  上传所有产物按钮:把所有 done 行的第一个输出全部派发
                  到当前默认图床后端,主进程串行执行,完成时弹结果面板。 */}
              <button
                className="ghost"
                onClick={() => void onUploadAll()}
                title="把所有已完成任务的产物上传到当前默认图床(可在「📤 上传设置」中切换)"
                style={{ marginLeft: 8 }}
              >
                ⚡ 上传所有产物
              </button>
              <button
                className="ghost"
                onClick={() => setUploadSettingsOpen(true)}
                title="配置图床后端(自定义 Web / GitHub / 七牛 / 阿里云 OSS / 腾讯 COS)"
                style={{ marginLeft: 4 }}
              >
                📤 上传设置
              </button>
            </div>
            <TaskTable
              items={items}
              progress={progress}
              onRetry={(m) => onProcessOne(m)}
              onForceAllow={(m) => onProcessOne(m, { forceAllowSmallSide: true })}
              onManualOptimize={onManualOptimize}
              onCancelOne={onCancelOne}
              onUploadOne={onUploadOne}
            />
            {logsVisible ? <LogBox lines={logs} /> : null}
          </div>
          {/* R-50 — Floating "Start" action button.
              旧的内嵌主按钮已被移除(原位于 .section.fixed.left-bottom),
              这个 FAB 完全继承了它的所有判断逻辑:idle 时显示
              「▶ 开始批处理 (N / 共选 M)」(M≠N 才带 / 共选 M),
              running 时显示「▶ 追加排队 (K)」;disabled 与 title 文案
              全部 1:1 对齐;状态复用 isHomeBatchProcessing /
              processable / appendable。FAB 是 position:fixed 故在底部
              dock + 进度区盖住时仍可点。 */}
          {(() => {
            const running = isHomeBatchProcessing;
            const count = running ? appendable.length : processable.length;
            const disabled = count === 0;
            const idleSuffix =
              !running && selected.size !== processable.length
                ? ` / 共选 ${selected.size}`
                : '';
            const label = running
              ? `▶ 追加排队 (${count})`
              : `▶ 开始批处理 (${count}${idleSuffix})`;
            const title = running
              ? (count === 0
                  ? '当前没有新选中的可处理项可追加;勾选更多卡片后会启用'
                  : `把 ${count} 个新选中的任务追加到当前队列`)
              : (count === 0
                  ? '请先在右侧勾选 video / gif'
                  : '开始批处理');
            return (
              <button
                type="button"
                className="fab-start-batch"
                onClick={running ? onAppend : onStart}
                disabled={disabled}
                title={title}
                aria-label={label}
              >
                {label}
              </button>
            );
          })()}
        </>
      ) : null}

      {activeMedia ? (
        <PreviewModal
          media={activeMedia}
          options={options}
          onChangeOptions={setOptions}
          onRequestPreview={onPreview}
          previewing={previewing}
          preview={preview}
          onClose={closeModal}
          onProcessOne={(m) => onProcessOne(m)}
          processOneDisabled={isProcessingOne(activeMedia.id) || activeMedia.kind === 'image' || (!!activeMedia.requiresExternalDownload && !activeMedia.resolved)}
        />
      ) : null}

      {batchModal ? (
        <BatchSegmentModal
          entries={batchModal.entries}
          maxSegmentSec={options.maxSegmentSec}
          onCancel={() => setBatchModal(null)}
          onConfirm={(perId) => {
            // R-43.2 — 'append' 模式只把 modal 创建时的 list 子集
            // 推到队列;'fresh' 模式沿用旧行为(传 null,dispatchBatch
            // 内部会用 processable 全集)。
            const snapshotList = batchModal.list;
            const mode = batchModal.mode;
            setBatchModal(null);
            if (mode === 'append') {
              setLogs((prev) => [...prev, `[batch] 追加 ${snapshotList.length} 个任务到当前队列`].slice(-300));
              void dispatchBatch(perId, snapshotList);
            } else {
              void dispatchBatch(perId);
            }
          }}
        />
      ) : null}

      {historyDetail ? (
        <HistoryDetailModal
          // Re-derive from the live history array on every render so
          // progress events (taskStatus / outputsByTaskId / outputDir
          // patches via patchHistory) are reflected in the modal —
          // otherwise we'd show the snapshot taken at openDetail time.
          rec={history.find((r) => r.id === historyDetail.id) ?? historyDetail}
          progress={progress}
          isProcessing={isProcessingOne}
          onProcessOneFromRecord={onReprocessFromHistory}
          onBatchFromRecord={onBatchFromRecord}
          onCancel={onCancel}
          onOpenOutputDir={onOpenHistoryDir}
          onClose={() => setHistoryDetail(null)}
          logs={logs}
          // R-29 (P0-C): forward the live task→record binding so the
          // modal can filter same-id collisions out of its TaskTable.
          taskRecordMap={taskRecordMapRef.current}
        />
      ) : null}

      <ManualOptimizeModal
        open={!!manualOpt}
        currentSizeMB={manualOpt?.progress.currentSizeMB ?? 0}
        baseOptions={options}
        taskTitle={manualOpt ? (() => {
          try {
            return new URL(manualOpt.media.url).pathname.split('/').pop() || manualOpt.media.url;
          } catch {
            return manualOpt.media.url;
          }
        })() : undefined}
        warning={manualOpt?.progress.warning}
        onConfirm={onManualOptimizeConfirm}
        onClose={() => setManualOpt(null)}
      />

      {uploadSettingsOpen && uploadConfigs ? (
        <UploadSettingsModal
          initial={uploadConfigs}
          onClose={() => setUploadSettingsOpen(false)}
          onSave={onSaveUploadSettings}
        />
      ) : null}

      {uploadResult ? (() => {
        const rec = uploadHistory.find((r) => r.id === uploadResult);
        if (!rec) return null;
        return <UploadResultModal record={rec} onClose={() => setUploadResult(null)} />;
      })() : null}
    </div>
  );
};

function shortDir(p: string): string {
  if (p.length <= 30) return p;
  return '…' + p.slice(p.length - 28);
}

export default App;
