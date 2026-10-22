import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type PointerEvent as ReactPointerEvent } from "react";
import type { WorkflowIR } from "@aif/workflow-ir";
import { tr, useI18n } from "../i18n";
import { irToScene, mermaidToScene, type Scene } from "../lib/canvas";
import { centerScroll, initialView, wheelZoomFactor, zoomAt } from "../lib/viewport";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";

type ExcalidrawAPI = Parameters<NonNullable<ComponentProps<typeof Excalidraw>["excalidrawAPI"]>>[0];
type ExcalidrawAppState = Parameters<NonNullable<ComponentProps<typeof Excalidraw>["onChange"]>>[1];

/** 视口：场景坐标系中的滚动位置和缩放，来自 Excalidraw 的 appState */
interface Viewport {
  scrollX: number;
  scrollY: number;
  zoom: number;
  width: number;
  height: number;
}

const MM_W = 200;
const MM_H = 130;
const MM_PAD = 8;

interface MiniElement {
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  points?: [number, number][];
  strokeColor?: string;
  backgroundColor?: string;
  containerId?: string | null;
}

/** 所有可见图形（不含绑定在图形里的文字）的外接矩形 */
function sceneBounds(elements: MiniElement[]) {
  const shapes = elements.filter((e) => e.type !== "text" && !e.containerId);
  if (shapes.length === 0) return null;
  const minX = Math.min(...shapes.map((e) => e.x));
  const minY = Math.min(...shapes.map((e) => e.y));
  const maxX = Math.max(...shapes.map((e) => e.x + e.width));
  const maxY = Math.max(...shapes.map((e) => e.y + e.height));
  return { minX, minY, width: Math.max(maxX - minX, 1), height: Math.max(maxY - minY, 1) };
}

/**
 * 缩略图：把整张流程图缩小画在右下角，白色框表示当前可见的区域。
 * 点击或拖动缩略图即可把画布移动到对应位置。
 */
function Minimap({ elements, api, viewport }: { elements: MiniElement[]; api: ExcalidrawAPI; viewport: Viewport | null }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);
  const bounds = useMemo(() => sceneBounds(elements), [elements]);
  if (!bounds) return null;

  const scale = Math.min((MM_W - MM_PAD * 2) / bounds.width, (MM_H - MM_PAD * 2) / bounds.height);
  const offX = MM_PAD + (MM_W - MM_PAD * 2 - bounds.width * scale) / 2;
  const offY = MM_PAD + (MM_H - MM_PAD * 2 - bounds.height * scale) / 2;
  const toMini = (x: number, y: number) => [offX + (x - bounds.minX) * scale, offY + (y - bounds.minY) * scale] as const;

  // 视口在场景中的位置：Excalidraw 的换算是 视口坐标 = (场景坐标 + scroll) * zoom
  const view = viewport
    ? (() => {
        const [x, y] = toMini(-viewport.scrollX, -viewport.scrollY);
        return { x, y, w: (viewport.width / viewport.zoom) * scale, h: (viewport.height / viewport.zoom) * scale };
      })()
    : null;

  const moveTo = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!viewport || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const sx = (px - offX) / scale + bounds.minX;
    const sy = (py - offY) / scale + bounds.minY;
    api.updateScene({ appState: centerScroll(sx, sy, viewport) });
  };

  return (
    <svg
      ref={svgRef}
      className="minimap"
      width={MM_W}
      height={MM_H}
      viewBox={`0 0 ${MM_W} ${MM_H}`}
      role="img"
      aria-label={tr("canvas.minimapAria")}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        moveTo(e);
      }}
      onPointerMove={(e) => dragging.current && moveTo(e)}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
    >
      {elements.map((el, i) => {
        if (el.type === "arrow" || el.type === "line") {
          const pts = (el.points ?? [[0, 0], [el.width, el.height]]).map(([px, py]) => toMini(el.x + px, el.y + py));
          return <polyline key={i} points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke={el.strokeColor ?? "#8a8270"} strokeWidth={1} />;
        }
        if (el.containerId || el.type === "text") return null;
        const [x, y] = toMini(el.x, el.y);
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={el.width * scale}
            height={el.height * scale}
            rx={el.type === "ellipse" ? el.width * scale : 2}
            fill={el.backgroundColor && el.backgroundColor !== "transparent" ? el.backgroundColor : "#fff"}
            stroke={el.strokeColor ?? "#8a8270"}
            strokeWidth={1}
          />
        );
      })}
      {view && (
        <rect x={view.x} y={view.y} width={view.w} height={view.h} fill="rgba(31,30,27,.06)" stroke="#1F1E1B" strokeWidth={1.5} rx={2} pointerEvents="none" />
      )}
    </svg>
  );
}

/** 把 IR 转成 Excalidraw 场景；ir 变化时重新计算。 */
export function useScene(ir: WorkflowIR | null) {
  const [state, setState] = useState<{ scene: Scene | null; error: string; loading: boolean }>({ scene: null, error: "", loading: false });
  useEffect(() => {
    if (!ir) {
      setState({ scene: null, error: "", loading: false });
      return;
    }
    let cancelled = false;
    setState({ scene: null, error: "", loading: true });
    irToScene(ir)
      .then((scene) => !cancelled && setState({ scene, error: "", loading: false }))
      .catch((e) => !cancelled && setState({ scene: null, error: tr("canvas.renderFailed", { msg: (e as Error).message }), loading: false }));
    return () => {
      cancelled = true;
    };
  }, [ir]);
  return state;
}

/**
 * 把用户输入的 mermaid 文本转成场景：停止输入 delay 毫秒后才渲染；
 * 语法出错时保留上一次成功的场景，只报错，避免一打错字画布就变空。
 */
export function useMermaidScene(src: string, delay = 400) {
  const [state, setState] = useState<{ scene: Scene | null; error: string; loading: boolean }>({ scene: null, error: "", loading: false });
  useEffect(() => {
    if (!src.trim()) {
      setState({ scene: null, error: "", loading: false });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      mermaidToScene(src)
        .then((scene) => !cancelled && setState({ scene, error: "", loading: false }))
        .catch((e) => !cancelled && setState((s) => ({ scene: s.scene, error: tr("canvas.syntaxError", { msg: (e as Error).message }), loading: false })));
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [src, delay]);
  return state;
}

export function CanvasView({
  scene,
  loading,
  error,
  readOnly = true,
  legend = true,
  emptyText,
  readonlyHint,
  wheelZoom = true,
  fitToContent = true,
}: {
  scene: Scene | null;
  loading: boolean;
  error: string;
  readOnly?: boolean;
  /** 是否显示执行方式图例（脚本 / AI / 人工） */
  legend?: boolean;
  emptyText?: string;
  readonlyHint?: string;
  /** 为 true 时，普通滚轮直接缩放（以鼠标位置为中心）；Ctrl/⌘+滚轮仍交给 Excalidraw */
  wheelZoom?: boolean;
  /** 为 true 时，每次出现新场景都会缩放到能看见全图 */
  fitToContent?: boolean;
}) {
  const { t } = useI18n();
  const emptyMsg = emptyText ?? t("canvas.empty");
  // 只读提示默认不显示；需要时由调用方通过 readonlyHint 传入文案
  const hintMsg = readonlyHint ?? "";
  // API 与它所属的场景绑定：场景变化后 Excalidraw 会重新挂载，旧的 API 自动失效
  const [bound, setBound] = useState<{ scene: Scene; api: ExcalidrawAPI } | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const api = scene && bound?.scene === scene ? bound.api : null;
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<ExcalidrawAPI | null>(null);
  const fitPending = useRef(false);

  // 滚轮缩放：用捕获阶段拦截，先于 Excalidraw 的平移处理
  useEffect(() => {
    const el = hostRef.current;
    if (!el || !api || !wheelZoom) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      const st = api.getAppState();
      const rect = el.getBoundingClientRect();
      const next = zoomAt(
        { zoom: st.zoom.value, scrollX: st.scrollX, scrollY: st.scrollY },
        e.clientX - rect.left,
        e.clientY - rect.top,
        wheelZoomFactor(e.deltaY),
      );
      api.updateScene({ appState: { zoom: { value: next.zoom as any }, scrollX: next.scrollX, scrollY: next.scrollY } });
    };
    el.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => el.removeEventListener("wheel", onWheel, { capture: true });
  }, [api, wheelZoom]);
  // 手写字体是按需下载的：文字第一次绘制时字体可能还没到，先用了后备字体。字体到位后重绘一次，不必等用户缩放
  useEffect(() => {
    if (!api || typeof document === "undefined" || !document.fonts) return;
    const redraw = () => api.refresh();
    document.fonts.addEventListener("loadingdone", redraw);
    void document.fonts.ready.then(redraw);
    return () => document.fonts.removeEventListener("loadingdone", redraw);
  }, [api]);
  // 回调必须保持同一个引用：每次渲染都换新函数，Excalidraw 会重复回调，导致无限重渲染
  const handleApi = useCallback((next: ExcalidrawAPI) => {
    apiRef.current = next;
    fitPending.current = fitToContent;
    if (scene) setBound({ scene, api: next });
  }, [scene, fitToContent]);
  const handleChange = useCallback((_: unknown, appState: ExcalidrawAppState) => {
    // 初始化完成后的第一次变化，才缩放到全图：此前 Excalidraw 会把缩放重置为 100%
    if (fitPending.current && apiRef.current) {
      fitPending.current = false;
      // 不用 scrollToContent：适应全图时图一大就会把字缩得看不清。自己算视图，缩放有下限
      const bounds = sceneBounds(apiRef.current.getSceneElements() as unknown as MiniElement[]);
      if (bounds) {
        const view = initialView(bounds, { width: appState.width, height: appState.height });
        apiRef.current.updateScene({ appState: { zoom: { value: view.zoom as any }, scrollX: view.scrollX, scrollY: view.scrollY } });
      }
    }
    const next = { scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom.value, width: appState.width, height: appState.height };
    setViewport((prev) =>
      prev && prev.scrollX === next.scrollX && prev.scrollY === next.scrollY && prev.zoom === next.zoom && prev.width === next.width && prev.height === next.height ? prev : next,
    );
  }, []);

  return (
    <div className="canvas-host" ref={hostRef}>
      {legend && (
        <div className="legend">
          <span><span className="dot det" /> {t("canvas.legendDet")}</span>
          <span><span className="dot llm" /> {t("canvas.legendLlm")}</span>
          <span><span className="dot hum" /> {t("canvas.legendHum")}</span>
        </div>
      )}
      {/* 已有场景时报错只占顶部一条，不挡住上一次成功的图 */}
      {error && (
        <div
          className="notice-error"
          style={scene ? { position: "absolute", top: 16, left: 16, right: 16, zIndex: 6 } : { position: "absolute", inset: 24, zIndex: 6 }}
        >
          {error}
        </div>
      )}
      {scene && api && <Minimap elements={scene.elements as MiniElement[]} api={api} viewport={viewport} />}
      {!scene && !error && (
        <div className="empty" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
          {loading ? t("canvas.drawing") : emptyMsg}
        </div>
      )}
      {scene && (
        <Excalidraw
          key={scene.elements.length + ":" + (scene.elements[0] as { id?: string } | undefined)?.id}
          initialData={{
            elements: scene.elements as any,
            files: scene.files as any,
            appState: { viewBackgroundColor: "transparent", zenModeEnabled: false, gridModeEnabled: false },
            scrollToContent: true,
          }}
          excalidrawAPI={handleApi}
          onChange={handleChange}
          viewModeEnabled={readOnly}
          UIOptions={{
            canvasActions: { loadScene: false, saveToActiveFile: false, export: false, toggleTheme: false, changeViewBackgroundColor: false, saveAsImage: false },
          }}
        />
      )}
      {/* 放在画布之后渲染，避免被 Excalidraw 的层叠盖住 */}
      {readOnly && hintMsg && <span className="readonly">{hintMsg}</span>}
    </div>
  );
}
