import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { copyText } from "../lib/clipboard";
import { buildFileTree, type TreeNode } from "../lib/fileTree";

export interface PreviewFile {
  path: string;
  content: string | Uint8Array;
}

export interface ExportPreviewSpec {
  title: string;
  files: PreviewFile[];
  /** 运行前需要、注意事项等，显示在标题下方 */
  notes: string[];
  downloadLabel: string;
  onDownload: () => Promise<void> | void;
}

/**
 * 导出预览：多个文件时左侧是文件树，点击文件在右侧预览内容并可以单独复制。
 * 通过 portal 挂在 body 上，避免被导出菜单的定位和层级影响。
 */
export function ExportPreview({ spec, onClose, top }: { spec: ExportPreviewSpec; onClose: () => void; top?: ReactNode }) {
  const [active, setActive] = useState(spec.files[0]?.path ?? "");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const file = spec.files.find((f) => f.path === active) ?? spec.files[0];
  const text = file && typeof file.content === "string" ? file.content : null;
  const tree = useMemo(() => buildFileTree(spec.files.map((f) => f.path)), [spec.files]);

  useEffect(() => setCopied(false), [active]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = async () => {
    if (text === null) return;
    setErr("");
    try {
      await copyText(text);
      setCopied(true);
    } catch (e) {
      setErr((e as Error).message || "复制失败");
    }
  };

  const download = async () => {
    setErr("");
    setBusy(true);
    try {
      await spec.onDownload();
    } catch (e) {
      setErr((e as Error).message || "下载失败");
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-back export-preview-back" onClick={onClose}>
      <div className="card modal export-preview" role="dialog" aria-label={spec.title} onClick={(e) => e.stopPropagation()}>
        <button className="x" onClick={onClose} aria-label="关闭">×</button>
        <h2>{spec.title}</h2>
        {spec.notes.length > 0 && (
          <div className="ep-notes">
            {spec.notes.map((n) => (
              <div key={n} className="req">{n}</div>
            ))}
          </div>
        )}
        {top}
        <div className={`ep-body${spec.files.length > 1 ? "" : " single"}`}>
          {spec.files.length > 1 && (
            <nav className="ep-tree" aria-label="文件列表">
              {renderTree(tree, 0, file?.path ?? "", setActive)}
            </nav>
          )}
          <section className="ep-pane">
            <div className="ep-bar">
              <span className="mono ep-path" title={file?.path}>{file?.path}</span>
              <button className="btn btn-line" disabled={text === null} onClick={copy}>
                {copied ? "已复制" : "复制"}
              </button>
            </div>
            {text === null ? <p className="muted ep-empty">这是二进制文件，无法预览，请下载后查看。</p> : <pre className="ep-code">{text}</pre>}
          </section>
        </div>
        <div className="ep-foot">
          {err ? <span className="notice-error">{err}</span> : <span />}
          <button className="btn btn-ink" disabled={busy} onClick={download}>{spec.downloadLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function renderTree(nodes: TreeNode[], depth: number, activePath: string, onSelect: (path: string) => void): ReactNode[] {
  const indent = { paddingLeft: 10 + depth * 14 };
  return nodes.flatMap((n) =>
    n.file
      ? [
          <button key={n.path} type="button" className={`ep-file${n.path === activePath ? " on" : ""}`} style={indent} title={n.path} onClick={() => onSelect(n.path)}>
            {n.name}
          </button>,
        ]
      : [<div key={`dir:${n.path}`} className="ep-dir" style={indent}>{n.name}/</div>, ...renderTree(n.children, depth + 1, activePath, onSelect)],
  );
}
