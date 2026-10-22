/**
 * 最小的 MCP（Model Context Protocol）服务端实现：Streamable HTTP 传输的无状态子集。
 * 只支持工具（tools），不使用会话、流式响应和服务端推送，所以每个请求独立处理，可以随意水平扩展。
 * 规范：https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export type RpcId = string | number | null;

export interface RpcError {
  code: number;
  message: string;
}
export type RpcResponse = { jsonrpc: "2.0"; id: RpcId; result: unknown } | { jsonrpc: "2.0"; id: RpcId; error: RpcError };

export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL = -32603;

export const rpcError = (id: RpcId, code: number, message: string): RpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export const textResult = (text: string, structured?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text }],
  ...(structured ? { structuredContent: structured } : {}),
});
export const errorResult = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

export interface ToolDef<Ctx> {
  name: string;
  title: string;
  description: string;
  /** 手写的 JSON Schema，直接发给客户端（保持简单，避免 anyOf 等部分客户端不支持的写法） */
  inputSchema: Record<string, unknown>;
  call(args: unknown, ctx: Ctx): Promise<ToolResult>;
}

export interface ServerInfo {
  name: string;
  version: string;
  /** 告诉模型这个服务是干什么的、什么时候用 */
  instructions?: string;
}

interface Request {
  jsonrpc: "2.0";
  id?: RpcId;
  method: string;
  params?: Record<string, unknown>;
}

const isRequest = (m: unknown): m is Request =>
  !!m && typeof m === "object" && (m as Request).jsonrpc === "2.0" && typeof (m as Request).method === "string";

/** 客户端发来的是响应（带 result 或 error，没有 method）；无状态服务不会主动发请求，直接忽略 */
const isResponse = (m: unknown): boolean =>
  !!m && typeof m === "object" && (m as { jsonrpc?: unknown }).jsonrpc === "2.0" && !("method" in m) && ("result" in m || "error" in m);

/** 处理一条消息；通知和响应没有返回值（HTTP 层回 202） */
export async function handleMessage<Ctx>(msg: unknown, opts: { info: ServerInfo; tools: ToolDef<Ctx>[]; ctx: Ctx }): Promise<RpcResponse | null> {
  if (isResponse(msg)) return null;
  if (!isRequest(msg)) return rpcError(null, RPC_INVALID_REQUEST, "不是有效的 JSON-RPC 2.0 请求");

  const isNotification = msg.id === undefined;
  const id: RpcId = msg.id ?? null;
  const reply = (result: unknown): RpcResponse | null => (isNotification ? null : { jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string): RpcResponse | null => (isNotification ? null : rpcError(id, code, message));

  switch (msg.method) {
    case "initialize": {
      const asked = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "";
      const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0];
      return reply({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: opts.info.name, version: opts.info.version },
        ...(opts.info.instructions ? { instructions: opts.info.instructions } : {}),
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: opts.tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema })),
      });
    case "tools/call": {
      const name = msg.params?.name;
      const tool = typeof name === "string" ? opts.tools.find((t) => t.name === name) : undefined;
      if (!tool) return fail(RPC_INVALID_PARAMS, `未知的工具：${String(name)}`);
      try {
        return reply(await tool.call(msg.params?.arguments ?? {}, opts.ctx));
      } catch (e) {
        // 工具内部出错：以工具执行错误返回，让模型看到原因；不泄漏堆栈
        console.error(`MCP tool ${tool.name} failed`, e);
        return reply(errorResult("平台内部错误，请稍后重试。"));
      }
    }
    default:
      // notifications/initialized、notifications/cancelled 等通知直接确认；未知的请求报错
      if (msg.method.startsWith("notifications/")) return null;
      return fail(RPC_METHOD_NOT_FOUND, `不支持的方法：${msg.method}`);
  }
}
