/** 视口换算：不依赖 Excalidraw，便于单独测试 */

/** 滚轮缩放的倍率：deltaY 越大缩得越多，向上滚为放大 */
export function wheelZoomFactor(deltaY: number) {
  return Math.exp(-deltaY * 0.002);
}

/**
 * 以鼠标所在的屏幕点 (px, py) 为中心缩放后的 zoom 与 scroll。
 * 缩放前后，鼠标指向的场景坐标保持不变：视口坐标 = (场景坐标 + scroll) * zoom。
 */
export function zoomAt(
  v: { zoom: number; scrollX: number; scrollY: number },
  px: number,
  py: number,
  factor: number,
  limits = { min: 0.1, max: 30 },
) {
  const sceneX = px / v.zoom - v.scrollX;
  const sceneY = py / v.zoom - v.scrollY;
  const zoom = Math.min(Math.max(v.zoom * factor, limits.min), limits.max);
  return { zoom, scrollX: px / zoom - sceneX, scrollY: py / zoom - sceneY };
}

/** 让场景坐标 (sx, sy) 位于视口中心所需的滚动值（Excalidraw：视口坐标 = (场景坐标 + scroll) * zoom） */
export function centerScroll(sx: number, sy: number, v: { width: number; height: number; zoom: number }) {
  return { scrollX: v.width / (2 * v.zoom) - sx, scrollY: v.height / (2 * v.zoom) - sy };
}
