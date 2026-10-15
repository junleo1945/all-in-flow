import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { WorkflowIR, WorkflowNode } from "@aif/workflow-ir";
import { createInterviewSession } from "./session.js";
import { parseJson } from "./irGenerator.js";
import type { RuntimeModel } from "./models.js";

/** 向模型提一个问题，返回文本 */
export type Ask = (system: string, prompt: string) => Promise<string>;

export function createAsk(opts: { runtime: ModelRuntime; model: RuntimeModel }): Ask {
  return async (system, prompt) => {
    const session = await createInterviewSession({
      cwd: mkdtempSync(join(tmpdir(), "aif-chat-")),
      model: opts.model,
      modelRuntime: opts.runtime,
      systemPrompt: system,
      tools: [],
    });
    try {
      await session.prompt(prompt, { expandPromptTemplates: false });
      return session.getLastAssistantText() ?? "";
    } finally {
      session.dispose();
    }
  };
}

const SYSTEM = `你为一个工作流的每个步骤补写「聊天场景下给用户看的操作说明」。
背景：这个工作流要放进普通聊天窗口，由 AI 带着用户一步步做。AI 无法访问任何系统，所以程序化的步骤（调用接口、拉取数据）要请用户亲手在系统里完成。

要求：
- 用用户看得懂的话，写出「在哪个系统的哪个页面做什么」，例如「在 ERP 的订单查询里，把下单时间设为本周一 00:00 到现在，导出订单列表」。
- 不要出现接口、API、字段、参数、调用等技术用语，不要使用 {{}} 引用，不要编造系统里不存在的页面名称（不确定时写「相关页面」）。
- 每条一到两句话，以「在……」或动词开头，不要以「请」开头。
- 只输出一个 JSON 对象：键是步骤 id，值是说明文字。不要解释，不要代码块。`;

function needsChat(n: WorkflowNode): boolean {
  return n.type === "step" && n.executor === "deterministic" && !n.chatInstructions;
}

function collect(nodes: WorkflowNode[], out: WorkflowNode[] = []): WorkflowNode[] {
  for (const n of nodes) {
    if (needsChat(n)) out.push(n);
    if (n.type === "foreach") collect(n.body.nodes, out);
  }
  return out;
}

/** 还缺 chatInstructions 的程序化步骤 */
export function missingChatSteps(ir: WorkflowIR): WorkflowNode[] {
  return collect(ir.nodes);
}

/**
 * 为旧工作流补写 chatInstructions（新生成的工作流已经带有）。
 * 只补 deterministic 步骤，只加这一个字段，其他内容不动。返回新对象和补写的步骤数；没有缺口时原样返回。
 */
export async function backfillChatInstructions(ir: WorkflowIR, ask: Ask): Promise<{ ir: WorkflowIR; filled: number }> {
  const steps = missingChatSteps(ir);
  if (steps.length === 0) return { ir, filled: 0 };

  const systems = new Map(ir.integrations.map((i) => [i.id, i.name]));
  const brief = steps.map((n) => {
    const s = n as Extract<WorkflowNode, { type: "step" }>;
    const sys = s.integration ? systems.get(s.integration) ?? s.integration : "";
    return { id: s.id, 步骤名: s.title, 系统: sys, 原说明: s.instructions };
  });
  const raw = await ask(SYSTEM, `工作流：${ir.name}\n${ir.description}\n\n需要补写的步骤：\n${JSON.stringify(brief, null, 1)}`);
  const parsed = parseJson(raw) as Record<string, unknown> | undefined;
  if (!parsed) return { ir, filled: 0 };

  let filled = 0;
  const patch = (list: WorkflowNode[]): WorkflowNode[] =>
    list.map((n): WorkflowNode => {
      if (n.type === "foreach") return { ...n, body: { ...n.body, nodes: patch(n.body.nodes) } };
      const text = needsChat(n) ? parsed[n.id] : undefined;
      if (typeof text === "string" && text.trim() && !/\{\{/.test(text)) {
        filled += 1;
        return { ...n, chatInstructions: text.trim() } as WorkflowNode;
      }
      return n;
    });
  return { ir: { ...ir, nodes: patch(ir.nodes) }, filled };
}
