import { useEffect, useRef, useState } from "react";
import { authorizationsApi, type Authorization } from "../lib/authorizations";
import { exportToN8n, workflowText, type ExportStage, type N8nExportResult } from "../lib/n8nExport";
import { download } from "../lib/exporters";
import { Select } from "./ui/Select";
import { useI18n } from "../i18n";

const STAGES: Array<ExportStage | "done"> = ["analyze", "match", "validate", "done"];

/**
 * 导出为 n8n 工作流：弹窗里完成，不跳页面。
 * 先选一个 n8n 授权，再由服务端分析流程图、匹配 n8n 的节点并校验，完成后复制 JSON 到 n8n 画布粘贴。
 */
export function N8nExportDialog({
  workflowId,
  version,
  slug,
  onOpenAuth,
  onClose,
}: {
  workflowId: string;
  version?: number;
  slug: string;
  /** 没有授权时，去授权管理添加（由调用方换成授权管理弹窗） */
  onOpenAuth: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [items, setItems] = useState<Authorization[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [authId, setAuthId] = useState("");
  const [stage, setStage] = useState<ExportStage | "done" | null>(null);
  const [result, setResult] = useState<N8nExportResult | null>(null);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const running = stage !== null && stage !== "done";
  /** 导出进行中关掉弹窗会取消导出（服务端随之停止），先确认 */
  const close = () => {
    if (running && !window.confirm(t("n8nExport.confirmClose"))) return;
    onClose();
  };

  useEffect(() => {
    authorizationsApi
      .list()
      .then((r) => {
        setEnabled(r.enabled);
        setItems(r.items);
        setAuthId(r.items[0]?.id ?? "");
      })
      .catch((e) => {
        setItems([]);
        setErr((e as Error).message);
      });
    return () => abort.current?.abort();
  }, []);

  const start = async () => {
    setErr("");
    setResult(null);
    setCopied(false);
    setStage("analyze");
    abort.current = new AbortController();
    try {
      const r = await exportToN8n(workflowId, { authorizationId: authId, ...(version ? { version } : {}) }, setStage, abort.current.signal);
      setResult(r);
      setStage("done");
    } catch (e) {
      if ((e as Error).name !== "AbortError") setErr((e as Error).message || t("n8nExport.failed"));
      setStage(null);
    }
  };

  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(workflowText(result));
      setCopied(true);
    } catch {
      setErr(t("n8nExport.copyFailed"));
    }
  };

  return (
    <div className="modal-back" onClick={() => !running && onClose()}>
      <div className="card modal n8n-export" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t("n8nExport.title")}>
        <button className="x" onClick={close} aria-label={t("common.close")}>✕</button>
        <h2>{t("n8nExport.title")}</h2>

        {items === null && <p className="muted">{t("n8nExport.loading")}</p>}

        {items !== null && !enabled && <div className="notice-error" style={{ marginTop: 14 }}>{t("auth.disabled")}</div>}

        {items !== null && enabled && items.length === 0 && (
          <div className="n8n-export-empty">
            <p>{t("n8nExport.needAuth")}</p>
            <button className="btn btn-ink" onClick={onOpenAuth}>{t("n8nExport.openAuth")}</button>
          </div>
        )}

        {items !== null && enabled && items.length > 0 && !result && (
          <div className="n8n-export-start">
            <p className="muted">{t("n8nExport.intro")}</p>
            {items.length > 1 && (
              <label className="n8n-field">
                <span>{t("n8nExport.pick")}</span>
                <Select className="n8n-select" ariaLabel={t("n8nExport.pick")} value={authId} disabled={running} options={items.map((i) => ({ value: i.id, label: `${i.name}（${i.url}）` }))} onChange={setAuthId} />
              </label>
            )}
            {items.length === 1 && <p className="muted">{t("n8nExport.using", { name: items[0]!.name })}</p>}
            {stage === null ? (
              <button className="btn btn-ink" disabled={!authId} onClick={start}>{t("n8nExport.start")}</button>
            ) : (
              <ol className="n8n-export-steps" aria-label={t("n8nExport.progress")}>
                {STAGES.slice(0, 3).map((s, i) => {
                  const at = STAGES.indexOf(stage);
                  return (
                    <li key={s} className={i < at ? "done" : i === at ? "now" : ""}>{t(`n8nExport.stage.${s}`)}</li>
                  );
                })}
              </ol>
            )}
          </div>
        )}

        {result && (
          <div className="n8n-export-result">
            <p><b>{result.summary || t("n8nExport.done")}</b></p>
            {result.problems.length > 0 && (
              <div className="notice-error" role="alert">
                <b>{t("n8nExport.problems")}</b>
                <ul>{result.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
              </div>
            )}
            {result.excluded.length > 0 && (
              <section>
                <h3>{t("n8nExport.excluded")}</h3>
                <ul>{result.excluded.map((e, i) => <li key={i}><b>{e.title}</b>：{e.reason}</li>)}</ul>
              </section>
            )}
            {result.todo.length > 0 && (
              <section>
                <h3>{t("n8nExport.todo")}</h3>
                <ul>{result.todo.map((x, i) => <li key={i}>{x}</li>)}</ul>
              </section>
            )}
            <details>
              <summary>{t("n8nExport.showJson")}</summary>
              <textarea className="input n8n-export-json" readOnly rows={16} value={workflowText(result)} aria-label={t("n8nExport.showJson")} onFocus={(e) => e.currentTarget.select()} />
            </details>
            <div className="n8n-export-actions">
              <button className="btn btn-ink" onClick={copy}>{copied ? t("n8nExport.copied") : t("n8nExport.copy")}</button>
              <button className="btn btn-line" onClick={() => download(new Blob([workflowText(result)], { type: "application/json" }), `${slug}.n8n.json`)}>{t("n8nExport.download")}</button>
              <button className="btn btn-ghost" onClick={start}>{t("n8nExport.again")}</button>
            </div>
            <small className="muted">{t("n8nExport.pasteHint")}</small>
          </div>
        )}

        {err && <div className="notice-error" style={{ marginTop: 14 }} role="alert">{err}</div>}
      </div>
    </div>
  );
}
