import { toMermaid, type WorkflowIR } from "@aif/workflow-ir";
import { colorizeSkeletons, type SkeletonLike } from "./colorize";
import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";

export interface Scene {
  elements: unknown[];
  files?: Record<string, unknown>;
}

/** IR → Excalidraw 场景（mermaid-to-excalidraw 转换 + 按执行方式上色） */
export async function irToScene(ir: WorkflowIR): Promise<Scene> {
  const { elements, files } = await parseMermaidToExcalidraw(toMermaid(ir), { themeVariables: { fontSize: "16px" } });
  const colored = colorizeSkeletons(elements as unknown as SkeletonLike[], ir);
  return {
    elements: convertToExcalidrawElements(colored as any, { regenerateIds: false }) as unknown[],
    files: files as Record<string, unknown> | undefined,
  };
}
