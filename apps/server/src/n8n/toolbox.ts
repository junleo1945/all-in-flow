import { McpError, type McpSession } from "./mcp.js";

/**
 * 导出 skill 能使用的 n8n 能力（对用户 n8n 的 MCP 做的只读包装）。
 * 模型不直接调用 MCP：它只能请求这里列出的几个动作，由服务端执行并把结果文本交还，
 * 所以流程图里的文字即使含有指令，也无法让模型去操作 n8n。
 */

export interface NodeCandidate {
  nodeType: string;
  name: string;
  version: number;
  description: string;
  /** n8n 标出的触发器 */
  trigger?: boolean;
  /** resource / operation 的可选值（节点按资源和操作拆分时） */
  discriminators?: string;
}

export interface CredentialInfo {
  id: string;
  name: string;
  type: string;
}

export interface NodeIssue {
  name: string;
  errors: string[];
}

export interface Toolbox {
  search(queries: string[]): Promise<NodeCandidate[]>;
  /** 节点的参数定义（TypeScript 类型文本，已截断）和可用的凭证类型 */
  types(nodeType: string, version?: number, discriminators?: { resource?: string; operation?: string }): Promise<{ definition: string; credentials: string[] }>;
  credentials(type?: string): Promise<CredentialInfo[]>;
  /** 逐节点校验参数，返回有问题的节点 */
  validate(nodes: Array<{ name: string; type: string; typeVersion: number; parameters: Record<string, unknown> }>): Promise<NodeIssue[]>;
}

const MAX_QUERIES = 3;
const MAX_CANDIDATES = 12;
const MAX_DEFINITION_CHARS = 12_000;
const VALIDATE_BATCH = 50;

/** 节点类型：包名.节点名，例如 n8n-nodes-base.slack */
export const NODE_TYPE = /^(@[a-z0-9-]+\/)?[a-z0-9-]+\.[A-Za-z0-9]+$/;
/** 能在服务器上执行命令、读写文件或操作 n8n 本身的节点不允许出现在导出结果里 */
const FORBIDDEN_NODES = new Set(["executeCommand", "readWriteFile", "readBinaryFile", "readBinaryFiles", "writeBinaryFile", "ssh", "ftp", "git", "n8n", "executeWorkflow", "localFileTrigger"]);

export function forbiddenNode(nodeType: string): boolean {
  return FORBIDDEN_NODES.has(nodeType.split(".")[1] ?? "");
}

/** 解析 search_nodes 返回的文本；触发器、工具节点和不允许的节点不作为普通候选以外的内容，触发器单独保留 */
export function parseSearchResults(text: string): NodeCandidate[] {
  const out: NodeCandidate[] = [];
  const seen = new Set<string>();
  for (const block of text.split(/\n- /).slice(1)) {
    const lines = block.split("\n");
    const nodeType = lines[0]!.trim().split(/\s+/)[0]!;
    const trigger = lines[0]!.includes("[TRIGGER]");
    if (!NODE_TYPE.test(nodeType) || forbiddenNode(nodeType) || /Tool$/.test(nodeType) || seen.has(nodeType)) continue;
    const field = (label: string) => lines.map((l) => l.trim()).find((l) => l.startsWith(`${label}:`))?.slice(label.length + 1).trim() ?? "";
    const version = Number(field("Version"));
    if (!Number.isFinite(version) || version <= 0) continue;
    seen.add(nodeType);
    const at = lines.findIndex((l) => l.trim().startsWith("Discriminators:"));
    const end = lines.findIndex((l, i) => i > at && l.trim().startsWith("Use get_node_types"));
    const discriminators =
      at >= 0 && !lines[at]!.includes("none")
        ? lines.slice(at + 1, end > at ? end : undefined).map((l) => l.trim()).filter(Boolean).join(" ").slice(0, 800)
        : undefined;
    out.push({ nodeType, name: field("Display Name") || nodeType, version, description: field("Description"), ...(trigger ? { trigger } : {}), ...(discriminators ? { discriminators } : {}) });
  }
  return out;
}

/** 从 get_node_types 返回的定义里取出节点可用的凭证类型 */
export function credentialNamesOf(definitions: string): string[] {
  const names: string[] = [];
  let inCreds = false;
  for (const line of definitions.split("\n")) {
    if (/^export interface \w*Credentials\w* \{/.test(line)) {
      inCreds = true;
      continue;
    }
    if (inCreds && line.startsWith("}")) {
      inCreds = false;
      continue;
    }
    const m = inCreds ? /^ {2}([A-Za-z]\w*)\??: CredentialReference/.exec(line) : null;
    if (m && !names.includes(m[1]!)) names.push(m[1]!);
  }
  return names;
}

/** list_credentials 的返回形态不固定：数组、{data:[]}、{credentials:[]}、{items:[]} 都认；只取 id、名称、类型 */
export function parseCredentials(raw: unknown): CredentialInfo[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? ((raw as any).data ?? (raw as any).credentials ?? (raw as any).items ?? [])
      : [];
  if (!Array.isArray(list)) return [];
  const out: CredentialInfo[] = [];
  for (const c of list) {
    if (!c || typeof c !== "object") continue;
    const id = (c as any).id;
    const type = (c as any).type;
    if ((typeof id !== "string" && typeof id !== "number") || typeof type !== "string") continue;
    out.push({ id: String(id), name: String((c as any).name ?? ""), type });
  }
  return out;
}

export function createToolbox(session: McpSession): Toolbox {
  return {
    async search(queries) {
      const list = queries.map((q) => q.trim()).filter(Boolean).slice(0, MAX_QUERIES);
      if (list.length === 0) return [];
      const r = await session.call<{ results?: unknown } | string>("search_nodes", { queries: list });
      const text = typeof r === "string" ? r : typeof r?.results === "string" ? r.results : "";
      return parseSearchResults(text).slice(0, MAX_CANDIDATES);
    },
    async types(nodeType, version, discriminators = {}) {
      const r = await session.call<{ definitions?: unknown } | string>("get_node_types", {
        nodeIds: [{ nodeId: nodeType, ...(version !== undefined ? { version: String(version) } : {}), ...discriminators }],
      });
      const text = typeof r === "string" ? r : typeof r?.definitions === "string" ? r.definitions : "";
      if (!text) throw new McpError(`目标 n8n 没有节点 ${nodeType} 的定义`, 404);
      return { definition: text.slice(0, MAX_DEFINITION_CHARS), credentials: credentialNamesOf(text) };
    },
    async credentials(type) {
      const r = await session.call("list_credentials", { limit: 200, ...(type ? { type } : {}) });
      return parseCredentials(r);
    },
    async validate(nodes) {
      const issues: NodeIssue[] = [];
      for (let i = 0; i < nodes.length; i += VALIDATE_BATCH) {
        const batch = nodes.slice(i, i + VALIDATE_BATCH);
        const r = await session.call<{ results?: Array<{ index?: number; name?: string; valid?: boolean; errors?: Array<{ path?: string; message?: string }> }> }>("validate_node_config", { nodes: batch });
        for (const item of r?.results ?? []) {
          if (item.valid !== false) continue;
          const errors = (item.errors?.length ? item.errors : [{ message: "参数不合法" }]).map((e) => `${e.path ? `${e.path}：` : ""}${e.message ?? "参数不合法"}`);
          issues.push({ name: item.name ?? batch[item.index ?? 0]?.name ?? "", errors });
        }
      }
      return issues;
    },
  };
}
