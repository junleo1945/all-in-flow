import { describe, expect, it } from "vitest";
import { assertPublicHttpsUrl, isPrivateAddress, McpTestError, parseRpcResponse, testMcpServer } from "../src/integrations/mcpTest.js";

const PUBLIC_LOOKUP = async () => [{ address: "203.0.113.10" }];
const SECRET_KEY = "SUPER-SECRET-KEY-123";
const URL_WITH_KEY = `https://mcp.example.com/server/abc?key=${SECRET_KEY}`;

/** 模拟 MCP 服务：initialize → 返回 session；tools/list 按 cursor 分两页 */
function fakeMcp(opts: { status?: number; listError?: boolean; sse?: boolean; requireKey?: boolean } = {}) {
  const calls: Array<{ method: string; session?: string; url: string }> = [];
  const fetchImpl = (async (input: any, init: any) => {
    const body = JSON.parse(String(init.body));
    const url = String(input);
    calls.push({ method: body.method, session: init.headers["mcp-session-id"], url });
    if (opts.status) return new Response("nope", { status: opts.status });
    if (opts.requireKey && !url.includes(`key=${SECRET_KEY}`)) return new Response("", { status: 401 });
    const send = (obj: unknown, headers: Record<string, string> = {}) => {
      if (opts.sse) return new Response(`event: message\ndata: ${JSON.stringify(obj)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream", ...headers } });
      return Response.json(obj, { headers });
    };
    if (body.method === "initialize") return send({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", serverInfo: { name: "钉钉文档" } } }, { "mcp-session-id": "sess-1" });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") {
      if (opts.listError) return send({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "boom" } });
      if (!body.params?.cursor) return send({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "create_doc", description: "创建文档" }], nextCursor: "p2" } });
      return send({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "read_doc", description: "读取文档" }] } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("内网地址判断", () => {
  it("拒绝回环、内网、链路本地、保留地址", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.5", "172.31.255.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
  });

  it("允许公网地址", () => {
    for (const a of ["8.8.8.8", "203.0.113.10", "172.32.0.1", "2001:4860:4860::8888"]) {
      expect(isPrivateAddress(a), a).toBe(false);
    }
  });
});

describe("地址校验", () => {
  it("只允许 https", async () => {
    await expect(assertPublicHttpsUrl("http://mcp.example.com/x", PUBLIC_LOOKUP)).rejects.toThrow("只支持 https");
  });

  it("拒绝带用户名密码的地址", async () => {
    await expect(assertPublicHttpsUrl("https://u:p@mcp.example.com/x", PUBLIC_LOOKUP)).rejects.toThrow("用户名或密码");
  });

  it("拒绝直接写内网 IP 的地址", async () => {
    await expect(assertPublicHttpsUrl("https://127.0.0.1/x", PUBLIC_LOOKUP)).rejects.toThrow("内网");
    await expect(assertPublicHttpsUrl("https://169.254.169.254/latest", PUBLIC_LOOKUP)).rejects.toThrow("内网");
  });

  it("域名解析到内网地址时拒绝（防止借域名访问内网）", async () => {
    const evil = async () => [{ address: "10.0.0.8" }];
    await expect(assertPublicHttpsUrl("https://evil.example.com/x", evil)).rejects.toThrow("内网");
  });

  it("域名解析结果中只要有一个内网地址就拒绝", async () => {
    const mixed = async () => [{ address: "203.0.113.10" }, { address: "127.0.0.1" }];
    await expect(assertPublicHttpsUrl("https://mixed.example.com/x", mixed)).rejects.toThrow("内网");
  });

  it("无法解析的域名给出提示", async () => {
    const fail = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(assertPublicHttpsUrl("https://nope.example.com/x", fail)).rejects.toThrow("无法解析");
  });

  it("格式错误的地址拒绝", async () => {
    await expect(assertPublicHttpsUrl("not a url", PUBLIC_LOOKUP)).rejects.toThrow("格式不正确");
  });
});

describe("响应解析", () => {
  it("支持普通 JSON", () => {
    expect(parseRpcResponse('{"jsonrpc":"2.0","id":1,"result":{}}', "application/json").result).toEqual({});
  });

  it("支持 SSE 格式，取最后一条带结果的消息", () => {
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","method":"progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":1}}\n\n';
    expect(parseRpcResponse(sse, "text/event-stream").result).toEqual({ ok: 1 });
  });

  it("无法解析时报错，不把原始内容返回", () => {
    expect(() => parseRpcResponse("<html>oops</html>", "text/html")).toThrow(McpTestError);
  });
});

describe("MCP 连接测试流程", () => {
  it("返回服务名和工具列表，并沿用 session id", async () => {
    const { fetchImpl, calls } = fakeMcp();
    const r = await testMcpServer(URL_WITH_KEY, { fetch: fetchImpl, lookup: PUBLIC_LOOKUP });
    expect(r.serverName).toBe("钉钉文档");
    expect(r.tools).toEqual([
      { name: "create_doc", description: "创建文档" },
      { name: "read_doc", description: "读取文档" },
    ]);
    expect(calls.map((c) => c.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/list"]);
    expect(calls.slice(1).every((c) => c.session === "sess-1")).toBe(true);
  });

  it("支持 SSE 响应", async () => {
    const { fetchImpl } = fakeMcp({ sse: true });
    const r = await testMcpServer(URL_WITH_KEY, { fetch: fetchImpl, lookup: PUBLIC_LOOKUP });
    expect(r.tools.map((t) => t.name)).toEqual(["create_doc", "read_doc"]);
  });

  it("鉴权失败时给出明确提示，且错误信息不包含 key", async () => {
    const { fetchImpl } = fakeMcp({ status: 401 });
    const err = await testMcpServer(URL_WITH_KEY, { fetch: fetchImpl, lookup: PUBLIC_LOOKUP }).catch((e) => e);
    expect(err).toBeInstanceOf(McpTestError);
    expect(err.message).toContain("鉴权失败");
    expect(JSON.stringify(err)).not.toContain(SECRET_KEY);
  });

  it("工具列表出错时报错", async () => {
    const { fetchImpl } = fakeMcp({ listError: true });
    await expect(testMcpServer(URL_WITH_KEY, { fetch: fetchImpl, lookup: PUBLIC_LOOKUP })).rejects.toThrow("获取工具列表失败");
  });

  it("服务返回跳转时不跟随，直接报错", async () => {
    const redirect = (async () => new Response("", { status: 302, headers: { location: "http://10.0.0.1/" } })) as typeof fetch;
    await expect(testMcpServer(URL_WITH_KEY, { fetch: redirect, lookup: PUBLIC_LOOKUP })).rejects.toThrow("跳转");
  });

  it("地址是内网时根本不发起请求", async () => {
    const { fetchImpl, calls } = fakeMcp();
    await expect(testMcpServer("https://10.0.0.5/mcp", { fetch: fetchImpl, lookup: PUBLIC_LOOKUP })).rejects.toThrow("内网");
    expect(calls).toHaveLength(0);
  });

  it("网络错误的提示中不包含地址", async () => {
    const broken = (async () => {
      throw new TypeError(`fetch failed for ${URL_WITH_KEY}`);
    }) as typeof fetch;
    const err = await testMcpServer(URL_WITH_KEY, { fetch: broken, lookup: PUBLIC_LOOKUP }).catch((e) => e);
    expect(err.message).toBe("无法连接到该服务");
    expect(JSON.stringify(err)).not.toContain(SECRET_KEY);
  });
});

describe("RPC 错误转换", () => {
  it("服务端报 Token 验证失败时给出鉴权提示，不重复前缀", async () => {
    const fetchImpl = (async (_i: any, init: any) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "x" } } }, { headers: { "mcp-session-id": "s" } });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "获取工具列表失败: [UNAUTHORIZED] Token验证失败" } });
    }) as typeof fetch;
    const err = await testMcpServer(URL_WITH_KEY, { fetch: fetchImpl, lookup: PUBLIC_LOOKUP }).catch((e) => e);
    expect(err.message).toBe("鉴权失败：请检查地址中的 key 是否正确");
  });
});
