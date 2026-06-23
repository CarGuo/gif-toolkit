/**
 * R-DOCK-FLOATING — Minimal preload exposed to the floating dock
 * BrowserWindow. **Intentionally tiny** — only 9 handlers the dock UI
 * needs (R-11 whitelist). No `giftk.*` IPC, no FS, no shell.
 *
 * v2 起追加：
 *  - getRecorderState / onRecorderState：dock 自治录制态订阅
 *  - revealLastRecording：done 后一键 reveal 最后产物
 *
 * v2.2 起追加：
 *  - copyErrorMessage(text)：错误 toast 上的「复制」按钮走主进程
 *    clipboard.writeText（renderer 侧不可访问 navigator.clipboard
 *    on transparent/alwaysOnTop window）
 *
 * Adding a new method here requires:
 *  1. Matching main-process `ipcMain.handle('dock:xxx', ...)`.
 *  2. Updating R-DOCK-FLOATING rule file's whitelist count (= 9).
 *  3. Telling tests/main/dock.test.ts so the action-enum exhaustiveness
 *     case knows about it.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type {
  DockActionKind,
  DockActionMeta,
  DockState,
  DockDragInput,
  DockRecorderState,
} from '../shared/types/dock';

const STATE_CHANNEL = 'dock:state';
const RECORDER_STATE_CHANNEL = 'dock:recorderState';

contextBridge.exposeInMainWorld('giftkDock', {
  async getActions(): Promise<DockActionMeta[]> {
    return ipcRenderer.invoke('dock:getActions') as Promise<DockActionMeta[]>;
  },
  async trigger(action: DockActionKind): Promise<{ ok: boolean; reason?: string }> {
    return ipcRenderer.invoke('dock:trigger', action) as Promise<{ ok: boolean; reason?: string }>;
  },
  async setExpanded(expanded: boolean): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('dock:setExpanded', expanded) as Promise<{ ok: boolean }>;
  },
  async drag(phase: 'start' | 'move' | 'end', input?: DockDragInput): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('dock:drag', { phase, input }) as Promise<{ ok: boolean }>;
  },
  async hide(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('dock:hide') as Promise<{ ok: boolean }>;
  },
  async getRecorderState(): Promise<DockRecorderState> {
    return ipcRenderer.invoke('dock:getRecorderState') as Promise<DockRecorderState>;
  },
  async revealLastRecording(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('dock:revealLastRecording') as Promise<{ ok: boolean }>;
  },
  async copyErrorMessage(text: string): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('dock:copyErrorMessage', String(text ?? '')) as Promise<{ ok: boolean }>;
  },
  onState(cb: (state: DockState) => void): () => void {
    const handler = (_e: unknown, payload: DockState): void => {
      try { cb(payload); } catch { /* swallow renderer-side throw */ }
    };
    ipcRenderer.on(STATE_CHANNEL, handler);
    return () => { ipcRenderer.removeListener(STATE_CHANNEL, handler); };
  },
  onRecorderState(cb: (state: DockRecorderState) => void): () => void {
    const handler = (_e: unknown, payload: DockRecorderState): void => {
      try { cb(payload); } catch { /* swallow renderer-side throw */ }
    };
    ipcRenderer.on(RECORDER_STATE_CHANNEL, handler);
    return () => { ipcRenderer.removeListener(RECORDER_STATE_CHANNEL, handler); };
  },
});
