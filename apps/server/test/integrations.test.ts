import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestApp } from "./helpers.js";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("集成连接测试接口", () => {
  let env: Awaited<ReturnType<typeof setupTestApp>>;
  let cookie: string;

  beforeAll(async () => {
    env = await setupTestApp(url!);
    cookie = await env.login("zhangsan");
  });

  afterAll(async () => {
    if (env) await env.sql.end();
  });

  it("未登录不能使用", async () => {
    const res = await env.api(undefined, "/api/integrations/mcp-test", { method: "POST", body: JSON.stringify({ url: "https://mcp.example.com/x" }) });
    expect((await res.json()).code).toBe(40001);
  });

  it("缺少地址返回 400", async () => {
    const res = await env.api(cookie, "/api/integrations/mcp-test", { method: "POST", body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });

  it("内网地址被拒绝，且不发起网络请求", async () => {
    const res = await env.api(cookie, "/api/integrations/mcp-test", { method: "POST", body: JSON.stringify({ url: "https://169.254.169.254/latest/meta-data" }) });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.message).toContain("内网");
  });

  it("http 地址被拒绝", async () => {
    const res = await env.api(cookie, "/api/integrations/mcp-test", { method: "POST", body: JSON.stringify({ url: "http://mcp.example.com/x?key=abc" }) });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain("key=abc");
  });
});
