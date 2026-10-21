import { z } from "zod";
import { convertV1 } from "./migrate.js";
import { codeProblem } from "./coverage.js";
import {
  REF_PATTERN,
  WorkflowIRSchema,
  WorkflowIRv1Schema,
  type Variable,
  type WorkflowEdge,
  type WorkflowIR,
  type WorkflowNode,
} from "./schema.js";

export interface ValidationIssue {
  level: "error";
  nodeId?: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; ir: WorkflowIR; issues: []; warnings: string[] }
  | { ok: false; issues: ValidationIssue[]; warnings: string[] };

/** 集成操作的声明，由调用方提供（通常来自 @aif/integrations），workflow-ir 不直接依赖集成目录 */
export interface OperationSpec {
  params: { name: string; required?: boolean }[];
}

export interface ValidateOptions {
  /** 提供后会检查 action.operation 是否存在、参数是否匹配 */
  resolveOperation?: (integrationId: string, operationId: string) => OperationSpec | undefined;
}

/** 与 executor 对应的 action 类型（export-v2.md 3.3） */
const ALLOWED_ACTIONS: Record<"deterministic" | "llm" | "human", string[]> = {
  deterministic: ["integration", "http", "transform", "code"],
  llm: ["llm"],
  human: ["human"],
};

const RESERVED_IDS = ["input", "env"];

/**
 * 校验 IR：先过 schema（v1 或 v2），v1 转换为 v2 后再做图结构校验。
 * 所有问题一次性返回，方便 LLM 生成失败时整体修正。
 */
export function validateWorkflow(input: unknown, options: ValidateOptions = {}): ValidationResult {
  const version = (input as { version?: unknown } | null)?.version;
  const warnings: string[] = [];

  if (version !== 1 && version !== 2) {
    return { ok: false, warnings, issues: [{ level: "error", message: `version: 只支持 1 或 2，当前为 ${String(version)}` }] };
  }

  let candidate: unknown = input;
  if (version === 1) {
    const legacy = WorkflowIRv1Schema.safeParse(input);
    if (!legacy.success) return { ok: false, warnings, issues: zodIssues(legacy.error) };
    const converted = convertV1(legacy.data);
    candidate = converted.ir;
    warnings.push(...converted.warnings);
  }

  const parsed = WorkflowIRSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, warnings, issues: zodIssues(parsed.error) };

  const issues = checkWorkflow(parsed.data, options);
  return issues.length === 0 ? { ok: true, ir: parsed.data, issues: [], warnings } : { ok: false, issues, warnings };
}

function zodIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((i) => ({
    level: "error" as const,
    message: `${i.path.join(".") || "(root)"}: ${i.message}`,
  }));
}

// ———————————————— 图结构与引用 ————————————————

/** 一层图：顶层是整个工作流，foreach 的子流程各自是一层 */
interface Frame {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** 子流程所属的 foreach 节点；顶层为 undefined */
  owner?: Extract<WorkflowNode, { type: "foreach" }>;
}

interface Ctx {
  ir: WorkflowIR;
  options: ValidateOptions;
  integrationIds: Set<string>;
  inputs: Map<string, Variable>;
  issues: ValidationIssue[];
  err: (message: string, nodeId?: string) => void;
}

type RefResult = { ok: true; variable?: Variable } | { ok: false; message: string };

/** 检查 IR 的所有图结构、引用和 action 规则，返回问题列表 */
export function checkWorkflow(ir: WorkflowIR, options: ValidateOptions = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const err = (message: string, nodeId?: string) => issues.push({ level: "error", nodeId, message });

  // 节点 id 全局唯一（子流程中的节点也算），且不能与引用保留字冲突
  const seen = new Set<string>();
  for (const n of collectNodes(ir.nodes)) {
    if (seen.has(n.id)) err(`节点 id 重复：${n.id}`, n.id);
    if (RESERVED_IDS.includes(n.id)) err(`节点 id 不能是保留字：${n.id}`, n.id);
    seen.add(n.id);
  }

  const ctx: Ctx = {
    ir,
    options,
    integrationIds: new Set(ir.integrations.map((i) => i.id)),
    inputs: new Map(ir.inputs.map((v) => [v.name, v])),
    issues,
    err,
  };
  if (ir.trigger.integration && !ctx.integrationIds.has(ir.trigger.integration)) {
    err(`触发器引用的集成不存在：${ir.trigger.integration}`);
  }
  if (ir.trigger.integration && ir.trigger.type !== "event") {
    err("只有事件触发可以指定来源集成");
  }
  checkFrame(ctx, [{ nodes: ir.nodes, edges: ir.edges }]);
  return issues;
}

function collectNodes(nodes: WorkflowNode[], out: WorkflowNode[] = []): WorkflowNode[] {
  for (const n of nodes) {
    out.push(n);
    if (n.type === "foreach") collectNodes(n.body.nodes, out);
  }
  return out;
}

/** frames 是从外到内的完整路径，最后一层是当前所在的图 */
function checkFrame(ctx: Ctx, frames: Frame[]) {
  const frame = frames[frames.length - 1]!;
  const { nodes, edges } = frame;
  const where = frame.owner ? `foreach「${frame.owner.title}」的子流程：` : "";
  const err = (message: string, nodeId?: string) => ctx.err(where + message, nodeId);

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const starts = nodes.filter((n) => n.type === "start");
  const ends = nodes.filter((n) => n.type === "end");
  if (starts.length !== 1) err(`必须且只能有一个 start 节点，当前 ${starts.length} 个`);
  if (ends.length === 0) err("至少需要一个 end 节点");

  let endpointsOk = true;
  for (const e of edges) {
    if (!byId.has(e.from)) {
      err(`边的起点不存在：${e.from}`);
      endpointsOk = false;
    }
    if (!byId.has(e.to)) {
      err(`边的终点不存在：${e.to}`);
      endpointsOk = false;
    }
    const src = byId.get(e.from);
    if (src && src.type !== "decision" && (e.condition || e.default)) {
      err("只有 decision 节点的出边可以带 condition 或 default", e.from);
    }
  }

  if (endpointsOk) checkStructure(ctx, frame, starts.length === 1 ? starts[0]!.id : undefined, ends.map((e) => e.id), err);

  // 节点规则
  for (const n of nodes) checkNode(ctx, frames, n, err);

  // 边上的条件引用，以判断节点的位置解析
  for (const e of edges) {
    if (e.condition) checkCondition(ctx, frames, e.condition, e.from, (m) => err(m, e.from));
  }

  // 递归检查子流程
  for (const n of nodes) {
    if (n.type === "foreach") checkFrame(ctx, [...frames, { nodes: n.body.nodes, edges: n.body.edges, owner: n }]);
  }
}

/** 图结构：判断节点的出边、从 start 可达、能到达 end、环必须经过 decision */
function checkStructure(
  ctx: Ctx,
  frame: Frame,
  startId: string | undefined,
  endIds: string[],
  err: (message: string, nodeId?: string) => void,
) {
  const { nodes, edges } = frame;
  const out = adjacency(nodes, edges, "forward");
  const inc = adjacency(nodes, edges, "backward");

  for (const n of nodes) {
    if (n.type !== "decision") continue;
    const outs = edges.filter((e) => e.from === n.id);
    if (outs.length < 2) err("decision 节点至少需要两条出边", n.id);
    if (outs.some((e) => !e.label)) err("decision 节点的每条出边都必须有 label", n.id);

    if (n.mode === "llm") {
      if (!n.question) err("llm 判断必须有 question", n.id);
      if (outs.some((e) => e.condition)) err("llm 判断的出边不能带 condition", n.id);
    } else {
      if (outs.some((e) => !e.condition && !e.default)) err("expr 判断的每条出边都必须有 condition 或 default", n.id);
      if (outs.filter((e) => e.default).length > 1) err("expr 判断最多只能有一条 default 出边", n.id);
    }
  }

  if (startId) {
    const fromStart = reach([startId], out);
    const toEnd = reach(endIds, inc);
    for (const n of nodes) {
      if (!fromStart.has(n.id)) err("节点无法从 start 到达", n.id);
      else if (!toEnd.has(n.id)) err("节点无法到达任何 end", n.id);
    }
  }

  // 去掉 decision 后图必须无环：环只能通过 decision 退出
  const decisionIds = new Set(nodes.filter((n) => n.type === "decision").map((n) => n.id));
  const withoutDecisions = new Map<string, string[]>();
  for (const n of nodes) {
    if (decisionIds.has(n.id)) continue;
    withoutDecisions.set(
      n.id,
      (out.get(n.id) ?? []).filter((t) => !decisionIds.has(t)),
    );
  }
  if (hasCycle(withoutDecisions)) err("存在不经过 decision 节点的循环，循环必须有 decision 作为出口");
}

function checkNode(
  ctx: Ctx,
  frames: Frame[],
  n: WorkflowNode,
  err: (message: string, nodeId?: string) => void,
) {
  if (n.type === "step") {
    if (n.integration && !ctx.integrationIds.has(n.integration)) {
      err(`节点引用的集成不存在：${n.integration}`, n.id);
    }
    if (n.action) checkAction(ctx, frames, n, err);
  }

  if (n.type === "decision" && n.mode === "llm" && n.input) {
    const r = resolveRef(ctx, frames, n.input, n.id);
    if (!r.ok) err(r.message, n.id);
  }

  if (n.type === "foreach") {
    const r = resolveRef(ctx, frames, n.over, n.id);
    if (!r.ok) err(r.message, n.id);
    else if (r.variable && r.variable.type !== "array") err("foreach 的 over 必须引用 array 类型的变量", n.id);
  }
}

function checkAction(
  ctx: Ctx,
  frames: Frame[],
  n: Extract<WorkflowNode, { type: "step" }>,
  err: (message: string, nodeId?: string) => void,
) {
  const action = n.action!;
  const allowed = ALLOWED_ACTIONS[n.executor];
  if (!allowed.includes(action.kind)) {
    err(`executor 为 ${n.executor} 时不能使用 ${action.kind} 类型的 action`, n.id);
  }

  const template = (text: string) => checkTemplate(ctx, frames, text, n.id, err);

  switch (action.kind) {
    case "integration": {
      if (!ctx.integrationIds.has(action.integration)) {
        err(`action 引用的集成不存在：${action.integration}`, n.id);
      } else if (n.integration && n.integration !== action.integration) {
        err("action 的集成必须与节点的 integration 一致", n.id);
      }
      const spec = ctx.options.resolveOperation?.(action.integration, action.operation);
      if (ctx.options.resolveOperation && !spec) {
        err(`集成 ${action.integration} 没有操作 ${action.operation}`, n.id);
      } else if (spec) {
        for (const key of Object.keys(action.params)) {
          if (!spec.params.some((p) => p.name === key)) err(`操作 ${action.operation} 没有参数 ${key}`, n.id);
        }
        for (const p of spec.params) {
          if (p.required && !(p.name in action.params)) err(`操作 ${action.operation} 缺少必填参数 ${p.name}`, n.id);
        }
      }
      for (const v of Object.values(action.params)) template(v);
      break;
    }
    case "http":
      template(action.url);
      for (const v of Object.values(action.headers ?? {})) template(v);
      if (action.body) template(action.body);
      break;
    case "llm":
      template(action.prompt);
      if (action.system) template(action.system);
      break;
    case "transform":
      template(action.template);
      break;
    case "human":
      template(action.message);
      break;
    case "code": {
      const problem = action.language === "javascript" ? codeProblem(action.source) : undefined;
      if (problem) err(problem, n.id);
      break;
    }
  }
}

/** 检查模板中所有 {{引用}} */
function checkTemplate(
  ctx: Ctx,
  frames: Frame[],
  text: string,
  nodeId: string,
  err: (message: string, nodeId?: string) => void,
) {
  for (const m of text.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) {
    const r = resolveRef(ctx, frames, m[1]!, nodeId);
    if (!r.ok) err(r.message, nodeId);
  }
}

function checkCondition(
  ctx: Ctx,
  frames: Frame[],
  cond: NonNullable<WorkflowEdge["condition"]>,
  atId: string,
  err: (message: string) => void,
) {
  if ("all" in cond) for (const c of cond.all) checkCondition(ctx, frames, c, atId, err);
  else if ("any" in cond) for (const c of cond.any) checkCondition(ctx, frames, c, atId, err);
  else {
    const r = resolveRef(ctx, frames, cond.left, atId);
    if (!r.ok) err(r.message);
  }
}

/**
 * 解析引用（export-v2.md 3.2）：
 * - input.x：必须是工作流输入；
 * - env.X：集成配置项，只检查格式；
 * - <元素名>：foreach 子流程中当前元素，取自最近的 foreach；
 * - <节点id>.<变量名>：节点必须在当前节点之前执行（存在从它到当前节点的路径），且声明了该输出。
 */
function resolveRef(ctx: Ctx, frames: Frame[], ref: string, atId: string): RefResult {
  if (!REF_PATTERN.test(ref)) return { ok: false, message: `引用格式错误：${ref}` };
  const [head, ...rest] = ref.split(".");

  if (head === "input") {
    const name = rest[0];
    const v = name ? ctx.inputs.get(name) : undefined;
    if (!v) return { ok: false, message: `引用的工作流输入不存在：${ref}` };
    return { ok: true, variable: v };
  }
  if (head === "env") {
    return rest.length === 1 ? { ok: true } : { ok: false, message: `env 引用格式应为 env.配置项：${ref}` };
  }

  // 子流程的当前元素（由内向外查找）
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i]!.owner?.item === head) return { ok: true };
  }

  // 节点输出（由内向外查找，内层优先）
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i]!;
    const target = frame.nodes.find((n) => n.id === head);
    if (!target) continue;

    const at = i === frames.length - 1 ? atId : frames[i + 1]!.owner!.id;
    if (target.id === at) return { ok: false, message: `不能引用节点自身的输出：${ref}` };
    if (!reach([target.id], adjacency(frame.nodes, frame.edges, "forward")).has(at)) {
      return { ok: false, message: `节点 ${head} 不在当前节点之前执行：${ref}` };
    }

    const name = rest[0];
    const outputs: Variable[] = target.type === "step" || target.type === "foreach" ? target.outputs ?? [] : [];
    const v = name ? outputs.find((o) => o.name === name) : undefined;
    if (!v) return { ok: false, message: `节点 ${head} 没有声明输出 ${name ?? ""}：${ref}` };
    return { ok: true, variable: v };
  }

  return { ok: false, message: `引用的节点或元素不存在：${head}` };
}

// ———————————————— 图工具 ————————————————

function adjacency(nodes: WorkflowNode[], edges: WorkflowEdge[], dir: "forward" | "backward"): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) {
    if (dir === "forward") adj.get(e.from)?.push(e.to);
    else adj.get(e.to)?.push(e.from);
  }
  return adj;
}

function reach(start: string[], adj: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [...start];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nx of adj.get(cur) ?? []) stack.push(nx);
  }
  return seen;
}

function hasCycle(adj: Map<string, string[]>): boolean {
  const state = new Map<string, 0 | 1 | 2>(); // 0 未访问 1 访问中 2 完成
  const visit = (u: string): boolean => {
    state.set(u, 1);
    for (const v of adj.get(u) ?? []) {
      const s = state.get(v) ?? 0;
      if (s === 1) return true;
      if (s === 0 && visit(v)) return true;
    }
    state.set(u, 2);
    return false;
  };
  for (const u of adj.keys()) {
    if ((state.get(u) ?? 0) === 0 && visit(u)) return true;
  }
  return false;
}
