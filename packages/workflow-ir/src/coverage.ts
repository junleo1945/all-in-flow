import type { WorkflowIR, WorkflowNode } from "./schema.js";

export interface ActionCoverage {
  /** step 节点总数（包括子流程中的） */
  steps: number;
  /** 其中带 action 的数量 */
  withAction: number;
  /** withAction / steps；没有 step 时为 null */
  ratio: number | null;
}

/** 有结构化 action 的 step 占比（export-v2.md 4：action 覆盖率） */
export function actionCoverage(ir: WorkflowIR): ActionCoverage {
  const steps: WorkflowNode[] = [];
  const walk = (nodes: WorkflowNode[]) => {
    for (const n of nodes) {
      if (n.type === "step") steps.push(n);
      if (n.type === "foreach") walk(n.body.nodes);
    }
  };
  walk(ir.nodes);
  const withAction = steps.filter((n) => n.type === "step" && n.action).length;
  return { steps: steps.length, withAction, ratio: steps.length === 0 ? null : withAction / steps.length };
}

/**
 * transform 的模板是否像字段拼接（可以直接写进 Set 节点）。
 * 去掉 {{引用}} 后剩下的文字很短且没有句读；写成句子的指令（"对…逐行判断…"）不能当作数据处理，
 * 这类整理应该写成 code 步骤。
 */
export function isSimpleTemplate(template: string): boolean {
  const literal = template.replace(/\{\{[^{}]*\}\}/g, "");
  return literal.length <= 20 && !/[。，,；;！!？?]/.test(literal);
}

/** code 步骤的源码长度上限，超出的内容应该拆成更小的步骤 */
export const MAX_CODE_LENGTH = 4000;
/** 源码中出现这些内容时不接受（访问文件系统、子进程、环境变量、动态执行） */
const FORBIDDEN_CODE = /child_process|require\s*\(|\bprocess\.|\bfs\.|\beval\s*\(|\bFunction\s*\(/;

/** JavaScript 步骤源码的问题；没有问题时返回 undefined */
export function codeProblem(source: string): string | undefined {
  if (source.length > MAX_CODE_LENGTH) return "代码过长，请拆分为更小的步骤";
  if (FORBIDDEN_CODE.test(source)) return "代码包含不允许的内容（文件、子进程、环境变量或动态执行）";
  return undefined;
}

export interface Executability {
  /** transform 步骤数 */
  transformSteps: number;
  /** 其中模板是一句描述而不是字段拼接的数量；它们应该写成 code 步骤 */
  descriptiveTransforms: number;
  /** code 步骤数 */
  codeSteps: number;
  /** 其中源码不安全的数量 */
  unsafeCode: number;
}

/**
 * 工作流能不能直接转成可执行节点（n8n-guided-export-revision.md 2）：
 * 导出阶段不再让模型补全，所以数据整理要在生成 IR 时就写成可执行的形式。
 */
export function executability(ir: WorkflowIR): Executability {
  const out: Executability = { transformSteps: 0, descriptiveTransforms: 0, codeSteps: 0, unsafeCode: 0 };
  const walk = (nodes: WorkflowNode[]) => {
    for (const n of nodes) {
      if (n.type === "foreach") walk(n.body.nodes);
      if (n.type !== "step" || !n.action) continue;
      if (n.action.kind === "transform") {
        out.transformSteps += 1;
        if (!isSimpleTemplate(n.action.template)) out.descriptiveTransforms += 1;
      }
      if (n.action.kind === "code") {
        out.codeSteps += 1;
        if (n.action.language === "javascript" && codeProblem(n.action.source)) out.unsafeCode += 1;
      }
    }
  };
  walk(ir.nodes);
  return out;
}
