import { useState } from "react";
import type { WorkflowIR } from "@aif/workflow-ir";
import type { Scene } from "../lib/canvas";
import * as ex from "../lib/exporters";
import { Select } from "./ui/Select";

export interface ExporterInfo { id: string; name: string; description: string; version: string }

export function ExportMenu({
  ir,
  scene,
  exporters,
  onClose,
}: {
  ir: WorkflowIR;
  scene: Scene | null;
  exporters: ExporterInfo[];
  onClose: () => void;
}) {
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string; extra?: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [packaging, setPackaging] = useState<"zip" | "claude-plugin">("zip");
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
  const hasN8n = exporters.some((e) => e.id === "n8n");

  return (
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
      {(hasSkill || hasN8n) && (
        <>
          <hr />
          <div className="grp">导出到平台<span>插件</span></div>
          {hasSkill && (
            <>
              <div className="pack-row">
                <span className="muted">打包方式</span>
                <Select
                  ariaLabel="打包方式"
                  value={packaging}
                  disabled={busy}
                  options={[
                    { value: "zip", label: "解压即用（个人试用）" },
                    { value: "claude-plugin", label: "Claude Code 插件（团队共享）" },
                  ]}
                  onChange={setPackaging}
                />
              </div>
              <button className="mi" disabled={busy} onClick={() => run(async () => {
                const r = await ex.exportSkillZip(ir, { target: "generic", packaging });
                ex.download(r.blob, r.filename);
                const how = packaging === "claude-plugin" ? "已导出 Claude Code 插件" : "已导出 Skill";
                setMsg({ kind: "ok", text: how, extra: [...r.requirements.map((q) => `运行前需要：${q}`), ...r.warnings.map((w) => `注意：${w}`)] });
              })}>
                <div className="ic">SK</div>
                <div><b>Agent Skill（.zip）</b><span>{packaging === "claude-plugin" ? "解压后放进公司的插件市场或插件目录" : "放进 Claude Code / Pi / Codex 的 skills 目录"}</span></div>
                <span className="badge">插件</span>
              </button>
            </>
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
  );
}
