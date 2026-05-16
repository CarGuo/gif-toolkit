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
  ResolvedMedia
} from '../shared/types';

export interface YtdlpStatus {
  installed: boolean;
  binaryPath: string;
  version?: string;
  workingDir: string;
}

export interface ResolveInstallProgress {
  stage: 'starting' | 'downloading' | 'done' | 'error';
  percent: number;
  version?: string;
  error?: string;
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
  async preview(media: SniffedMedia, options: ProcessOptions): Promise<PreviewResult> {
    ensureObject(media, 'media');
    ensureObject(options, 'options');
    return ipcRenderer.invoke('media:preview', media, options);
  },
  async thumbnail(media: SniffedMedia): Promise<ThumbnailResult> {
    ensureObject(media, 'media');
    return ipcRenderer.invoke('media:thumbnail', media);
  },
  async startBatch(tasks: ProcessTask[], pageTitle?: string): Promise<BatchStartResult> {
    if (!Array.isArray(tasks)) throw new TypeError('tasks must be array');
    return ipcRenderer.invoke('process:start', { tasks, pageTitle });
  },
  async cancelAll(): Promise<void> {
    return ipcRenderer.invoke('process:cancelAll');
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
  /* ---------------- Embed resolver (yt-dlp, opt-in) ---------------- */
  async checkYtdlp(): Promise<YtdlpStatus> {
    return ipcRenderer.invoke('resolve:checkYtdlp');
  },
  async installYtdlp(): Promise<YtdlpStatus> {
    return ipcRenderer.invoke('resolve:installYtdlp');
  },
  async uninstallYtdlp(): Promise<{ ok: true }> {
    return ipcRenderer.invoke('resolve:uninstallYtdlp');
  },
  async resolveEmbed(media: SniffedMedia): Promise<ResolvedMedia> {
    ensureObject(media, 'media');
    return ipcRenderer.invoke('resolve:embed', media);
  },
  onResolveInstallProgress(cb: (p: ResolveInstallProgress) => void): () => void {
    const handler = (_: unknown, payload: ResolveInstallProgress) => {
      try { cb(payload); } catch { /* swallow */ }
    };
    ipcRenderer.on('resolve:install-progress', handler);
    return () => ipcRenderer.removeListener('resolve:install-progress', handler);
  }
};

try {
  contextBridge.exposeInMainWorld('giftk', api);
} catch (e) {
  console.error('[preload] expose failed:', e);
}

export type GifToolkitApi = typeof api;
