import JSZip from "jszip";
import { checkExport, lower, toMermaid, type ExportFile, type ExportIssue, type WorkflowIR } from "@aif/workflow-ir";
import { tr } from "../i18n";
import { skillExporter, type SkillOptions } from "@aif/plugin-exporter-skill";
import { promptExporter } from "@aif/plugin-exporter-prompt";
export { applyPromptAnswers, promptGaps, type PromptGap } from "@aif/plugin-exporter-prompt";
import { exportToBlob, exportToSvg, serializeAsJSON } from "@excalidraw/excalidraw";
import type { Scene } from "./canvas";

/** 导出问题按当前语言展示；没有词条 key 的（插件自己写的中文说明）原样显示 */
export function issueText(i: ExportIssue): string {
  if (!i.key) return i.message;
  const feature = i.params?.feature ?? "";
  const label = tr(`exp.feat.${feature}`);
  const nodes = i.params?.nodes ?? "";
  return tr(nodes ? i.key : `${i.key}NoNode`, { label, nodes });
}

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
 * 生成 Agent Skill 的全部文件（未打包），供预览和打包使用。有 error 级别的问题时拒绝导出。
 * packaging 为 claude-plugin 时，文件路径是 Claude Code 插件的目录结构（.claude-plugin/ 和 skills/）。
 */
export async function buildSkill(ir: WorkflowIR, options: SkillOptions = { target: "generic", packaging: "zip" }) {
  const graph = lower(ir);
  const issues = checkExport(skillExporter, graph);
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length) throw new Error(errors.map(issueText).join("；"));

  const files = (await skillExporter.compile(graph, options)) as ExportFile[];
  const suffix = options.packaging === "claude-plugin" ? "claude-plugin" : "skill";
  return { files, filename: `${ir.slug}.${suffix}.zip`, warnings: issues.map(issueText), requirements: skillExporter.requirements(graph) };
}

/** 把文件打包成 zip */
export async function zipFiles(files: ExportFile[]): Promise<Blob> {
  const zip = new JSZip();
  for (const f of files) zip.file(f.path, f.content);
  return zip.generateAsync({ type: "blob" });
}

/**
 * 导出为对话提示词（<slug>.prompt.md）：粘贴到聊天窗口即可让 AI 带着用户完成流程。
 * 有 error 级别的问题时拒绝导出。
 */
export async function exportPrompt(ir: WorkflowIR) {
  const graph = lower(ir);
  const issues = checkExport(promptExporter, graph);
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length) throw new Error(errors.map(issueText).join("；"));

  // 完整版与精简版：预览时用文件树切换，下载时打成一个 zip
  const files = (await promptExporter.compile(graph, promptExporter.defaultOptions)) as ExportFile[];
  return {
    files,
    filename: `${ir.slug}.prompt.zip`,
    warnings: issues.map(issueText),
    requirements: promptExporter.requirements(graph),
  };
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
