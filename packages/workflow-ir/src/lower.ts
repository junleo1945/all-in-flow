import type { Action, Condition, WorkflowEdge, WorkflowIR, WorkflowNode } from "./schema.js";

/**
 * 导出能力。插件用 capabilities 声明自己支持哪些，
 * 公共检查据此生成 error / warning，插件不再手写"不支持什么"。
 */
export type Feature =
  | "trigger:manual"
  | "trigger:schedule"
  | "trigger:event"
  | "action:http"
  | "action:llm"
  | "action:transform"
  | "action:code"
  | "action:human"
  | "action:none"
  | "decision:expr"
  | "decision:llm"
  | "foreach"
  | "parallel"
  | "merge"
  | "cycle";

export const FEATURE_LABELS: Record<Feature, string> = {
  "trigger:manual": "手动触发",
  "trigger:schedule": "定时触发",
  "trigger:event": "事件触发",
  "action:http": "HTTP 请求",
  "action:llm": "大模型调用",
  "action:transform": "数据整理",
  "action:code": "代码执行",
  "action:human": "人工确认",
  "action:none": "没有结构化执行方式的步骤",
  "decision:expr": "条件分支",
  "decision:llm": "大模型判断分支",
  "foreach": "循环（foreach）",
  "parallel": "并行分支",
  "merge": "汇合（merge）",
  cycle: "循环回边",
};

export interface Point {
  x: number;
  y: number;
}

export type RefKind = "input" | "env" | "item" | "node";

/** 一个被解析过的引用，例如 {{n1.orders}} → { kind: "node", nodeId: "n1", name: "orders" } */
export interface ResolvedRef {
  raw: string;
  kind: RefKind;
  /** kind 为 node 时的节点 id */
  nodeId?: string;
  /** input 的输入名、env 的配置项名、item 的元素名、node 的输出变量名 */
  name?: string;
  /** 变量名之后的字段访问，例如 order.id 中的 ["id"] */
  path: string[];
}

/** 一层图：顶层是整个工作流，每个 foreach 的子流程是一层 */
export interface ExecFrame {
  /** 所属的 foreach 节点 id；顶层为 undefined */
  owner?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** 从 start 出发的遍历顺序（先序）；没有从 start 到达的节点排在最后 */
  order: string[];
  /** 闭合循环的边（指向遍历路径上已经出现的节点） */
  backEdges: Array<{ from: string; to: string }>;
  /** 分层布局的坐标，供 n8n、Dify 等平台使用 */
  layout: Map<string, Point>;
  /** 节点用到的引用，key 为节点 id（判断节点的条件引用也归在判断节点下） */
  refs: Map<string, ResolvedRef[]>;
  /** foreach 节点 id → 子流程 */
  children: Map<string, ExecFrame>;
}

export interface ExecGraph {
  ir: WorkflowIR;
  root: ExecFrame;
  /** 全局唯一的显示名（包括子流程中的节点）。部分平台按名字引用节点，需要唯一 */
  names: Map<string, string>;
  /** 本工作流用到的能力 → 用到它的节点 id（工作流级别的能力对应空数组） */
  features: Map<Feature, string[]>;
}

interface FrameCtx {
  nodes: WorkflowNode[];
  owner?: Extract<WorkflowNode, { type: "foreach" }>;
}

/**
 * 把 IR 降级为平台无关的执行图。
 * 输入必须已经通过 validateWorkflow，这里不再做校验，遇到无法解析的引用直接抛错。
 */
export function lower(ir: WorkflowIR): ExecGraph {
  const features = new Map<Feature, string[]>();
  const add = (f: Feature, nodeId?: string) => {
    const list = features.get(f) ?? [];
    if (nodeId !== undefined) list.push(nodeId);
    features.set(f, list);
  };
  add(`trigger:${ir.trigger.type}`);

  const inputs = new Set(ir.inputs.map((v) => v.name));
  const root = lowerFrame({ ir, frames: [{ nodes: ir.nodes }], edges: ir.edges, items: [], inputs, add }, undefined);
  return { ir, root, names: uniqueNames(allNodes(ir.nodes)), features };
}

interface LowerCtx {
  ir: WorkflowIR;
  frames: FrameCtx[];
  edges: WorkflowEdge[];
  items: string[];
  inputs: Set<string>;
  add: (f: Feature, nodeId?: string) => void;
}

function lowerFrame(ctx: LowerCtx, owner: Extract<WorkflowNode, { type: "foreach" }> | undefined): ExecFrame {
  const frame = ctx.frames[ctx.frames.length - 1]!;
  const { nodes } = frame;
  const edges = ctx.edges;

  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) adj.get(e.from)?.push(e.to);

  const start = nodes.find((n) => n.type === "start");
  const order: string[] = [];
  const backEdges: ExecFrame["backEdges"] = [];
  if (start) dfs(start.id, adj, new Set(), new Set(), order, backEdges);
  for (const n of nodes) if (!order.includes(n.id)) order.push(n.id);

  const layout = layoutFrame(nodes, edges, backEdges, order);

  const refs = new Map<string, ResolvedRef[]>();
  const children = new Map<string, ExecFrame>();
  for (const n of nodes) {
    const found = nodeRefs(n, ctx);
    if (found.length) refs.set(n.id, found);
    const feature = featureOf(n);
    if (feature) ctx.add(feature, n.id);
    if (n.type === "foreach") {
      ctx.add("foreach", n.id);
      const bodyCtx: LowerCtx = {
        ...ctx,
        frames: [...ctx.frames, { nodes: n.body.nodes, owner: n }],
        edges: n.body.edges,
        items: [...ctx.items, n.item],
      };
      children.set(n.id, lowerFrame(bodyCtx, n));
    }
  }

  // 同一层中有多条出边的非判断节点：并行
  for (const n of nodes) {
    if (n.type === "decision") continue;
    if ((adj.get(n.id) ?? []).length > 1) ctx.add("parallel", n.id);
  }
  for (const b of backEdges) ctx.add("cycle", b.from);

  return { owner: owner?.id, nodes, edges, order, backEdges, layout, refs, children };
}

function dfs(id: string, adj: Map<string, string[]>, visited: Set<string>, onStack: Set<string>, order: string[], back: ExecFrame["backEdges"]) {
  visited.add(id);
  onStack.add(id);
  order.push(id);
  for (const t of adj.get(id) ?? []) {
    if (onStack.has(t)) back.push({ from: id, to: t });
    else if (!visited.has(t)) dfs(t, adj, visited, onStack, order, back);
  }
  onStack.delete(id);
}

/** 分层布局：去掉回边后取最长路径层，层内按遍历顺序排列。不依赖第三方库。 */
function layoutFrame(nodes: WorkflowNode[], edges: WorkflowEdge[], back: ExecFrame["backEdges"], order: string[]): Map<string, Point> {
  const isBack = (e: WorkflowEdge) => back.some((b) => b.from === e.from && b.to === e.to);
  const forward = edges.filter((e) => !isBack(e));
  const level = new Map<string, number>();
  for (const n of nodes) level.set(n.id, 0);
  // 按遍历顺序松弛：从 start 出发，每条前向边让后继至少比前驱深一层
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const e of forward) {
      const want = (level.get(e.from) ?? 0) + 1;
      if ((level.get(e.to) ?? 0) < want) {
        level.set(e.to, want);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const byLevel = new Map<number, string[]>();
  for (const id of order) {
    const l = level.get(id) ?? 0;
    byLevel.set(l, [...(byLevel.get(l) ?? []), id]);
  }
  const layout = new Map<string, Point>();
  for (const [l, ids] of byLevel) ids.forEach((id, i) => layout.set(id, { x: l * 240, y: i * 120 }));
  return layout;
}

/** 节点本身带来的能力（foreach 和并行另外统计） */
function featureOf(n: WorkflowNode): Feature | undefined {
  switch (n.type) {
    case "step":
      return n.action ? (`action:${n.action.kind}` as Feature) : "action:none";
    case "decision":
      return `decision:${n.mode}`;
    case "merge":
      return "merge";
    default:
      return undefined;
  }
}

// ———————————————— 引用 ————————————————

const TEMPLATE = /\{\{\s*([^{}]*?)\s*\}\}/g;

function nodeRefs(n: WorkflowNode, ctx: LowerCtx): ResolvedRef[] {
  const out: ResolvedRef[] = [];
  const template = (text: string) => {
    for (const m of text.matchAll(TEMPLATE)) out.push(resolve(m[1]!, ctx));
  };
  if (n.type === "step" && n.action) {
    for (const t of actionTemplates(n.action)) template(t);
  }
  if (n.type === "decision" && n.input) out.push(resolve(n.input, ctx));
  if (n.type === "foreach") out.push(resolve(n.over, ctx));
  if (n.type === "decision") {
    for (const e of ctx.edges) if (e.from === n.id && e.condition) for (const r of conditionRefs(e.condition)) out.push(resolve(r, ctx));
  }
  return out;
}

function actionTemplates(a: Action): string[] {
  switch (a.kind) {
    case "http":
      return [a.url, ...Object.values(a.headers ?? {}), ...(a.body ? [a.body] : [])];
    case "llm":
      return [a.prompt, ...(a.system ? [a.system] : [])];
    case "transform":
      return [a.template];
    case "human":
      return [a.message];
    case "code":
      return [];
  }
}

function conditionRefs(c: Condition): string[] {
  if ("all" in c) return c.all.flatMap(conditionRefs);
  if ("any" in c) return c.any.flatMap(conditionRefs);
  return [c.left];
}

/** 解析一个引用：先看输入、环境配置、子流程元素，再由内向外查找节点 */
function resolve(raw: string, ctx: LowerCtx): ResolvedRef {
  const [head, ...rest] = raw.split(".");
  if (head === "input") return { raw, kind: "input", name: rest[0], path: rest.slice(1) };
  if (head === "env") return { raw, kind: "env", name: rest[0], path: rest.slice(1) };
  if (ctx.items.includes(head!)) return { raw, kind: "item", name: head, path: rest };
  for (let i = ctx.frames.length - 1; i >= 0; i--) {
    if (ctx.frames[i]!.nodes.some((n) => n.id === head)) {
      return { raw, kind: "node", nodeId: head, name: rest[0], path: rest.slice(1) };
    }
  }
  throw new Error(`无法解析引用：${raw}（应已通过 validateWorkflow 校验）`);
}

// ———————————————— 工具 ————————————————

function allNodes(nodes: WorkflowNode[], out: WorkflowNode[] = []): WorkflowNode[] {
  for (const n of nodes) {
    out.push(n);
    if (n.type === "foreach") allNodes(n.body.nodes, out);
  }
  return out;
}

/** 同名节点加序号后缀，保证全局唯一 */
function uniqueNames(nodes: WorkflowNode[]): Map<string, string> {
  const used = new Map<string, number>();
  const names = new Map<string, string>();
  for (const n of nodes) {
    const base = n.title;
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    names.set(n.id, count === 1 ? base : `${base} (${count})`);
  }
  return names;
}
