import { CONDITION_OPS, type Condition, type WorkflowIR, type WorkflowNode } from "./schema.js";

/** 步骤编号的显示方式：默认就是数字，子流程用前缀（例如 "3." 显示为 3.1） */
export type NumberFormat = (k: number) => string;
const plainNumber: NumberFormat = (k) => String(k);

/** 编号与结束语的写法。子流程要给编号加前缀，并把"结束"换成只针对本轮的说法 */
export interface StepLabels {
  fmt: NumberFormat;
  /** 分支跳到结束节点时的写法 */
  endBranch: string;
  /** 单个出口指向结束节点时的衔接语 */
  finish: string;
}
const plainLabels: StepLabels = { fmt: plainNumber, endBranch: "结束", finish: "至此流程结束" };

export type StepNodeType = Extract<WorkflowNode, { type: "step" }>;
export type ForeachNodeType = Extract<WorkflowNode, { type: "foreach" }>;

/** 按从 start 出发的遍历顺序给步骤编号；返回编号表与遍历顺序 */
export function orderSteps(ir: WorkflowIR) {
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  const out = new Map<string, string[]>();
  for (const n of ir.nodes) out.set(n.id, []);
  for (const e of ir.edges) out.get(e.from)!.push(e.to);

  const start = ir.nodes.find((n) => n.type === "start");
  const order: WorkflowNode[] = [];
  const number = new Map<string, number>();
  if (!start) return { order, number, byId, out };

  // 编号规则：
  // - 深度优先：决策的第一个分支紧跟在决策之后，便于读者顺序阅读；
  // - 并行分支（非判断节点连出多条边）按分支逐条编号：一条分支的步骤连续编号，再轮到下一条；
  // - 并行汇合点要等全部上游都编号后才编号，否则会排在某一路分支的中间。
  const place = (id: string, force = false): boolean => {
    const n = byId.get(id)!;
    if (number.has(id) || n.type === "end" || n.type === "start") return false;
    if (n.type === "merge" && !force && isParallelJoin(id, ir, byId, out) && !allUpstreamPlaced(id)) return false;
    number.set(id, order.length + 1);
    order.push(n);
    return true;
  };
  const allUpstreamPlaced = (id: string) =>
    ir.edges.filter((e) => e.to === id).every((e) => number.has(e.from) || byId.get(e.from)?.type === "start");
  // 逐条分支展开：一条分支的步骤连续编号，再轮到下一条分支；并行汇合点在最后一条分支到达后才编号
  const expand = (id: string) => {
    for (const t of out.get(id) ?? []) if (place(t)) expand(t);
  };
  expand(start.id);
  // 理论上并行汇合点的上游都能编号到；如果存在环导致无法编号，强制补上，避免步骤丢失
  for (const n of ir.nodes) if (n.type === "merge" && place(n.id, true)) expand(n.id);
  return { order, number, byId, out };
}

/**
 * 指向目标步骤的写法。目标编号不大于当前步骤时是回边（循环），写成"回到第 N 步"（design.md 7.5）。
 */
function describeTarget(
  toId: string,
  fromNumber: number | undefined,
  number: Map<string, number>,
  byId: Map<string, WorkflowNode>,
  labels: StepLabels = plainLabels,
): string {
  const n = byId.get(toId)!;
  if (n.type === "end") return labels.endBranch;
  const k = number.get(toId);
  if (!k) return labels.endBranch;
  // 汇合点不是循环：并行分支先到的会排在汇合点之后，编号却更大
  const back = fromNumber !== undefined && k <= fromNumber && n.type !== "merge";
  return back ? `回到第 ${labels.fmt(k)} 步` : `第 ${labels.fmt(k)} 步`;
}

/**
 * 汇合点的上游是否来自扇出（非判断节点连出多条边）：是则为并行分支汇合，否则为互斥分支汇合。
 * 注意并行分支本身各只有一条出边，扇出在更早的节点上（例如 start），所以要看上游的上游。
 */
function isParallelJoin(id: string, ir: WorkflowIR, byId: Map<string, WorkflowNode>, out: Map<string, string[]>): boolean {
  return ir.edges
    .filter((e) => e.to === id)
    .some((e) =>
      ir.edges
        .filter((p) => p.to === e.from)
        .some((p) => byId.get(p.from)?.type !== "decision" && (out.get(p.from)?.length ?? 0) > 1),
    );
}

/** 从某个节点出发能到达的全部节点（不含结束与开始节点）；给出 stops 时不越过这些汇合点 */
function reachable(startId: string, ir: WorkflowIR, byId: Map<string, WorkflowNode>, stops?: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [startId];
  while (stack.length) {
    const id = stack.pop()!;
    const n = byId.get(id);
    if (!n || seen.has(id) || n.type === "end" || n.type === "start" || stops?.has(id)) continue;
    seen.add(id);
    for (const e of ir.edges) if (e.from === id) stack.push(e.to);
  }
  return seen;
}

/**
 * 并行扇出的各条分支所包含的步骤（不含汇合点本身）。
 * 外层分支中间可能有内层汇合点，只有被两条及以上分支都到达的汇合点才是这一层的分界。
 */
function branchLanes(targets: string[], ir: WorkflowIR, byId: Map<string, WorkflowNode>): Set<string>[] {
  const reaches = targets.map((t) => reachable(t, ir, byId));
  const count = new Map<string, number>();
  for (const r of reaches) for (const id of r) if (byId.get(id)?.type === "merge") count.set(id, (count.get(id) ?? 0) + 1);
  const joins = new Set([...count].filter(([, c]) => c >= 2).map(([id]) => id));
  return targets.map((t) => new Set([...reachable(t, ir, byId, joins)].filter((id) => byId.get(id)?.type !== "merge")));
}

/**
 * 与当前步骤同时进行的其他分支步骤编号。
 * 非判断节点连出多条边即为并行扇出；判断节点的分支是互斥的，不算并行。
 * 嵌套并行时取包含当前步骤的最内层扇出。
 * exclusive 表示同时进行的那些分支里含有判断节点，其中的步骤只会执行其一。
 */
function parallelOthers(
  id: string,
  ir: WorkflowIR,
  number: Map<string, number>,
  byId: Map<string, WorkflowNode>,
  out: Map<string, string[]>,
): { others: number[]; exclusive: boolean } {
  let best: { size: number; others: number[]; exclusive: boolean } | undefined;
  for (const [fid, fn] of byId) {
    const targets = out.get(fid) ?? [];
    if (fn.type === "decision" || fn.type === "end" || targets.length < 2) continue;
    const lanes = branchLanes(targets, ir, byId);
    const mine = lanes.findIndex((l) => l.has(id));
    if (mine < 0) continue;
    const size = lanes[mine]!.size;
    if (best && best.size <= size) continue;
    const otherLanes = lanes.filter((_, i) => i !== mine);
    const others = otherLanes
      .flatMap((l) => [...l])
      .map((x) => number.get(x))
      .filter((k): k is number => k !== undefined)
      .sort((a, b) => a - b);
    const exclusive = otherLanes.some((l) => [...l].some((x) => byId.get(x)?.type === "decision"));
    best = { size, others, exclusive };
  }
  return best ?? { others: [], exclusive: false };
}

/** 同时进行的标注，例如"与第 2 步同时进行"；没有并行关系时返回 undefined */
function parallelNote(
  id: string,
  ir: WorkflowIR,
  number: Map<string, number>,
  byId: Map<string, WorkflowNode>,
  out: Map<string, string[]>,
  labels: StepLabels = plainLabels,
): string | undefined {
  const { others, exclusive } = parallelOthers(id, ir, number, byId, out);
  if (!others.length) return undefined;
  return `与${formatSteps(others, labels.fmt)}同时进行${exclusive ? "（判断后的分支只执行其一）" : ""}`;
}

/**
 * 回边：目标编号不大于来源编号，且目标不是汇合点（汇合点会排在并行分支之后，不是循环）。
 * 与 describeTarget 的"回到第 N 步"判断保持一致。
 */
function backEdges(ir: WorkflowIR, number: Map<string, number>, byId: Map<string, WorkflowNode>) {
  return ir.edges.filter((e) => {
    const kf = number.get(e.from);
    const kt = number.get(e.to);
    const target = byId.get(e.to);
    return kf !== undefined && kt !== undefined && !!target && target.type !== "merge" && kt <= kf;
  });
}

/** 能够到达 targetId 的全部节点（不含结束与开始节点），即 reachable 的反向版本 */
function reachingTo(targetId: string, ir: WorkflowIR, byId: Map<string, WorkflowNode>): Set<string> {
  const seen = new Set<string>();
  const stack = [targetId];
  while (stack.length) {
    const id = stack.pop()!;
    const n = byId.get(id);
    if (!n || seen.has(id) || n.type === "end" || n.type === "start") continue;
    seen.add(id);
    for (const e of ir.edges) if (e.to === id) stack.push(e.from);
  }
  return seen;
}

/**
 * 循环的起点与循环体：回边指向的节点是循环起点；循环体是从起点能到达、并且能回到回边来源的步骤。
 * 同一起点有多条回边时取并集。注意循环体不等于编号区间：起点与回边之间可能夹着不在循环里的并行分支。
 */
function loopBodies(ir: WorkflowIR, number: Map<string, number>, byId: Map<string, WorkflowNode>): Map<string, number[]> {
  const bodies = new Map<string, Set<number>>();
  for (const e of backEdges(ir, number, byId)) {
    const forward = reachable(e.to, ir, byId);
    const backward = reachingTo(e.from, ir, byId);
    const set = bodies.get(e.to) ?? new Set<number>();
    for (const id of forward) if (backward.has(id) && number.has(id)) set.add(number.get(id)!);
    bodies.set(e.to, set);
  }
  return new Map([...bodies].map(([id, set]) => [id, [...set].sort((a, b) => a - b)]));
}

/** 循环终点：有回边从它发出的节点 */
function loopEnds(ir: WorkflowIR, number: Map<string, number>, byId: Map<string, WorkflowNode>): Set<string> {
  return new Set(backEdges(ir, number, byId).map((e) => e.from));
}

/** 循环起点的标注：列出循环体包含的步骤；只有起点自己时说明该步骤会重复执行 */
function loopNote(body: number[] | undefined, fmt: NumberFormat = plainNumber): string | undefined {
  if (!body?.length) return undefined;
  return body.length > 1 ? `循环起点：循环体为${formatSteps(body, fmt)}` : "循环起点：本步骤会重复执行";
}

/** 步骤编号的写法：连续的写成"第 2 至 4 步"，否则列出"第 2、4 步" */
function formatSteps(nums: number[], fmt: NumberFormat = plainNumber): string {
  // 把升序编号按连续段分组："1、2、3、5" → "1 至 3、5"
  const runs: [number, number][] = [];
  for (const k of nums) {
    const last = runs[runs.length - 1];
    if (last && k === last[1] + 1) last[1] = k;
    else runs.push([k, k]);
  }
  return `第 ${runs.map(([a, b]) => (a === b ? fmt(a) : `${fmt(a)} 至 ${fmt(b)}`)).join("、")} 步`;
}

/** 步骤的输出说明，步骤和 foreach 共用 */
function outputsText(outputs: { name: string; type: string; description?: string }[] | undefined): string | undefined {
  if (!outputs?.length) return undefined;
  return `输出：${outputs.map((o) => `\`${o.name}\`（${o.type}${o.description ? `，${o.description}` : ""}）`).join("、")}`;
}

/** 片段结尾补上句号，已有句末标点的不重复添加 */
function endSentence(text: string): string {
  return /[。！？.!?]$/.test(text) ? text : `${text}。`;
}

/** 单个出口时的衔接语：指向下一步，或说明流程到此结束 */
function nextStepText(
  fromNumber: number,
  outs: string[],
  number: Map<string, number>,
  byId: Map<string, WorkflowNode>,
  labels: StepLabels = plainLabels,
): string | undefined {
  // 并行扇出：同时进入多个步骤（结束节点不计入编号）
  if (outs.length > 1) {
    const nums = outs.map((t) => number.get(t)).filter((k): k is number => k !== undefined).sort((a, b) => a - b);
    return nums.length ? `完成后同时进入${formatSteps(nums, labels.fmt)}` : undefined;
  }
  if (outs.length !== 1) return undefined;
  const target = describeTarget(outs[0]!, fromNumber, number, byId, labels);
  if (target === labels.endBranch) return labels.finish;
  return target.startsWith("回到") ? `完成后${target}` : `完成后进入${target}`;
}

/**
 * 把步骤的标题和各片段拼成一行：每个片段单独成句并补句号，空片段跳过。
 * 标题与正文之间留一个空格，正文各句之间不加空格（中文习惯）。
 */
function joinStep(head: string, parts: (string | undefined)[]): string {
  const body = parts
    .filter((p): p is string => !!p && p.trim() !== "")
    .map((p) => endSentence(p.trim()))
    .join("");
  return body ? `${head} ${body}` : head;
}

/** 把条件表达式翻译成可读的中文（export-v2.md 7.2） */
export function conditionText(c: Condition): string {
  if ("all" in c) return c.all.map(conditionText).join(" 且 ");
  if ("any" in c) return c.any.map(conditionText).join(" 或 ");
  const right = c.right !== undefined ? ` ${String(c.right)}` : "";
  const ops: Record<(typeof CONDITION_OPS)[number], string> = {
    eq: "等于",
    ne: "不等于",
    gt: "大于",
    gte: "大于等于",
    lt: "小于",
    lte: "小于等于",
    contains: "包含",
    not_contains: "不包含",
    empty: "为空",
    not_empty: "不为空",
    is_true: "为真",
    is_false: "为假",
  };
  return `\`${c.left}\` ${ops[c.op]}${right}`;
}


export interface RenderStepsOptions {
  /** 编号前缀；子流程用 "3." 得到 3.1、3.2……，默认无前缀 */
  prefix?: string;
  /** 确定性步骤生成的脚本，key 为节点 id */
  scripts?: Map<string, { path: string; args: string[]; usage?: string }>;
  /** 步骤标题后的标记（例如〔脚本〕），返回 undefined 时不加 */
  tag?: (n: StepNodeType) => string | undefined;
  /**
   * foreach 的说明：text 写在循环那一行，lines 为展开的子步骤（不返回时只写说明）。
   * k 为该循环的编号，子步骤应以它为前缀渲染。
   */
  foreach?: (n: ForeachNodeType, k: string) => { text: string; lines?: string[] } | undefined;
  /** 结束语：默认"结束"与"至此流程结束"；子流程内改为只针对本轮 */
  endLabels?: { branch: string; finish: string };
  /** 分支条件的写法，默认 conditionText（会原样显示引用名） */
  conditionText?: (c: Condition) => string;
  /** 步骤输出说明的写法，默认带变量名和类型（给 Skill 用）；聊天场景可改成只写人话 */
  outputsText?: (outputs: { name: string; type: string; description?: string }[]) => string | undefined;
}

/**
 * 执行步骤列表，每个元素是一行：步骤、判断（及其分支）、循环、并行等。
 * Agent Skill 与提示词导出共用，差别只在标记、foreach 的写法和结束语。
 */
export function renderSteps(ir: WorkflowIR, options: RenderStepsOptions = {}): string[] {
  const { prefix = "", scripts = new Map<string, { path: string; args: string[]; usage?: string }>(), tag = () => undefined, foreach, endLabels } = options;
  const condText = options.conditionText ?? conditionText;
  const outText = options.outputsText ?? outputsText;
  const { order, number, byId, out } = orderSteps(ir);
  const fmt: NumberFormat = (k) => `${prefix}${k}`;
  const labels: StepLabels = { fmt, endBranch: endLabels?.branch ?? "结束", finish: endLabels?.finish ?? "至此流程结束" };
  const lines: string[] = [];
  const bodies = loopBodies(ir, number, byId);
  const ends = loopEnds(ir, number, byId);
  for (const n of order) {
    const k = number.get(n.id)!;
    const label = fmt(k);
    const outs = out.get(n.id) ?? [];
    const next = nextStepText(k, outs, number, byId, labels);
    const loopMark = loopNote(bodies.get(n.id), fmt);
    const endMark = ends.has(n.id) ? "循环终点：循环体在此结束" : undefined;
    if (n.type === "decision") {
      const parallel = parallelNote(n.id, ir, number, byId, out, labels);
      const head = `${label}. **判断：${n.title}**${n.mode === "llm" && n.question && n.question !== n.title ? `（判断问题：${n.question}）` : ""}`;
      lines.push(joinStep(head, [parallel, loopMark, endMark]));
      for (const e of ir.edges.filter((x) => x.from === n.id)) {
        const cond = e.condition ? `（条件：${condText(e.condition)}）` : e.default ? "（其他情况）" : "";
        lines.push(`   - ${e.label ?? "其他"}${cond} → ${describeTarget(e.to, k, number, byId, labels)}`);
      }
      continue;
    }
    const parallel = parallelNote(n.id, ir, number, byId, out, labels);
    // 子流程的细节在 workflow.json 中，这里只说明循环和汇合的含义（design：degraded 导出）
    if (n.type === "foreach") {
      const custom = foreach?.(n, label);
      const loop = custom?.text ?? `对 \`${n.over}\` 中的每一项依次执行子流程（子流程的步骤见 references/workflow.json）`;
      lines.push(joinStep(`${label}. **${n.title}**`, [loop, n.outputs?.length ? outText(n.outputs) : undefined, parallel, loopMark, endMark, next]));
      lines.push(...(custom?.lines ?? []));
      continue;
    }
    if (n.type === "merge") {
      // 并行分支的汇合要等全部完成；判断分支是互斥的，只需要在此继续
      const join = isParallelJoin(n.id, ir, byId, out) ? "等待前面的并行分支全部完成" : "各分支在此汇合，之后继续";
      lines.push(joinStep(`${label}. **${n.title}**`, [join, next]));
      continue;
    }
    if (n.type !== "step") continue;
    const plan = scripts.get(n.id);
    const run = plan
      ? `运行 \`${plan.path}\`${plan.args.length ? `，参数依次为：${plan.args.map((a) => `\`${a}\``).join("、")}` : ""}${plan.usage ? `，${plan.usage}` : ""}`
      : undefined;
    const human = n.executor === "human" ? "暂停，等用户回复后再继续" : undefined;
    lines.push(joinStep(`${label}. **${n.title}**${tag(n) ?? ""}`, [n.instructions, run, n.outputs?.length ? outText(n.outputs) : undefined, parallel, loopMark, endMark, human, next]));
  }
  return lines;
}
