/** 视口换算：不依赖 Excalidraw，便于单独测试 */

/** 让场景坐标 (sx, sy) 位于视口中心所需的滚动值（Excalidraw：视口坐标 = (场景坐标 + scroll) * zoom） */
export function centerScroll(sx: number, sy: number, v: { width: number; height: number; zoom: number }) {
  return { scrollX: v.width / (2 * v.zoom) - sx, scrollY: v.height / (2 * v.zoom) - sy };
}
