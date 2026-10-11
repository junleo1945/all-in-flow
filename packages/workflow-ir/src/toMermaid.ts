import type { WorkflowIR, WorkflowNode } from "./schema.js";

/**
 * 把 IR 编译成 Mermaid flowchart（design.md 7.3）。
 * 节点 id 统一改写为 n0, n1…，避免与 Mermaid 关键字冲突；标签统一加引号并转义。
 */
export function toMermaid(ir: WorkflowIR): string {
  const idMap = new Map<string, string>();
  ir.nodes.forEach((n, i) => idMap.set(n.id, `n${i}`));

  const lines: string[] = ["flowchart TD"];
  for (const n of ir.nodes) {
    lines.push(`    ${idMap.get(n.id)}${shape(n)}`);
  }
  for (const e of ir.edges) {
    const from = idMap.get(e.from);
    const to = idMap.get(e.to);
    const label = e.label ? `|"${escapeLabel(e.label)}"|` : "";
    lines.push(`    ${from} -->${label} ${to}`);
  }

  // 按 executor 着色：蓝=脚本，紫=AI，橙=人工（design.md 6.2）
  lines.push("    classDef det fill:#E7EEFC,stroke:#2F62D9,color:#1C1B18");
  lines.push("    classDef llm fill:#F0E9FA,stroke:#7D4FC4,color:#1C1B18");
  lines.push("    classDef hum fill:#FCEEDF,stroke:#D9701A,color:#1C1B18");
  const byClass = { det: [] as string[], llm: [] as string[], hum: [] as string[] };
  for (const n of ir.nodes) {
    const cls = executorClass(n);
    if (cls) byClass[cls].push(idMap.get(n.id)!);
  }
  for (const cls of ["det", "llm", "hum"] as const) {
    if (byClass[cls].length) lines.push(`    class ${byClass[cls].join(",")} ${cls}`);
  }

  return lines.join("\n") + "\n";
}

function shape(n: WorkflowNode): string {
  const label = `"${escapeLabel(n.title)}"`;
  switch (n.type) {
    case "start":
    case "end":
      return `([${label}])`;
    case "decision":
      return `{${label}}`;
    case "step":
      return `[${label}]`;
    // 子流程的内容只出现在 workflow.json 中，这里只画出循环本身
    case "foreach":
      return `[[${label}]]`;
    case "merge":
      return `{{${label}}}`;
  }
}

function executorClass(n: WorkflowNode): "det" | "llm" | "hum" | undefined {
  if (n.type !== "step") return undefined;
  if (n.executor === "deterministic") return "det";
  if (n.executor === "llm") return "llm";
  if (n.executor === "human") return "hum";
  return undefined;
}

/** Mermaid 标签里的双引号用实体转义，换行变空格。 */
function escapeLabel(text: string): string {
  return text.replace(/"/g, "#quot;").replace(/\r?\n/g, " ");
}
