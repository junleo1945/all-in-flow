import type { WorkflowIR, WorkflowNode } from "@aif/workflow-ir";

/**
 * 画布上色（纯函数，不依赖 Excalidraw，便于测试）。
 */

/** 三种执行方式的颜色（design.md 6.2）：蓝=脚本，紫=AI，橙=人工 */
export const EXECUTOR_COLORS = {
  deterministic: { backgroundColor: "#E7EEFC", strokeColor: "#2F62D9" },
  llm: { backgroundColor: "#F0E9FA", strokeColor: "#7D4FC4" },
  human: { backgroundColor: "#FCEEDF", strokeColor: "#D9701A" },
} as const;

export const NEUTRAL_COLORS = { backgroundColor: "#FFFDF8", strokeColor: "#1C1B18" };

export function colorFor(node: WorkflowNode) {
  if (node.type === "step" && node.executor) return EXECUTOR_COLORS[node.executor];
  return NEUTRAL_COLORS;
}

/** Excalidraw 元素的最小结构（只用到这些字段） */
export interface SkeletonLike {
  type: string;
  label?: { text?: string | null } | undefined;
  backgroundColor?: string;
  strokeColor?: string;
  [key: string]: unknown;
}

/**
 * 按节点标题给形状上色（纯函数，便于测试）。
 * mermaid-to-excalidraw 不保留 classDef 的填充色，所以这里按标题重新着色。
 */
export function colorizeSkeletons<T extends SkeletonLike>(elements: T[], ir: WorkflowIR): T[] {
  const byTitle = new Map<string, WorkflowNode>();
  for (const n of ir.nodes) byTitle.set(n.title, n);
  return elements.map((el) => {
    const text = el.label?.text;
    if (!text || (el.type !== "rectangle" && el.type !== "diamond" && el.type !== "ellipse")) return el;
    const node = byTitle.get(text);
    if (!node) return el;
    const c = colorFor(node);
    return { ...el, backgroundColor: c.backgroundColor, strokeColor: c.strokeColor };
  });
}
