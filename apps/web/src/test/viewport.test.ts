import { describe, expect, it } from "vitest";
import { centerScroll, wheelZoomFactor, zoomAt } from "../lib/viewport";

// 视口坐标 = (场景坐标 + scroll) * zoom
const toScene = (v: { zoom: number; scrollX: number; scrollY: number }, px: number, py: number) => ({
  x: px / v.zoom - v.scrollX,
  y: py / v.zoom - v.scrollY,
});

describe("视口缩放", () => {
  it("缩放前后，鼠标指向的场景点保持不动", () => {
    const v = { zoom: 1, scrollX: 40, scrollY: -20 };
    const before = toScene(v, 300, 200);
    const next = zoomAt(v, 300, 200, 1.7);
    const after = toScene(next, 300, 200);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("向上滚放大、向下滚缩小", () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    expect(wheelZoomFactor(0)).toBe(1);
  });

  it("缩放倍率被限制在 0.1 到 30 之间", () => {
    expect(zoomAt({ zoom: 1, scrollX: 0, scrollY: 0 }, 0, 0, 1000).zoom).toBe(30);
    expect(zoomAt({ zoom: 1, scrollX: 0, scrollY: 0 }, 0, 0, 0.0001).zoom).toBe(0.1);
  });

  it("centerScroll 仍然把目标点放到视口中心", () => {
    const v = { width: 800, height: 600, zoom: 2 };
    const s = centerScroll(100, 50, v);
    const p = { x: (100 + s.scrollX) * v.zoom, y: (50 + s.scrollY) * v.zoom };
    expect(p.x).toBeCloseTo(400);
    expect(p.y).toBeCloseTo(300);
  });
});
