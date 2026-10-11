import JSZip from "jszip";
import { checkExport, lower, toMermaid, type ExportFile, type WorkflowIR } from "@aif/workflow-ir";
import { skillExporter, type SkillOptions } from "@aif/plugin-exporter-skill";
import { n8nExporter, type N8nOptions } from "@aif/plugin-exporter-n8n";
import { exportToBlob, exportToSvg, serializeAsJSON } from "@excalidraw/excalidraw";
import type { Scene } from "./canvas";

/** 内置导出：PNG / SVG / Excalidraw 都取自画布当前的元素，与屏幕所见一致 */
const baseAppState = { exportBackground: true, viewBackgroundColor: "#FFFEFA" };

export async function exportPng(scene: Scene): Promise<Blob> {
  return exportToBlob({
    elements: scene.elements as any,
    files: (scene.files ?? {}) as any,
    appState: baseAppState as any,
    mimeType: "image/png",
    exportPadding: 24,
    getDimensions: (w: number, h: number) => ({ width: w * 2, height: h * 2, scale: 2 }),
  } as any);
}

/** 中文字体回退：内嵌字体（Xiaolai）在设计工具、部分预览器里不生效，这时用系统里的中文字体显示 */
const CJK_FALLBACK = "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif";

export async function exportSvg(scene: Scene): Promise<Blob> {
  const svg = await exportToSvg({
    elements: scene.elements as any,
    files: (scene.files ?? {}) as any,
    appState: baseAppState as any,
    exportPadding: 24,
  } as any);
  const body = new XMLSerializer().serializeToString(svg).replace(/Xiaolai, Segoe UI Emoji/g, `Xiaolai, ${CJK_FALLBACK}, Segoe UI Emoji`);
  // 显式声明 UTF-8：部分软件不声明编码时会按系统默认编码读取，中文就会显示成乱码
  const text = `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
  return new Blob([text], { type: "image/svg+xml;charset=utf-8" });
}

export async function exportExcalidrawJson(scene: Scene): Promise<Blob> {
  const json = serializeAsJSON(scene.elements as any, baseAppState as any, (scene.files ?? {}) as any, "local");
  return new Blob([json], { type: "application/json" });
}

export function exportMermaid(ir: WorkflowIR): Blob {
  return new Blob([toMermaid(ir)], { type: "text/plain" });
}

export function exportIrJson(ir: WorkflowIR): Blob {
  return new Blob([JSON.stringify(ir, null, 2)], { type: "application/json" });
}

/**
 * 导出为 Agent Skill（zip）。有 error 级别的问题时拒绝导出。
 * packaging 为 claude-plugin 时，压缩包内是 Claude Code 插件的目录结构（.claude-plugin/ 和 skills/）。
 */
export async function exportSkillZip(ir: WorkflowIR, options: SkillOptions = { target: "generic", packaging: "zip" }) {
  const graph = lower(ir);
  const issues = checkExport(skillExporter, graph);
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length) throw new Error(errors.map((e) => e.message).join("；"));

  const zip = new JSZip();
  for (const f of await skillExporter.compile(graph, options)) zip.file(f.path, f.content);
  const blob = await zip.generateAsync({ type: "blob" });
  const suffix = options.packaging === "claude-plugin" ? "claude-plugin" : "skill";
  return { blob, filename: `${ir.slug}.${suffix}.zip`, warnings: issues.map((i) => i.message), requirements: skillExporter.requirements(graph) };
}

/**
 * 导出为 n8n 工作流 JSON（<slug>.n8n.json）。有 error 级别的问题时拒绝导出。
 * 警告和导入前需要的条件一并返回，导出后展示给用户。
 */
export async function exportN8nJson(ir: WorkflowIR, options: N8nOptions = n8nExporter.defaultOptions) {
  const graph = lower(ir);
  const issues = checkExport(n8nExporter, graph);
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length) throw new Error(errors.map((e) => e.message).join("；"));

  const [file] = (await n8nExporter.compile(graph, options)) as ExportFile[];
  const blob = new Blob([file!.content as string], { type: "application/json" });
  return { blob, filename: file!.path, warnings: issues.map((i) => i.message), requirements: n8nExporter.requirements(graph) };
}

/** 触发浏览器下载 */
export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
