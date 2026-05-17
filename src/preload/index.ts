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
  UploadTestResult
} from '../shared/types';

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
  async sniff(url: string): Promise<SniffResult> {
    ensureString(url, 'url');
    return ipcRenderer.invoke('sniff:url', url);
  },
  // R-44 — webview-assisted sniff. Opens a real Chromium window in the
  // main process so the user can sign in to gated sites (Medium private
  // posts, Twitter/X media tabs, members-only Patreon, ...). Once the
  // user clicks "✅ 完成嗅探" in the injected toolbar, this resolves with
  // the same `SniffResult` shape as `sniff()`, so the renderer can feed
  // both pipelines into the same dedupe/history flow.
  async sniffWithWebview(url: string): Promise<SniffResult> {
    ensureString(url, 'url');
    return ipcRenderer.invoke('sniff:webview', url);
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
    outputDirOverride?: string
  ): Promise<BatchStartResult> {
    if (!Array.isArray(tasks)) throw new TypeError('tasks must be array');
    return ipcRenderer.invoke('process:start', {
      tasks,
      pageTitle,
      outputDirOverride
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
  }
};

try {
  contextBridge.exposeInMainWorld('giftk', api);
} catch (e) {
  console.error('[preload] expose failed:', e);
}

export type GifToolkitApi = typeof api;
