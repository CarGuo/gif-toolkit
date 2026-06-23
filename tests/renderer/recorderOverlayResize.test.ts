/**
 * R-REC-DESKTOP-AREA #snap-default-and-adjust — applyResize 纯函数契约。
 * 8 把 handle + move + clamp 到 bounds + 保最小尺寸。
 */
import { describe, expect, it } from 'vitest';
import { applyResize } from '../../src/renderer/recorderOverlay';

const BOUNDS = { width: 1000, height: 800 };
const BASE = { x: 200, y: 150, w: 400, h: 300 };

describe('applyResize', () => {
  it('move clamps to bounds origin', () => {
    const r = applyResize(BASE, 'move', -9999, -9999, BOUNDS);
    expect(r).toEqual({ x: 0, y: 0, w: 400, h: 300 });
  });

  it('move clamps to bounds far edge', () => {
    const r = applyResize(BASE, 'move', 9999, 9999, BOUNDS);
    expect(r).toEqual({ x: 600, y: 500, w: 400, h: 300 });
  });

  it('east handle grows width and clamps to right edge', () => {
    const r = applyResize(BASE, 'e', 9999, 0, BOUNDS);
    expect(r).toEqual({ x: 200, y: 150, w: 800, h: 300 });
  });

  it('east handle respects min side', () => {
    const r = applyResize(BASE, 'e', -9999, 0, BOUNDS, 50);
    expect(r.w).toBe(50);
  });

  it('west handle shifts x and shrinks width preserving right edge', () => {
    const r = applyResize(BASE, 'w', 50, 0, BOUNDS);
    expect(r).toEqual({ x: 250, y: 150, w: 350, h: 300 });
  });

  it('west handle stops at x=0', () => {
    const r = applyResize(BASE, 'w', -9999, 0, BOUNDS);
    expect(r.x).toBe(0);
    expect(r.w).toBe(600);
  });

  it('north handle shrinks from top preserving bottom edge', () => {
    const r = applyResize(BASE, 'n', 100, 100, BOUNDS);
    expect(r).toEqual({ x: 200, y: 250, w: 400, h: 200 });
  });

  it('south handle clamps to bottom bounds', () => {
    const r = applyResize(BASE, 's', 0, 9999, BOUNDS);
    expect(r).toEqual({ x: 200, y: 150, w: 400, h: 650 });
  });

  it('nw corner resizes from top-left and respects minSide', () => {
    const r = applyResize(BASE, 'nw', 9999, 9999, BOUNDS, 50);
    // x can't go past base.x + w - minSide = 550; y past base.y + h - 50 = 400
    expect(r.x).toBe(550);
    expect(r.y).toBe(400);
    expect(r.w).toBe(50);
    expect(r.h).toBe(50);
  });

  it('se corner grows both axes simultaneously', () => {
    const r = applyResize(BASE, 'se', 100, 50, BOUNDS);
    expect(r).toEqual({ x: 200, y: 150, w: 500, h: 350 });
  });

  it('move is no-op with zero delta', () => {
    expect(applyResize(BASE, 'move', 0, 0, BOUNDS)).toEqual(BASE);
  });
});
