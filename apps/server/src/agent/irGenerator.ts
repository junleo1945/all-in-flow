import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { validateWorkflow, type ValidateOptions, type ValidationIssue, type WorkflowIR, type WorkflowNode } from "@aif/workflow-ir";
import { findOperation } from "@aif/integrations";
import { createInterviewSession } from "./session.js";
import { IR_SYSTEM_PROMPT } from "./irPrompt.js";
import type { RuntimeModel } from "./models.js";

export class IrGenerationError extends Error {}

export interface GeneratedWorkflow {
  ir: WorkflowIR;
  /** 需要用户或 Agent 注意的情况，例如某个步骤的 action 被回退 */
  warnings: string[];
}

export interface IrGeneratorOptions {
  runtime: ModelRuntime;
  model: RuntimeModel;
  /** 总尝试次数：1 次生成 + 最多 2 次修复（export-v2.md 4） */
  maxAttempts?: number;
}

const VALIDATE_OPTIONS: ValidateOptions = { resolveOperation: findOperation };

/**
 * 用 Pro 模型把方案摘要编译成 Workflow IR v2（design.md 4.5）。
 * 1. 输出不合法时，把校验错误反馈给同一个会话，最多修复两次；
 * 2. 仍不合法时，如果问题只出在某些步骤的 action 上，去掉这些 action，退回文字说明，并给出警告；
 * 3. 其余情况报错。
 * 这一步不给任何工具，只产出文本。
 */
export function createIrGenerator(opts: IrGeneratorOptions) {
  const maxAttempts = opts.maxAttempts ?? 3;

  return async function generate(brief: string, context: string): Promise<GeneratedWorkflow> {
    const session = await createInterviewSession({
      cwd: mkdtempSync(join(tmpdir(), "aif-ir-")),
      model: opts.model,
      modelRuntime: opts.runtime,
      systemPrompt: IR_SYSTEM_PROMPT,
      tools: [],
    });
    try {
      let prompt = `方案摘要：\n${brief}\n\n相关画像（JSON）：\n${context}\n\n请输出 Workflow IR v2 的 JSON。`;
      let lastIssues = "";
      let lastParsed: unknown;
      let lastIssueList: ValidationIssue[] = [];
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await session.prompt(prompt, { expandPromptTemplates: false });
        const raw = session.getLastAssistantText() ?? "";
        const parsed = parseJson(raw);
        lastParsed = parsed;
        if (parsed === undefined) {
          lastIssues = "输出不是合法的 JSON 对象";
          lastIssueList = [];
        } else {
          const result = validateWorkflow(parsed, VALIDATE_OPTIONS);
          if (result.ok) return { ir: result.ir, warnings: result.warnings };
          lastIssueList = result.issues;
          lastIssues = result.issues.map((i) => `- ${i.nodeId ? `[${i.nodeId}] ` : ""}${i.message}`).join("\n");
        }
        prompt = `上一次的输出有以下问题：\n${lastIssues}\n\n请修正后只输出完整的 JSON 对象。`;
      }

      const fallback = withoutFailingActions(lastParsed, lastIssueList);
      if (fallback) return fallback;
      throw new IrGenerationError(`工作流生成失败（已尝试 ${maxAttempts} 次）：\n${lastIssues}`);
    } finally {
      session.dispose();
    }
  };
}

/**
 * 修复失败后的回退：如果所有问题都出在某些 step 的 action 上，去掉这些 action，
 * 步骤保留 instructions，退回文字说明（export-v2.md 4）。其他问题无法回退。
 */
export function withoutFailingActions(raw: unknown, issues: ValidationIssue[]): GeneratedWorkflow | undefined {
  if (!raw || typeof raw !== "object" || issues.length === 0) return undefined;
  if (issues.some((i) => !i.nodeId)) return undefined;

  const candidate = structuredClone(raw) as { nodes?: WorkflowNode[] };
  const byId = new Map(allNodes(candidate.nodes ?? []).map((n) => [n.id, n]));
  const warnings: string[] = [];
  for (const id of new Set(issues.map((i) => i.nodeId!))) {
    const node = byId.get(id);
    if (!node || node.type !== "step" || !node.action) return undefined;
    delete node.action;
    warnings.push(`步骤「${node.title}」的结构化执行方式未能通过校验，已退回为文字说明，请在对话中补充细节`);
  }

  const result = validateWorkflow(candidate, VALIDATE_OPTIONS);
  return result.ok ? { ir: result.ir, warnings: [...warnings, ...result.warnings] } : undefined;
}

function allNodes(nodes: WorkflowNode[], out: WorkflowNode[] = []): WorkflowNode[] {
  for (const n of nodes) {
    out.push(n);
    if (n.type === "foreach") allNodes(n.body.nodes, out);
  }
  return out;
}

/** 去掉可能的 Markdown 代码块包裹后解析 */
export function parseJson(raw: string): unknown {
  const body = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
