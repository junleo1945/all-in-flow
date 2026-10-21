import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { copyText } from "../lib/clipboard";
import { buildFileTree, type TreeNode } from "../lib/fileTree";
import { PromptDoc } from "./PromptDoc";
import { useI18n } from "../i18n";

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
  /** 复制是主要操作（例如粘贴到聊天窗口的提示词）：复制放在底部作为主按钮，下载降为次要按钮 */
  copyPrimary?: boolean;
  /** 不显示文件名（只有一个文件、文件名对用户没有意义时） */
  hidePath?: boolean;
  /** 调起系统的分享面板（手机上可以直接发给其他应用或设备）；不支持时不传，按钮不显示 */
  onShare?: () => Promise<void> | void;
  /** 文件是提示词文档：默认排成易读的文档，可以切换查看原文；复制和下载仍然是原文 */
  renderDoc?: boolean;
}

/**
 * 导出预览：多个文件时左侧是文件树，点击文件在右侧预览内容并可以单独复制。
 * 通过 portal 挂在 body 上，避免被导出菜单的定位和层级影响。
 */
export function ExportPreview({ spec, onClose, top }: { spec: ExportPreviewSpec; onClose: () => void; top?: ReactNode }) {
  const { t } = useI18n();
  const [active, setActive] = useState(spec.files[0]?.path ?? "");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [raw, setRaw] = useState(false);
  const file = spec.files.find((f) => f.path === active) ?? spec.files[0];
  const text = file && typeof file.content === "string" ? file.content : null;
  const tree = useMemo(() => buildFileTree(spec.files.map((f) => f.path)), [spec.files]);

  useEffect(() => setCopied(false), [active, text]);
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
      setErr((e as Error).message || t("exp.copyFail"));
    }
  };

  const download = async () => {
    setErr("");
    setBusy(true);
    try {
      await spec.onDownload();
    } catch (e) {
      setErr((e as Error).message || t("exp.downloadFail"));
    } finally {
      setBusy(false);
    }
  };

  const share = async () => {
    setErr("");
    try {
      await spec.onShare?.();
    } catch (e) {
      // 用户关闭分享面板时浏览器会抛 AbortError，不算失败
      if ((e as Error).name !== "AbortError") setErr((e as Error).message || t("exp.shareFail"));
    }
  };

  const copyButton = (cls: string) => (
    <button className={`btn ${cls}`} disabled={text === null} onClick={copy}>
      {copied ? t("exp.copied") : t("exp.copy")}
    </button>
  );

  return createPortal(
    <div className="modal-back export-preview-back" onClick={onClose}>
      <div className="card modal export-preview" role="dialog" aria-label={spec.title} onClick={(e) => e.stopPropagation()}>
        <button className="x" onClick={onClose} aria-label={t("exp.close")}>×</button>
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
            <nav className="ep-tree" aria-label={t("exp.fileList")}>
              {renderTree(tree, 0, file?.path ?? "", setActive)}
            </nav>
          )}
          <section className="ep-pane">
            {(!(spec.copyPrimary && spec.hidePath) || spec.renderDoc) && (
              <div className="ep-bar">
                {spec.hidePath ? <span /> : <span className="mono ep-path" title={file?.path}>{file?.path}</span>}
                <span className="ep-bar-btns">
                  {spec.renderDoc && text !== null && (
                    <button className="btn btn-line" onClick={() => setRaw((v) => !v)}>{raw ? t("exp.viewDoc") : t("exp.viewRaw")}</button>
                  )}
                  {!spec.copyPrimary && copyButton("btn-line")}
                </span>
              </div>
            )}
            {text === null ? (
              <p className="muted ep-empty">{t("exp.binary")}</p>
            ) : spec.renderDoc && !raw ? (
              <div className="ep-doc"><PromptDoc text={text} /></div>
            ) : (
              <pre className="ep-code">{text}</pre>
            )}
          </section>
        </div>
        <div className="ep-foot">
          {err ? <span className="notice-error">{err}</span> : <span />}
          <span className="ep-actions">
            {spec.copyPrimary ? (
              <>
                {spec.onShare && <button className="btn btn-line" disabled={text === null} onClick={share}>{t("exp.share")}</button>}
                <button className="btn btn-line" disabled={busy} onClick={download}>{spec.downloadLabel}</button>
                {copyButton("btn-ink")}
              </>
            ) : (
              <button className="btn btn-ink" disabled={busy} onClick={download}>{spec.downloadLabel}</button>
            )}
          </span>
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
