/**
 * 演示冒烟脚本：只通过 HTTP 访问一个正在运行的服务端，把演示工作流（test/demos.ts）全部导入当前账号，
 * 并打印每个工作流的流程图链接。用于演示前确认「登录 → 令牌 → MCP → 导入 → 分享链接」整条链路可用。
 *
 * 用法：
 *   BASE_URL=http://localhost:5173 DEMO_USERNAME=zhangsan DEMO_PASSWORD=secret pnpm --filter @aif/server exec tsx scripts/demo-smoke.ts
 *
 * 注意：会在该账号名下新建 4 个工作流，并生成一个 1 天有效的访问令牌（跑完自动撤销）。
 * 账号密码只从环境变量读取，不会写入任何文件。
 */
import { DEMOS } from "../test/demos.js";

const base = (process.env.BASE_URL ?? "").replace(/\/+$/, "");
const username = process.env.DEMO_USERNAME;
const password = process.env.DEMO_PASSWORD;
if (!base || !username || !password) throw new Error("请设置 BASE_URL、DEMO_USERNAME、DEMO_PASSWORD");

const check = (ok: boolean, what: string, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
  return ok;
};

// 1. 登录
const login = await fetch(`${base}/api/user/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ UserName: username, Password: password }),
});
const cookie = login.headers.get("set-cookie")?.split(";")[0];
if (!check(login.ok && !!cookie, "登录", `HTTP ${login.status}`)) process.exit(1);
const api = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { "Content-Type": "application/json", Cookie: cookie!, ...(init.headers as Record<string, string>) } });

// 2. 访问令牌
const made = await (await api("/api/access-tokens", { method: "POST", body: JSON.stringify({ name: "演示冒烟", expiresInDays: 1 }) })).json();
const token: string | undefined = made?.data?.token;
if (!check(!!token, "生成访问令牌")) process.exit(1);

let id = 0;
const rpc = async (method: string, params?: unknown) => {
  const res = await fetch(`${base}/api/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  return { status: res.status, body: (await res.json()) as any };
};

try {
  // 3. MCP 握手
  const init = await rpc("initialize", { protocolVersion: "2025-06-18" });
  check(init.body?.result?.serverInfo?.name === "all-in-flow", "MCP 握手");
  const tools = await rpc("tools/list");
  check(tools.body?.result?.tools?.length === 2, "MCP 工具列表", tools.body?.result?.tools?.map((t: any) => t.name).join(","));

  // 4. 逐个导入，并用返回的链接读回流程图
  for (const d of DEMOS) {
    const r = await rpc("tools/call", { name: "import_workflow", arguments: { ir: d.ir } });
    const result = r.body?.result;
    if (!check(!result?.isError && !!result?.structuredContent?.shareUrl, `导入「${d.key}」`, result?.isError ? result.content?.[0]?.text : "")) continue;
    const shareToken = String(result.structuredContent.shareUrl).split("/s/")[1];
    const view = await api(`/api/s/${shareToken}`);
    const body: any = await view.json();
    check(view.ok && body?.data?.ir?.nodes?.length === d.ir.nodes.length, `  读回「${d.key}」`, `${base}/s/${shareToken}`);
  }
} finally {
  // 5. 撤销令牌
  if (made?.data?.id) {
    const del = await api(`/api/access-tokens/${made.data.id}`, { method: "DELETE" });
    check(del.ok, "撤销令牌");
  }
}
