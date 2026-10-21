import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Variable, WorkflowIR, WorkflowNode } from "@aif/workflow-ir";
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

/** 只有需要用户去系统里操作的步骤（HTTP 请求）才会用到这段说明；计算、整理类的步骤由 AI 自己完成，不用补 */
function needsChat(n: WorkflowNode): boolean {
  if (n.type !== "step" || n.executor !== "deterministic" || n.chatInstructions) return false;
  return n.action?.kind === "http";
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

  const brief = steps.map((n) => {
    const s = n as Extract<WorkflowNode, { type: "step" }>;
    return { id: s.id, 步骤名: s.title, 原说明: s.instructions };
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

// ——— 循环项的字段说明：把「当前这一项的 name」写成人话 ———

/** 工作流里所有变量上已有的字段说明，脚本用它打印新增了什么 */
export function listItemFields(ir: WorkflowIR): string[] {
  const out: string[] = [];
  for (const [ref, v] of variableMap(ir)) for (const f of v.fields ?? []) out.push(`${ref}.${f.name}：${f.description}`);
  return out;
}

/** 一个循环用到、但还没有中文说明的字段 */
export interface MissingItemFields {
  /** 被循环的数组变量的引用，如 input.resume_list、n1.orders */
  ref: string;
  description: string;
  /** 子流程里用到、还缺说明的字段名 */
  fields: string[];
}

function variableMap(ir: WorkflowIR): Map<string, Variable> {
  const vars = new Map<string, Variable>();
  for (const v of ir.inputs) vars.set(`input.${v.name}`, v);
  const visit = (list: WorkflowNode[]) => {
    for (const n of list) {
      if (n.type === "step" || n.type === "foreach") for (const o of n.outputs ?? []) vars.set(`${n.id}.${o.name}`, o);
      if (n.type === "foreach") visit(n.body.nodes);
    }
  };
  visit(ir.nodes);
  return vars;
}

/** 找出缺字段说明的循环：子流程里引用了「循环项.字段」，但数组变量上没有这个字段的说明 */
export function missingItemFields(ir: WorkflowIR): MissingItemFields[] {
  const vars = variableMap(ir);
  const found = new Map<string, MissingItemFields>();
  const visit = (list: WorkflowNode[]) => {
    for (const n of list) {
      if (n.type !== "foreach") continue;
      visit(n.body.nodes);
      const v = vars.get(n.over);
      if (!v) continue;
      const used = new Set<string>();
      const escaped = n.item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      for (const m of JSON.stringify(n.body).matchAll(new RegExp(`(?<![\\w.])${escaped}\\.([A-Za-z_]\\w*)`, "g"))) if (m[1] !== "length") used.add(m[1]!);
      const need = [...used].filter((u) => !v.fields?.some((f) => f.name === u && f.description));
      if (!need.length) continue;
      const entry = found.get(n.over) ?? { ref: n.over, description: v.description, fields: [] };
      for (const f of need) if (!entry.fields.includes(f)) entry.fields.push(f);
      found.set(n.over, entry);
    }
  };
  visit(ir.nodes);
  return [...found.values()];
}

const FIELDS_SYSTEM = `你为工作流里被循环处理的数据补写「字段的中文说明」。
背景：这个工作流要放进普通聊天窗口，由 AI 带着用户一步步做。提示词里会把「当前这一项的 name」之类的字段名换成用户看得懂的说法。

要求：
- 每个字段写一个简短的中文名称，2 到 8 个字，例如 name → 候选人姓名，text → 简历内容，amount → 订单金额。
- 结合变量的说明和字段所在的数据来判断含义；不确定时按常见含义写，不要写英文，不要使用 {{}}。
- 只输出一个 JSON 对象：键是变量引用，值是 {字段名: 中文名称} 的对象。不要解释，不要代码块。`;

/**
 * 为旧工作流补写循环项的字段说明（新生成的工作流已经带有）。
 * 只往数组变量上加 fields，已有的说明不动。返回新对象和补写的字段数；没有缺口时原样返回。
 */
export async function backfillItemFields(ir: WorkflowIR, ask: Ask): Promise<{ ir: WorkflowIR; filled: number }> {
  const needs = missingItemFields(ir);
  if (needs.length === 0) return { ir, filled: 0 };

  const brief = Object.fromEntries(needs.map((n) => [n.ref, { 变量说明: n.description, 需要说明的字段: n.fields }]));
  const raw = await ask(FIELDS_SYSTEM, `工作流：${ir.name}\n${ir.description}\n\n需要补写的变量：\n${JSON.stringify(brief, null, 1)}`);
  const parsed = parseJson(raw) as Record<string, unknown> | undefined;
  if (!parsed) return { ir, filled: 0 };

  const additions = new Map<string, { name: string; description: string }[]>();
  let filled = 0;
  for (const need of needs) {
    const answer = parsed[need.ref];
    if (!answer || typeof answer !== "object") continue;
    const list: { name: string; description: string }[] = [];
    for (const name of need.fields) {
      const text = (answer as Record<string, unknown>)[name];
      if (typeof text === "string" && text.trim() && !/\{\{/.test(text) && text.trim().length <= 20) list.push({ name, description: text.trim() });
    }
    if (list.length) {
      additions.set(need.ref, list);
      filled += list.length;
    }
  }
  if (filled === 0) return { ir, filled: 0 };

  const patchVar = (v: Variable, ref: string): Variable => {
    const add = additions.get(ref);
    if (!add) return v;
    // 已有但没有说明的同名字段被替换，其余保留
    const keep = (v.fields ?? []).filter((f) => !add.some((a) => a.name === f.name));
    return { ...v, fields: [...keep, ...add] };
  };
  const patch = (list: WorkflowNode[]): WorkflowNode[] =>
    list.map((n): WorkflowNode => {
      if (n.type === "foreach") {
        return { ...n, outputs: n.outputs?.map((o) => patchVar(o, `${n.id}.${o.name}`)), body: { ...n.body, nodes: patch(n.body.nodes) } };
      }
      if (n.type === "step" && n.outputs) return { ...n, outputs: n.outputs.map((o) => patchVar(o, `${n.id}.${o.name}`)) };
      return n;
    });
  return { ir: { ...ir, inputs: ir.inputs.map((v) => patchVar(v, `input.${v.name}`)), nodes: patch(ir.nodes) }, filled };
}
