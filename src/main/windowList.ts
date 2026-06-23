/**
 * R-REC-DESKTOP-AREA #window-snap + #self-window-exclude — 区域选择器
 * 「窗口吸附」模式所需的「当前桌面有哪些可见窗口 + 各自的屏幕坐标」一次性快照。
 *
 * 设计抉择：
 *   - mac：spawn `osascript` 跑一段 JXA，调用 System Events 拿每个 process
 *     可见 window 的 {position, size, name}。不需要额外 npm 依赖（R-15），
 *     不需要打包额外 helper 二进制。**需要辅助功能权限**——拿不到时返回
 *     空数组，让 UI 静默降级到普通拖框，不弹打扰对话框。
 *   - win/linux：v1 不支持原生窗口枚举（要么引大依赖 node-window-manager
 *     违反 R-15 7d 静默期，要么 spawn 平台命令体验不齐）。返回 [] 静默降级。
 *
 * 输出坐标：osascript 在 mac 上返回**全局桌面坐标 (CSS px，相对所有屏左上原点)**，
 * caller 需要按 display.bounds.x/y 偏移到对应屏内相对坐标（overlay 是
 * per-display 全屏的 BrowserWindow，clientX/Y 就是屏内相对 px）。
 *
 * #self-window-exclude：JXA 会把**我们自己的 Electron 窗口**（dock 悬浮球 /
 * recorderOverlay 自身 / staticOverlay）一并枚举，hover 时面积更小的它们会
 * 抢占 pickWindowAt 命中——所以 JXA 内先按 app 名黑名单跳过，调用方还可以
 * 用 BrowserWindow.getAllWindows 的 bounds 再二次剔重叠者。
 */

import { spawn } from 'child_process';
import { log } from './logger';

export interface VisibleWindow {
  /** 全局桌面坐标（CSS px，相对所有屏左上原点）。 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Owner app / process name (e.g. "Safari"). */
  app: string;
  /** Window title (可能为空)。 */
  title: string;
}

/** 自家 Electron 进程在 JXA `System Events` 里通常的 process.name() 值。
 *  打包后是 productName ("Gif Toolkit")，dev 下是 "Electron"；含 helper。 */
export const SELF_APP_NAMES = ['Gif Toolkit', 'Electron', 'Electron Helper'];

const JXA_SCRIPT = `
  ObjC.import('AppKit');
  var SELF = ${JSON.stringify(SELF_APP_NAMES)};
  var se = Application('System Events');
  var out = [];
  var procs = se.processes.whose({ visible: true })();
  for (var i = 0; i < procs.length; i++) {
    var p = procs[i];
    var appName;
    try { appName = p.name(); } catch (e) { appName = ''; }
    // #self-window-exclude — 跳过我们自己的进程，避免 dock 悬浮球被吸附。
    var skip = false;
    for (var k = 0; k < SELF.length; k++) {
      if (appName === SELF[k] || appName.indexOf(SELF[k] + ' Helper') === 0) { skip = true; break; }
    }
    if (skip) continue;
    var wins;
    try { wins = p.windows(); } catch (e) { wins = []; }
    for (var j = 0; j < wins.length; j++) {
      try {
        var w = wins[j];
        var pos = w.position();
        var sz = w.size();
        if (!pos || !sz || sz[0] < 8 || sz[1] < 8) continue;
        var title = '';
        try { title = w.name() || ''; } catch (e) {}
        out.push({ x: pos[0], y: pos[1], w: sz[0], h: sz[1], app: appName, title: title });
      } catch (e) { /* skip */ }
    }
  }
  JSON.stringify(out);
`;

/**
 * 拿 mac 全桌面可见窗口列表。osascript 失败 / 没权限时返回 []。
 * 5 分钟内不重复跑（窗口拖移频繁但 selector 只在打开瞬间需要一次快照）。
 */
let _cache: { ts: number; data: VisibleWindow[] } | null = null;
const CACHE_MS = 500; // 短缓存，避免每打开一次 selector 都吃一次 ~200ms osascript

export function _resetWindowListCacheForTest(): void {
  _cache = null;
}

export async function listVisibleWindows(): Promise<VisibleWindow[]> {
  if (process.platform !== 'darwin') return [];
  const now = Date.now();
  if (_cache && now - _cache.ts < CACHE_MS) return _cache.data;
  const data = await runJxaOnce();
  if (data.length > 0) _cache = { ts: now, data };
  return data;
}

function runJxaOnce(): Promise<VisibleWindow[]> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const proc = spawn('osascript', ['-l', 'JavaScript', '-e', JXA_SCRIPT], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      log('windowList: osascript timeout (3000ms), returning []');
      resolve([]);
    }, 3000);
    proc.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
    proc.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
    proc.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      log(`windowList: spawn error, stderr=${stderr.slice(0, 200)}`);
      resolve([]);
    });
    proc.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      if (code !== 0) {
        log(`windowList: osascript exit=${code}, stderr=${stderr.slice(0, 200)}`);
        resolve([]);
        return;
      }
      resolve(parseJxaOutput(stdout));
    });
  });
}

export function parseJxaOutput(raw: string): VisibleWindow[] {
  const trimmed = (raw || '').trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: VisibleWindow[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const x = Number(o.x); const y = Number(o.y);
    const w = Number(o.w); const h = Number(o.h);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue;
    if (w < 8 || h < 8) continue;
    const app = typeof o.app === 'string' ? o.app : '';
    // #self-window-exclude — JXA 已按 SELF_APP_NAMES 跳过，但 productName
    // 撞名时仍可能漏；这里再做一道纯函数兜底。
    if (SELF_APP_NAMES.includes(app)) continue;
    out.push({ x, y, w, h, app, title: typeof o.title === 'string' ? o.title : '' });
  }
  return out;
}

/** #self-window-exclude 第三道闸：按调用方传入的自家 BrowserWindow bounds
 *  列表，剔除 IoU > 0.7 的"恰好就是我们自己窗口"项。纯函数，便于测。 */
export function excludeSelfWindows(
  windows: VisibleWindow[],
  selfBounds: Array<{ x: number; y: number; width: number; height: number }>,
): VisibleWindow[] {
  if (selfBounds.length === 0) return windows;
  return windows.filter((w) => !selfBounds.some((s) => iou(w, s) > 0.7));
}

function iou(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.width) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.height) - Math.max(a.y, b.y));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const ua = a.w * a.h + b.width * b.height - inter;
  return ua > 0 ? inter / ua : 0;
}
