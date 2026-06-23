import { describe, it, expect, vi } from 'vitest';
import type { RecorderRegion } from '../../src/shared/types/recorder';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false, getAppPath: vi.fn(() => '/tmp') },
  systemPreferences: { isTrustedAccessibilityClient: vi.fn(() => false) },
  screen: {
    getAllDisplays: vi.fn(() => []),
    getPrimaryDisplay: vi.fn(() => ({ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1 })),
  },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: vi.fn(() => []) }),
  shell: { openExternal: vi.fn() },
}));

const { applyOverlayContentDelta } = await import('../../src/main/recorderOverlay');

describe('applyOverlayContentDelta (SC-REC-OVERLAY-MENU-BAR)', () => {
  const raw: RecorderRegion = { displayId: 1, x: 100, y: 200, w: 400, h: 300 };

  it('macOS 主屏 menu bar=24pt：raw + (workArea - bounds) 把 overlay-local CSS 抬到 display-local', () => {
    // workArea.y=24 表示 menu bar 高 24pt，selector 渲染端 (0,0) ≈ workArea 顶
    const out = applyOverlayContentDelta(
      raw,
      { x: 0, y: 24 },   // workArea
      { x: 0, y: 0 },    // display.bounds
    );
    expect(out).toEqual({ displayId: 1, x: 100, y: 224, w: 400, h: 300 });
  });

  it('macOS notch 屏 menu bar=37pt：偏移按 workArea-bounds 精确累加', () => {
    const out = applyOverlayContentDelta(
      raw,
      { x: 0, y: 37 },
      { x: 0, y: 0 },
    );
    expect(out.y).toBe(237);
  });

  it('win/linux workArea==display.bounds：偏移为 0，region 不变（跨平台契约）', () => {
    const out = applyOverlayContentDelta(
      raw,
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    );
    expect(out).toEqual(raw);
  });

  it('外接副屏 display.bounds.x=1920 + 该屏自己的 menu bar：偏移按 (workArea-bounds) 精确算', () => {
    // 副屏 bounds 起点 (1920,0)，副屏 workArea 起点 (1920,24)
    const out = applyOverlayContentDelta(
      raw,
      { x: 1920, y: 24 },
      { x: 1920, y: 0 },
    );
    expect(out).toEqual({ displayId: 1, x: 100, y: 224, w: 400, h: 300 });
  });

  it('w/h/displayId 透传不变（不会被 delta 污染）', () => {
    const out = applyOverlayContentDelta(
      { displayId: 7, x: 0, y: 0, w: 1280, h: 720 },
      { x: 0, y: 32 },
      { x: 0, y: 0 },
    );
    expect(out.w).toBe(1280);
    expect(out.h).toBe(720);
    expect(out.displayId).toBe(7);
  });

  it('反向校正（static overlay）：display-local CSS 减去 (workArea-bounds) 得到 overlay-local CSS', () => {
    // 校正过的 region (x=100,y=224) 减去 menu bar=24 = overlay-local (100, 200)
    const displayLocal = { displayId: 1, x: 100, y: 224, w: 400, h: 300 };
    const workArea = { x: 0, y: 24 };
    const bounds = { x: 0, y: 0 };
    const overlayLocal = {
      ...displayLocal,
      x: displayLocal.x - (workArea.x - bounds.x),
      y: displayLocal.y - (workArea.y - bounds.y),
    };
    expect(overlayLocal).toEqual({ displayId: 1, x: 100, y: 200, w: 400, h: 300 });
  });
});
