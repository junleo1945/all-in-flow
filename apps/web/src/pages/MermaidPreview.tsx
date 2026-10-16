import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { exportToBlob, exportToSvg } from "@excalidraw/excalidraw";
import { Topbar } from "../components/Topbar";
import { CanvasView, useMermaidScene } from "../components/CanvasView";

const DRAFT_KEY = "aif:mermaid-draft";
const WIDTH_KEY = "aif:mermaid-editor-width";
const DEFAULT_W = 420;
const MIN_W = 280; // 左栏最小宽度
const MIN_CANVAS_W = 320; // 右侧画布至少留出的宽度

// 第一次打开时的默认内容
const SAMPLE = `flowchart TD
  A[收到需求] --> B{是否紧急?}
  B -- 是 --> C[立即处理]
  B -- 否 --> D[排入计划]
  C --> E[通知相关人]
  D --> E`;

// 浏览器存储在隐私模式等情况下可能不可用，读写失败时当作没有草稿
function loadDraft() {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? SAMPLE;
  } catch {
    return SAMPLE;
  }
}

// 左栏宽度同样存在本地；读写失败时使用默认宽度
function loadWidth() {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_W;
  } catch {
    return DEFAULT_W;
  }
}

function saveWidth(w: number) {
  try {
    localStorage.setItem(WIDTH_KEY, String(w));
  } catch {
    /* 存不了不影响拖拽 */
  }
}

/** 限制左栏宽度：不小于 MIN_W，且右侧画布至少留出 MIN_CANVAS_W */
function clampWidth(w: number) {
  return Math.min(Math.max(w, MIN_W), Math.max(MIN_W, window.innerWidth - MIN_CANVAS_W));
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Mermaid 预览：左边粘贴 mermaid 语法，右边实时渲染。纯前端，不保存到服务端。 */
export default function MermaidPreviewPage() {
  const [src, setSrc] = useState(loadDraft);
  const { scene, loading, error } = useMermaidScene(src);
  const [exportErr, setExportErr] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [editorW, setEditorW] = useState(() => clampWidth(loadWidth()));
  const dragging = useRef(false);

  const onSplitDown = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onSplitMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    // 左栏宽度 = 鼠标相对页面容器左边缘的距离
    const left = e.currentTarget.parentElement!.getBoundingClientRect().left;
    const next = clampWidth(e.clientX - left);
    setEditorW(next);
    saveWidth(next); // 每次移动都存，不依赖松开时的闭包取值
  };
  const onSplitUp = () => {
    dragging.current = false;
  };
  // 键盘也能调整：左右方向键每次 16px
  const onSplitKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = clampWidth(editorW + (e.key === "ArrowLeft" ? -16 : 16));
    setEditorW(next);
    saveWidth(next);
  };

  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, src);
    } catch {
      /* 存不了草稿不影响使用 */
    }
  }, [src]);

  const exportAs = async (type: "png" | "svg") => {
    if (!scene) return;
    setExportErr("");
    const opts = {
      elements: scene.elements as any,
      files: (scene.files ?? null) as any,
      appState: { exportBackground: true, viewBackgroundColor: "#FFFEFA" },
      exportPadding: 24,
    };
    try {
      if (type === "png") {
        download(await exportToBlob({ ...opts, mimeType: "image/png" }), "mermaid.png");
      } else {
        const svg = await exportToSvg(opts);
        download(new Blob([svg.outerHTML], { type: "image/svg+xml" }), "mermaid.svg");
      }
    } catch (e) {
      setExportErr(`导出失败：${(e as Error).message}`);
    }
  };

  // 菜单：点击空白处或按 Esc 关闭
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: globalThis.PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const copySrc = async () => {
    setMenuOpen(false);
    setExportErr("");
    try {
      await navigator.clipboard.writeText(src);
    } catch {
      setExportErr("复制失败：浏览器不允许访问剪贴板");
    }
  };

  const clearSrc = () => {
    setMenuOpen(false);
    setSrc("");
  };

  const runExport = (type: "png" | "svg") => {
    setMenuOpen(false);
    void exportAs(type);
  };

  return (
    <div className="page">
      <Topbar />
      <div className="mmd" style={{ "--mmd-w": `${editorW}px` } as CSSProperties}>
        <section className="mmd-editor">
          <div className="mmd-input-wrap">
            <textarea
              className="mmd-input"
              value={src}
              onChange={(e) => setSrc(e.target.value)}
              spellCheck={false}
              placeholder={"flowchart TD\n  A[开始] --> B[结束]"}
              aria-label="mermaid 代码"
            />
            {loading && <span className="mmd-loading">渲染中…</span>}
            <div className="menu-wrap mmd-menu" ref={menuRef}>
              <button
                type="button"
                className="mmd-menu-btn"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label="菜单"
                title="菜单"
                onClick={() => setMenuOpen((v) => !v)}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <circle cx="5" cy="12" r="2" />
                  <circle cx="12" cy="12" r="2" />
                  <circle cx="19" cy="12" r="2" />
                </svg>
              </button>
              {menuOpen && (
                <div className="pop-menu" role="menu">
                  <button type="button" role="menuitem" onClick={copySrc} disabled={!src}>复制代码</button>
                  <button type="button" role="menuitem" onClick={clearSrc} disabled={!src}>删除代码</button>
                  <hr />
                  <button type="button" role="menuitem" onClick={() => runExport("png")} disabled={!scene}>导出 PNG</button>
                  <button type="button" role="menuitem" onClick={() => runExport("svg")} disabled={!scene}>导出 SVG</button>
                </div>
              )}
            </div>
          </div>
          {exportErr && <div className="notice-error">{exportErr}</div>}
        </section>
        <div
          className="mmd-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整左右宽度"
          aria-valuenow={editorW}
          tabIndex={0}
          onPointerDown={onSplitDown}
          onPointerMove={onSplitMove}
          onPointerUp={onSplitUp}
          onPointerCancel={onSplitUp}
          onKeyDown={onSplitKey}
        />
        <section className="mmd-canvas">
          <CanvasView
            scene={scene}
            loading={loading}
            error={error}
            legend={false}
            emptyText="在左侧粘贴 mermaid 语法，流程图会出现在这里。"
            readonlyHint=""
            wheelZoom
            fitToContent
          />
        </section>
      </div>
    </div>
  );
}
