import { toMermaid, type WorkflowIR } from "@aif/workflow-ir";
import { colorizeSkeletons, type SkeletonLike } from "./colorize";
import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";

export interface Scene {
  elements: unknown[];
  files?: Record<string, unknown>;
}

type Skeletons = Awaited<ReturnType<typeof parseMermaidToExcalidraw>>;

/** mermaid 文本 → Excalidraw 场景；transform 可在转换前改写骨架元素（如上色） */
async function buildScene(src: string, transform?: (els: Skeletons["elements"]) => Skeletons["elements"]): Promise<Scene> {
  const { elements, files } = await parseMermaidToExcalidraw(src, { themeVariables: { fontSize: "16px" } });
  return {
    elements: convertToExcalidrawElements((transform ? transform(elements) : elements) as any, { regenerateIds: false }) as unknown[],
    files: files as Record<string, unknown> | undefined,
  };
}

/** IR → Excalidraw 场景（mermaid-to-excalidraw 转换 + 按执行方式上色） */
export function irToScene(ir: WorkflowIR): Promise<Scene> {
  return buildScene(toMermaid(ir), (els) => colorizeSkeletons(els as unknown as SkeletonLike[], ir) as unknown as Skeletons["elements"]);
}

/** 用户粘贴的 mermaid 文本 → Excalidraw 场景（不上色，保持原样） */
export function mermaidToScene(src: string): Promise<Scene> {
  return buildScene(src);
}
