import { describe, expect, it } from "vitest";
import { centerScroll, initialView, topCenterScroll, wheelZoomFactor, zoomAt } from "../lib/viewport";

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

  it("topCenterScroll 让内容水平居中、顶部留出边距", () => {
    const bounds = { minX: 100, minY: 40, width: 200 };
    const v = { width: 800, zoom: 1.5 };
    const s = topCenterScroll(bounds, v, 24);
    expect((100 + 100 + s.scrollX) * v.zoom).toBeCloseTo(400);
    expect((40 + s.scrollY) * v.zoom).toBeCloseTo(24);
  });

  it("initialView：放得下就居中，小图不放大", () => {
    const v = initialView({ minX: 0, minY: 0, width: 200, height: 100 }, { width: 800, height: 600 });
    expect(v.zoom).toBe(1);
    expect((100 + v.scrollX) * v.zoom).toBeCloseTo(400);
    expect((50 + v.scrollY) * v.zoom).toBeCloseTo(300);
  });

  it("initialView：放不下时以下限缩放，从顶部开始显示", () => {
    const v = initialView({ minX: 0, minY: 0, width: 300, height: 5000 }, { width: 800, height: 600 });
    expect(v.zoom).toBe(1);
    expect((0 + v.scrollY) * v.zoom).toBeCloseTo(24);
    expect((150 + v.scrollX) * v.zoom).toBeCloseTo(400);
  });

  it("initialView：下限调低时仍可缩小适应全图", () => {
    const v = initialView({ minX: 0, minY: 0, width: 300, height: 1200 }, { width: 800, height: 600 }, { pad: 24, minZoom: 0.1 });
    expect(v.zoom).toBeCloseTo((600 - 48) / 1200);
  });
});
