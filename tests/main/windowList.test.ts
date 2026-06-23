/**
 * R-REC-DESKTOP-AREA #window-snap + #self-window-exclude — windowList JXA
 * 输出解析、自家窗口过滤、pickWindowAt 命中逻辑契约。
 *
 * 这三个都是纯函数；spawn 真 osascript 在 CI 里要么不存在要么不许，
 * 所以只测 parser + filter + picker。
 */
import { describe, expect, it } from 'vitest';
import {
  parseJxaOutput,
  excludeSelfWindows,
  SELF_APP_NAMES,
  type VisibleWindow,
} from '../../src/main/windowList';

describe('parseJxaOutput', () => {
  it('returns [] on empty', () => {
    expect(parseJxaOutput('')).toEqual([]);
    expect(parseJxaOutput('   ')).toEqual([]);
  });

  it('returns [] on non-json', () => {
    expect(parseJxaOutput('not json')).toEqual([]);
    expect(parseJxaOutput('{not array}')).toEqual([]);
  });

  it('returns [] when payload is object instead of array', () => {
    expect(parseJxaOutput(JSON.stringify({ x: 1 }))).toEqual([]);
  });

  it('parses well-formed records', () => {
    const raw = JSON.stringify([
      { x: 100, y: 50, w: 800, h: 600, app: 'Safari', title: 'Apple' },
      { x: 200, y: 300, w: 400, h: 300, app: 'Code', title: 'main.ts' },
    ]);
    const out = parseJxaOutput(raw);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ x: 100, y: 50, w: 800, h: 600, app: 'Safari', title: 'Apple' });
  });

  it('skips records with non-finite coords or zero-size', () => {
    const raw = JSON.stringify([
      { x: 'bad', y: 0, w: 100, h: 100, app: 'A', title: '' },
      { x: 0, y: 0, w: 4, h: 100, app: 'B', title: '' },
      { x: 0, y: 0, w: 100, h: 0, app: 'C', title: '' },
      { x: 10, y: 10, w: 50, h: 50, app: 'D', title: 'ok' },
    ]);
    const out = parseJxaOutput(raw);
    expect(out).toHaveLength(1);
    expect(out[0].app).toBe('D');
  });

  it('defaults missing app/title to empty string', () => {
    const raw = JSON.stringify([{ x: 0, y: 0, w: 100, h: 100 }]);
    const out = parseJxaOutput(raw);
    expect(out[0].app).toBe('');
    expect(out[0].title).toBe('');
  });

  it('#self-window-exclude — drops records owned by SELF_APP_NAMES', () => {
    const raw = JSON.stringify([
      { x: 0, y: 0, w: 100, h: 100, app: SELF_APP_NAMES[0], title: 'dock' },
      { x: 200, y: 200, w: 400, h: 300, app: 'Safari', title: 'page' },
      { x: 50, y: 50, w: 200, h: 100, app: 'Electron', title: 'overlay' },
    ]);
    const out = parseJxaOutput(raw);
    expect(out).toHaveLength(1);
    expect(out[0].app).toBe('Safari');
  });
});

describe('excludeSelfWindows', () => {
  const mk = (x: number, y: number, w: number, h: number, app = 'X'): VisibleWindow =>
    ({ x, y, w, h, app, title: '' });

  it('returns input unchanged when self list is empty', () => {
    const wins = [mk(0, 0, 100, 100), mk(200, 200, 300, 300)];
    expect(excludeSelfWindows(wins, [])).toEqual(wins);
  });

  it('removes windows with IoU > 0.7 against any self bound', () => {
    const wins = [
      mk(100, 100, 200, 200, 'Chrome'),
      mk(50, 50, 100, 100, 'OurDock'), // 完全重叠 self[0]
    ];
    const self = [{ x: 50, y: 50, width: 100, height: 100 }];
    const out = excludeSelfWindows(wins, self);
    expect(out).toHaveLength(1);
    expect(out[0].app).toBe('Chrome');
  });

  it('keeps windows with small overlap (IoU <= 0.7)', () => {
    const wins = [mk(0, 0, 200, 200, 'Big')];
    const self = [{ x: 0, y: 0, width: 100, height: 100 }]; // 25% overlap, IoU ~0.25
    expect(excludeSelfWindows(wins, self)).toEqual(wins);
  });

  it('non-overlap = keep', () => {
    const wins = [mk(0, 0, 100, 100, 'A')];
    const self = [{ x: 500, y: 500, width: 100, height: 100 }];
    expect(excludeSelfWindows(wins, self)).toEqual(wins);
  });
});

// pickWindowAt 是 renderer 侧的纯函数；为了避免 vitest 跑 jsdom，
// 我们直接拷贝实现做契约锁（renderer/recorderOverlay.tsx 改名了请同步）。
function pickWindowAt(windows: VisibleWindow[] | undefined, px: number, py: number): VisibleWindow | null {
  if (!windows || windows.length === 0) return null;
  let best: VisibleWindow | null = null;
  let bestArea = Infinity;
  for (const w of windows) {
    if (px < w.x || py < w.y) continue;
    if (px > w.x + w.w || py > w.y + w.h) continue;
    const area = w.w * w.h;
    if (area < bestArea) { best = w; bestArea = area; }
  }
  return best;
}

describe('pickWindowAt (hit-test contract mirror)', () => {
  const mk = (x: number, y: number, w: number, h: number, app = 'App'): VisibleWindow =>
    ({ x, y, w, h, app, title: '' });

  it('returns null on empty / undefined / miss', () => {
    expect(pickWindowAt(undefined, 10, 10)).toBeNull();
    expect(pickWindowAt([], 10, 10)).toBeNull();
    expect(pickWindowAt([mk(0, 0, 100, 100)], 200, 200)).toBeNull();
  });

  it('returns the single hit', () => {
    const w = mk(0, 0, 100, 100);
    expect(pickWindowAt([w], 50, 50)).toBe(w);
  });

  it('prefers the smaller-area window on stacked overlap (toolbar over document)', () => {
    const big = mk(0, 0, 1000, 800, 'Editor');
    const tool = mk(100, 100, 200, 60, 'Toolbar');
    const out = pickWindowAt([big, tool], 150, 130);
    expect(out).toBe(tool);
  });

  it('still picks big window when click is outside the small one', () => {
    const big = mk(0, 0, 1000, 800, 'Editor');
    const tool = mk(100, 100, 200, 60, 'Toolbar');
    const out = pickWindowAt([big, tool], 500, 500);
    expect(out).toBe(big);
  });

  it('hit on the exact border counts as inside', () => {
    const w = mk(10, 10, 100, 100);
    expect(pickWindowAt([w], 10, 10)).toBe(w);
    expect(pickWindowAt([w], 110, 110)).toBe(w);
  });
});
