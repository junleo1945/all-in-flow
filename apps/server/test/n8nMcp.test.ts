import { describe, expect, it } from "vitest";
import { assertAllowedTarget, checkToken, McpError, McpSession, MCP_TOOLS, normalizeMcpUrl, parseRpc, toolResult, type McpTool } from "../src/n8n/mcp.js";

const BASE = "https://n8n.example.com";
const ENDPOINT = `${BASE}/mcp-server/http`;
const PLACEHOLDER = "mcp-token-for-test";
const publicDns = { lookup: async () => [{ address: "93.184.216.34" }] };

/** 按顺序返回预设响应，并记录请求 */
function scripted(responses: Array<Response>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: any }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const next = responses.shift();
    if (!next) throw new Error("没有预设的响应");
    return next;
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}
const rpc = (id: number, result: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "content-type": "application/json", ...headers } });
const sse = (id: number, result: unknown) =>
  new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`, { headers: { "content-type": "text/event-stream" } });
const accepted = () => new Response(null, { status: 202 });
const text = (value: unknown) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });

describe("地址与 token", () => {
  it("规范化：地址就是 MCP 服务的完整地址，去掉结尾斜杠；只填 n8n 地址（没有路径）时补上 n8n 的 MCP 路径", () => {
    expect(normalizeMcpUrl("https://n8n.example.com/mcp-server/http")).toBe("https://n8n.example.com/mcp-server/http");
    expect(normalizeMcpUrl("https://n8n.example.com/mcp-server/http/")).toBe("https://n8n.example.com/mcp-server/http");
    expect(normalizeMcpUrl("https://n8n.example.com/")).toBe("https://n8n.example.com/mcp-server/http");
    expect(normalizeMcpUrl("https://mcp.example.com/v1/mcp")).toBe("https://mcp.example.com/v1/mcp");
    for (const bad of ["not a url", "ftp://x.com", "https://u:p@x.com", "https://x.com/?a=1"]) expect(() => normalizeMcpUrl(bad), bad).toThrow(McpError);
  });

  it("默认只允许 https 且不能指向内网", async () => {
    await expect(assertAllowedTarget(BASE, publicDns)).resolves.toBeUndefined();
    for (const bad of ["http://n8n.example.com", "https://127.0.0.1", "https://192.168.1.10", "https://10.0.0.5:5678", "https://[::1]", "https://localhost", "https://n8n.internal"]) {
      await expect(assertAllowedTarget(bad, publicDns), bad).rejects.toThrow(McpError);
    }
  });

  it("域名解析到内网地址时拒绝；解析不了时拒绝", async () => {
    await expect(assertAllowedTarget(BASE, { lookup: async () => [{ address: "10.1.2.3" }] })).rejects.toThrow("内网");
    await expect(assertAllowedTarget(BASE, { lookup: async () => [{ address: "93.184.216.34" }, { address: "192.168.0.9" }] })).rejects.toThrow("内网");
    await expect(assertAllowedTarget(BASE, { lookup: async () => { throw new Error("x"); } })).rejects.toThrow("解析");
  });

  it("内部部署显式放开后，内网和 http 都可以", async () => {
    await expect(assertAllowedTarget("http://192.168.1.10:5678", { allowPrivateHosts: true })).resolves.toBeUndefined();
  });

  it("token 为空或带换行时拒绝", () => {
    expect(() => checkToken("")).toThrow("MCP token");
    expect(() => checkToken("a\nb")).toThrow("MCP token");
    expect(checkToken("  abc ")).toBe("abc");
  });
});

describe("MCP 响应解析", () => {
  it("JSON 与 SSE 都能取出对应 id 的消息", () => {
    expect(parseRpc('{"jsonrpc":"2.0","id":2,"result":{"a":1}}', "application/json", 2)?.result).toEqual({ a: 1 });
    expect(parseRpc('[{"id":1,"result":1},{"id":2,"result":2}]', "application/json", 2)?.result).toBe(2);
    expect(parseRpc('event: message\ndata: {"id":3,"result":"x"}\n\n', "text/event-stream", 3)?.result).toBe("x");
    expect(parseRpc("not json", "application/json", 1)).toBeUndefined();
  });

  it("工具结果：结构化内容优先，其次 JSON 文本，其次原文；工具报错时抛出", () => {
    expect(toolResult({ structuredContent: { ok: true } })).toEqual({ ok: true });
    expect(toolResult(text({ a: 1 }))).toEqual({ a: 1 });
    expect(toolResult(text("纯文本"))).toBe("纯文本");
    expect(() => toolResult({ isError: true, content: [{ type: "text", text: "出错了" }] })).toThrow("出错了");
  });
});

describe("McpSession", () => {
  const open = async (extra: Response[] = []) => {
    const s = scripted([rpc(1, { protocolVersion: "2025-03-26" }, { "mcp-session-id": "sess-1" }), accepted(), ...extra]);
    const session = await McpSession.open(ENDPOINT, PLACEHOLDER, { fetch: s.fetchFn, lookup: publicDns.lookup });
    return { session, ...s };
  };

  it("先 initialize 再发 initialized 通知；token 放在 Authorization 头，之后的请求带会话标识", async () => {
    const { calls, session } = await open([sse(2, { tools: [{ name: "search_nodes" }, { name: "execute_workflow" }, { name: "list_credentials" }] })]);
    expect(calls[0]!.url).toBe("https://n8n.example.com/mcp-server/http");
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${PLACEHOLDER}`);
    expect(calls[0]!.body.method).toBe("initialize");
    expect(calls[1]!.body.method).toBe("notifications/initialized");
    expect(calls[1]!.headers["Mcp-Session-Id"]).toBe("sess-1");
    expect(await session.availableTools()).toEqual(["search_nodes", "list_credentials"]);
  });

  it("只允许调用白名单中的只读工具", async () => {
    const { session, calls } = await open();
    await expect(session.call("execute_workflow" as McpTool, {})).rejects.toThrow("不允许");
    expect(calls).toHaveLength(2);
    for (const bad of ["create_workflow_from_code", "update_workflow", "execute_workflow", "test_workflow", "publish_workflow", "archive_workflow"]) expect(MCP_TOOLS as readonly string[]).not.toContain(bad);
  });

  it("调用工具并解析结果", async () => {
    const { session, calls } = await open([rpc(2, text({ results: "ok" }))]);
    expect(await session.call("search_nodes", { queries: ["slack"] })).toEqual({ results: "ok" });
    expect(calls[2]!.body).toMatchObject({ method: "tools/call", params: { name: "search_nodes", arguments: { queries: ["slack"] } } });
  });

  it("token 被拒绝、没有开启 MCP、跳转都有明确的错误，错误里不出现 token", async () => {
    for (const [status, message] of [[401, "拒绝"], [403, "拒绝"], [404, "没有开启 MCP"], [302, "跳转"]] as const) {
      const s = scripted([new Response("{}", { status })]);
      const error = await McpSession.open(ENDPOINT, PLACEHOLDER, { fetch: s.fetchFn, lookup: publicDns.lookup }).catch((e: Error) => e);
      expect((error as Error).message).toContain(message);
      expect((error as Error).message).not.toContain(PLACEHOLDER);
    }
  });

  it("内网地址在发出任何请求之前就被拒绝", async () => {
    const s = scripted([]);
    await expect(McpSession.open("https://192.168.1.5/mcp-server/http", PLACEHOLDER, { fetch: s.fetchFn })).rejects.toThrow("内网");
    expect(s.calls).toHaveLength(0);
  });
});
