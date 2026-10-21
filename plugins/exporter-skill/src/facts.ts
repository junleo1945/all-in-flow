import { conditionText, orderSteps, type Executor, type Variable, type WorkflowIR, type WorkflowNode } from "@aif/workflow-ir";
import { findIntegration, findOperation } from "@aif/integrations";
import type { ScriptPlan, ScriptPlanResult } from "./scripts.js";

/** 一个步骤（或判断、循环、汇合）的事实，编号与 SKILL.md 中的编号一致，子流程里是 3.1、3.2…… */
export interface FactStep {
  number: string;
  id: string;
  /** SKILL.md 里加粗的标题原文：判断节点是「判断：标题」，其他是标题 */
  heading: string;
  title: string;
  kind: "step" | "decision" | "foreach" | "merge";
  executor?: Executor;
  instructions?: string;
  chatInstructions?: string;
  template?: string;
  /** 判断节点：mode 为 llm 时的判断问题 */
  question?: string;
  script?: { path: string; args: string[]; runtime: "bash" | "node" | "python" };
  /** 确定性步骤却没有脚本时的原因 */
  noScriptReason?: string;
  outputs?: Variable[];
  /** 判断节点的出边。target 是步骤编号，或「结束」 */
  branches?: Array<{ label: string; condition?: string; default?: boolean; target: string }>;
  /** foreach 的循环对象与当前项的名字 */
  over?: string;
  item?: string;
  /** foreach 的子步骤编号 */
  loopBody?: string[];
  /** 只有一个出口时的下一步编号，或「结束」 */
  next?: string;
}

/** 给模型和校验器的事实清单：不含任何真实地址或密钥，只有配置项名 */
export interface SkillFacts {
  name: string;
  title: string;
  descriptionDraft: string;
  trigger: { type: "manual" | "schedule" | "event"; detail: string; cron?: string };
  inputs: Array<{ name: string; type: string; required: boolean; description: string }>;
  steps: FactStep[];
  integrations: Array<{ id: string; name: string; access: string; fields: string[]; verify?: string; registered: boolean }>;
  /** 骨架里已有的文件，相对于 Skill 根目录；正文只能引用这些和模型自己新增的 references 文件 */
  files: string[];
  /** 导出前仍然空缺的信息（判断标准、模板、未确认的接口路径），需要写进「待确认」 */
  gaps: string[];
}

export interface FactsInput {
  plans: ScriptPlanResult["plans"];
  unsupported?: ScriptPlanResult["unsupported"];
  files: string[];
  gaps?: string[];
}

const runtimeOf = (path: string): "bash" | "node" | "python" => (path.endsWith(".py") ? "python" : path.endsWith(".mjs") ? "node" : "bash");

/** 按 SKILL.md 里出现的顺序展开全部步骤（含 foreach 子流程），带上编号 */
export function collectSteps(ir: WorkflowIR): Array<{ node: WorkflowNode; number: string; frame: WorkflowIR; next: string | undefined; targetOf: (id: string) => string }> {
  const out: ReturnType<typeof collectSteps> = [];
  const visit = (frame: WorkflowIR, prefix: string) => {
    const { order, number, byId, out: edges } = orderSteps(frame);
    const targetOf = (id: string) => {
      const n = byId.get(id);
      const k = number.get(id);
      return !n || n.type === "end" || k === undefined ? "结束" : `${prefix}${k}`;
    };
    for (const n of order) {
      const outs = edges.get(n.id) ?? [];
      out.push({ node: n, number: `${prefix}${number.get(n.id)}`, frame, next: n.type !== "decision" && outs.length === 1 ? targetOf(outs[0]!) : undefined, targetOf });
      if (n.type === "foreach") visit({ ...frame, nodes: n.body.nodes, edges: n.body.edges }, `${prefix}${number.get(n.id)}.`);
    }
  };
  visit(ir, "");
  return out;
}

export function buildFacts(ir: WorkflowIR, input: FactsInput): SkillFacts {
  const unsupported = new Map((input.unsupported ?? []).map((u) => [u.stepId, u.reason]));
  const all = collectSteps(ir);

  const steps: FactStep[] = all.flatMap(({ node: n, number, frame, next, targetOf }): FactStep[] => {
    if (n.type === "start" || n.type === "end") return [];
    const base = { number, id: n.id, title: n.title, heading: n.title };
    if (n.type === "merge") return [{ ...base, kind: "merge", next }];
    if (n.type === "foreach") {
      const children = all.filter((c) => c.number.startsWith(`${number}.`) && c.frame.nodes === n.body.nodes && c.node.type !== "start" && c.node.type !== "end");
      return [{ ...base, kind: "foreach", over: n.over, item: n.item, outputs: n.outputs, loopBody: children.map((c) => c.number), next }];
    }
    if (n.type === "decision") {
      const branches = frame.edges
        .filter((e) => e.from === n.id)
        .map((e) => ({
          label: e.label ?? "其他",
          ...(e.condition ? { condition: conditionText(e.condition) } : {}),
          ...(e.default ? { default: true } : {}),
          target: targetOf(e.to),
        }));
      return [{ ...base, heading: `判断：${n.title}`, kind: "decision", question: n.mode === "llm" ? n.question : undefined, branches }];
    }
    const plan: ScriptPlan | undefined = input.plans.get(n.id);
    return [
      {
        ...base,
        kind: "step",
        executor: n.executor,
        instructions: n.instructions,
        chatInstructions: n.chatInstructions,
        template: n.template,
        ...(plan ? { script: { path: plan.path, args: plan.args, runtime: runtimeOf(plan.path) } } : {}),
        ...(!plan && n.executor === "deterministic" ? { noScriptReason: unsupported.get(n.id) ?? "没有可执行的访问方式" } : {}),
        outputs: n.outputs,
        next,
      },
    ];
  });

  return {
    name: ir.slug,
    title: ir.name,
    descriptionDraft: ir.description,
    trigger: { type: ir.trigger.type, detail: ir.trigger.detail, ...(ir.trigger.cron ? { cron: ir.trigger.cron } : {}) },
    inputs: ir.inputs.map((v) => ({ name: v.name, type: v.type, required: !!v.required, description: v.description })),
    steps,
    integrations: ir.integrations.map((i) => {
      const entry = findIntegration(i.id);
      return {
        id: i.id,
        name: i.name,
        access: entry?.access ?? i.access,
        fields: entry?.fields.map((f) => f.name) ?? [],
        ...(entry ? { verify: entry.verify } : {}),
        registered: !!entry,
      };
    }),
    files: input.files,
    gaps: input.gaps ?? [],
  };
}

/**
 * 用到的接口里路径尚未确认的（集成目录里路径含占位符）。路径是使用者环境的事，不写进 IR，
 * 只能提醒使用者在 .env 里填写对应的配置项（.env.example 里已有）。
 */
export function unconfirmedPaths(ir: WorkflowIR): string[] {
  const out = new Set<string>();
  const visit = (nodes: WorkflowNode[]) => {
    for (const n of nodes) {
      if (n.type === "foreach") visit(n.body.nodes);
      if (n.type !== "step" || n.action?.kind !== "integration") continue;
      const entry = findIntegration(n.action.integration);
      const op = findOperation(n.action.integration, n.action.operation);
      if (!entry || !op?.api?.path.includes("<")) continue;
      const env = `${entry.id.replace(/-/g, "_").toUpperCase()}_${op.id.toUpperCase()}_PATH`;
      out.add(`${entry.name}的「${op.title}」接口路径尚未确认，使用前要在 .env 中填写 ${env}`);
    }
  };
  visit(ir.nodes);
  return [...out];
}
