import type { ExecFrame, ExecGraph, ExporterPlugin, ExportFile, ExportIssue, WorkflowEdge, WorkflowNode } from "@aif/workflow-ir";
import { toIfConditions } from "./expr.js";
import { findOperation } from "@aif/integrations";
import { canMapIntegration, isSimpleTemplate } from "./nodes.js";
import { buildN8nWorkflow, type N8nOptions } from "./workflow.js";

export type { N8nOptions, N8nWorkflow } from "./workflow.js";

/**
 * 把工作流编译成单个 n8n 工作流 JSON（<slug>.n8n.json），在 n8n 中用 Import from File 导入。
 * 一期骨架：只映射常用节点，其余以 NoOp 占位 + 便签提醒补全。
 */
export const n8nExporter: ExporterPlugin<N8nOptions> = {
  type: "exporter",
  id: "n8n",
  name: "n8n",
  description: "导出为 n8n 工作流（JSON），在 n8n 中通过 Import from File 导入。",
  version: "0.1.0",
  targetVersion: "n8n >= 1.x",
  output: "file",
  defaultOptions: { includeNotes: true },

  // full：有直接对应的 n8n 节点；degraded：以占位节点代替，导入后需要手动补全
  capabilities: {
    "trigger:manual": "full",
    "trigger:schedule": "full",
    "trigger:event": "degraded",
    "action:http": "full",
    "action:transform": "degraded",
    "action:code": "full",
    "action:integration": "degraded",
    "action:llm": "degraded",
    "action:human": "degraded",
    "action:none": "degraded",
    "decision:expr": "full",
    "decision:llm": "degraded",
    foreach: "full",
    merge: "full",
  },

  supports(graph: ExecGraph): ExportIssue[] {
    const { ir } = graph;
    const issues: ExportIssue[] = [];

    if (ir.trigger.type === "schedule" && !ir.trigger.cron) {
      issues.push({ level: "warning", message: "定时触发没有 cron 表达式，n8n 中的定时节点需要手动设置时间" });
    }

    for (const { node, edges } of frameNodes(graph.root)) {
      if (node.type === "step" && node.action?.kind === "code" && node.action.language !== "javascript") {
        issues.push({ level: "warning", nodeId: node.id, message: `代码步骤「${node.title}」不是 JavaScript，导出时以占位节点代替` });
      }
      if (node.type === "decision" && node.mode === "expr") issues.push(...decisionIssues(edges, node));
      if (node.type === "foreach" && (node.outputs?.length ?? 0) > 1) {
        issues.push({ level: "warning", nodeId: node.id, message: `循环「${node.title}」声明了多个输出，n8n 中只汇总到第一个输出「${node.outputs![0]!.name}」` });
      }
    }
    return issues;
  },

  compile(graph: ExecGraph, options: N8nOptions): ExportFile[] {
    const workflow = buildN8nWorkflow(graph, options);
    return [{ path: `${graph.ir.slug}.n8n.json`, content: JSON.stringify(workflow, null, 2) }];
  },

  requirements(graph: ExecGraph): string[] {
    const { ir } = graph;
    const out: string[] = [];
    if (ir.trigger.type === "schedule") out.push("导入后需要在 n8n 中激活工作流，定时触发才会运行。");
    if (ir.trigger.type === "event") out.push("需要一个 n8n 能被外部访问的 Webhook 地址，并把事件源指向它。");
    const all = frameNodes(graph.root).map((f) => f.node);
    for (const node of all) {
      if (node.type === "foreach") {
        const field = node.outputs?.[0]?.name ?? "results";
        out.push(`「${node.title}」展开为 Loop Over Items：结果在「${node.title}（合并结果）」的 ${field} 字段，是循环体最后一步每轮输出组成的数组；没有数据时为空数组，后续节点照常执行。`);
      }
      if (node.type !== "step" || !node.action) continue;
      if (node.action.kind === "http") out.push(`「${node.title}」使用 HTTP Request，如有鉴权请在节点中配置凭证。`);
      if (node.action.kind === "integration" && canMapIntegration(node.action)) {
        const op = findOperation(node.action.integration, node.action.operation)!;
        out.push(`「${node.title}」映射为 HTTP Request，需要 n8n 允许表达式读取环境变量（N8N_BLOCK_ENV_ACCESS_IN_NODE 不为 true），并配置基地址变量。`);
        if (op.api!.path.includes("<")) out.push(`「${node.title}」的接口路径尚未确认，导入后请替换 URL 中的占位路径。`);
      } else if (node.action.kind === "integration") {
        out.push(`「${node.title}」对应的集成（${node.action.integration}）需要在 n8n 中配置凭证。`);
      }
    }
    for (const node of all) {
      if (isPlaceholder(node)) out.push(`「${node.title}」没有自动映射，已放置占位节点，导入后请手动补全。`);
    }
    return out;
  },
};

/** 所有层的节点（含 foreach 子流程），附带所在层的连线 */
function frameNodes(frame: ExecFrame): Array<{ node: WorkflowNode; edges: WorkflowEdge[] }> {
  return frame.nodes.flatMap((node) => [
    { node, edges: frame.edges },
    ...(node.type === "foreach" ? frameNodes(frame.children.get(node.id)!) : []),
  ]);
}

function decisionIssues(edges: WorkflowEdge[], node: Extract<WorkflowNode, { type: "decision" }>): ExportIssue[] {
  const out = edges.filter((e) => e.from === node.id);
  if (out.length !== 2) {
    return [{ level: "error", nodeId: node.id, message: `条件分支「${node.title}」需要且只能有两条出边（多分支 Switch 尚未支持）` }];
  }
  const cond = (out.find((e) => !e.default) ?? out[0])!.condition;
  if (!cond) return [{ level: "error", nodeId: node.id, message: `条件分支「${node.title}」的真分支缺少条件` }];
  try {
    toIfConditions(cond, { names: new Map(), triggerName: "" }, node.id);
  } catch (e) {
    return [{ level: "error", nodeId: node.id, message: `条件分支「${node.title}」：${(e as Error).message}` }];
  }
  return [];
}

function isPlaceholder(node: WorkflowNode): boolean {
  if (node.type === "decision") return node.mode === "llm";
  if (node.type !== "step") return false;
  if (node.action?.kind === "transform") return !isSimpleTemplate(node.action.template);
  if (node.action?.kind === "integration") return !canMapIntegration(node.action);
  return !node.action || ["integration", "llm", "human"].includes(node.action.kind) || (node.action.kind === "code" && node.action.language !== "javascript");
}
