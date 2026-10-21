import { createHash } from "node:crypto";
import { codeProblem } from "@aif/workflow-ir";
import { forbiddenNode, NODE_TYPE, type CredentialInfo } from "./toolbox.js";

/**
 * 模型给出的 n8n 工作流草稿 → 可以粘贴到 n8n 画布的工作流（n8n-export-skill.md 2、3）。
 * 这里全是确定性的检查和整理：模型的输出不直接信任，凭证只能引用 n8n 里真实存在的，密钥不能出现在参数里。
 */

export interface DraftNode {
  name: string;
  type: string;
  typeVersion: number;
  parameters: Record<string, unknown>;
  /** 凭证类型 → { id }；id 必须来自 list_credentials 的结果 */
  credentials?: Record<string, { id: string }>;
}

export type Connections = Record<string, Record<string, Array<Array<{ node: string; type: string; index: number }>>>>;

export interface DraftWorkflow {
  nodes: DraftNode[];
  connections: Connections;
}

export interface N8nNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
}

export interface N8nWorkflowJson {
  name: string;
  nodes: N8nNode[];
  connections: Connections;
  settings: { executionOrder: "v1" };
}

const MAX_NODES = 40;
const MAX_NAME = 100;
const MAX_PARAMS_CHARS = 30_000;
const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|authorization)/i;
const CONNECTION_TYPES = /^(main|ai_[A-Za-z]+)$/;

/** 名称不带 Trigger、但是触发器的节点（n8n 的老节点） */
const LEGACY_TRIGGERS = new Set(["webhook", "emailReadImap", "cron", "interval", "start"]);

/**
 * 触发器：类型名以 Trigger 结尾，或是已知的老触发节点；搜索节点时 n8n 标出的触发器（known）也算。
 */
export function isTrigger(type: string, known: ReadonlySet<string> = new Set()): boolean {
  const name = type.split(".")[1] ?? "";
  return known.has(type) || /trigger$/i.test(name) || LEGACY_TRIGGERS.has(name);
}

/** 参数里不能直接写密钥：键名像密钥、值是非空且不是表达式的字符串，返回路径 */
export function secretPath(value: unknown, path = ""): string | undefined {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = secretPath(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const here = path ? `${path}.${k}` : k;
      if (SECRET_KEY.test(k) && typeof v === "string" && v.trim() !== "" && !v.startsWith("=")) return here;
      const hit = secretPath(v, here);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** 把模型的输出规整成草稿；格式不对时返回问题 */
export function parseDraft(raw: unknown): { draft?: DraftWorkflow; problems: string[] } {
  const problems: string[] = [];
  const o = (raw ?? {}) as { nodes?: unknown; connections?: unknown };
  if (!Array.isArray(o.nodes) || o.nodes.length === 0) return { problems: ["workflow.nodes 必须是非空数组"] };
  if (o.nodes.length > MAX_NODES) return { problems: [`节点最多 ${MAX_NODES} 个`] };
  const nodes: DraftNode[] = [];
  for (const [i, n] of (o.nodes as unknown[]).entries()) {
    const x = (n ?? {}) as Record<string, unknown>;
    const label = typeof x.name === "string" ? `「${x.name}」` : `第 ${i + 1} 个节点`;
    if (typeof x.name !== "string" || x.name.trim() === "" || x.name.length > MAX_NAME) {
      problems.push(`${label}：name 必须是 1 到 ${MAX_NAME} 个字符`);
      continue;
    }
    if (typeof x.type !== "string" || !NODE_TYPE.test(x.type)) {
      problems.push(`${label}：type 不正确`);
      continue;
    }
    if (typeof x.typeVersion !== "number" || !Number.isFinite(x.typeVersion) || x.typeVersion <= 0) {
      problems.push(`${label}：typeVersion 必须是正数`);
      continue;
    }
    const parameters = x.parameters && typeof x.parameters === "object" && !Array.isArray(x.parameters) ? (x.parameters as Record<string, unknown>) : {};
    if (JSON.stringify(parameters).length > MAX_PARAMS_CHARS) {
      problems.push(`${label}：parameters 太长`);
      continue;
    }
    const credentials: Record<string, { id: string }> = {};
    if (x.credentials && typeof x.credentials === "object" && !Array.isArray(x.credentials)) {
      for (const [type, ref] of Object.entries(x.credentials as Record<string, unknown>)) {
        const id = (ref as { id?: unknown } | null)?.id;
        if (typeof id === "string" || typeof id === "number") credentials[type] = { id: String(id) };
      }
    }
    nodes.push({ name: x.name, type: x.type, typeVersion: x.typeVersion, parameters, ...(Object.keys(credentials).length ? { credentials } : {}) });
  }
  if (problems.length) return { problems };
  const connections = (o.connections && typeof o.connections === "object" && !Array.isArray(o.connections) ? o.connections : {}) as Connections;
  return { draft: { nodes, connections }, problems };
}

/** 结构与安全检查：返回问题（空表示通过），用于让模型修正 */
export function checkDraft(draft: DraftWorkflow, triggerTypes: ReadonlySet<string> = new Set()): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const n of draft.nodes) {
    if (names.has(n.name)) problems.push(`节点名称重复：「${n.name}」`);
    names.add(n.name);
    if (forbiddenNode(n.type)) problems.push(`「${n.name}」使用了不允许的节点 ${n.type}`);
    const secret = secretPath(n.parameters);
    if (secret) problems.push(`「${n.name}」的参数「${secret}」像是密钥：密钥必须放在 n8n 的凭证里，不要写在节点参数中`);
    if (n.type === "n8n-nodes-base.code" && typeof n.parameters.jsCode === "string") {
      const p = codeProblem(n.parameters.jsCode);
      if (p) problems.push(`「${n.name}」的代码不安全：${p}`);
    }
  }
  const triggers = draft.nodes.filter((n) => isTrigger(n.type, triggerTypes));
  if (triggers.length === 0) problems.push("工作流需要一个触发器（定时、收到邮件、Webhook、表单或手动触发）");
  if (triggers.length > 1) problems.push(`只能有一个触发器，现在有 ${triggers.length} 个`);
  for (const [from, byType] of Object.entries(draft.connections)) {
    if (!names.has(from)) problems.push(`连线的起点「${from}」不是工作流里的节点`);
    for (const [type, outputs] of Object.entries(byType ?? {})) {
      if (!CONNECTION_TYPES.test(type)) problems.push(`连线类型 ${type} 不正确`);
      if (!Array.isArray(outputs)) {
        problems.push(`「${from}」的连线格式不正确：应为二维数组`);
        continue;
      }
      for (const slot of outputs) {
        if (!Array.isArray(slot)) {
          problems.push(`「${from}」的连线格式不正确：应为二维数组`);
          continue;
        }
        for (const link of slot) {
          if (!link || !names.has(link.node)) problems.push(`「${from}」连到了不存在的节点「${link?.node}」`);
          else if (!Number.isInteger(link.index) || link.index < 0) problems.push(`「${from}」到「${link.node}」的 index 必须是非负整数`);
        }
      }
    }
  }
  // 除触发器和 AI 子节点外，每个节点都应该有上游
  const hasInput = new Set<string>();
  const isSub = new Set<string>();
  for (const [from, byType] of Object.entries(draft.connections)) {
    for (const [type, outputs] of Object.entries(byType ?? {})) {
      if (type.startsWith("ai_")) isSub.add(from);
      for (const slot of Array.isArray(outputs) ? outputs : []) for (const link of Array.isArray(slot) ? slot : []) if (link?.node) hasInput.add(link.node);
    }
  }
  for (const n of draft.nodes) {
    if (!isTrigger(n.type, triggerTypes) && !isSub.has(n.name) && !hasInput.has(n.name)) problems.push(`「${n.name}」没有连到工作流里（没有任何上游）`);
  }
  return problems;
}

/**
 * 凭证只能引用 n8n 里真实存在、类型一致的：其余的去掉，并记入“需要补的东西”。
 * available 是 list_credentials 返回的全部凭证。
 */
export function resolveCredentials(draft: DraftWorkflow, available: CredentialInfo[]): { nodes: Array<DraftNode & { resolved?: Record<string, { id: string; name: string }> }>; todo: string[] } {
  const todo: string[] = [];
  const nodes = draft.nodes.map((n) => {
    const resolved: Record<string, { id: string; name: string }> = {};
    for (const [type, ref] of Object.entries(n.credentials ?? {})) {
      const found = available.find((c) => c.id === ref.id && c.type === type);
      if (found) resolved[type] = { id: found.id, name: found.name };
      else todo.push(`「${n.name}」需要 ${type} 类型的凭证：请在 n8n 里选择或新建`);
    }
    return { ...n, ...(Object.keys(resolved).length ? { resolved } : {}) };
  });
  return { nodes, todo };
}

const stableId = (seed: string) => {
  const h = createHash("sha1").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** 按连线深度排版：主流程从左到右，同一列从上到下；AI 子节点放在它所连节点的下方 */
export function layout(draft: DraftWorkflow, triggerTypes: ReadonlySet<string> = new Set()): Map<string, [number, number]> {
  const depth = new Map<string, number>();
  const sub = new Map<string, string>();
  const next = new Map<string, string[]>();
  for (const [from, byType] of Object.entries(draft.connections)) {
    for (const [type, outputs] of Object.entries(byType ?? {})) {
      for (const slot of Array.isArray(outputs) ? outputs : []) {
        for (const link of Array.isArray(slot) ? slot : []) {
          if (!link?.node) continue;
          if (type.startsWith("ai_")) sub.set(from, link.node);
          else next.set(from, [...(next.get(from) ?? []), link.node]);
        }
      }
    }
  }
  const roots = draft.nodes.filter((n) => isTrigger(n.type, triggerTypes)).map((n) => n.name);
  const queue: Array<[string, number]> = roots.map((r) => [r, 0]);
  for (const [name, d] of queue) {
    if ((depth.get(name) ?? -1) >= d) continue;
    depth.set(name, d);
    for (const to of next.get(name) ?? []) queue.push([to, d + 1]);
    if (queue.length > 2000) break;
  }
  const rows = new Map<number, number>();
  const pos = new Map<string, [number, number]>();
  for (const n of draft.nodes) {
    if (sub.has(n.name)) continue;
    const d = depth.get(n.name) ?? 0;
    const row = rows.get(d) ?? 0;
    rows.set(d, row + 1);
    pos.set(n.name, [240 + d * 240, 300 + row * 180]);
  }
  let k = 0;
  for (const n of draft.nodes) {
    const parent = sub.get(n.name);
    if (!parent) continue;
    const [px, py]: [number, number] = pos.get(parent) ?? [240, 300];
    pos.set(n.name, [px - 100 + (k++ % 3) * 120, py + 200]);
  }
  return pos;
}

/** 组装可以粘贴到 n8n 画布的工作流 JSON */
export function assembleWorkflow(name: string, slug: string, draft: DraftWorkflow, available: CredentialInfo[], triggerTypes: ReadonlySet<string> = new Set()): { workflow: N8nWorkflowJson; todo: string[] } {
  const { nodes, todo } = resolveCredentials(draft, available);
  const pos = layout(draft, triggerTypes);
  return {
    workflow: {
      name,
      nodes: nodes.map((n) => ({
        id: stableId(`${slug}:${n.name}`),
        name: n.name,
        type: n.type,
        typeVersion: n.typeVersion,
        position: pos.get(n.name) ?? [240, 300],
        parameters: n.parameters,
        ...(n.resolved ? { credentials: n.resolved } : {}),
      })),
      connections: draft.connections,
      settings: { executionOrder: "v1" },
    },
    todo,
  };
}
