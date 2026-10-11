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
