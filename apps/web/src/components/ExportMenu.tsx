import { useState } from "react";
import type { WorkflowIR } from "@aif/workflow-ir";
import type { Scene } from "../lib/canvas";
import * as ex from "../lib/exporters";
import { ExportPreview, type ExportPreviewSpec } from "./ExportPreview";
import { PromptExportPreview } from "./PromptExportPreview";
import { tr, useI18n } from "../i18n";

export interface ExporterInfo { id: string; name: string; description: string; version: string }

export function ExportMenu({
  ir,
  scene,
  exporters,
  workflowId,
  onSaved,
  onClose,
}: {
  ir: WorkflowIR;
  workflowId?: string;
  onSaved?: (version: number) => void;
  scene: Scene | null;
  exporters: ExporterInfo[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string; extra?: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ExportPreviewSpec | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const base = ir.slug;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message || tr("exp.failed") });
    } finally {
      setBusy(false);
    }
  };

  const hasSkill = exporters.some((e) => e.id === "skill");
  const hasPrompt = exporters.some((e) => e.id === "prompt");
  const hasN8n = exporters.some((e) => e.id === "n8n");

  return (
    <>
      <div className="card menu" role="menu" onMouseLeave={() => undefined}>
        <div className="grp">{t("exp.grpImages")}<span>{t("exp.builtin")}</span></div>
        <div className="quick">
          <button className="q" disabled={!scene || busy} onClick={() => run(async () => ex.download(await ex.exportPng(scene!), `${base}.png`))}>
            <span className="ic">PNG</span><b>{t("exp.png")}</b><span>{t("exp.pngDesc")}</span>
          </button>
          <button className="q" disabled={!scene || busy} onClick={() => run(async () => ex.download(await ex.exportSvg(scene!), `${base}.svg`))}>
            <span className="ic">SVG</span><b>{t("exp.svg")}</b><span>{t("exp.svgDesc")}</span>
          </button>
          <button className="q" disabled={busy} onClick={() => run(async () => ex.download(ex.exportMermaid(ir), `${base}.mmd`))}>
            <span className="ic">MMD</span><b>Mermaid</b><span>{t("exp.mmdDesc")}</span>
          </button>
          <button className="q" disabled={!scene || busy} onClick={() => run(async () => ex.download(await ex.exportExcalidrawJson(scene!), `${base}.excalidraw`))}>
            <span className="ic">EX</span><b>Excalidraw</b><span>{t("exp.exDesc")}</span>
          </button>
        </div>
        {(hasSkill || hasPrompt || hasN8n) && (
          <>
            <hr />
            <div className="grp">{t("exp.grpPlatform")}<span>{t("exp.plugin")}</span></div>
            {hasSkill && (
              <>
                <button className="mi" disabled={busy} onClick={() => run(async () => {
                  const s = await ex.buildSkill(ir, { target: "generic", packaging: "zip" });
                  setPreview({
                    title: t("exp.skillPreview"),
                    files: s.files,
                    notes: [...s.requirements.map((q) => t("exp.reqRun", { q })), ...s.warnings.map((w) => t("exp.warn", { w }))],
                    downloadLabel: t("exp.downloadZip"),
                    onDownload: async () => ex.download(await ex.zipFiles(s.files), s.filename),
                  });
                })}>
                  <div className="ic">SK</div>
                  <div><b>Agent Skill</b><span>{t("exp.skillDesc")}</span></div>
                  <span className="badge">{t("exp.plugin")}</span>
                </button>
              </>
            )}
            {hasPrompt && (
              <button className="mi" disabled={busy} onClick={() => setPromptOpen(true)}>
                <div className="ic">PT</div>
                <div><b>{t("exp.prompt")}</b><span>{t("exp.promptDesc")}</span></div>
                <span className="badge">{t("exp.plugin")}</span>
              </button>
            )}
            {hasN8n && (
              <button className="mi" disabled={busy} onClick={() => run(async () => {
                const r = await ex.exportN8nJson(ir);
                ex.download(r.blob, r.filename);
                setMsg({ kind: "ok", text: t("exp.n8nDone"), extra: [...r.requirements.map((q) => t("exp.reqImport", { q })), ...r.warnings.map((w) => t("exp.warn", { w }))] });
              })}>
                <div className="ic">N8</div>
                <div><b>{t("exp.n8n")}</b><span>{t("exp.n8nDesc")}</span></div>
                <span className="badge">{t("exp.plugin")}</span>
              </button>
            )}
          </>
        )}
        {msg && (
          <div style={{ margin: "8px 6px 4px" }}>
            <div className={msg.kind === "err" ? "notice-error" : "muted"}>{msg.text}</div>
            {msg.extra?.map((x) => <div key={x} className="req">{x}</div>)}
          </div>
        )}
        <div className="foot" style={{ display: "flex", justifyContent: "space-between" }}>
          <span>{t("exp.foot")}</span>
          <button className="btn-ghost" onClick={onClose}>{t("exp.close")}</button>
        </div>
      </div>
      {promptOpen && (
        <PromptExportPreview
          ir={ir}
          workflowId={workflowId}
          onSaved={onSaved}
          onClose={() => {
            setPromptOpen(false);
            onClose();
          }}
        />
      )}
      {preview && (
        <ExportPreview
          spec={preview}
          onClose={() => {
            setPreview(null);
            onClose();
          }}
        />
      )}
    </>
  );
}
