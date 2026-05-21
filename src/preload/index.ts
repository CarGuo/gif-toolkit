import { contextBridge, ipcRenderer } from 'electron';
import type {
  ProcessOptions,
  ProcessTask,
  SniffResult,
  TaskProgress,
  PreviewResult,
  SniffedMedia,
  ThumbnailResult,
  BatchStartResult,
  SniffProgress,
  ResolvedMedia,
  ToolboxJob,
  ToolboxKind,
  ToolboxStartResult,
  UploadConfigs,
  UploadProgress,
  UploadStartPayload,
  UploadStartResult,
  UploadTestResult,
  CapabilityReport,
  SessionLogEntry,
  SessionLogSnapshot,
  SessionLogExportFormat
} from '../shared/types';
import type { BuildInfo } from '../shared/buildInfo';

export interface YtdlpStatus {
  installed: boolean;
  binaryPath: string;
  version?: string;
  workingDir: string;
  source?: 'packaged' | 'userData' | 'missing';
}

function ensureString(v: unknown, name: string): string {
  if (typeof v !== 'string') throw new TypeError(`${name} must be string`);
  return v;
}

function ensureObject<T>(v: unknown, name: string): T {
  if (!v || typeof v !== 'object') throw new TypeError(`${name} must be object`);
  return v as T;
}

const api = {
  async sniff(url: string, opts?: { includeStaticImages?: boolean }): Promise<SniffResult> {
    ensureString(url, 'url');
    return ipcRenderer.invoke('sniff:url', url, opts ?? {});
  },
  // R-44 — webview-assisted sniff. Opens a real Chromium window in the
  // main process so the user can sign in to gated sites (Medium private
  // posts, Twitter/X media tabs, members-only Patreon, ...). Once the
  // user clicks "✅ 完成嗅探" in the injected toolbar, this resolves with
  // the same `SniffResult` shape as `sniff()`, so the renderer can feed
  // both pipelines into the same dedupe/history flow.
  async sniffWithWebview(url: string, opts?: { includeStaticImages?: boolean }): Promise<SniffResult> {
    ensureString(url, 'url');
    return ipcRenderer.invoke('sniff:webview', url, opts ?? {});
  },
  // R-51 — system-Chrome sniff. Spawns the user's actual installed
  // Chrome / Edge / Brave (NOT Electron's bundled Chromium) so TLS &
  // HTTP/2 fingerprints come from a real browser; the user manually
  // clears any Turnstile / login in that window, and we scrape via
  // CDP. Same `SniffResult` shape as the other two sniff entries.
  async sniffWithSystemChrome(
    url: string,
    opts?: { includeStaticImages?: boolean },
    chromeOpts?: { useRealProfile?: boolean }
  ): Promise<SniffResult> {
    ensureString(url, 'url');
    return ipcRenderer.invoke('sniff:system-chrome', url, opts ?? {}, chromeOpts ?? {});
  },
  /**
   * Preflight: list installed system browsers (Chrome / Edge / Brave /
   * Chromium) by probing canonical install paths. Renderer uses this to
   * decide whether to surface the "真 Chrome 嗅探" entry, and to render
   * an actionable "Chrome not installed" prompt with a download link.
   */
  async detectSystemBrowsers(): Promise<Array<{ id: string; label: string; exePath: string }>> {
    return ipcRenderer.invoke('sniff:system-chrome:detect');
  },
  /**
   * R-55 Fix #2 — Cooperative finalize for the real-Chrome sniff.
   * Resolves the in-flight `sniffWithSystemChrome` Promise as if the
   * user had closed the Chrome window — runs a final DOM scan and
   * returns whatever was captured so far. Used by the「✓ 完成嗅探」
   * button that appears at the 60% stage so users no longer have to
   * fully quit Chrome to escape the wait.
   *
   * Returns `true` if a sniff was actually in flight.
   */
  async finalizeSystemChromeSniff(): Promise<boolean> {
    return ipcRenderer.invoke('sniff:system-chrome:finalize');
  },
  /**
   * R-55 Fix #3 — Offline import. Hand a fully-saved web page (or any
   * single media file) on disk back to the renderer wrapped as a
   * `SniffResult`. Three input shapes:
   *
   *  - .mhtml / .mht  (Chrome / Edge "Webpage, single file")
   *  - .html + sibling _files/  (Chrome "Webpage, complete")
   *  - single .mp4 / .webm / .gif / .png / .jpg / .webp / etc.
   *
   * If `absPath` is omitted, a native file/directory picker pops up.
   * If the picker is cancelled, returns `null`.
   *
   * R-56 — `opts.includeStaticImages` (default `false`) controls
   * whether <img>-sourced .png/.jpg/.webp/.bmp/.avif references make
   * it into the result. GIFs and <video>/og:video are always kept.
   * The renderer surfaces this as a checkbox in the offline-import
   * trigger so by-default-empty saved pages can opt back in.
   */
  async importOfflinePage(
    absPath?: string,
    opts?: { includeStaticImages?: boolean }
  ): Promise<SniffResult | null> {
    if (typeof absPath === 'string') ensureString(absPath, 'absPath');
    return ipcRenderer.invoke('sniff:offlineImport', absPath, opts ?? {});
  },
  // R-52 — yt-dlp direct sniff. No webview involved at all; the page URL
  // is handed straight to yt-dlp's 1900+ extractors. Returns the same
  // SniffResult shape as the other entries, with a single SniffedMedia
  // whose `resolved` field is already populated so the renderer can
  // dispatch it into the processor without an extra resolve step.
  async sniffWithYtdlpDirect(url: string, opts?: { includeStaticImages?: boolean }): Promise<SniffResult> {
    ensureString(url, 'url');
    return ipcRenderer.invoke('sniff:ytdlp-direct', url, opts ?? {});
  },
  async preview(media: SniffedMedia, options: ProcessOptions): Promise<PreviewResult> {
    ensureObject(media, 'media');
    ensureObject(options, 'options');
    return ipcRenderer.invoke('media:preview', media, options);
  },
  async thumbnail(media: SniffedMedia): Promise<ThumbnailResult> {
    ensureObject(media, 'media');
    return ipcRenderer.invoke('media:thumbnail', media);
  },
  async startBatch(
    tasks: ProcessTask[],
    pageTitle?: string,
    outputDirOverride?: string,
    sessionId?: string
  ): Promise<BatchStartResult> {
    if (!Array.isArray(tasks)) throw new TypeError('tasks must be array');
    return ipcRenderer.invoke('process:start', {
      tasks,
      pageTitle,
      outputDirOverride,
      sessionId
    });
  },
  async cancelAll(): Promise<void> {
    return ipcRenderer.invoke('process:cancelAll');
  },
  // R-43.2 — single-task cancellation. Returns the main-side reply
  // verbatim so the caller can decide UI behaviour (e.g. show a
  // toast if `cancelled === false`, meaning the task already finished
  // before the click landed).
  async cancelTask(taskId: string): Promise<{ ok: boolean; cancelled: boolean; error?: string }> {
    return ipcRenderer.invoke('process:cancelTask', taskId);
  },
  async cancelSniff(): Promise<void> {
    return ipcRenderer.invoke('sniff:cancel');
  },
  async getLogBuffer(): Promise<string[]> {
    return ipcRenderer.invoke('app:logBuffer');
  },
  async pickOutputDir(): Promise<string | null> {
    return ipcRenderer.invoke('app:pickDir');
  },
  async openOutputDir(p: string): Promise<void> {
    ensureString(p, 'path');
    return ipcRenderer.invoke('app:openDir', p);
  },
  /** R-39 — open OS file-manager and highlight a single file. Used by
   *  the toolbox history list. Path must be inside an allowed output
   *  directory subtree (main-side enforces this). */
  async revealItem(p: string): Promise<{ ok: boolean }> {
    ensureString(p, 'path');
    return ipcRenderer.invoke('app:revealItem', p);
  },
  async registerOutputDir(p: string): Promise<{ ok: boolean }> {
    // R-27 — best-effort re-allow of a persisted history dir after
    // restart. Always returns {ok:false} for invalid / out-of-allowed-tree
    // paths, never throws, so the caller can iterate hydration without
    // breaking on stale entries.
    ensureString(p, 'path');
    return ipcRenderer.invoke('app:registerOutputDir', p);
  },
  async getDefaultOutputDir(): Promise<string> {
    return ipcRenderer.invoke('app:defaultDir');
  },
  /**
   * R-62 — Cross-platform capability probe. Returns the current
   * platform / arch, binary availability matrix, and a list of
   * `CapabilityIssue`s the renderer should surface as toasts. Cached
   * on the main side for the lifetime of the process — calling this
   * multiple times is cheap.
   */
  async getCapabilities(): Promise<CapabilityReport> {
    return ipcRenderer.invoke('system:capabilities');
  },
  /**
   * R-71 — Read the build fingerprint that was tree-baked into the
   * bundle by the release pipeline. Renderer uses this for the About
   * panel and to seed bug-report templates so the issue tracker
   * always knows which exact build produced a screenshot. Cheap
   * synchronous IPC; safe to call eagerly on mount.
   */
  async getBuildInfo(): Promise<BuildInfo> {
    return ipcRenderer.invoke('app:buildInfo');
  },
  onProgress(cb: (p: TaskProgress) => void): () => void {
    const handler = (_: unknown, payload: TaskProgress) => {
      try { cb(payload); } catch { /* swallow */ }
    };
    ipcRenderer.on('process:progress', handler);
    return () => ipcRenderer.removeListener('process:progress', handler);
  },
  onLog(cb: (line: string) => void): () => void {
    const handler = (_: unknown, line: string) => {
      try { cb(line); } catch { /* swallow */ }
    };
    ipcRenderer.on('app:log', handler);
    return () => ipcRenderer.removeListener('app:log', handler);
  },
  onSniffProgress(cb: (p: SniffProgress) => void): () => void {
    const handler = (_: unknown, payload: SniffProgress) => {
      try { cb(payload); } catch { /* swallow */ }
    };
    ipcRenderer.on('sniff:progress', handler);
    return () => ipcRenderer.removeListener('sniff:progress', handler);
  },
  /* ---------------- Embed resolver (yt-dlp, bundled) ---------------- */
  async checkYtdlp(): Promise<YtdlpStatus> {
    return ipcRenderer.invoke('resolve:checkYtdlp');
  },
  async resolveEmbed(media: SniffedMedia): Promise<ResolvedMedia> {
    ensureObject(media, 'media');
    return ipcRenderer.invoke('resolve:embed', media);
  },
  /* ---------------- R-35 Toolbox ---------------- */
  async toolboxPickFiles(kind: ToolboxKind): Promise<string[]> {
    ensureString(kind, 'kind');
    return ipcRenderer.invoke('toolbox:pickFiles', kind);
  },
  async startToolbox(jobs: ToolboxJob[], outputDirOverride?: string): Promise<ToolboxStartResult> {
    if (!Array.isArray(jobs)) throw new TypeError('jobs must be array');
    return ipcRenderer.invoke('toolbox:start', { jobs, outputDirOverride });
  },
  /* R-38 — Trim/Crop need source dimensions and duration before the user
   *  configures the tool. probeMedia is a thin pass-through to ffmpeg's
   *  `probe()`; firstFrame returns a small JPEG dataUrl used by the
   *  CropBox preview canvas. */
  async toolboxProbeMedia(p: string): Promise<{
    width: number; height: number; durationSec: number; frameRate: number; nbFrames: number; sizeBytes: number;
  }> {
    ensureString(p, 'path');
    return ipcRenderer.invoke('toolbox:probeMedia', p);
  },
  async toolboxFirstFrame(p: string): Promise<{ dataUrl: string }> {
    ensureString(p, 'path');
    return ipcRenderer.invoke('toolbox:firstFrame', p);
  },
  /* ---------------- R-45 Image-host upload (PicGo-style) ---------------- */
  /**
   * Get the persisted upload configs. Secrets (PAT / SK / accessKeySecret
   * / qiniu secretKey / Authorization header value) are masked with
   * "••••••" markers — the renderer never reads back actual secret bytes.
   */
  async uploadGetSettings(): Promise<UploadConfigs> {
    return ipcRenderer.invoke('upload:settings:get');
  },
  /**
   * Save upload configs. Any field whose value is still the literal
   * "••••••" mask is preserved verbatim from the prior persisted value;
   * the renderer's "edit secret" affordance must replace that mask with
   * the actual new secret to update it.
   */
  async uploadSetSettings(c: UploadConfigs): Promise<{ ok: boolean }> {
    ensureObject(c, 'configs');
    return ipcRenderer.invoke('upload:settings:set', c);
  },
  async uploadStart(payload: UploadStartPayload): Promise<UploadStartResult> {
    ensureObject(payload, 'payload');
    return ipcRenderer.invoke('upload:start', payload);
  },
  async uploadCancel(jobId: string): Promise<{ ok: boolean; cancelled: boolean }> {
    ensureString(jobId, 'jobId');
    return ipcRenderer.invoke('upload:cancel', jobId);
  },
  async uploadCancelAll(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('upload:cancelAll');
  },
  /**
   * R-46 — Probe the active backend by uploading a 1×1 PNG. The
   * `configs` parameter is optional — when supplied (e.g. with the
   * unsaved values currently in the settings modal), main merges
   * masked secrets from the persisted config so the user does not
   * have to "save" before being able to test.
   */
  async uploadTest(payload: { backend?: string; configs?: UploadConfigs }): Promise<UploadTestResult> {
    ensureObject(payload, 'payload');
    return ipcRenderer.invoke('upload:test', payload);
  },
  /**
   * R-46 — Resolve the seven-niu upload region from a (AK, bucket)
   * tuple via the public UC v3 endpoint. Returns either the inferred
   * region literal ('z0'/'z1'/...) or an explanatory error string.
   */
  async uploadQiniuProbeRegion(payload: { accessKey: string; bucket: string }): Promise<{ ok: boolean; region?: string; host?: string; error?: string }> {
    ensureObject(payload, 'payload');
    return ipcRenderer.invoke('upload:qiniuProbeRegion', payload);
  },
  onUploadProgress(cb: (p: UploadProgress) => void): () => void {
    const handler = (_: unknown, payload: UploadProgress) => {
      try { cb(payload); } catch { /* swallow */ }
    };
    ipcRenderer.on('upload:progress', handler);
    return () => ipcRenderer.removeListener('upload:progress', handler);
  },

  /**
   * Subscribe to session log lifecycle + entry broadcasts. The main
   * process opens a session, streams `append` events for every log
   * line (sniff/process/upload stages), and finally fires `close`
   * with a terminal summary. The renderer uses these to drive a
   * live "Logs" tab without having to poll the DB.
   *
   * Returns an unsubscribe function that detaches all three IPC
   * listeners; safe to call multiple times.
   */
  onSessionLog(cb: (
    ev:
      | { kind: 'open'; snapshot: Omit<SessionLogSnapshot, 'entries'> }
      | { kind: 'append'; entry: SessionLogEntry }
      | { kind: 'close'; snapshot: Omit<SessionLogSnapshot, 'entries'> }
  ) => void): () => void {
    const onOpen = (_: unknown, snapshot: Omit<SessionLogSnapshot, 'entries'>): void => {
      try { cb({ kind: 'open', snapshot }); } catch { /* swallow */ }
    };
    const onAppend = (_: unknown, entry: SessionLogEntry): void => {
      try { cb({ kind: 'append', entry }); } catch { /* swallow */ }
    };
    const onClose = (_: unknown, snapshot: Omit<SessionLogSnapshot, 'entries'>): void => {
      try { cb({ kind: 'close', snapshot }); } catch { /* swallow */ }
    };
    ipcRenderer.on('session:log:open', onOpen);
    ipcRenderer.on('session:log:append', onAppend);
    ipcRenderer.on('session:log:close', onClose);
    return () => {
      ipcRenderer.removeListener('session:log:open', onOpen);
      ipcRenderer.removeListener('session:log:append', onAppend);
      ipcRenderer.removeListener('session:log:close', onClose);
    };
  },

  /**
   * R-80 — SQLite-backed history. Each sub-namespace mirrors one of
   * the four `useXxxHistory` hooks 1:1. The renderer keeps the same
   * record types it had under localStorage; the main process is just
   * the durable store. Calls are async and never throw on the wire —
   * any error caught in the main handler is rejected so the renderer
   * can fall back to an empty list (history is convenience, not load-
   * bearing).
   */
  db: {
    history: {
      readAll(): Promise<unknown[]> {
        return ipcRenderer.invoke('db:history:readAll');
      },
      upsert(rec: unknown): Promise<void> {
        return ipcRenderer.invoke('db:history:upsert', rec);
      },
      remove(id: string): Promise<void> {
        return ipcRenderer.invoke('db:history:remove', ensureString(id, 'id'));
      },
      clear(): Promise<void> {
        return ipcRenderer.invoke('db:history:clear');
      }
    },
    uploadHistory: {
      readAll(): Promise<unknown[]> {
        return ipcRenderer.invoke('db:uploadHistory:readAll');
      },
      upsert(rec: unknown): Promise<void> {
        return ipcRenderer.invoke('db:uploadHistory:upsert', rec);
      },
      remove(id: string): Promise<void> {
        return ipcRenderer.invoke('db:uploadHistory:remove', ensureString(id, 'id'));
      },
      clear(): Promise<void> {
        return ipcRenderer.invoke('db:uploadHistory:clear');
      }
    },
    sniffHistory: {
      readAll(): Promise<unknown[]> {
        return ipcRenderer.invoke('db:sniffHistory:readAll');
      },
      upsert(entry: unknown): Promise<void> {
        return ipcRenderer.invoke('db:sniffHistory:upsert', entry);
      },
      remove(url: string): Promise<void> {
        return ipcRenderer.invoke('db:sniffHistory:remove', ensureString(url, 'url'));
      },
      clear(): Promise<void> {
        return ipcRenderer.invoke('db:sniffHistory:clear');
      }
    },
    toolboxHistory: {
      readAll(): Promise<unknown[]> {
        return ipcRenderer.invoke('db:toolboxHistory:readAll');
      },
      upsert(entry: unknown): Promise<void> {
        return ipcRenderer.invoke('db:toolboxHistory:upsert', entry);
      },
      remove(id: string): Promise<void> {
        return ipcRenderer.invoke('db:toolboxHistory:remove', ensureString(id, 'id'));
      },
      clear(): Promise<void> {
        return ipcRenderer.invoke('db:toolboxHistory:clear');
      }
    },
    /**
     * Session-scoped operation logs (sniff → process → upload).
     * `list` returns lightweight session metadata (no entries) for the
     * picker; `read` pulls one full snapshot (meta + every entry) the
     * UI then renders or hands to the export dialog. Both `remove` and
     * `clear` are destructive — the renderer is expected to confirm
     * with the user first.
     */
    sessionLogs: {
      list(): Promise<Array<Omit<SessionLogSnapshot, 'entries'>>> {
        return ipcRenderer.invoke('db:sessionLogs:list');
      },
      read(sessionId: string): Promise<SessionLogSnapshot | null> {
        return ipcRenderer.invoke('db:sessionLogs:read', ensureString(sessionId, 'sessionId'));
      },
      remove(sessionId: string): Promise<void> {
        return ipcRenderer.invoke('db:sessionLogs:remove', ensureString(sessionId, 'sessionId'));
      },
      clear(): Promise<void> {
        return ipcRenderer.invoke('db:sessionLogs:clear');
      },
      /**
       * Export one session's log to disk via a native save-dialog.
       * `format` picks .log (per-line text) vs .json (structured).
       * Returns `{ ok:false, cancelled:true }` if the user dismissed
       * the dialog; `{ ok:true, path }` on success.
       */
      export(payload: {
        sessionId: string;
        format: SessionLogExportFormat;
        suggestedName?: string;
      }): Promise<{ ok: boolean; cancelled?: boolean; path?: string }> {
        ensureObject(payload, 'payload');
        return ipcRenderer.invoke('db:sessionLogs:export', payload);
      }
    },
    /**
     * R-80 — Bootstrap import. The renderer reads the four legacy
     * localStorage keys verbatim (raw JSON strings) on boot and
     * sends them here. Main parses defensively, INSERT OR IGNOREs
     * inside a transaction, then returns per-family insert counts.
     * Renderer deletes the keys on a successful (non-rejecting)
     * return. Idempotent on partial-import recovery.
     */
    bootstrapImport(payload: {
      history?: string | null;
      uploadHistory?: string | null;
      sniffHistory?: string | null;
      toolboxHistory?: string | null;
    }): Promise<{
      history: number;
      uploadHistory: number;
      sniffHistory: number;
      toolboxHistory: number;
    }> {
      ensureObject(payload, 'payload');
      return ipcRenderer.invoke('db:bootstrapImport', payload);
    },
    /**
     * R-80 hardening (H5) — Subscribe to the main-process
     * `db:flushBeforeQuit` lifecycle event. The renderer is expected
     * to (1) cancel all debounce timers, (2) await every queued upsert
     * IPC, (3) call back via `acked()`. Main side waits up to ~1s for
     * the ack before forcing the quit; a slow / hung renderer must not
     * be able to block app exit indefinitely.
     */
    onFlushBeforeQuit(
      cb: (acked: () => void) => void
    ): () => void {
      const handler = (_: unknown, requestId: string) => {
        let already = false;
        const acked = (): void => {
          if (already) return;
          already = true;
          ipcRenderer.send('db:flushBeforeQuit:ack', requestId);
        };
        try { cb(acked); } catch { acked(); }
      };
      ipcRenderer.on('db:flushBeforeQuit', handler);
      return () => ipcRenderer.removeListener('db:flushBeforeQuit', handler);
    }
  }
};

try {
  contextBridge.exposeInMainWorld('giftk', api);
} catch (e) {
  console.error('[preload] expose failed:', e);
}

export type GifToolkitApi = typeof api;
