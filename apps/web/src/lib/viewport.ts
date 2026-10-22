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

/** 首次适应内容的缩放下限：再小，手写字体的细笔画就会发虚 */
export const MIN_FIT_ZOOM = 1;

/**
 * 首次打开时的视图：能完整放下就居中显示，放不下则按 MIN_FIT_ZOOM 为下限缩放。
 * 为下限所限放不下时，水平居中、从顶部开始显示，其余部分靠滚动或缩略图查看。
 * 缩放上限为 1（小图不放大）。
 */
export function initialView(
  bounds: { minX: number; minY: number; width: number; height: number },
  v: { width: number; height: number },
  opts = { pad: 24, minZoom: MIN_FIT_ZOOM },
) {
  const fit = Math.min((v.width - opts.pad * 2) / bounds.width, (v.height - opts.pad * 2) / bounds.height);
  const zoom = Math.max(Math.min(fit, 1), opts.minZoom);
  if (fit >= zoom) {
    const c = centerScroll(bounds.minX + bounds.width / 2, bounds.minY + bounds.height / 2, { ...v, zoom });
    return { zoom, ...c };
  }
  return { zoom, ...topCenterScroll(bounds, { width: v.width, zoom }, opts.pad) };
}

/**
 * 以缩放 zoom 显示场景外接矩形时，让内容水平居中、顶部留 pad 像素所需的滚动值。
 */
export function topCenterScroll(
  bounds: { minX: number; minY: number; width: number },
  v: { width: number; zoom: number },
  pad = 24,
) {
  return { scrollX: v.width / (2 * v.zoom) - (bounds.minX + bounds.width / 2), scrollY: pad / v.zoom - bounds.minY };
}
