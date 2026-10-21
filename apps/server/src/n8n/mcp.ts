import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPrivateAddress } from "../lib/netguard.js";

/**
 * 与用户添加的 MCP 服务通信（n8n 导出用的是 n8n 的 MCP，见 n8n-export-skill.md）。
 * - 只允许调用下面白名单中的只读工具；创建、修改、执行工作流的工具一律不调用；
 * - 地址由用户填写，所以服务端先检查：只允许 https，域名解析后的地址不能是内网（内部部署可显式放开）；
 * - token 只用于请求头，不写日志，错误信息中也不回显；不跟随跳转，设置超时，限制响应大小。
 */

export const MCP_TOOLS = ["search_nodes", "get_node_types", "list_credentials", "validate_node_config"] as const;
export type McpTool = (typeof MCP_TOOLS)[number];

export class McpError extends Error {
  constructor(message: string, public status: 400 | 401 | 404 | 502 | 504 = 502) {
    super(message);
  }
}

export interface McpDeps {
  fetch?: typeof fetch;
  lookup?: (host: string) => Promise<Array<{ address: string }>>;
  timeoutMs?: number;
  /** 允许地址指向内网、允许 http（仅内部部署） */
  allowPrivateHosts?: boolean;
}

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const PROTOCOL_VERSION = "2025-03-26";
/** n8n 的 MCP 端点路径：用户只填 n8n 的地址（没有路径）时补上 */
const N8N_MCP_PATH = "/mcp-server/http";

/**
 * 规范化用户填写的 MCP 地址：就是 MCP 服务的完整地址（和 .mcp.json 里的 url 一样），去掉结尾的斜杠；
 * 只填了 n8n 的地址（没有路径）时，补上 n8n 的 MCP 路径。不合法时抛出。
 */
export function normalizeMcpUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new McpError("地址格式不正确", 400);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new McpError("只支持 http 或 https 地址", 400);
  if (url.username || url.password) throw new McpError("地址中不能包含用户名或密码", 400);
  if (url.search || url.hash) throw new McpError("地址中不能包含查询参数", 400);
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path === "" ? N8N_MCP_PATH : path}`;
}

/** 检查地址是否允许访问：默认只允许 https 且不能指向内网 */
export async function assertAllowedTarget(target: string, deps: McpDeps = {}): Promise<void> {
  const url = new URL(target);
  if (deps.allowPrivateHosts) return;
  if (url.protocol !== "https:") throw new McpError("只支持 https 地址", 400);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) throw new McpError("不允许访问内网或保留地址", 400);
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new McpError("不允许访问内网或保留地址", 400);
    return;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await (deps.lookup ?? ((h: string) => dnsLookup(h, { all: true })))(host);
  } catch {
    throw new McpError("无法解析该域名", 400);
  }
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) throw new McpError("不允许访问内网或保留地址", 400);
}

/** 检查 token 的格式（真假交给 n8n） */
export function checkToken(token: string | undefined): string {
  if (!token || token.trim() === "" || token.length > 4096 || /[\r\n]/.test(token)) throw new McpError("请填写 n8n 的 MCP token", 400);
  return token.trim();
}

interface RpcResponse {
  id?: number;
  result?: any;
  error?: { code?: number; message?: string };
}

/** 从 SSE 或 JSON 响应文本中取出指定 id 的 JSON-RPC 消息 */
export function parseRpc(text: string, contentType: string, id: number): RpcResponse | undefined {
  const messages: unknown[] = [];
  if (contentType.includes("text/event-stream")) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        messages.push(JSON.parse(data));
      } catch {
        /* 忽略不是 JSON 的事件 */
      }
    }
  } else {
    try {
      const parsed = JSON.parse(text);
      messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      return undefined;
    }
  }
  return messages.find((m): m is RpcResponse => !!m && typeof m === "object" && (m as RpcResponse).id === id);
}

/** 取出工具结果：优先结构化内容，其次文本（能解析成 JSON 就解析）；工具报错时抛出 */
export function toolResult<T = unknown>(result: any): T {
  const text = Array.isArray(result?.content)
    ? result.content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("\n")
    : "";
  if (result?.isError) throw new McpError(text ? text.slice(0, 300) : "n8n 的 MCP 工具返回了错误", 502);
  if (result?.structuredContent !== undefined) return result.structuredContent as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

export class McpSession {
  private id = 0;
  private sessionId?: string;
  private constructor(
    private readonly endpoint: string,
    private readonly token: string,
    private readonly deps: McpDeps,
  ) {}

  /** 建立会话：检查地址与 token，initialize，再发 initialized 通知 */
  static async open(endpoint: string, token: string, deps: McpDeps = {}): Promise<McpSession> {
    await assertAllowedTarget(endpoint, deps);
    const session = new McpSession(endpoint, checkToken(token), deps);
    const init = await session.rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "all-in-flow", version: "1" },
    });
    session.sessionId = init.sessionId;
    await session.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    return session;
  }

  private async post(body: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await (this.deps.fetch ?? fetch)(`${this.endpoint}`, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId, "MCP-Protocol-Version": PROTOCOL_VERSION } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if ((e as Error).name === "TimeoutError" || (e as Error).name === "AbortError") throw new McpError("连接 n8n 超时", 504);
      throw new McpError("无法连接到该 n8n", 502);
    }
    if (res.status >= 300 && res.status < 400) throw new McpError("n8n 返回了跳转，请使用最终地址", 502);
    if (res.status === 401 || res.status === 403) throw new McpError("n8n 拒绝了该 MCP token，请检查 token 与权限", 401);
    if (res.status === 404 || res.status === 405) throw new McpError("该 n8n 没有开启 MCP 服务", 404);
    if (!res.ok) throw new McpError(`n8n 的 MCP 服务返回 HTTP ${res.status}`, 502);
    return res;
  }

  private async rpc(method: string, params?: unknown): Promise<{ result: any; sessionId?: string }> {
    const id = ++this.id;
    const res = await this.post({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new McpError("n8n 返回的数据过大", 502);
    const message = parseRpc(text, res.headers.get("content-type") ?? "", id);
    if (!message) throw new McpError("n8n 的 MCP 服务返回的数据无法解析", 502);
    if (message.error) throw new McpError((message.error.message ?? "n8n 的 MCP 服务返回了错误").slice(0, 300), 502);
    return { result: message.result, sessionId: res.headers.get("mcp-session-id") ?? this.sessionId };
  }

  /** 实例上可用的工具（只返回白名单中的） */
  async availableTools(): Promise<McpTool[]> {
    const { result } = await this.rpc("tools/list");
    const names = new Set<string>((result?.tools ?? []).map((t: any) => String(t?.name)));
    return MCP_TOOLS.filter((t) => names.has(t));
  }

  /** 调用白名单中的工具 */
  async call<T = unknown>(tool: McpTool, args: Record<string, unknown>): Promise<T> {
    if (!(MCP_TOOLS as readonly string[]).includes(tool)) throw new McpError("不允许调用该 MCP 工具", 400);
    const { result } = await this.rpc("tools/call", { name: tool, arguments: args });
    return toolResult<T>(result);
  }

  /** 结束会话；失败不影响结果 */
  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await (this.deps.fetch ?? fetch)(`${this.endpoint}`, {
        method: "DELETE",
        redirect: "manual",
        signal: AbortSignal.timeout(3000),
        headers: { Authorization: `Bearer ${this.token}`, "Mcp-Session-Id": this.sessionId },
      });
    } catch {
      /* 忽略 */
    }
  }
}

/** 打开会话、执行、再关闭 */
export async function withMcp<T>(endpoint: string, token: string, deps: McpDeps, fn: (s: McpSession) => Promise<T>): Promise<T> {
  const session = await McpSession.open(endpoint, token, deps);
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}
