import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type PointerEvent as ReactPointerEvent } from "react";
import type { WorkflowIR } from "@aif/workflow-ir";
import { irToScene, type Scene } from "../lib/canvas";
import { centerScroll } from "../lib/viewport";
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
      aria-label="流程图缩略图，点击或拖动可移动画布"
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
      .catch((e) => !cancelled && setState({ scene: null, error: `画布渲染失败：${(e as Error).message}`, loading: false }));
    return () => {
      cancelled = true;
    };
  }, [ir]);
  return state;
}

export function CanvasView({ scene, loading, error, readOnly = true }: { scene: Scene | null; loading: boolean; error: string; readOnly?: boolean }) {
  // API 与它所属的场景绑定：场景变化后 Excalidraw 会重新挂载，旧的 API 自动失效
  const [bound, setBound] = useState<{ scene: Scene; api: ExcalidrawAPI } | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const api = scene && bound?.scene === scene ? bound.api : null;
  // 回调必须保持同一个引用：每次渲染都换新函数，Excalidraw 会重复回调，导致无限重渲染
  const handleApi = useCallback((next: ExcalidrawAPI) => {
    if (scene) setBound({ scene, api: next });
  }, [scene]);
  const handleChange = useCallback((_: unknown, appState: ExcalidrawAppState) => {
    const next = { scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom.value, width: appState.width, height: appState.height };
    setViewport((prev) =>
      prev && prev.scrollX === next.scrollX && prev.scrollY === next.scrollY && prev.zoom === next.zoom && prev.width === next.width && prev.height === next.height ? prev : next,
    );
  }, []);

  return (
    <div className="canvas-host">
      <div className="legend">
        <span><span className="dot det" /> 脚本执行</span>
        <span><span className="dot llm" /> AI 执行</span>
        <span><span className="dot hum" /> 需要人工</span>
      </div>
      {error && <div className="notice-error" style={{ position: "absolute", inset: 24, zIndex: 6 }}>{error}</div>}
      {scene && api && <Minimap elements={scene.elements as MiniElement[]} api={api} viewport={viewport} />}
      {!scene && !error && (
        <div className="empty" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
          {loading ? "正在绘制流程图…" : "还没有工作流。完成访谈并选定方案后，流程图会出现在这里。"}
        </div>
      )}
      {scene && (
        <Excalidraw
          key={scene.elements.length + ":" + (scene.elements[0] as { id?: string } | undefined)?.id}
          initialData={{
            elements: scene.elements as any,
            files: scene.files as any,
            appState: { viewBackgroundColor: "#FFFEFA", zenModeEnabled: false, gridModeEnabled: false },
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
      {readOnly && <span className="readonly">只读 · 通过对话修改</span>}
    </div>
  );
}
