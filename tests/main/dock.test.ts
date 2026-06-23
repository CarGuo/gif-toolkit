/**
 * R-DOCK-FLOATING — dock pure-function contract tests.
 *
 * 锁定：
 *   - dockActionMeta 与 DockActionKind 完全对齐（无遗漏、无多余）
 *   - clampDockPosition 在四个边界、四个角、单调 clamp 行为正确
 *   - computeDockMoveTarget 简单线性变换契约
 *   - recorderStateReducer v2 状态机：idle→selecting→recording→done/error
 *
 * dock.ts 顶层 import electron + './tray' + './recorder' + './recorderOverlay'，
 * 纯单测里 stub 掉就好。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp'), getAppPath: vi.fn(() => '/tmp'), isPackaged: false, quit: vi.fn() },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  screen: {
    getPrimaryDisplay: vi.fn(() => ({ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 720 }, workArea: { x: 0, y: 0, width: 1280, height: 720 } })),
    getDisplayNearestPoint: vi.fn(() => ({ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 720 }, workArea: { x: 0, y: 0, width: 1280, height: 720 } })),
    getAllDisplays: vi.fn(() => []),
  },
  systemPreferences: { getMediaAccessStatus: vi.fn(() => 'granted') },
  shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
  clipboard: { readText: vi.fn(() => '') },
  dialog: { showMessageBox: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(() => ({})) },
  nativeImage: { createEmpty: vi.fn(), createFromPath: vi.fn() },
  Tray: vi.fn(),
  globalShortcut: { register: vi.fn(() => true), unregister: vi.fn(), unregisterAll: vi.fn() },
}));

vi.mock('../../src/main/recorder', () => ({
  startRecorder: vi.fn(),
  stopRecorder: vi.fn(),
  cancelRecorder: vi.fn(),
  // dock.ts:40 顶层 import 了 detectMacScreenDevice；vi.mock 替换整个
  // 模块时必须显式 export，否则 binding 为 undefined，任何走 startDockRecording
  // 的集成测试会立刻 throw 'detectMacScreenDevice is not a function'。
  detectMacScreenDevice: vi.fn(async () => 1),
}));

vi.mock('../../src/main/recorderOverlay', () => ({
  openRegionSelectorOverlay: vi.fn(),
  showStaticOverlayForRegion: vi.fn(),
  closeStaticOverlay: vi.fn(),
}));

vi.mock('../../src/main/processor', () => ({
  startToolboxChain: vi.fn(async () => ({ status: 'done', steps: [{ status: 'done', outputs: ['/tmp/out.gif'] }] })),
}));

const {
  dockActionMeta,
  clampDockPosition,
  computeDockMoveTarget,
  computeDockResizeTarget,
  recorderStateReducer,
} = await import('../../src/main/dock');
const {
  captureRegionInsideFrame,
  dockRecorderParams,
  rememberDockRecorderParams,
  _resetDockRecorderParamsForTest,
} = await import('../../src/main/dockRecording');
const {
  DOCK_COLLAPSED_SIZE,
  DOCK_EXPANDED_SIZE,
  DOCK_EDGE_PADDING,
  DOCK_RECORDER_IDLE_STATE,
} = await import('../../src/shared/types/dock');

describe('dockActionMeta', () => {
  it('exposes all 11 v2 actions in deterministic order (就地优先 + 跳转其次 + 窗口控制)', () => {
    const meta = dockActionMeta();
    const kinds = meta.map((m) => m.kind);
    expect(kinds).toEqual([
      'dock-record-region',
      'dock-record-stop',
      'dock-record-cancel',
      'sniff-clipboard',
      'open-output-dir',
      'open-toolbox',
      'open-recorder',
      'open-history',
      'show-main',
      'hide-main',
      'quit-app',
    ]);
    // 没有重复
    expect(new Set(kinds).size).toBe(kinds.length);
    // 每一项都有 label / icon / description
    for (const m of meta) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.icon.length).toBeGreaterThan(0);
      expect(m.description.length).toBeGreaterThan(0);
    }
    // dock-record-stop 必须是 danger tone（红色），dock-record-region 必须是 primary tone
    const stop = meta.find((m) => m.kind === 'dock-record-stop');
    const rec = meta.find((m) => m.kind === 'dock-record-region');
    expect(stop?.tone).toBe('danger');
    expect(rec?.tone).toBe('primary');
  });
});

describe('dockRecorderParams', () => {
  it('uses gif-direct so dock recordings come out as GIF directly (recompress only when oversize)', () => {
    _resetDockRecorderParamsForTest();
    const params = dockRecorderParams({ displayId: 1, x: 10, y: 20, w: 320, h: 240 });
    expect(params.mode).toBe('gif-direct');
    expect(params.softMaxBytes).toBe(2 * 1024 * 1024);
    expect(params.maxBytes).toBe(4 * 1024 * 1024);
    expect(params.maxLongSide).toBe(800);
  });

  it('captures inside the visible red frame so the recording does not include the overlay border', () => {
    expect(captureRegionInsideFrame({ displayId: 1, x: 10, y: 20, w: 320, h: 240 })).toEqual({
      displayId: 1,
      x: 12,
      y: 22,
      w: 316,
      h: 236,
    });
  });

  it('does not invert tiny regions when insetting the visible frame', () => {
    expect(captureRegionInsideFrame({ displayId: 1, x: 10, y: 20, w: 5, h: 5 })).toEqual({
      displayId: 1,
      x: 10,
      y: 20,
      w: 5,
      h: 5,
    });
  });

  /* ------------------------------------------------------------------ */
  /*  R-DOCK-FLOATING #shared-pref — sticky cache 把主窗用户偏好同步给     */
  /*  dock，避免「两套录屏」体验脱节（SC-DOCK-PARAMS-ISOLATED）。         */
  /* ------------------------------------------------------------------ */

  it('sticky: rememberDockRecorderParams 之后, dockRecorderParams 透传 fps/mode/maxBytes/maxLongSide/captureCursor/captureAudio', () => {
    _resetDockRecorderParamsForTest();
    rememberDockRecorderParams({
      region: { displayId: 99, x: 1, y: 2, w: 3, h: 4 }, // region 应被忽略
      mode: 'gif-direct',
      fps: 30,
      maxDurationSec: 60,
      captureCursor: false,
      captureAudio: true,
      softMaxBytes: 1 * 1024 * 1024,
      maxBytes: 8 * 1024 * 1024,
      maxLongSide: 1080,
    });
    const params = dockRecorderParams({ displayId: 1, x: 10, y: 20, w: 320, h: 240 });
    expect(params.region).toEqual({ displayId: 1, x: 10, y: 20, w: 320, h: 240 });
    expect(params.mode).toBe('gif-direct');
    expect(params.fps).toBe(30);
    expect(params.maxDurationSec).toBe(60);
    expect(params.captureCursor).toBe(false);
    expect(params.captureAudio).toBe(true);
    expect(params.softMaxBytes).toBe(1 * 1024 * 1024);
    expect(params.maxBytes).toBe(8 * 1024 * 1024);
    expect(params.maxLongSide).toBe(1080);
  });

  it('sticky: _reset 后 dockRecorderParams 回到 hardcode 默认值（fps=15/mode=gif-direct/maxLongSide=800）', () => {
    rememberDockRecorderParams({
      region: { displayId: 1, x: 0, y: 0, w: 100, h: 100 },
      mode: 'gif-direct',
      fps: 60,
      maxDurationSec: 5,
      captureCursor: false,
      captureAudio: true,
      softMaxBytes: 1,
      maxBytes: 2,
      maxLongSide: 9999,
    });
    _resetDockRecorderParamsForTest();
    const params = dockRecorderParams({ displayId: 1, x: 10, y: 20, w: 320, h: 240 });
    expect(params.mode).toBe('gif-direct');
    expect(params.fps).toBe(15);
    expect(params.maxLongSide).toBe(800);
    expect(params.captureCursor).toBe(true);
    expect(params.captureAudio).toBe(false);
  });
});

describe('clampDockPosition', () => {
  const workArea = { x: 0, y: 0, width: 1280, height: 720 };
  const size = DOCK_COLLAPSED_SIZE;

  it('keeps a position inside the work area untouched (except integer rounding)', () => {
    expect(clampDockPosition({ x: 100, y: 200 }, size, workArea)).toEqual({ x: 100, y: 200 });
  });

  it('clamps negatives to the left/top edge with DOCK_EDGE_PADDING', () => {
    expect(clampDockPosition({ x: -50, y: -50 }, size, workArea)).toEqual({
      x: workArea.x + DOCK_EDGE_PADDING,
      y: workArea.y + DOCK_EDGE_PADDING,
    });
  });

  it('clamps overflow to the right/bottom edge minus size minus padding', () => {
    expect(clampDockPosition({ x: 99999, y: 99999 }, size, workArea)).toEqual({
      x: workArea.x + workArea.width - size.width - DOCK_EDGE_PADDING,
      y: workArea.y + workArea.height - size.height - DOCK_EDGE_PADDING,
    });
  });

  it('rounds fractional pixels (avoid sub-pixel setBounds)', () => {
    expect(clampDockPosition({ x: 100.7, y: 200.4 }, size, workArea)).toEqual({ x: 101, y: 200 });
  });

  it('honours a non-zero workArea origin (multi-monitor offset)', () => {
    const off = { x: 1280, y: 0, width: 1920, height: 1080 };
    const r1 = clampDockPosition({ x: 0, y: 0 }, size, off);
    expect(r1).toEqual({ x: off.x + DOCK_EDGE_PADDING, y: off.y + DOCK_EDGE_PADDING });
    const r2 = clampDockPosition({ x: 10_000, y: 10_000 }, size, off);
    expect(r2).toEqual({
      x: off.x + off.width - size.width - DOCK_EDGE_PADDING,
      y: off.y + off.height - size.height - DOCK_EDGE_PADDING,
    });
  });

  it('clamps differently for collapsed vs expanded size (expanded loses more max-x)', () => {
    const a = clampDockPosition({ x: 99999, y: 99999 }, DOCK_COLLAPSED_SIZE, workArea);
    const b = clampDockPosition({ x: 99999, y: 99999 }, DOCK_EXPANDED_SIZE, workArea);
    expect(b.x).toBeLessThan(a.x);
  });
});

describe('computeDockMoveTarget', () => {
  it('subtracts anchor offset from current cursor', () => {
    const out = computeDockMoveTarget(
      { startWindowX: 100, startWindowY: 200, cursorScreenX: 350, cursorScreenY: 600 },
      { offsetX: 50, offsetY: 30 },
    );
    expect(out).toEqual({ x: 300, y: 570 });
  });

  it('is pure: same input -> same output', () => {
    const input = { startWindowX: 0, startWindowY: 0, cursorScreenX: 123, cursorScreenY: 456 };
    const anchor = { offsetX: 10, offsetY: 20 };
    expect(computeDockMoveTarget(input, anchor)).toEqual(computeDockMoveTarget(input, anchor));
  });
});

describe('computeDockResizeTarget', () => {
  it('keeps the orb center stable when expanding from collapsed', () => {
    expect(computeDockResizeTarget(
      { x: 100, y: 200, width: DOCK_COLLAPSED_SIZE.width, height: DOCK_COLLAPSED_SIZE.height },
      DOCK_EXPANDED_SIZE,
    )).toEqual({ x: 94, y: 174 });
  });

  it('keeps the orb center stable when collapsing back', () => {
    expect(computeDockResizeTarget(
      { x: 94, y: 174, width: DOCK_EXPANDED_SIZE.width, height: DOCK_EXPANDED_SIZE.height },
      DOCK_COLLAPSED_SIZE,
    )).toEqual({ x: 100, y: 200 });
  });
});

describe('recorderStateReducer', () => {
  it('idle → selecting on select-start', () => {
    const s = recorderStateReducer(DOCK_RECORDER_IDLE_STATE, { type: 'select-start' });
    expect(s.phase).toBe('selecting');
  });

  it('selecting → idle on select-cancelled', () => {
    const s1 = recorderStateReducer(DOCK_RECORDER_IDLE_STATE, { type: 'select-start' });
    const s2 = recorderStateReducer(s1, { type: 'select-cancelled' });
    expect(s2).toEqual(DOCK_RECORDER_IDLE_STATE);
  });

  it('selecting → recording on recording-start, sessionId set, elapsedMs=0', () => {
    const s1 = recorderStateReducer(DOCK_RECORDER_IDLE_STATE, { type: 'select-start' });
    const s2 = recorderStateReducer(s1, { type: 'recording-start', sessionId: 'rec-1' });
    expect(s2).toMatchObject({ phase: 'recording', sessionId: 'rec-1', elapsedMs: 0 });
  });

  it('progress 更新 elapsedMs 仅当 sessionId 匹配 + phase==recording', () => {
    const s2 = recorderStateReducer(
      { phase: 'recording', sessionId: 'rec-1', elapsedMs: 0, errorMessage: null, lastOutputPath: null },
      { type: 'progress', sessionId: 'rec-1', elapsedMs: 1500, substep: 'capturing' },
    );
    expect(s2.elapsedMs).toBe(1500);
    // 不匹配的 sessionId 应被忽略
    const s3 = recorderStateReducer(s2, { type: 'progress', sessionId: 'OTHER', elapsedMs: 9999, substep: 'capturing' });
    expect(s3.elapsedMs).toBe(1500);
    // idle 时收 progress 应忽略
    const s4 = recorderStateReducer(DOCK_RECORDER_IDLE_STATE, { type: 'progress', sessionId: 'rec-1', elapsedMs: 1, substep: 'capturing' });
    expect(s4).toEqual(DOCK_RECORDER_IDLE_STATE);
  });

  it('recording → finalizing 在 finalize-request / cancel-request 之后', () => {
    const base = { phase: 'recording' as const, sessionId: 'rec-1', elapsedMs: 100, errorMessage: null, lastOutputPath: null };
    expect(recorderStateReducer(base, { type: 'finalize-request' }).phase).toBe('finalizing');
    expect(recorderStateReducer(base, { type: 'cancel-request' }).phase).toBe('finalizing');
  });

  it('done 包含 lastOutputPath，sessionId 清空', () => {
    const base = { phase: 'finalizing' as const, sessionId: 'rec-1', elapsedMs: 1234, errorMessage: null, lastOutputPath: null };
    const s = recorderStateReducer(base, { type: 'done', outputPath: '/tmp/out.mp4' });
    expect(s.phase).toBe('done');
    expect(s.lastOutputPath).toBe('/tmp/out.mp4');
    expect(s.sessionId).toBeNull();
  });

  it('cancelled 重置为 idle', () => {
    const base = { phase: 'finalizing' as const, sessionId: 'rec-1', elapsedMs: 1234, errorMessage: null, lastOutputPath: null };
    expect(recorderStateReducer(base, { type: 'cancelled' })).toEqual(DOCK_RECORDER_IDLE_STATE);
  });

  it('error 携带消息进入 error 阶段', () => {
    const s = recorderStateReducer(DOCK_RECORDER_IDLE_STATE, { type: 'error', message: 'avfoundationDeviceIndex required' });
    expect(s.phase).toBe('error');
    expect(s.errorMessage).toBe('avfoundationDeviceIndex required');
  });
});
