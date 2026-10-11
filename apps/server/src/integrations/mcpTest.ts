import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * 测试 MCP 服务连接：发送 initialize 与 tools/list，返回工具名称和说明。
 * 地址与密钥只用于这一次请求：不写入数据库、不写日志、不在结果或错误信息中回显。
 */

export class McpTestError extends Error {
  constructor(message: string, public status: 400 | 502 | 504 = 400) {
    super(message);
  }
}

export interface McpTool {
  name: string;
  description?: string;
}

export interface McpTestResult {
  ok: true;
  serverName?: string;
  tools: McpTool[];
}

export interface McpTestDeps {
  fetch?: typeof fetch;
  lookup?: (host: string) => Promise<Array<{ address: string }>>;
  timeoutMs?: number;
}

const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_TOOL_PAGES = 5;

/** 判断地址是否属于内网、回环、链路本地、保留地址等不允许访问的范围 */
export function isPrivateAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (v === 6) {
    const lower = address.toLowerCase();
    return (
      lower === "::" ||
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe80") ||
      lower.startsWith("::ffff:") // IPv4 映射地址，统一按拒绝处理
    );
  }
  return true; // 不是合法 IP 的结果一律拒绝
}

/** 校验地址：必须是 https，且域名解析后的所有地址都不在内网范围 */
export async function assertPublicHttpsUrl(raw: string, lookup: McpTestDeps["lookup"] = (h) => dnsLookup(h, { all: true })): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpTestError("地址格式不正确");
  }
  if (url.protocol !== "https:") throw new McpTestError("只支持 https 地址");
  if (url.username || url.password) throw new McpTestError("地址中不能包含用户名或密码");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new McpTestError("不允许访问内网或保留地址");
    return url;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host);
  } catch {
    throw new McpTestError("无法解析该域名");
  }
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new McpTestError("不允许访问内网或保留地址");
  }
  return url;
}

/** 解析响应：支持普通 JSON 和 SSE（data: 行）两种格式 */
export function parseRpcResponse(text: string, contentType: string | null): any {
  if (contentType?.includes("text/event-stream") || text.trimStart().startsWith("event:") || text.includes("\ndata:") || text.startsWith("data:")) {
    const dataLines = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    for (let i = dataLines.length - 1; i >= 0; i--) {
      try {
        const msg = JSON.parse(dataLines[i]!);
        if (msg && (msg.result !== undefined || msg.error !== undefined)) return msg;
      } catch {
        /* 继续找下一条 */
      }
    }
    throw new McpTestError("服务返回的数据无法解析", 502);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new McpTestError("服务返回的数据无法解析", 502);
  }
}

/** 把服务端的错误转成可读提示；鉴权类错误给出明确的操作建议 */
function rpcError(step: string, message: unknown): McpTestError {
  const text = String(message ?? "");
  if (/unauthori[sz]ed|token|鉴权|认证/i.test(text)) return new McpTestError("鉴权失败：请检查地址中的 key 是否正确", 502);
  return new McpTestError(`${step}：${text.slice(0, 200) || "未知错误"}`, 502);
}

export async function testMcpServer(rawUrl: string, deps: McpTestDeps = {}): Promise<McpTestResult> {
  const url = await assertPublicHttpsUrl(rawUrl, deps.lookup);
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 10_000;

  const post = async (body: unknown, sessionId?: string) => {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        redirect: "manual", // 不跟随跳转，避免跳到未校验的地址
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if ((e as Error).name === "TimeoutError" || (e as Error).name === "AbortError") throw new McpTestError("连接超时", 504);
      throw new McpTestError("无法连接到该服务", 502);
    }
    if (res.status >= 300 && res.status < 400) throw new McpTestError("服务返回了跳转，请使用最终地址", 502);
    if (res.status === 401 || res.status === 403) throw new McpTestError("鉴权失败：请检查地址中的 key 是否正确", 502);
    if (!res.ok && res.status !== 202) throw new McpTestError(`服务返回 HTTP ${res.status}`, 502);
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new McpTestError("服务返回的数据过大", 502);
    return { session: res.headers.get("mcp-session-id") ?? undefined, body: text ? parseRpcResponse(text, res.headers.get("content-type")) : undefined };
  };

  const init = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "all-in-flow-connection-test", version: "1.0.0" } },
  });
  if (init.body?.error) throw rpcError("初始化失败", init.body.error.message);
  const serverName: string | undefined = init.body?.result?.serverInfo?.name;

  // 按规范发送 initialized 通知（服务端可能返回 202，没有响应体）
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, init.session).catch(() => undefined);

  const tools: McpTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const listed = await post({ jsonrpc: "2.0", id: 2 + page, method: "tools/list", params: cursor ? { cursor } : {} }, init.session);
    if (listed.body?.error) throw rpcError("获取工具列表失败", listed.body.error.message);
    for (const t of listed.body?.result?.tools ?? []) {
      tools.push({ name: String(t.name), description: t.description ? String(t.description).slice(0, 300) : undefined });
    }
    cursor = listed.body?.result?.nextCursor;
    if (!cursor) break;
  }
  return { ok: true, serverName, tools };
}
