/**
 * useSniffSession — extracts the three "嗅探" entry points that
 * previously lived inline in App.tsx (lines ~525-643 / ~660-740 /
 * ~1124-1187 of the pre-Step-6 blob):
 *
 *   • runEmbed()                         — `giftk.sniff` (the embedded
 *                                          mainline path with a 60s
 *                                          watchdog timeout).
 *   • runWebview(mode)                   — dispatches to one of
 *                                          `giftk.sniffWithWebview`
 *                                          (mode === 'embed'),
 *                                          `giftk.sniffWithSystemChrome`
 *                                          (mode === 'system-chrome',
 *                                          forwarding the
 *                                          `useRealChromeProfile` opt),
 *                                          or
 *                                          `giftk.sniffWithYtdlpDirect`
 *                                          (mode === 'ytdlp-direct').
 *   • runOffline(absPath?, runOpts?)     — `giftk.importOfflinePage`
 *                                          for both the toolbar button
 *                                          (no path → main pops a
 *                                          picker, `r === null`
 *                                          ⇒ silent bail) and DnD
 *                                          (renderer already has the
 *                                          absolute path).
 *
 * Why this hook exists
 * --------------------
 * Each entry-point shares an almost identical lifecycle skeleton:
 *
 *   1. trim+validate the URL (urlError, only meaningful for the two
 *      online paths — the offline one has no URL bar at all)
 *   2. (embed only) ask the user to confirm if they're re-sniffing the
 *      exact same URL that's currently on screen
 *   3. bump `sniffReqId.current` so a stale resolve from the previous
 *      run can be discarded via `myId !== currentReq(wsId)`
 *   4. claim a workspace tab (`ws.claimForSniff()`), forward the URL
 *      onto the claimed tab and clear its `historyId`
 *   5. flip every "fresh-start" flag: setSniffing(true), setSniffProgress
 *      kickoff, setResult(null), setSelected(new Set()), setActiveId(null),
 *      setPreview(null), resetEmbedResolve(), activeHistoryIdRef = null,
 *      optional setActiveSniffMode + setLogs hint
 *   6. await the IPC, gated by `myId === currentReq(wsId)` on every
 *      branch
 *   7. on success: setResult, auto-select non-embed video/gif rows,
 *      makeHistoryRecord + pushOrReplace + ws.patchById({ historyId })
 *      + addSniffHistory (offline path skips addSniffHistory because it
 *      is keyed by absolute file path, not a sniffable URL)
 *   8. on catch: setResult({ pageUrl: trimmed/absPath, items: [],
 *      warnings: [(e as Error).message] })
 *   9. finally: clear setSniffing / setSniffProgress / setActiveSniffMode
 *      (only when we still own the request id)
 *
 * Pulling those 200+ duplicated lines into one hook means App.tsx no
 * longer has to spell out the three near-identical lifecycles, and the
 * renderer-side tests can exercise them without spinning up the entire
 * home-page tree.
 *
 * Why "deps" instead of owning everything
 * ---------------------------------------
 * Like useEmbedResolve, the sniff session is intrinsically coupled to
 * the active workspace's setters / history mutators / refs. Owning
 * those here would mean re-implementing half of useWorkspaces +
 * useHistory + useSniffHistory. Instead the hook accepts a
 * `SniffSessionDeps` bag and mirrors it via a `depsRef` so the
 * exposed `runEmbed` / `runWebview` / `runOffline` callbacks stay
 * stable (mount-once friendly) — consumers' useCallback dep arrays
 * downstream don't need to re-fire just because a setter shim
 * re-renders.
 *
 * The `sniffReqId` ref
 * --------------------
 * Exposed verbatim on the returned API so other code paths that need
 * to invalidate an in-flight sniff (e.g. `onCancelSniff` could bump
 * it) can keep doing so. The watchdog timeout inside `runEmbed` also
 * bumps it directly when it fires, mirroring the original behaviour
 * where the timeout pre-empts a slow-resolving promise.
 *
 * What we deliberately did NOT extract
 * ------------------------------------
 *  • The `onPreferredWebviewSniff` shortcut (which calls runWebview
 *    with the persisted mode) stays in App.tsx because it depends on
 *    the webviewMenu hook's preferred mode.
 *  • The DnD listener and `onOfflineImport` toolbar handler stay in
 *    App.tsx because they're UI plumbing, not lifecycle.
 *  • Repeated-URL confirm only exists on the embed path; it is NOT
 *    replicated for webview / offline because the original code did
 *    not have it there either (Step 6 is a verbatim extraction, not a
 *    behavioural change).
 */
import { useCallback, useRef } from 'react';
import type {
  ProcessOptions,
  SniffProgress,
  SniffResult,
  SniffedMedia
} from '../../shared/types';
import type { HistoryRecord } from './useHistory';
import type { UseWorkspacesApi } from './useWorkspaces';

/** Subset of the giftk preload surface this hook actually needs. */
export interface SniffSessionGiftk {
  sniff: (
    url: string,
    opts?: { includeStaticImages?: boolean; sessionId?: string }
  ) => Promise<SniffResult>;
  sniffWithWebview?: (
    url: string,
    opts?: { includeStaticImages?: boolean; sessionId?: string }
  ) => Promise<SniffResult>;
  sniffWithSystemChrome?: (
    url: string,
    opts?: { includeStaticImages?: boolean; sessionId?: string },
    chromeOpts?: { useRealProfile?: boolean }
  ) => Promise<SniffResult>;
  sniffWithYtdlpDirect?: (
    url: string,
    opts?: { includeStaticImages?: boolean; sessionId?: string }
  ) => Promise<SniffResult>;
  importOfflinePage?: (
    absPath?: string,
    opts?: { includeStaticImages?: boolean; sessionId?: string }
  ) => Promise<SniffResult | null>;
}

export type SniffMode = 'embed' | 'system-chrome' | 'ytdlp-direct';
export type ActiveSniffMode = SniffMode | 'offline' | null;

export interface SniffSessionDeps {
  /** Preload IPC surface. */
  giftk: SniffSessionGiftk | undefined;
  /** Workspace tab manager. */
  ws: UseWorkspacesApi;
  /** Latest URL the user typed (only consumed by online entry-points). */
  url: string;
  /** Latest live sniff result (only consumed for the repeated-URL confirm). */
  result: SniffResult | null;
  /** Persisted "use the user's real Chrome profile" toggle for system-chrome. */
  useRealChromeProfile: boolean;
  /** Snapshot of options forwarded into every new HistoryRecord. */
  options: ProcessOptions;
  /** Workspace setter shims (each lands on the active tab). */
  setUrlError: (msg: string | null) => void;
  setSniffing: (v: boolean) => void;
  setSniffProgress: (v: SniffProgress | null) => void;
  setResult: (
    v: SniffResult | null | ((prev: SniffResult | null) => SniffResult | null)
  ) => void;
  setSelected: (
    v: Set<string> | ((prev: Set<string>) => Set<string>)
  ) => void;
  setActiveId: (v: string | null) => void;
  setPreview: (v: null) => void;
  setLogs: (
    v: string[] | ((prev: string[]) => string[])
  ) => void;
  setActiveSniffMode: (v: ActiveSniffMode) => void;
  /** Atomic clear of the embed-resolve overlay. */
  resetEmbedResolve: () => void;
  /** Mirrored history-id pointer (still needed by non-workspace consumers). */
  activeHistoryIdRef: React.MutableRefObject<string | null>;
  /** History helpers. */
  makeHistoryRecord: (input: {
    pageUrl: string;
    title?: string;
    items: SniffedMedia[];
    options: ProcessOptions;
    sessionId?: string;
  }) => HistoryRecord;
  pushOrReplace: (rec: HistoryRecord) => void;
  addSniffHistory: (entry: { url: string; title?: string; itemCount: number }) => void;
  /** Watchdog window for the embed path. Mirrors the App-side constant. */
  SNIFF_TIMEOUT_MS: number;
}

export interface SniffSessionApi {
  /** Bumpable cancellation token shared with the watchdog and external callers. */
  sniffReqId: React.MutableRefObject<number>;
  /** `giftk.sniff` mainline. */
  runEmbed: () => Promise<void>;
  /** `giftk.sniffWith{Webview|SystemChrome|YtdlpDirect}` dispatch. */
  runWebview: (mode: SniffMode) => Promise<void>;
  /**
   * `giftk.importOfflinePage`. `absPath === undefined` ⇒ main pops a
   * file picker; if the user cancels (`r === null`), the whole
   * lifecycle silently bails per the original behaviour.
   */
  runOffline: (
    absPath?: string,
    runOpts?: { includeStaticImages?: boolean }
  ) => Promise<void>;
}

export function useSniffSession(deps: SniffSessionDeps): SniffSessionApi {
  // Mirror deps in a ref so the run* callbacks can be mount-once
  // stable. Setters / refs / history helpers may all be re-created on
  // every render of App.tsx (the workspace shim setters are
  // intentionally NOT memoised) — depsRef collapses that churn into a
  // single reference read.
  const depsRef = useRef(deps);
  depsRef.current = deps;

  // R-WS-90 P4 — `sniffReqId` was a single global useRef<number> that
  // got bumped by every run. That single token meant kicking off
  // sniff B inside ws-B would invalidate the still-pending sniff A
  // inside ws-A: A's resolve branch sees `myId !== currentReq(wsId)`
  // and short-circuits before writing its result patch, so the user's
  // ws-A tab stays empty even though the IPC succeeded. The fix is
  // per-wsId stale-guards: each workspace has its own counter, and
  // a new run only invalidates older runs **on the same ws**.
  //
  // The legacy `sniffReqId` ref is preserved on the returned API
  // (mirroring the active ws's counter) for the watchdog timeout and
  // for any external caller that still wants a "current run" token.
  const sniffReqMap = useRef<Map<string, number>>(new Map());
  const sniffReqId = useRef(0);
  const bumpReq = (wsId: string): number => {
    const next = (sniffReqMap.current.get(wsId) ?? 0) + 1;
    sniffReqMap.current.set(wsId, next);
    sniffReqId.current = next; // legacy mirror for the API surface
    return next;
  };
  const currentReq = (wsId: string): number =>
    sniffReqMap.current.get(wsId) ?? 0;

  // R-WS-90 P4 — mint a per-run sessionId so the main process can route
  // progress events / cancellation back to the originating workspace
  // tab. Uses crypto.randomUUID when available (Electron renderer +
  // happy-dom both ship it) and falls back to a timestamp+random token
  // for the rare environment where it's missing.
  const mintSessionId = (): string => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'sniff-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  };

  const autoSelect = (items: SniffedMedia[]): Set<string> =>
    new Set(
      items
        .filter((i) => (i.kind === 'video' || i.kind === 'gif') && !i.requiresExternalDownload)
        .map((i) => i.id)
    );

  const runEmbed = useCallback(async (): Promise<void> => {
    const d = depsRef.current;
    if (!d.giftk) return;
    const trimmed = d.url.trim();
    if (!trimmed) {
      d.setUrlError('请先输入文章 URL');
      return;
    }
    // R-25 (#3): if the user just sniffed this same URL and the result is
    // still on screen, re-sniffing is almost always an accidental click.
    // Sniffing again throws away the current selection / resolved chips
    // and triggers another full network round-trip, so confirm first.
    if (
      d.result?.pageUrl === trimmed &&
      (d.result.items.length > 0 || (d.result.warnings?.length ?? 0) > 0)
    ) {
      const ok = typeof window !== 'undefined'
        ? window.confirm(`已嗅探过该 URL,是否再次嗅探?\n\n${trimmed}\n\n确认会清空当前结果重新拉取。`)
        : true;
      if (!ok) return;
    }
    d.setUrlError(null);
    const wsId = d.ws.claimForSniff();
    // R-WS-90 P4 — bump the per-ws stale-guard counter (NOT the
    // legacy global sniffReqId), so a new sniff in another ws can no
    // longer invalidate this one.
    const myId = bumpReq(wsId);
    // R-WS-90 P4 — mint a per-run sessionId, write it onto the
    // workspace BEFORE the IPC fires so close(wsId) can cancel via
    // sniffSessionId and (in P4 step 2) useIpcEvents can route
    // `sniff:progress` events back to the right tab.
    const sessionId = mintSessionId();
    // R-WS-89 — every per-workspace state mutation in this run MUST
    // target `wsId` directly via ws.patchById, NEVER via the active
    // shim setters. Reason: claimForSniff() may itself flip the
    // active tab to a fresh ws (when the previous active ws already
    // has a result), and the user is free to switch tabs at any
    // point during the await. If we kept calling d.setSniffing /
    // d.setResult / d.setSelected / d.setLogs (which are
    // makeWsSetter shims that always write to whichever ws is
    // active *right now*), the success branch of sniff B would
    // overwrite ws A's result the moment the user clicks back to
    // A while B is still loading. That's exactly the bug the user
    // reported: "切换 tab 后 A workspace 里的内容就看不到了".
    d.ws.patchById(wsId, {
      url: trimmed,
      historyId: null,
      sniffing: true,
      sniffSessionId: sessionId,
      result: null,
      selected: new Set<string>()
    });
    d.setSniffProgress({ stage: 'fetching', percent: 0 });
    d.setActiveId(null);
    d.setPreview(null);
    d.resetEmbedResolve();
    // R-27 (post-review #1.1): a new sniff round invalidates the
    // previous "active" record. Clear BEFORE the await so any in-flight
    // progress events from a still-running batch land on their own
    // record (looked up via the taskRecordMap) rather than getting
    // silently dropped or — worse — splicing into the record we're
    // about to create.
    d.activeHistoryIdRef.current = null;

    let finished = false;
    const timeout = setTimeout(() => {
      if (finished) return;
      if (myId !== currentReq(wsId)) return;
      finished = true;
      bumpReq(wsId);
      d.setSniffProgress(null);
      d.ws.patchById(wsId, {
        sniffing: false,
        sniffSessionId: null,
        result: {
          pageUrl: trimmed,
          items: [],
          warnings: [`嗅探超时(>${d.SNIFF_TIMEOUT_MS / 1000}s),请稍后重试或换一个 URL`]
        }
      });
    }, d.SNIFF_TIMEOUT_MS);

    try {
      const r = await d.giftk.sniff(trimmed, { sessionId });
      if (myId !== currentReq(wsId) || finished) return;
      finished = true;
      clearTimeout(timeout);
      d.ws.patchById(wsId, {
        result: r,
        selected: autoSelect(r.items)
      });
      // R-27 — every successful sniff opens a fresh history record. We
      // create it here (with no outputDir yet) so even sniffs that
      // never get batched are surfaced.
      if (r.items.length > 0 || (r.warnings?.length ?? 0) === 0) {
        const rec = d.makeHistoryRecord({
          pageUrl: r.pageUrl,
          title: r.title,
          items: r.items,
          options: { ...d.options },
          sessionId: r.sessionId
        });
        d.pushOrReplace(rec);
        d.activeHistoryIdRef.current = rec.id;
        d.ws.patchById(wsId, { historyId: rec.id });
      } else {
        d.activeHistoryIdRef.current = null;
        d.ws.patchById(wsId, { historyId: null });
      }
      // R-32 — record the URL in the lightweight sniff-URL LRU,
      // regardless of item count (a 0-item sniff is still a valid
      // entry the user may want to revisit).
      d.addSniffHistory({
        url: r.pageUrl,
        title: r.title,
        itemCount: r.items.length
      });
    } catch (e) {
      if (myId !== currentReq(wsId) || finished) return;
      finished = true;
      clearTimeout(timeout);
      d.ws.patchById(wsId, {
        result: { pageUrl: trimmed, items: [], warnings: [(e as Error).message] }
      });
    } finally {
      if (myId === currentReq(wsId)) {
        d.ws.patchById(wsId, { sniffing: false, sniffSessionId: null });
        d.setSniffProgress(null);
      }
    }
  }, []);

  const runWebview = useCallback(async (mode: SniffMode): Promise<void> => {
    const d = depsRef.current;
    const api =
      mode === 'system-chrome'
        ? d.giftk?.sniffWithSystemChrome
        : mode === 'ytdlp-direct'
          ? d.giftk?.sniffWithYtdlpDirect
          : d.giftk?.sniffWithWebview;
    if (!api) return;
    const trimmed = d.url.trim();
    if (!trimmed) {
      d.setUrlError('请先输入文章 URL');
      return;
    }
    d.setUrlError(null);
    const wsId = d.ws.claimForSniff();
    // R-WS-90 P4 — bump the per-ws stale-guard counter so concurrent
    // sniffs across different ws no longer invalidate each other.
    const myId = bumpReq(wsId);
    // R-WS-90 P4 — mint a sessionId for this run so the main process
    // can route progress/cancellation to the originating workspace.
    const sessionId = mintSessionId();
    // R-WS-89 — same contract as runEmbed: every per-workspace
    // mutation in this run MUST target `wsId` directly via
    // ws.patchById, NEVER via the active-shim setSniffing /
    // setResult / setSelected / setLogs. claimForSniff() may flip
    // active to a fresh ws, and the user is free to switch tabs
    // during the (often slow) webview / system-chrome / ytdlp-direct
    // round-trip. Without this targeting, sniff B's success branch
    // would overwrite ws A's freshly-restored result the moment the
    // user clicks back to A — exactly the bug the user reported:
    // "切换 tab 后 A workspace 里的内容就看不到了".
    d.ws.patchById(wsId, {
      url: trimmed,
      historyId: null,
      sniffing: true,
      sniffSessionId: sessionId,
      result: null,
      selected: new Set<string>()
    });
    // R-55 Fix #2 — remember which sniff backend is active so we can
    // show the「✓ 完成嗅探」button only for system-chrome runs.
    // setActiveSniffMode is a global (not per-ws) flag, so it stays
    // on the shim setter.
    d.setActiveSniffMode(mode);
    d.setSniffProgress({ stage: 'fetching', percent: 0 });
    d.setActiveId(null);
    d.setPreview(null);
    d.resetEmbedResolve();
    d.activeHistoryIdRef.current = null;
    const hint =
      mode === 'system-chrome'
        ? `[system-chrome] 启动系统 Chrome 打开 ${trimmed} — 登录/通过验证后,关闭 Chrome 窗口完成嗅探`
        : mode === 'ytdlp-direct'
          ? `[ytdlp-direct] 调用 yt-dlp 直接解析 ${trimmed}(无需 webview)`
          : `[webview] 打开 ${trimmed} — 浏览到目标页面后,点击顶部「✅ 完成嗅探」`;
    d.setLogs((prev) => [...prev, hint].slice(-300));
    try {
      // R-59 — system-chrome accepts a third arg (chrome opts) to
      // request the real-profile branch. Other backends ignore extras.
      const r = mode === 'system-chrome'
        ? await (api as NonNullable<SniffSessionGiftk['sniffWithSystemChrome']>)(
            trimmed,
            { sessionId },
            { useRealProfile: d.useRealChromeProfile }
          )
        : await (api as (
            url: string,
            opts?: { includeStaticImages?: boolean; sessionId?: string }
          ) => Promise<SniffResult>)(trimmed, { sessionId });
      if (myId !== currentReq(wsId)) return;
      d.ws.patchById(wsId, {
        result: r,
        selected: autoSelect(r.items)
      });
      if (r.items.length > 0 || (r.warnings?.length ?? 0) === 0) {
        const rec = d.makeHistoryRecord({
          pageUrl: r.pageUrl,
          title: r.title,
          items: r.items,
          options: { ...d.options },
          sessionId: r.sessionId
        });
        d.pushOrReplace(rec);
        d.activeHistoryIdRef.current = rec.id;
        d.ws.patchById(wsId, { historyId: rec.id });
      }
      d.addSniffHistory({
        url: r.pageUrl,
        title: r.title,
        itemCount: r.items.length
      });
    } catch (e) {
      if (myId !== currentReq(wsId)) return;
      d.ws.patchById(wsId, {
        result: { pageUrl: trimmed, items: [], warnings: [(e as Error).message] }
      });
    } finally {
      if (myId === currentReq(wsId)) {
        d.ws.patchById(wsId, { sniffing: false, sniffSessionId: null });
        d.setSniffProgress(null);
        d.setActiveSniffMode(null);
      }
    }
  }, []);

  const runOffline = useCallback(async (
    absPath?: string,
    runOpts?: { includeStaticImages?: boolean }
  ): Promise<void> => {
    const d = depsRef.current;
    if (!d.giftk?.importOfflinePage) return;
    // R-Workspaces — claim a tab; for picker mode (no `absPath` yet)
    // the URL slot is left empty and filled in by the success branch
    // from `r.pageUrl`.
    const wsId = d.ws.claimForSniff();
    // R-WS-90 P4 — bump the per-ws stale-guard counter so concurrent
    // sniffs across different ws no longer invalidate each other.
    const myId = bumpReq(wsId);
    // R-WS-90 P4 — mint a sessionId for this run so the main process
    // can route progress/cancellation to the originating workspace.
    const sessionId = mintSessionId();
    // R-WS-89 — same contract as runEmbed/runWebview: every per-ws
    // mutation must be aimed at `wsId` via patchById. The offline
    // import path is especially exposed because the picker dialog is
    // modal but the user can still kick off an online sniff in
    // another tab between the dialog opening and resolving — without
    // the explicit wsId, A's offline result would land on whatever
    // tab is active at resolve time.
    d.ws.patchById(wsId, {
      url: absPath ?? '',
      historyId: null,
      sniffing: true,
      sniffSessionId: sessionId,
      result: null,
      selected: new Set<string>()
    });
    d.setActiveSniffMode('offline');
    // R-56 — kick off with stage:fetching/percent:0; main emits real
    // milestones (5/15/25/55/70/85/100) which override this via the
    // global onSniffProgress handler.
    d.setSniffProgress({ stage: 'fetching', percent: 0, message: '准备解析离线内容…' });
    d.setActiveId(null);
    d.setPreview(null);
    d.resetEmbedResolve();
    d.activeHistoryIdRef.current = null;
    d.setLogs((prev) =>
      [
        ...prev,
        `[offline-import] ${absPath ? absPath : '(等用户在弹窗里选择文件/目录)'}${runOpts?.includeStaticImages ? ' (包含静态图像)' : ''}`
      ].slice(-300)
    );
    try {
      const r = await d.giftk.importOfflinePage(absPath, {
        includeStaticImages: !!runOpts?.includeStaticImages,
        sessionId
      });
      if (myId !== currentReq(wsId)) return;
      if (!r) {
        // Picker cancelled — silently bail.
        return;
      }
      d.ws.patchById(wsId, {
        result: r,
        selected: autoSelect(r.items)
      });
      if (r.items.length > 0 || (r.warnings?.length ?? 0) === 0) {
        const rec = d.makeHistoryRecord({
          pageUrl: r.pageUrl,
          title: r.title,
          items: r.items,
          options: { ...d.options },
          sessionId: r.sessionId
        });
        d.pushOrReplace(rec);
        d.activeHistoryIdRef.current = rec.id;
        d.ws.patchById(wsId, { historyId: rec.id, url: r.pageUrl });
      }
    } catch (e) {
      if (myId !== currentReq(wsId)) return;
      d.ws.patchById(wsId, {
        result: { pageUrl: absPath ?? '(offline)', items: [], warnings: [(e as Error).message] }
      });
    } finally {
      if (myId === currentReq(wsId)) {
        d.ws.patchById(wsId, { sniffing: false, sniffSessionId: null });
        d.setSniffProgress(null);
        d.setActiveSniffMode(null);
      }
    }
  }, []);

  return {
    sniffReqId,
    runEmbed,
    runWebview,
    runOffline
  };
}
