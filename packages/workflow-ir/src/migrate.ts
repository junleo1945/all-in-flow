import type { WorkflowIR, WorkflowIRv1, WorkflowNode } from "./schema.js";

export interface ConvertResult {
  ir: WorkflowIR;
  /** 迁移时需要人工确认的地方，例如判断节点的依据 */
  warnings: string[];
}

/**
 * v1 → v2。
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
 * 去掉已经不再支持的集成相关内容：顶层 integrations、触发器的 integration / event、
 * 节点的 integration，以及 integration 类型的 action（步骤保留 instructions，退回文字说明）。
 * 旧数据在读取时清理，不批量改写；输入不会被修改。
 */
export function stripIntegrations<T>(raw: T): T {
  const clean = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== "object") return value;
    const o = { ...(value as Record<string, unknown>) };
    if ((o.action as { kind?: unknown } | undefined)?.kind === "integration") delete o.action;
    if (o.type === "step") delete o.integration;
    for (const k of Object.keys(o)) if (k === "nodes" || k === "body") o[k] = clean(o[k]);
    return o;
  };
  const ir = { ...(raw as Record<string, unknown>) };
  delete ir.integrations;
  if (ir.trigger && typeof ir.trigger === "object") {
    const { integration: _i, event: _e, ...trigger } = ir.trigger as Record<string, unknown>;
    ir.trigger = trigger;
  }
  if (Array.isArray(ir.nodes)) ir.nodes = clean(ir.nodes);
  return ir as T;
}

/**
 * 读取时使用：把任意已知版本转换为 v2，不做校验。
 * 数据库中的历史数据在读取时转换，不批量改写。
 */
export function migrateIr(raw: WorkflowIR | WorkflowIRv1): WorkflowIR {
  return stripIntegrations(raw.version === 2 ? raw : convertV1(raw).ir);
}
