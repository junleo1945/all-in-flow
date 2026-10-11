import { describe, expect, it } from "vitest";
import { INTEGRATION_CATALOG, findIntegration, findOperation, findTarget } from "../src/index.js";

describe("集成目录", () => {
  it("id 唯一，且每个 MCP 集成都有 serverName 与 urlEnv", () => {
    const ids = INTEGRATION_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of INTEGRATION_CATALOG.filter((x) => x.access === "mcp")) {
      expect(e.mcp?.serverName).toBeTruthy();
      expect(e.mcp?.urlField).toBeTruthy();
    }
  });

  it("不包含任何真实地址或密钥：URL 与密钥只以环境变量名的形式出现", () => {
    const text = JSON.stringify(INTEGRATION_CATALOG);
    expect(text).not.toMatch(/https?:\/\/[^"\s]*key=/i);
    expect(text).not.toMatch(/mcp-gw\.dingtalk\.com/);
    for (const e of INTEGRATION_CATALOG) {
      for (const v of e.fields) expect(v.name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it("钉钉文档：流式 HTTP 传输，地址字段为 DINGTALK_DOC_MCP_URL，且标记为凭证", () => {
    const d = findIntegration("dingtalk-doc")!;
    expect(d.mcp).toMatchObject({ serverName: "钉钉文档", transport: "streamable-http", urlField: "DINGTALK_DOC_MCP_URL" });
    expect(d.fields.find((x) => x.name === "DINGTALK_DOC_MCP_URL")?.secret).toBe(true);
  });

  it("未知 id 返回 undefined", () => {
    expect(findIntegration("nope")).toBeUndefined();
  });

  it("操作 id 在同一集成内唯一，参数名符合引用规则（不含空白、花括号和点）", () => {
    for (const e of INTEGRATION_CATALOG) {
      const ids = e.operations.map((o) => o.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const o of e.operations) {
        for (const p of o.params) expect(p.name).toMatch(/^[^\s{}.]+$/);
      }
    }
  });

  it("ERP 的 listOrders 必填 start 和 end，并返回 orders 数组", () => {
    const op = findOperation("erp", "listOrders")!;
    expect(op.params.filter((p) => p.required).map((p) => p.name)).toEqual(["start", "end"]);
    expect(op.output).toEqual([expect.objectContaining({ name: "orders", type: "array" })]);
  });

  it("findOperation：未知集成或操作返回 undefined", () => {
    expect(findOperation("erp", "nope")).toBeUndefined();
    expect(findOperation("nope", "listOrders")).toBeUndefined();
  });
});

describe("平台写法 targets（export-v2.md 5.2）", () => {
  it("目前没有登记任何平台写法：查询返回 undefined，插件应退回通用 HTTP 节点", () => {
    for (const e of INTEGRATION_CATALOG) expect(e.targets).toBeUndefined();
    expect(findTarget("erp", "n8n")).toBeUndefined();
    expect(findTarget("nope", "dify")).toBeUndefined();
  });

  it("findTarget 返回已登记的写法", () => {
    const erp = findIntegration("erp")!;
    erp.targets = { dify: { http: true } };
    try {
      expect(findTarget("erp", "dify")).toEqual({ http: true });
      expect(findTarget("erp", "n8n")).toBeUndefined();
    } finally {
      delete erp.targets;
    }
  });
});
