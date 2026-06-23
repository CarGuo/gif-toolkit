/**
 * R-REC-DESKTOP-AREA — Minimal preload exposed to the region-selector
 * overlay window. **Intentionally tiny** — only the four handlers the
 * overlay needs. No `giftk.*` IPC, no FS, no shell.
 *
 * v2 起新增 onStaticConfig：dock 的就地录制启动时主进程会用同一份
 * recorderOverlay.html 弹一个**只读静态遮罩**显示录制范围（区分于交
 * 互式 onConfig）。
 */

import { contextBridge, ipcRenderer } from 'electron';

const CONFIG_CHANNEL = 'recorder-overlay:config';
const STATIC_CONFIG_CHANNEL = 'recorder-overlay:static-config';
const RESULT_CHANNEL = 'recorder-overlay:result';

contextBridge.exposeInMainWorld('giftkRecOverlay', {
  onConfig(cb: (cfg: unknown) => void): void {
    ipcRenderer.on(CONFIG_CHANNEL, (_e, cfg) => {
      try { cb(cfg); } catch { /* swallow renderer-side throw */ }
    });
  },
  onStaticConfig(cb: (cfg: unknown) => void): void {
    ipcRenderer.on(STATIC_CONFIG_CHANNEL, (_e, cfg) => {
      try { cb(cfg); } catch { /* swallow renderer-side throw */ }
    });
  },
  finish(region: { displayId: number; x: number; y: number; w: number; h: number }): void {
    ipcRenderer.send(RESULT_CHANNEL, { ok: true, region });
  },
  cancel(): void {
    ipcRenderer.send(RESULT_CHANNEL, { ok: false, cancelled: true });
  },
  // R-REC-DESKTOP-AREA #ax-perm — selector overlay 在 mac 上无辅助功能权限
  // 时，「🔓 授予辅助功能权限」chip 点击会调这条 IPC，让主进程深链到
  // 系统设置「隐私与安全性 → 辅助功能」。
  openAxSettings(): Promise<void> {
    return ipcRenderer.invoke('recorder-overlay:open-ax-settings');
  },
});
