import type { WorkflowIR, WorkflowIRv1, WorkflowNode } from "./schema.js";

export interface ConvertResult {
  ir: WorkflowIR;
  /** 迁移时需要人工确认的地方，例如判断节点的依据 */
  warnings: string[];
}

/**
 * v1 → v2（export-v2.md 3.7）。
 * 只做结构转换，不做校验；调用方需要先用 v1 schema 校验过输入。
 */
export function convertV1(ir: WorkflowIRv1): ConvertResult {
  const warnings: string[] = [];

  const nodes: WorkflowNode[] = ir.nodes.map((n): WorkflowNode => {
    switch (n.type) {
      case "start":
      case "end":
        return { id: n.id, type: n.type, title: n.title };
      case "decision":
        // v1 的判断条件只是自然语言标签，无法写成表达式，统一按 LLM 判断迁移
        warnings.push(`判断节点「${n.title}」已按 LLM 判断迁移，请确认判断依据`);
        return { id: n.id, type: "decision", title: n.title, mode: "llm", question: n.title };
      case "step":
        // v1 的 executor / instructions 已由 v1 schema 保证存在
        return {
          id: n.id,
          type: "step",
          title: n.title,
          executor: n.executor!,
          ...(n.integration ? { integration: n.integration } : {}),
          instructions: n.instructions!,
          ...(n.inputs ? { inputs: n.inputs } : {}),
          outputs: (n.outputs ?? []).map((name) => ({ name, type: "string" as const, description: "" })),
        };
    }
  });

  return {
    ir: {
      ...ir,
      version: 2,
      inputs: ir.inputs.map((i) => ({ name: i.name, type: "string" as const, description: i.description, required: i.required })),
      nodes,
      edges: ir.edges.map((e) => ({ from: e.from, to: e.to, ...(e.label ? { label: e.label } : {}) })),
    },
    warnings,
  };
}

/**
 * 读取时使用：把任意已知版本转换为 v2，不做校验。
 * 数据库中的历史数据在读取时转换，不批量改写（export-v2.md 3.7）。
 */
export function migrateIr(raw: WorkflowIR | WorkflowIRv1): WorkflowIR {
  if (raw.version === 2) return raw;
  return convertV1(raw).ir;
}
