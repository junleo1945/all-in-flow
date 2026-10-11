import { FEATURE_LABELS, type ExecFrame, type ExecGraph, type Feature, type WorkflowEdge, type WorkflowNode } from "@aif/workflow-ir";
import type { ExprCtx } from "./expr.js";
import { loopNodes, mapNode, type MappableNode, type MappedNode } from "./nodes.js";
import { stableId } from "./ids.js";

export interface N8nOptions {
  /** 占位节点是否附带便签，便签中写着原来的执行说明 */
  includeNotes: boolean;
}

export interface N8nNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id?: string; name: string }>;
}

export interface N8nConnection {
  node: string;
  type: "main";
  index: number;
}

export interface N8nWorkflow {
  name: string;
  nodes: N8nNode[];
  connections: Record<string, { main: N8nConnection[][] }>;
  settings: { executionOrder: "v1" };
}

/** layout 中的坐标已经是像素值，这里只留出触发器列和便签的位置 */
const OFFSET: [number, number] = [240, 300];
const NOTE_LIFT = 220;
/** lower() 分层布局中一列的宽度 */
const COL = 240;
/** 循环体相对循环节点下移的距离 */
const BODY_DROP = 260;

/** Loop Over Items 的输出槽：done 为 0，loop 为 1 */
const LOOP_DONE = 0;
const LOOP_BODY = 1;

type ForeachNode = Extract<WorkflowNode, { type: "foreach" }>;

/** 一个 foreach 展开出的节点名 */
interface LoopNames {
  loop: string;
  prepare: string;
  gate: string;
  split: string;
  collect: string;
  empty: string;
  merge: string;
}

/**
 * 把执行图组装成 n8n 工作流 JSON（export-v2.md 8.1）。
 * foreach 展开为 准备 → 有数据？ → 拆分 → Loop Over Items → 汇总，没有数据时走"空结果"，两条路径汇入合并节点。
 * 循环体放在循环节点下方，循环体的结束节点接回循环节点。
 * 引用只在"一定已经执行过"的节点上直接取值，其余的先判断 isExecuted。
 * 调用前应先通过 checkExport，不支持的结构（cycle、并行）不在这里处理。
 */
export function buildN8nWorkflow(graph: ExecGraph, options: N8nOptions): N8nWorkflow {
  const { ir, root, names } = graph;
  const triggerName = `触发器（${FEATURE_LABELS[`trigger:${ir.trigger.type}` as Feature]}）`;

  // 先为所有 foreach 分配节点名：foreach 的输出可能在任意位置被引用
  const used = new Set([...names.values(), triggerName]);
  const unique = (base: string) => {
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base} (${i})`;
    used.add(name);
    return name;
  };
  const loops = new Map<string, LoopNames>();
  const assign = (frame: ExecFrame) => {
    for (const n of frame.nodes) {
      if (n.type !== "foreach") continue;
      const loop = names.get(n.id)!;
      loops.set(n.id, {
        loop,
        prepare: unique(`${loop}（准备数据）`),
        gate: unique(`${loop}（有数据？）`),
        split: unique(`${loop}（拆分）`),
        collect: unique(`${loop}（汇总）`),
        empty: unique(`${loop}（空结果）`),
        merge: unique(`${loop}（合并结果）`),
      });
      assign(frame.children.get(n.id)!);
    }
  };
  assign(root);

  const nodes: N8nNode[] = [];
  const add = (seed: string, name: string, mapped: MappedNode, pos: [number, number]) => {
    nodes.push({
      id: stableId(`${ir.slug}:${seed}`),
      name,
      type: mapped.type,
      typeVersion: mapped.typeVersion,
      position: pos,
      parameters: mapped.parameters,
      ...(mapped.credentials ? { credentials: mapped.credentials } : {}),
    });
    if (mapped.placeholder && options.includeNotes) {
      const noteName = `便签：${name}`;
      nodes.push({
        id: stableId(`${ir.slug}:note:${seed}`),
        name: noteName,
        type: "n8n-nodes-base.stickyNote",
        typeVersion: 1,
        position: [pos[0], pos[1] - NOTE_LIFT],
        parameters: { content: mapped.placeholder.note, height: 200, width: 280 },
      });
    }
  };

  // 连线：以节点名为键（export-v2.md 8.1）
  const connections: N8nWorkflow["connections"] = {};
  const connect = (from: string, outIndex: number, to: string, inIndex: number) => {
    const entry = (connections[from] ??= { main: [] });
    (entry.main[outIndex] ??= []).push({ node: to, type: "main", index: inIndex });
  };
  const mergeSlots = new Map<string, number>();

  /**
   * 生成一层图。base 是这一层以外的上下文（名字、循环元素），inherited 是外层已经保证执行过的节点
   * （循环体每轮都会经过循环节点，所以外层的支配节点对循环体也成立）。
   */
  const emitFrame = (frame: ExecFrame, base: ExprCtx, origin: [number, number], owner: ForeachNode | undefined, inherited: Set<string>) => {
    const colX = columnOffsets(frame);
    const position = (id: string): [number, number] => {
      const p = frame.layout.get(id) ?? { x: 0, y: 0 };
      return [origin[0] + colX(Math.round(p.x / COL)), origin[1] + p.y];
    };
    const start = frame.nodes.find((n) => n.type === "start");
    const ownerLoop = owner ? loops.get(owner.id)!.loop : undefined;
    const dom = dominators(frame);
    // foreach 也算支配节点：它的合并节点每次都会执行
    const guard = (id: string) => new Set([...inherited, ...(dom.get(id) ?? [])]);

    // 顶层的触发器替换 start 节点；循环体的 start 由循环节点的 loop 输出代替
    if (!owner) add(start?.id ?? "__trigger__", triggerName, triggerNode(ir.trigger), start ? position(start.id) : origin);

    const incomingCount = new Map<string, number>();
    for (const e of frame.edges) incomingCount.set(e.to, (incomingCount.get(e.to) ?? 0) + 1);

    for (const node of frame.nodes) {
      if (node.type === "start") continue;
      const ctx: ExprCtx = { ...base, guaranteed: guard(node.id) };
      if (node.type === "foreach") {
        emitLoop(frame, node, ctx, position(node.id), owner !== undefined, guard(node.id));
        continue;
      }
      const condition = node.type === "decision" ? trueEdge(frame.edges, node.id)?.condition : undefined;
      const mapped = mapNode(node as MappableNode, condition, ctx, `${ir.slug}:${node.id}`, incomingCount.get(node.id) ?? 0);
      add(node.id, names.get(node.id)!, mapped, position(node.id));
      // 循环体执行完一轮，回到循环节点取下一条
      if (ownerLoop && node.type === "end") connect(names.get(node.id)!, 0, ownerLoop, 0);
    }

    const typeOf = (id: string) => frame.nodes.find((n) => n.id === id)?.type;
    for (const edge of frame.edges) {
      if (start && edge.to === start.id) continue;

      let from = names.get(edge.from)!;
      let outIndex = 0;
      if (start && edge.from === start.id) [from, outIndex] = ownerLoop ? [ownerLoop, LOOP_BODY] : [triggerName, 0];
      else if (typeOf(edge.from) === "foreach") from = loops.get(edge.from)!.merge;
      else if (typeOf(edge.from) === "decision") outIndex = branchIndex(frame.edges, edge);

      let to = names.get(edge.to)!;
      let inIndex = 0;
      if (typeOf(edge.to) === "foreach") to = loops.get(edge.to)!.prepare;
      else if (typeOf(edge.to) === "merge") {
        inIndex = mergeSlots.get(edge.to) ?? 0;
        mergeSlots.set(edge.to, inIndex + 1);
      }
      connect(from, outIndex, to, inIndex);
    }
  };

  /**
   * foreach 展开：准备、有数据？、拆分、循环排成一行，循环体在下方；汇总在循环体之后，
   * 空结果在汇总的下方，合并在最右侧。
   */
  const emitLoop = (frame: ExecFrame, node: ForeachNode, ctx: ExprCtx, [x, y]: [number, number], nested: boolean, bodyInherited: Set<string>) => {
    const n = loops.get(node.id)!;
    const body = frame.children.get(node.id)!;
    const mapped = loopNodes(node, ctx, `${ir.slug}:${node.id}`, nested ? n.split : undefined);
    const bodyX = x + 3 * COL;
    const afterBody = bodyX + frameWidth(body);
    add(`${node.id}:prepare`, n.prepare, mapped.prepare, [x, y]);
    add(`${node.id}:gate`, n.gate, mapped.gate, [x + COL, y]);
    add(`${node.id}:split`, n.split, mapped.split, [x + 2 * COL, y]);
    add(node.id, n.loop, mapped.loop, [bodyX, y]);
    // 循环体的 start 不生成节点，它所在的列与循环节点对齐
    const bodyBase: ExprCtx = { ...ctx, guaranteed: undefined, items: new Map(ctx.items).set(node.item, n.loop) };
    emitFrame(body, bodyBase, [bodyX, y + BODY_DROP], node, bodyInherited);
    add(`${node.id}:collect`, n.collect, mapped.collect, [afterBody, y]);
    add(`${node.id}:empty`, n.empty, mapped.empty, [afterBody, y + BODY_DROP]);
    add(`${node.id}:merge`, n.merge, mapped.merge, [afterBody + COL, y]);

    connect(n.prepare, 0, n.gate, 0);
    connect(n.gate, 0, n.split, 0);
    connect(n.gate, 1, n.empty, 0);
    connect(n.split, 0, n.loop, 0);
    connect(n.loop, LOOP_DONE, n.collect, 0);
    connect(n.collect, 0, n.merge, 0);
    connect(n.empty, 0, n.merge, 1);
  };

  const outputs = new Map([...loops].map(([id, n]) => [id, n.merge]));
  emitFrame(root, { names, triggerName, outputs, items: new Map() }, OFFSET, undefined, new Set());

  // n8n 的 main 输出要求每个槽位都存在，缺的补空数组（例如 IF 的假分支没有连线）
  for (const entry of Object.values(connections)) {
    for (let i = 0; i < entry.main.length; i++) entry.main[i] ??= [];
  }

  return { name: ir.name, nodes, connections, settings: { executionOrder: "v1" } };
}

/**
 * 每个节点的支配节点：从 start 到它的每条路径上都经过的节点（含它自己）。
 * 迭代求解，图很小，不需要更复杂的算法。不可达的节点不会执行，取自身即可。
 */
function dominators(frame: ExecFrame): Map<string, Set<string>> {
  const ids = frame.nodes.map((n) => n.id);
  const all = new Set(ids);
  const start = frame.nodes.find((n) => n.type === "start")?.id;
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of frame.edges) preds.get(e.to)?.push(e.from);

  const dom = new Map<string, Set<string>>();
  for (const id of ids) dom.set(id, id === start ? new Set([id]) : new Set(all));
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of ids) {
      if (id === start) continue;
      const ps = preds.get(id)!;
      const next = ps.length === 0 ? new Set([id]) : new Set(all);
      if (ps.length > 0) {
        for (const p of ps) for (const x of [...next]) if (!dom.get(p)!.has(x)) next.delete(x);
        next.add(id);
      }
      if (next.size !== dom.get(id)!.size) {
        dom.set(id, next);
        changed = true;
      }
    }
  }
  return dom;
}

/** 一个节点在画布上占的宽度：foreach 展开后包括准备、有数据？、拆分、循环、循环体、汇总和合并 */
function nodeWidth(frame: ExecFrame, node: WorkflowNode): number {
  return node.type === "foreach" ? 5 * COL + frameWidth(frame.children.get(node.id)!) : COL;
}

/** 每一列取该列最宽的节点，返回第 level 列的横坐标 */
function columnOffsets(frame: ExecFrame): (level: number) => number {
  const widths = columnWidths(frame);
  return (level) => widths.slice(0, level).reduce((sum, w) => sum + w, 0) + Math.max(0, level - widths.length) * COL;
}

function columnWidths(frame: ExecFrame): number[] {
  const widths: number[] = [];
  for (const node of frame.nodes) {
    const level = Math.round((frame.layout.get(node.id)?.x ?? 0) / COL);
    widths[level] = Math.max(widths[level] ?? COL, nodeWidth(frame, node));
  }
  return Array.from(widths, (w) => w ?? COL);
}

function frameWidth(frame: ExecFrame): number {
  return columnWidths(frame).reduce((sum, w) => sum + w, 0);
}

function triggerNode(trigger: { type: "manual" | "schedule" | "event"; cron?: string }): MappedNode {
  switch (trigger.type) {
    case "manual":
      return { type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {} };
    case "schedule":
      // 定时触发的参数结构在目标 n8n 版本上待验证（export-v2.md 8.4）
      return {
        type: "n8n-nodes-base.scheduleTrigger",
        typeVersion: 1.2,
        parameters: { rule: { interval: [{ field: "cronExpression", expression: trigger.cron ?? "" }] } },
      };
    case "event":
      return { type: "n8n-nodes-base.webhook", typeVersion: 2, parameters: { httpMethod: "POST", path: "event", responseMode: "onReceived" } };
  }
}

/** decision 的"真"出边：没有标记 default 的第一条，否则取第一条 */
function trueEdge(edges: WorkflowEdge[], decisionId: string): WorkflowEdge | undefined {
  const out = edges.filter((e) => e.from === decisionId);
  return out.find((e) => !e.default) ?? out[0];
}

/** decision 的出边输出槽：真 → 0，假 → 1（IF 节点的约定） */
function branchIndex(edges: WorkflowEdge[], edge: WorkflowEdge): number {
  const t = trueEdge(edges, edge.from);
  return t === edge ? 0 : 1;
}
