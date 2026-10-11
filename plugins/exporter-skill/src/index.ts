import {
  CONDITION_OPS,
  toMermaid,
  type Condition,
  type ExecGraph,
  type ExporterPlugin,
  type ExportFile,
  type ExportIssue,
  type WorkflowIR,
  type WorkflowNode,
} from "@aif/workflow-ir";
import { findIntegration, type IntegrationEntry } from "@aif/integrations";
import { connectionEntries, renderConnections } from "./connections.js";
import { planScripts, renderEnvExample, type ScriptPlan } from "./scripts.js";

export interface SkillOptions {
  /** 目标 Agent：只影响安装说明，Skill 内容相同 */
  target: "generic" | "claude-code" | "pi";
  /**
   * 打包方式：zip 解压即用（个人试用）；claude-plugin 是 Claude Code 插件，
   * 可以放进公司内部的 git marketplace 统一更新（export-v2.md 7.4）
   */
  packaging?: "zip" | "claude-plugin";
}

const INSTALL_HINT: Record<SkillOptions["target"], string> = {
  generic: "放到 Agent 的 skills 目录中（.agents/skills/ 或对应 Agent 的技能目录）。",
  "claude-code": "解压到 ~/.claude/skills/ 或项目的 .claude/skills/ 目录。",
  pi: "解压到 ~/.pi/agent/skills/ 或项目的 .agents/skills/ 目录。",
};

/**
 * 把工作流编译成 Agent Skill（遵循 agentskills.io 规范）。
 * 结构：SKILL.md + references/workflow.mmd + references/workflow.json（design.md 7.5）。
 */
export const skillExporter: ExporterPlugin<SkillOptions> = {
  type: "exporter",
  id: "skill",
  name: "Agent Skill",
  description: "导出为 Agent Skill，可放进 Claude Code、Pi、Codex 等支持 Agent Skills 规范的 Agent 中运行。",
  version: "1.0.0",
  output: "zip",
  defaultOptions: { target: "generic", packaging: "zip" },

  // action 的内容写进 instructions；确定性步骤另外生成 scripts/（P4）。
  // 没有脚本的 http 步骤、foreach 子流程、并行分支仍以文字说明代替，标为有损
  capabilities: {
    "trigger:manual": "full",
    "trigger:schedule": "full",
    "trigger:event": "full",
    "action:integration": "full",
    "action:http": "full",
    "action:llm": "full",
    "action:transform": "full",
    "action:human": "full",
    "action:none": "full",
    "action:code": "full",
    "decision:llm": "full",
    "decision:expr": "full",
    foreach: "degraded",
    parallel: "degraded",
    merge: "full",
    cycle: "full",
  },

  supports(graph: ExecGraph): ExportIssue[] {
    const ir = graph.ir;
    const issues: ExportIssue[] = [];
    if (!/时使用|时才使用|时调用/.test(ir.description)) {
      issues.push({ level: "warning", message: "description 没有写明什么时候使用（应包含「……时使用」），Agent 可能不会自动触发这个 Skill" });
    }
    const { unsupported } = planScripts(ir, orderSteps(ir).number);
    for (const u of unsupported) {
      issues.push({ level: "warning", nodeId: u.stepId, message: `步骤「${u.title}」无法生成脚本（${u.reason}），将以文字说明导出` });
    }
    for (const i of ir.integrations) {
      const entry = findIntegration(i.id);
      if (!entry) {
        issues.push({ level: "warning", message: `集成「${i.name}」未在集成目录中登记，Skill 中只能写成模型推断的说明。` });
        continue;
      }
      if (!entry.verified && entry.access !== "manual") {
        issues.push({ level: "warning", message: `集成「${i.name}」尚未在真实环境中验证连通性，使用前请先执行连通性检查。` });
      }
      if (entry.access === "manual") {
        issues.push({ level: "warning", message: `集成「${i.name}」需要人工操作，Skill 中只能写成说明，无法自动执行。` });
      }
    }
    if (ir.kind !== "automation") {
      issues.push({ level: "error", message: "只有 automation 类型的工作流可以导出为 Skill。" });
    }
    return issues;
  },

  requirements(graph: ExecGraph): string[] {
    return graph.ir.integrations.flatMap((i) => {
      const entry = findIntegration(i.id);
      if (!entry) return [`${i.name}：${i.hint ?? i.purpose}`];
      return entry.fields.length
        ? entry.fields.map((v) => `${i.name}：需要在本地配置 ${v.name}（${v.description}）`)
        : [`${i.name}：无需额外配置`];
    });
  },

  compile(graph: ExecGraph, options: SkillOptions): ExportFile[] {
    const ir = graph.ir;
    const base = ir.slug;
    const { plans } = planScripts(ir, orderSteps(ir).number);
    const files: ExportFile[] = [
      { path: `SKILL.md`, content: renderSkillMd(ir, plans) },
      { path: `references/workflow.mmd`, content: toMermaid(ir) },
      { path: `references/workflow.json`, content: JSON.stringify(ir, null, 2) + "\n" },
      { path: `INSTALL.md`, content: renderInstall(ir, options, plans) },
    ];
    for (const plan of plans.values()) files.push({ path: plan.path, content: plan.content });
    const env = renderEnvExample(ir);
    if (env) files.push({ path: `.env.example`, content: env });
    const mcp = mcpTemplate(ir);
    if (mcp) files.push({ path: `mcp.json.template`, content: mcp });
    const connections = renderConnections(ir);
    if (connections) files.push({ path: `CONNECTIONS.md`, content: connections });

    if (options.packaging === "claude-plugin") {
      // Claude Code 插件：.claude-plugin/plugin.json + skills/<slug>/...
      const plugin = { name: base, version: "1.0.0", description: ir.description };
      return [
        { path: `${base}/.claude-plugin/plugin.json`, content: JSON.stringify(plugin, null, 2) + "\n" },
        ...files.map((f) => ({ ...f, path: `${base}/skills/${base}/${f.path}` })),
      ];
    }
    return files.map((f) => ({ ...f, path: `${base}/${f.path}` }));
  },
};

// ——— 渲染 ———

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

const TAG: Record<string, string> = {
  deterministic: "脚本",
  llm: "AI",
  human: "需要确认",
};

/**
 * 指向目标步骤的写法。目标编号不大于当前步骤时是回边（循环），写成"回到第 N 步"（design.md 7.5）。
 */
function describeTarget(
  toId: string,
  fromNumber: number | undefined,
  number: Map<string, number>,
  byId: Map<string, WorkflowNode>,
): string {
  const n = byId.get(toId)!;
  if (n.type === "end") return "结束";
  const k = number.get(toId);
  if (!k) return "结束";
  // 汇合点不是循环：并行分支先到的会排在汇合点之后，编号却更大
  const back = fromNumber !== undefined && k <= fromNumber && n.type !== "merge";
  return back ? `回到第 ${k} 步` : `第 ${k} 步`;
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
function parallelNote(id: string, ir: WorkflowIR, number: Map<string, number>, byId: Map<string, WorkflowNode>, out: Map<string, string[]>): string | undefined {
  const { others, exclusive } = parallelOthers(id, ir, number, byId, out);
  if (!others.length) return undefined;
  return `与${formatSteps(others)}同时进行${exclusive ? "（判断后的分支只执行其一）" : ""}`;
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
function loopNote(body: number[] | undefined): string | undefined {
  if (!body?.length) return undefined;
  return body.length > 1 ? `循环起点：循环体为${formatSteps(body)}` : "循环起点：本步骤会重复执行";
}

/** 步骤编号的写法：连续的写成"第 2 至 4 步"，否则列出"第 2、4 步" */
function formatSteps(nums: number[]): string {
  // 把升序编号按连续段分组："1、2、3、5" → "1 至 3、5"
  const runs: [number, number][] = [];
  for (const k of nums) {
    const last = runs[runs.length - 1];
    if (last && k === last[1] + 1) last[1] = k;
    else runs.push([k, k]);
  }
  return `第 ${runs.map(([a, b]) => (a === b ? `${a}` : `${a} 至 ${b}`)).join("、")} 步`;
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
): string | undefined {
  // 并行扇出：同时进入多个步骤（结束节点不计入编号）
  if (outs.length > 1) {
    const nums = outs.map((t) => number.get(t)).filter((k): k is number => k !== undefined).sort((a, b) => a - b);
    return nums.length ? `完成后同时进入${formatSteps(nums)}` : undefined;
  }
  if (outs.length !== 1) return undefined;
  const target = describeTarget(outs[0]!, fromNumber, number, byId);
  if (target === "结束") return "至此流程结束";
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

export function renderSkillMd(ir: WorkflowIR, plans: Map<string, ScriptPlan> = new Map()): string {
  const { order, number, byId, out } = orderSteps(ir);
  const integrations = ir.integrations;

  const frontmatter = [
    "---",
    `name: ${ir.slug}`,
    `description: ${JSON.stringify(ir.description)}`,
    integrations.length
      ? `compatibility: ${JSON.stringify(`需要：${integrations.map((i) => i.name).join("、")}`)}`
      : undefined,
    "metadata:",
    `  generated-by: all-in-flow`,
    `  workflow-version: "${ir.version}"`,
    "---",
  ].filter((line): line is string => line !== undefined);

  const lines: string[] = [...frontmatter, "", `# ${ir.name}`, ""];

  lines.push("## 触发方式", "", `${ir.trigger.detail}${ir.trigger.type === "manual" ? "，或用户主动要求时" : ""}。`, "");

  if (integrations.length) {
    lines.push("## 前置条件", "");
    for (const i of integrations) {
      const entry = findIntegration(i.id);
      if (!entry) {
        lines.push(`- ${i.name}：${i.purpose}${i.hint ? `（${i.hint}）` : ""}（未在集成目录中登记，请先确认访问方式）`);
        continue;
      }
      const fields = entry.fields.map((v) => `\`${v.name}\``).join("、");
      lines.push(`- ${entry.name}：${entry.summary}${fields ? `。需要在本地配置 ${fields}` : ""}`);
      lines.push(`  - 连通性检查：${entry.verify}`);
      if (entry.access === "api" || entry.access === "cli" || entry.access === "webhook") lines.push("  - 调用方式见 `CONNECTIONS.md`。");
      if (entry.access === "mcp") lines.push("  - 配置方式见 `mcp.json.template`。");
      if (!entry.verified && entry.access !== "manual") lines.push("  - 注意：此集成尚未在真实环境中验证，请先完成连通性检查。");
      if (entry.notes) lines.push(`  - 说明：${entry.notes}`);
    }
    lines.push("");
  }

  if (ir.inputs.length) {
    lines.push("## 输入", "");
    for (const i of ir.inputs) lines.push(`- \`${i.name}\`${i.required ? "（必填）" : "（可选）"}：${i.description}`);
    lines.push("");
  }

  lines.push("## 流程图", "", "见 `references/workflow.mmd`。", "");

  lines.push("## 执行步骤", "");
  const bodies = loopBodies(ir, number, byId);
  const ends = loopEnds(ir, number, byId);
  for (const n of order) {
    const k = number.get(n.id)!;
    const outs = out.get(n.id) ?? [];
    const next = nextStepText(k, outs, number, byId);
    const loopMark = loopNote(bodies.get(n.id));
    const endMark = ends.has(n.id) ? "循环终点：循环体在此结束" : undefined;
    if (n.type === "decision") {
      const parallel = parallelNote(n.id, ir, number, byId, out);
      const head = `${k}. **判断：${n.title}**${n.mode === "llm" && n.question && n.question !== n.title ? `（判断问题：${n.question}）` : ""}`;
      lines.push(joinStep(head, [parallel, loopMark, endMark]));
      for (const e of ir.edges.filter((x) => x.from === n.id)) {
        const cond = e.condition ? `（条件：${conditionText(e.condition)}）` : e.default ? "（其他情况）" : "";
        lines.push(`   - ${e.label ?? "其他"}${cond} → ${describeTarget(e.to, k, number, byId)}`);
      }
      continue;
    }
    const parallel = parallelNote(n.id, ir, number, byId, out);
    // 子流程的细节在 workflow.json 中，这里只说明循环和汇合的含义（design：degraded 导出）
    if (n.type === "foreach") {
      const loop = `对 \`${n.over}\` 中的每一项依次执行子流程（子流程的步骤见 references/workflow.json）`;
      lines.push(joinStep(`${k}. **${n.title}**`, [loop, outputsText(n.outputs), parallel, loopMark, endMark, next]));
      continue;
    }
    if (n.type === "merge") {
      // 并行分支的汇合要等全部完成；判断分支是互斥的，只需要在此继续
      const join = isParallelJoin(n.id, ir, byId, out) ? "等待前面的并行分支全部完成" : "各分支在此汇合，之后继续";
      lines.push(joinStep(`${k}. **${n.title}**`, [join, next]));
      continue;
    }
    if (n.type !== "step") continue;
    const tag = n.executor ? `〔${TAG[n.executor]}〕` : "";
    const plan = plans.get(n.id);
    const run = plan ? `运行 \`${plan.path}\`${plan.args.length ? `，参数依次为：${plan.args.map((a) => `\`${a}\``).join("、")}` : ""}` : undefined;
    const human = n.executor === "human" ? "暂停，等用户回复后再继续" : undefined;
    lines.push(joinStep(`${k}. **${n.title}**${tag}`, [n.instructions, run, outputsText(n.outputs), parallel, loopMark, endMark, human, next]));
  }
  lines.push("");

  lines.push("## 执行约定", "");
  lines.push("- 标记〔需要确认〕的步骤，必须等用户回复后才能继续。");
  lines.push("- 任何一步失败时，停下来说明失败原因，不要跳过。");
  lines.push("- 标记〔脚本〕的步骤优先使用确定性的命令或接口调用，不要凭记忆编造结果。");
  lines.push("");

  return lines.join("\n");
}

/**
 * .mcp.json 模板：地址处只放占位符，使用者在自己的副本中替换为真实地址。
 * 模板本身不含任何真实地址或密钥。
 */
export function mcpTemplate(ir: WorkflowIR): string | undefined {
  const servers = Object.fromEntries(
    ir.integrations
      .map((i) => findIntegration(i.id))
      .filter((e): e is IntegrationEntry => !!e && e.access === "mcp" && !!e.mcp?.urlField)
      .map((e) => [e.mcp!.serverName, { type: e.mcp!.transport, url: `<填写 ${e.mcp!.urlField}>` }]),
  );
  if (Object.keys(servers).length === 0) return undefined;
  return JSON.stringify({ mcpServers: servers }, null, 2) + "\n";
}

/** INSTALL.md 中的 MCP 说明：指向模板文件，不再直接写配置 */
function mcpSnippet(ir: WorkflowIR): string[] {
  if (!mcpTemplate(ir)) return [];
  return [
    "## MCP 配置",
    "",
    "1. 复制 `mcp.json.template` 为项目根目录的 `.mcp.json`（或合并到你已有的 `.mcp.json` 中）。",
    "2. 把模板中 `<填写 …>` 的占位符替换为你自己的服务地址。地址可能包含访问凭证，不要提交到代码仓库。",
    "3. 在 Agent 中确认 MCP 服务已经连接。",
    "",
  ];
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

function renderInstall(ir: WorkflowIR, options: SkillOptions, plans: Map<string, ScriptPlan> = new Map()): string {
  const hasTransform = [...plans.values()].some((p) => p.path.endsWith(".mjs") || p.path.endsWith(".py"));
  const needsScripts = plans.size > 0;
  return [
    `# 安装「${ir.name}」`,
    "",
    INSTALL_HINT[options.target],
    "",
    "## 运行前需要准备",
    "",
    ...(ir.integrations.length
      ? ir.integrations.map((i) => {
          const e = findIntegration(i.id);
          return e ? `- ${e.name}：${e.summary}（需要配置：${e.fields.map((v) => v.name).join("、") || "无"}）` : `- ${i.name}：${i.hint ?? i.purpose}`;
        })
      : ["- 无额外依赖"]),
    "",
    ...(needsScripts
      ? [
          "## 脚本",
          "",
          "- 脚本需要 bash 和 curl（外部接口、Webhook）；命令行工具需要事先安装，见 CONNECTIONS.md。",
          ...(hasTransform ? ["- 数据整理与代码步骤需要 Node.js 20 或更高版本（Python 步骤需要 python3）。"] : []),
          "- 脚本会读取 Skill 根目录下的 `.env`。",
          "",
        ]
      : []),
    ...(renderEnvExample(ir) ? ["## 配置", "", "复制 `.env.example` 为 `.env`，填写其中的值。`.env` 不要提交到代码仓库。", ""] : []),
    ...mcpSnippet(ir),
    "准备好以后，在 Agent 中输入 `/" + ir.slug + "` 或直接描述你的需求即可触发。",
    "",
  ].join("\n");
}
