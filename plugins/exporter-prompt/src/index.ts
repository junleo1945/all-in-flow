import {
  renderSteps,
  type Condition,
  type ExecGraph,
  type ExporterPlugin,
  type ExportFile,
  type ExportIssue,
  type StepNodeType,
  type WorkflowIR,
  type WorkflowNode,
} from "@aif/workflow-ir";

/** variant：full 完整版（直接粘贴、Projects、GPTs 等）；short 精简版（2000 字以内，适合放进智能体或 Gem 的设定） */
export interface PromptOptions {
  variant?: "full" | "short";
}

/** 步骤标记：对话中的 AI 无法直接访问外部系统，需要用户去操作后把结果贴回来 */
const USER_ACTION = "〔需要用户操作〕";
const CONFIRM = "〔需要确认〕";
/** 精简版的长度上限（字符） */
export const SHORT_LIMIT = 2000;

function stepTag(n: StepNodeType): string | undefined {
  if (n.executor === "human") return CONFIRM;
  if (n.integration || n.action?.kind === "integration" || n.action?.kind === "http") return USER_ACTION;
  return undefined;
}

/** 去掉给 Skill 触发用的句子（"……时使用。"）和版本备注（"（v2：……）"），对话里没有用处 */
function plainDescription(text: string): string {
  return text.replace(/当[^。]*时(才)?(使用|调用)。?/, "").replace(/（v\d[^）]*）/g, "").trim();
}

// ——— 引用的人话化：{{n1.orders}}、n2.results 这类内部名字不能出现在给用户的文字里 ———

interface Ctx {
  nodes: Map<string, WorkflowNode>;
  items: Set<string>;
  systems: Map<string, string>;
}

function buildCtx(ir: WorkflowIR): Ctx {
  const nodes = new Map<string, WorkflowNode>();
  const items = new Set<string>();
  const visit = (list: WorkflowNode[]) => {
    for (const n of list) {
      nodes.set(n.id, n);
      if (n.type === "foreach") {
        items.add(n.item);
        visit(n.body.nodes);
      }
    }
  };
  visit(ir.nodes);
  return { nodes, items, systems: new Map(ir.integrations.map((i) => [i.id, i.name])) };
}

function refLabel(ref: string, ctx: Ctx): string {
  const [head, ...rest] = ref.trim().split(".");
  const field = rest.join(".");
  if (head === "input") return `用户提供的「${field}」`;
  if (head && ctx.items.has(head)) return `当前这一项的「${field || head}」`;
  const node = head ? ctx.nodes.get(head) : undefined;
  if (node) {
    const out = node.type === "step" || node.type === "foreach" ? node.outputs?.find((o) => o.name === field) : undefined;
    return `「${node.title}」的「${out?.description || field || node.title}」`;
  }
  return field || ref;
}

/** 把文字里的 {{引用}} 换成人话 */
function fillRefs(text: string, ctx: Ctx): string {
  return text.replace(/\{\{([^}]+)\}\}/g, (_, r: string) => refLabel(r, ctx));
}

function humanCondition(c: Condition, ctx: Ctx): string {
  if ("all" in c) return c.all.map((x) => humanCondition(x, ctx)).join("，且");
  if ("any" in c) return c.any.map((x) => humanCondition(x, ctx)).join("，或");
  const left = refLabel(c.left, ctx);
  // 右侧通常是常量，但模型有时会把对另一个变量的引用（如 expense.invoice_amount）写在这里
  const isRef = typeof c.right === "string" && /^[A-Za-z_]\w*\.[\w.]+$/.test(c.right) && (c.right.startsWith("input.") || ctx.items.has(c.right.split(".")[0]!) || ctx.nodes.has(c.right.split(".")[0]!));
  const right = c.right !== undefined ? ` ${isRef ? refLabel(String(c.right), ctx) : String(c.right)}` : "";
  const ops: Record<string, string> = {
    eq: "等于",
    ne: "不等于",
    gt: "大于",
    gte: "不小于",
    lt: "小于",
    lte: "不大于",
    contains: "包含",
    not_contains: "不包含",
    empty: "为空",
    not_empty: "不为空",
    is_true: "为真",
    is_false: "为假",
  };
  return `${left}${ops[c.op] ?? c.op}${right}`;
}

// ——— 把工作流改写成适合聊天窗口的副本（不修改工作流本身） ———

function hasCriteria(n: Extract<WorkflowNode, { type: "decision" }>, edges: WorkflowIR["edges"]): boolean {
  return edges.some((e) => e.from === n.id && e.condition) || (!!n.question && n.question !== n.title);
}

function prepareNodes(nodes: WorkflowNode[], edges: WorkflowIR["edges"], ctx: Ctx): WorkflowNode[] {
  return nodes.map((n): WorkflowNode => {
    if (n.type === "decision") {
      const question = n.question ? fillRefs(n.question, ctx) : undefined;
      if (hasCriteria(n, edges)) return { ...n, question };
      // 没有判断标准：标题里直接提醒，问题不再单独写出
      return { ...n, title: `${n.title}（判断标准未写明，请先向用户确认）`, question: undefined };
    }
    if (n.type === "foreach") {
      return { ...n, body: { ...n.body, nodes: prepareNodes(n.body.nodes, n.body.edges, ctx) } };
    }
    if (n.type !== "step") return n;

    if (stepTag(n) === USER_ACTION) {
      const systemId = n.integration ?? (n.action?.kind === "integration" ? n.action.integration : undefined);
      const where = (systemId && ctx.systems.get(systemId)) || "相关系统";
      // 有专门写给聊天场景的说明就直接用（已经写明了在哪个系统做什么），否则退回到通用说明加系统名
      const what = n.chatInstructions ? `请你${fillRefs(n.chatInstructions, ctx).replace(/[。.]$/, "")}` : `请你在${where}中完成：${fillRefs(n.instructions, ctx)}`;
      return { ...n, instructions: `${what}。请把${bringText(n, ctx)}粘贴到对话里，我再继续。`, outputs: undefined };
    }

    const parts = [fillRefs(n.instructions, ctx)];
    if (n.template) parts.push(`必须按用户确认的模板或格式输出：${fillRefs(n.template, ctx)}`);
    if (n.action?.kind === "llm") {
      const prompt = fillRefs(n.action.prompt, ctx);
      if (prompt && !parts[0]!.includes(prompt)) parts.push(`具体要求：${prompt}`);
      if (n.action.outputSchema?.length) {
        parts.push(`请按这个结构输出：${n.action.outputSchema.map((o) => `${o.name}（${o.description}）`).join("、")}`);
      }
    }
    if (n.action?.kind === "human") {
      const { message, form, approval } = n.action;
      // 说明里已经写了的内容不再重复；太短的确认语（如「请确认」）只是重复说明，也不追加
      const msg = message ? fillRefs(message, ctx) : "";
      if (msg.length > 6 && !parts[0]!.includes(msg)) parts.push(msg);
      if (form?.length) parts.push(`请用户填写：${form.map((f) => `${f.label}${f.options?.length ? `（可选：${f.options.join("/")}）` : ""}`).join("、")}`);
      if (approval && !/确认|同意/.test(parts.join(""))) parts.push("请用户明确同意或拒绝");
    }
    // 各部分可能已经以句号结尾，去掉后再拼，避免出现「。。」
    return { ...n, instructions: parts.map((x) => x.replace(/[。.]+\s*$/, "")).join("。") };
  });
}

function bringText(n: StepNodeType, ctx: Ctx): string {
  if (!n.outputs?.length) return "操作结果";
  return n.outputs.map((o) => `\`${o.name}\`（${o.description || o.type}）`).join("、");
}

/** 需要用户事先准备的材料：每个需要用户操作的步骤对应一项 */
function materials(ir: WorkflowIR, ctx: Ctx): string[] {
  const out: string[] = [];
  const visit = (list: WorkflowNode[]) => {
    for (const n of list) {
      if (n.type === "foreach") visit(n.body.nodes);
      if (n.type === "step" && stepTag(n) === USER_ACTION) out.push(`「${n.title}」：${bringText(n, ctx)}`);
    }
  };
  visit(ir.nodes);
  return out;
}

/** 导出前需要用户补充的内容：判断标准、模板或输出格式 */
export interface PromptGap {
  /** 对应的节点 id，补充内容按它写回工作流 */
  nodeId: string;
  kind: "criteria" | "template";
  /** 节点标题，用于在表单里标明是哪一步 */
  title: string;
  /** 向用户提出的问题 */
  question: string;
}

/** 找出所有缺口。已经补充过的（决策有判断标准、步骤有 template）不会再出现 */
export function promptGaps(source: WorkflowIR): PromptGap[] {
  const out: PromptGap[] = [];
  const visit = (list: WorkflowNode[], edges: WorkflowIR["edges"]) => {
    for (const n of list) {
      if (n.type === "foreach") visit(n.body.nodes, n.body.edges);
      if (n.type === "decision" && !hasCriteria(n, edges)) {
        out.push({ nodeId: n.id, kind: "criteria", title: n.title, question: `「${n.title}」的判断标准是什么？` });
      }
      if (n.type === "step" && !n.template && /模板|模版|格式/.test(`${n.instructions}${n.action?.kind === "llm" ? n.action.prompt : ""}`)) {
        out.push({ nodeId: n.id, kind: "template", title: n.title, question: `「${n.title}」用什么模板或输出格式？` });
      }
    }
  };
  visit(source.nodes, source.edges);
  return out;
}

/**
 * 把用户补充的内容写回工作流（返回新对象，不修改原对象）：
 * 判断标准写进决策节点的 question，模板写进步骤的 template。空白的回答被忽略。
 */
export function applyPromptAnswers(source: WorkflowIR, answers: Record<string, string>): WorkflowIR {
  const patch = (list: WorkflowNode[]): WorkflowNode[] =>
    list.map((n): WorkflowNode => {
      const answer = answers[n.id]?.trim();
      if (n.type === "foreach") return { ...n, body: { ...n.body, nodes: patch(n.body.nodes) } };
      if (!answer) return n;
      if (n.type === "decision") return { ...n, question: answer };
      if (n.type === "step") return { ...n, template: answer };
      return n;
    });
  return { ...source, nodes: patch(source.nodes) };
}

function gaps(ir: WorkflowIR): string[] {
  return promptGaps(ir).map((g) => g.question);
}

/**
 * 精简版：普通步骤只保留第一句，去掉输出细节；需要用户操作的步骤保留完整说明（里面有要贴回什么）。
 * 只改副本，用的是已经改写过的节点。
 */
function shortenIr(ir: WorkflowIR): WorkflowIR {
  const shorten = (nodes: WorkflowNode[]): WorkflowNode[] =>
    nodes.map((n) => {
      if (n.type === "foreach") return { ...n, body: { ...n.body, nodes: shorten(n.body.nodes) } };
      if (n.type !== "step") return n;
      if (stepTag(n) === USER_ACTION) return n;
      const first = n.instructions.split(/[。；]/)[0] ?? n.instructions;
      const head = first.length > 60 ? `${first.slice(0, 60)}…` : first;
      // 用户确认的模板是硬性要求，精简版里也要完整保留
      return { ...n, instructions: n.template ? `${head}。必须按用户确认的模板或格式输出：${n.template}` : head, outputs: undefined };
    });
  return { ...ir, nodes: shorten(ir.nodes) };
}

/** 循环中的步骤：子流程写进提示词，编号为 3.1、3.2……，结束语只针对本轮 */
function stepLines(ir: WorkflowIR, ctx: Ctx, prefix = ""): string[] {
  return renderSteps(ir, {
    prefix,
    tag: stepTag,
    endLabels: prefix ? { branch: "本项结束", finish: "本项完成，继续循环中的下一项" } : undefined,
    conditionText: (c) => humanCondition(c, ctx),
    foreach: (n, label) => {
      const body = { ...ir, nodes: n.body.nodes, edges: n.body.edges } as WorkflowIR;
      return {
        text: `对${refLabel(n.over, ctx)}中的每一项，依次完成下面的子步骤`,
        lines: stepLines(body, ctx, `${label}.`).map((l) => `   ${l}`),
      };
    },
  });
}

const CONVENTIONS_FULL = [
  "一次只推进一步。每一步完成后，简要说明结果，再告诉用户下一步要做什么。",
  "每次回复开头用一行标明当前进度，例如「当前：第 2 步（判断）」。",
  `标记${USER_ACTION}的步骤：请用户去操作，等用户把结果贴回来再继续。不要替用户编造数据或结果。`,
  `标记${CONFIRM}的步骤：必须等用户明确回复后才能继续。`,
  "把步骤里的技术用语（接口、字段、API、参数等）翻译成用户在系统里能找到的操作，不要原样照念。",
  "判断标准没写明时，先给 2 到 3 个建议口径请用户选；用户说「你定」就直接给一个推荐并请他确认，不要拒绝或长篇追问。",
  "每轮只问一件最关键的事。开始前的事项要在一条消息里一次问完。",
  "数据是否完整（比如订单有没有漏）只在拿到数据时确认一次，之后不要每步重复问。",
  "用户没有提供的数据不要假设或补全；需要的模板或格式缺失时，请用户给出，或先给一个简单格式请他确认。",
  "用户粘贴的数据很长或格式不清楚时，先请用户确认结构，或分批发送。",
  "某一步无法完成时，停下来说明原因，不要跳过。",
];

const CONVENTIONS_SHORT = [
  "一次只推进一步。每一条回复（包括追问和确认）都必须以「当前：第 N 步」开头，没有例外。",
  `${USER_ACTION}的步骤请用户操作后贴回结果；${CONFIRM}的步骤必须等用户明确回复。不编造数据。`,
  "把技术用语翻译成用户能在系统里找到的操作。",
  "判断标准没写明时，给 2 到 3 个建议口径请用户选；用户说「你定」就给一个推荐并请他确认。",
  "开场消息里把「开始前需要确认的事项」和第 1 步所需的输入合并，一次问完；之后每条回复最多只问一个问题，不要连问。",
  "无法完成的步骤说明原因，不要跳过。",
];

/**
 * 把工作流写成一段提示词：粘贴到聊天窗口，或放进智能体、Gem、Projects 的设定里，由 AI 带着用户一步一步完成。
 */
export function renderPrompt(source: WorkflowIR, options: PromptOptions = {}): string {
  const variant = options.variant ?? "full";
  const base = source;
  const ctx = buildCtx(base);
  const ir = { ...base, nodes: prepareNodes(base.nodes, base.edges, ctx) };
  const gapList = gaps(base);
  const materialList = materials(base, ctx);
  const short = variant === "short";
  const body = short ? shortenIr(ir) : ir;

  const lines: string[] = [`# 任务：${ir.name}`, "", "你是一名工作流助手，接下来要带着用户一步一步完成这项工作。", "", plainDescription(ir.description), ""];

  lines.push(
    "## 你的工作环境",
    "",
    short
      ? "你在普通聊天窗口里工作：无法访问任何系统、无法联网、无法运行代码、不会定时执行。数据都由用户提供或粘贴到对话里。"
      : "你在普通聊天窗口里工作：无法登录或访问任何系统，无法联网，无法运行代码，也不会定时执行。需要的数据都由用户提供，或由用户粘贴到对话里。",
    "",
  );

  lines.push("## 开始方式", "");
  const startLine = ir.inputs.length ? "先简单说明要做什么，向用户收集下面的输入" : "先简单说明要做什么";
  lines.push(`${startLine}${gapList.length || materialList.length ? "，再按「开始前需要确认的事项」一次问完" : ""}，然后从第 1 步开始。`);
  if (ir.trigger.type !== "manual" && !short) lines.push(`这个流程原本是「${ir.trigger.detail}」自动执行的，在对话中改为由用户手动发起。`);
  lines.push("");

  if (ir.inputs.length) {
    lines.push("## 需要用户提供的输入", "");
    for (const i of ir.inputs) lines.push(`- \`${i.name}\`${i.required ? "（必填）" : "（可选）"}：${i.description}`);
    lines.push("");
  }

  if (gapList.length || materialList.length) {
    lines.push("## 开始前需要确认的事项", "");
    if (gapList.length) {
      lines.push("请先问清楚：");
      for (const g of gapList) lines.push(`- ${g}`);
      lines.push("");
    }
    if (materialList.length) {
      lines.push("请告诉用户需要提前准备的材料：");
      for (const m of materialList) lines.push(`- ${m}`);
      lines.push("");
    }
  }

  lines.push("## 执行步骤", "", ...stepLines(body, ctx), "");

  const end = ir.nodes.find((n) => n.type === "end" && n.outputs?.length);
  if (end?.type === "end" && end.outputs) {
    lines.push("## 最终交付", "", "全部步骤完成后，把下面的内容整理给用户：", "");
    for (const o of end.outputs) lines.push(`- ${refLabel(o.from, ctx)}`);
    lines.push("");
  }

  lines.push("## 执行约定", "");
  for (const c of short ? CONVENTIONS_SHORT : CONVENTIONS_FULL) lines.push(`- ${c}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * 导出为对话提示词：完整版 <slug>.prompt.md 与精简版 <slug>.prompt-short.md。
 * 支持 automation 和 process 两种类型：人工流程正适合在对话里一步步引导完成，Agent Skill 则不支持。
 */
export function promptFiles(ir: WorkflowIR): ExportFile[] {
  return [
    { path: `${ir.slug}.prompt.md`, content: renderPrompt(ir, { variant: "full" }) },
    { path: `${ir.slug}.prompt-short.md`, content: renderPrompt(ir, { variant: "short" }) },
  ];
}

export const promptExporter: ExporterPlugin<PromptOptions> = {
  type: "exporter",
  id: "prompt",
  name: "对话提示词",
  description: "导出为提示词，粘贴到 ChatGPT、DeepSeek、豆包等聊天窗口，或放进智能体、Gem、Projects 的设定里，由 AI 带着你一步一步完成这项工作。",
  version: "1.1.0",
  output: "file",
  defaultOptions: { variant: "full" },

  // full：对话中可以直接完成；degraded：会有损失，导出时给出提示
  capabilities: {
    "trigger:manual": "full",
    "trigger:schedule": "degraded",
    "trigger:event": "degraded",
    "action:integration": "degraded",
    "action:http": "degraded",
    "action:llm": "full",
    "action:transform": "full",
    "action:code": "degraded",
    "action:human": "full",
    "action:none": "full",
    "decision:expr": "full",
    "decision:llm": "full",
    foreach: "full",
    parallel: "degraded",
    merge: "full",
    cycle: "full",
  },

  supports(_graph: ExecGraph): ExportIssue[] {
    return [];
  },

  requirements(graph: ExecGraph): string[] {
    return graph.ir.integrations.map((i) => `${i.name}：对话中的 AI 无法直接访问，相关步骤需要你手动操作后把结果贴回对话。`);
  },

  compile(graph: ExecGraph): ExportFile[] {
    return promptFiles(graph.ir);
  },
};
