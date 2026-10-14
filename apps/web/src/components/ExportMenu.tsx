import { useState } from "react";
import type { WorkflowIR } from "@aif/workflow-ir";
import type { Scene } from "../lib/canvas";
import * as ex from "../lib/exporters";
import { ExportPreview, type ExportPreviewSpec } from "./ExportPreview";
import { PromptExportPreview } from "./PromptExportPreview";

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
      setMsg({ kind: "err", text: (e as Error).message || "导出失败" });
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
        <div className="grp">图片与图形<span>内置</span></div>
        <div className="quick">
          <button className="q" disabled={!scene || busy} onClick={() => run(async () => ex.download(await ex.exportPng(scene!), `${base}.png`))}>
            <span className="ic">PNG</span><b>PNG 图片</b><span>插入文档、汇报</span>
          </button>
          <button className="q" disabled={!scene || busy} onClick={() => run(async () => ex.download(await ex.exportSvg(scene!), `${base}.svg`))}>
            <span className="ic">SVG</span><b>SVG 矢量图</b><span>无损缩放</span>
          </button>
          <button className="q" disabled={busy} onClick={() => run(async () => ex.download(ex.exportMermaid(ir), `${base}.mmd`))}>
            <span className="ic">MMD</span><b>Mermaid</b><span>粘贴到文档工具</span>
          </button>
          <button className="q" disabled={!scene || busy} onClick={() => run(async () => ex.download(await ex.exportExcalidrawJson(scene!), `${base}.excalidraw`))}>
            <span className="ic">EX</span><b>Excalidraw</b><span>继续自由编辑</span>
          </button>
        </div>
        {(hasSkill || hasPrompt || hasN8n) && (
          <>
            <hr />
            <div className="grp">导出到平台<span>插件</span></div>
            {hasSkill && (
              <>
                <button className="mi" disabled={busy} onClick={() => run(async () => {
                  const s = await ex.buildSkill(ir, { target: "generic", packaging: "zip" });
                  setPreview({
                    title: "Agent Skill 预览",
                    files: s.files,
                    notes: [...s.requirements.map((q) => `运行前需要：${q}`), ...s.warnings.map((w) => `注意：${w}`)],
                    downloadLabel: "下载 .zip",
                    onDownload: async () => ex.download(await ex.zipFiles(s.files), s.filename),
                  });
                })}>
                  <div className="ic">SK</div>
                  <div><b>Agent Skill</b><span>预览文件，复制或下载后放进 Claude Code / Pi / Codex 的 skills 目录</span></div>
                  <span className="badge">插件</span>
                </button>
              </>
            )}
            {hasPrompt && (
              <button className="mi" disabled={busy} onClick={() => setPromptOpen(true)}>
                <div className="ic">PT</div>
                <div><b>Prompt 对话提示词</b><span>完整版与精简版，预览后直接复制，粘贴到聊天窗口或智能体设定里</span></div>
                <span className="badge">插件</span>
              </button>
            )}
            {hasN8n && (
              <button className="mi" disabled={busy} onClick={() => run(async () => {
                const r = await ex.exportN8nJson(ir);
                ex.download(r.blob, r.filename);
                setMsg({ kind: "ok", text: "已导出 n8n 工作流", extra: [...r.requirements.map((q) => `导入前后需要：${q}`), ...r.warnings.map((w) => `注意：${w}`)] });
              })}>
                <div className="ic">N8</div>
                <div><b>n8n 工作流（.json）</b><span>在 n8n 中通过 Import from File 导入</span></div>
                <span className="badge">插件</span>
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
          <span>导出前会检查哪些节点无法转换</span>
          <button className="btn-ghost" onClick={onClose}>关闭</button>
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
