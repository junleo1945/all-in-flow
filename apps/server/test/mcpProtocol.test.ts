import { describe, expect, it } from "vitest";
import { handleMessage, textResult, type ToolDef } from "../src/mcp/protocol.js";

const echo: ToolDef<{ who: string }> = {
  name: "echo",
  title: "Echo",
  description: "echo",
  inputSchema: { type: "object", properties: {} },
  async call(args, ctx) {
    return textResult(`${ctx.who}:${JSON.stringify(args)}`);
  },
};
const boom: ToolDef<{ who: string }> = { ...echo, name: "boom", async call() { throw new Error("secret stack detail"); } };
const opts = { info: { name: "t", version: "1", instructions: "hi" }, tools: [echo, boom], ctx: { who: "u" } };
const rpc = (method: string, params?: unknown, id: number | undefined = 1) => ({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params });

describe("MCP 协议层", () => {
  it("initialize：协商协议版本，不认识的版本回退到最新版本，并带上使用说明", async () => {
    const ok = (await handleMessage(rpc("initialize", { protocolVersion: "2025-03-26" }), opts)) as any;
    expect(ok.result.protocolVersion).toBe("2025-03-26");
    expect(ok.result.capabilities.tools).toBeDefined();
    expect(ok.result.serverInfo.name).toBe("t");
    expect(ok.result.instructions).toBe("hi");
    const unknown = (await handleMessage(rpc("initialize", { protocolVersion: "1999-01-01" }), opts)) as any;
    expect(unknown.result.protocolVersion).toBe("2025-06-18");
  });

  it("通知没有返回值，请求的 id 原样带回", async () => {
    expect(await handleMessage(rpc("notifications/initialized", undefined, undefined), opts)).toBeNull();
    expect(await handleMessage({ jsonrpc: "2.0", id: 7, result: {} }, opts)).toBeNull(); // 客户端发来的响应被忽略
    const pong = (await handleMessage(rpc("ping", undefined, 42), opts)) as any;
    expect(pong).toEqual({ jsonrpc: "2.0", id: 42, result: {} });
  });

  it("tools/list 列出工具；未知方法和未知工具报错", async () => {
    const list = (await handleMessage(rpc("tools/list"), opts)) as any;
    expect(list.result.tools.map((t: any) => t.name)).toEqual(["echo", "boom"]);
    expect(list.result.tools[0].inputSchema.type).toBe("object");
    expect(((await handleMessage(rpc("resources/list"), opts)) as any).error.code).toBe(-32601);
    expect(((await handleMessage(rpc("tools/call", { name: "nope" }), opts)) as any).error.code).toBe(-32602);
    expect(((await handleMessage({ foo: 1 }, opts)) as any).error.code).toBe(-32600);
  });

  it("tools/call：把参数和上下文交给工具；工具抛错时只告诉模型内部错误，不泄漏细节", async () => {
    const res = (await handleMessage(rpc("tools/call", { name: "echo", arguments: { a: 1 } }), opts)) as any;
    expect(res.result.content[0].text).toBe('u:{"a":1}');
    const bad = (await handleMessage(rpc("tools/call", { name: "boom" }), opts)) as any;
    expect(bad.result.isError).toBe(true);
    expect(JSON.stringify(bad)).not.toContain("secret stack detail");
  });
});
