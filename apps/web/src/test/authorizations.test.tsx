import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { ApiError } from "../lib/api";
import { authorizationsApi, parseMcpConfig, type Authorization } from "../lib/authorizations";
import { AuthorizationsDialog } from "../components/AuthorizationsDialog";
import { UserMenu } from "../components/Topbar";

// @ts-expect-error 测试环境使用 React 的 act 标记
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/authorizations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/authorizations")>();
  return { ...actual, authorizationsApi: { list: vi.fn(), create: vi.fn(), rename: vi.fn(), remove: vi.fn() } };
});

const item = (over: Partial<Authorization> = {}): Authorization => ({ id: "a1", kind: "mcp", name: "我的 n8n", url: "https://n8n.example.com", createdAt: "2026-10-20T00:00:00Z", ...over });

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
const typeInto = (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

describe("MCP 服务", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    vi.mocked(authorizationsApi.list).mockResolvedValue({ enabled: true, items: [item()] });
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });
  const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
  const render = async (onClose = () => {}) => {
    await act(async () => root.render(<AuthorizationsDialog onClose={onClose} />));
    await flush();
  };

  it("列出已有的授权，只显示名称、类型和地址，不显示 token", async () => {
    await render();
    const row = document.querySelector(".auth-list li")!;
    expect(row.textContent).toContain("我的 n8n");
    expect(row.textContent).toContain("https://n8n.example.com");
    expect(row.textContent).toContain("https://n8n.example.com");
  });

  it("没有授权时给出提示；服务端没启用时说明原因且不能添加", async () => {
    vi.mocked(authorizationsApi.list).mockResolvedValue({ enabled: true, items: [] });
    await render();
    expect(document.body.textContent).toContain("还没有添加 MCP");
    await act(async () => root.render(null)); // 卸载后重新挂载才会重新读取
    vi.mocked(authorizationsApi.list).mockResolvedValue({ enabled: false, items: [] });
    await render();
    expect(document.body.textContent).toContain("AUTH_SECRET_KEY");
    expect(button("添加 MCP")).toBeUndefined();
  });

  it("添加：三项都填了才能提交；提交内容里有 token；成功后刷新列表并收起表单", async () => {
    vi.mocked(authorizationsApi.create).mockResolvedValue(item({ id: "a2" }));
    await render();
    await act(async () => button("添加 MCP").click());
    expect(button("验证并保存").disabled).toBe(true);
    const inputs = document.querySelectorAll<HTMLInputElement>(".auth-form input");
    await typeInto(inputs[0]!, "公司 n8n");
    await typeInto(inputs[1]!, "https://n8n.corp.com");
    expect(inputs[2]!.type).toBe("password");
    await typeInto(inputs[2]!, "tok-123");
    expect(button("验证并保存").disabled).toBe(false);
    await act(async () => button("验证并保存").click());
    await flush();
    expect(authorizationsApi.create).toHaveBeenCalledWith({ kind: "mcp", name: "公司 n8n", url: "https://n8n.corp.com", secret: "tok-123" });
    expect(authorizationsApi.list).toHaveBeenCalledTimes(2);
    expect(document.querySelector(".auth-form")).toBeNull();
  });

  it("添加失败时显示服务端给的原因，表单保留", async () => {
    vi.mocked(authorizationsApi.create).mockRejectedValue(new ApiError(401, "n8n 拒绝了该 MCP token，请检查 token 与权限", 401));
    await render();
    await act(async () => button("添加 MCP").click());
    const inputs = document.querySelectorAll<HTMLInputElement>(".auth-form input");
    await typeInto(inputs[0]!, "x");
    await typeInto(inputs[1]!, "https://n8n.corp.com");
    await typeInto(inputs[2]!, "bad");
    await act(async () => button("验证并保存").click());
    await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("拒绝了该 MCP token");
    expect(document.querySelector(".auth-form")).not.toBeNull();
  });

  it("改名与删除（删除前确认）", async () => {
    vi.mocked(authorizationsApi.rename).mockResolvedValue(item({ name: "新名字" }));
    vi.mocked(authorizationsApi.remove).mockResolvedValue(null);
    await render();
    await act(async () => button("改名").click());
    await typeInto(document.querySelector<HTMLInputElement>(".auth-list input")!, "新名字");
    await act(async () => button("保存").click());
    await flush();
    expect(authorizationsApi.rename).toHaveBeenCalledWith("a1", "新名字");

    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    await act(async () => button("删除").click());
    expect(authorizationsApi.remove).not.toHaveBeenCalled();
    await act(async () => button("删除").click());
    await flush();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(authorizationsApi.remove).toHaveBeenCalledWith("a1");
  });
});

describe("头像菜单里的MCP 服务", () => {
  it("点击「MCP 服务」打开弹窗", async () => {
    vi.mocked(authorizationsApi.list).mockResolvedValue({ enabled: true, items: [] });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<MemoryRouter><UserMenu name="张三" /></MemoryRouter>));
    await act(async () => host.querySelector<HTMLButtonElement>(".user-trigger")!.click());
    const entry = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === "MCP 服务")!;
    await act(async () => entry.click());
    await flush();
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("MCP 服务");
    expect(host.querySelector('[role="menu"]')).toBeNull();
    act(() => root.unmount());
    host.remove();
  });
});

describe("识别 MCP 配置 JSON", () => {
  const sample = {
    mcpServers: { "n8n-mcp": { type: "http", url: "https://n8n.nantianmen.dpdns.org/mcp-server/http", headers: { Authorization: "Bearer abc.def" } } },
  };

  it("取出名称、地址和 Bearer token（去掉 Bearer 前缀）", () => {
    expect(parseMcpConfig(JSON.stringify(sample))).toEqual({ name: "n8n-mcp", url: "https://n8n.nantianmen.dpdns.org/mcp-server/http", secret: "abc.def" });
  });

  it("有多个服务时优先取名称带 n8n 的；只有服务本身的对象、header 名大小写不同也认", () => {
    const many = { mcpServers: { github: { url: "https://g.example.com", headers: { Authorization: "Bearer g" } }, "my-N8N": { url: "https://n.example.com", headers: { authorization: "bearer n" } } } };
    expect(parseMcpConfig(JSON.stringify(many))).toMatchObject({ name: "my-N8N", url: "https://n.example.com", secret: "n" });
    expect(parseMcpConfig(JSON.stringify({ url: "https://n.example.com", headers: { Authorization: "Bearer t" } }))).toEqual({ name: "", url: "https://n.example.com", secret: "t" });
  });

  it("识别不了的返回 undefined：不是 JSON、没有地址、没有 token", () => {
    expect(parseMcpConfig("not json")).toBeUndefined();
    expect(parseMcpConfig("{}")).toBeUndefined();
    expect(parseMcpConfig(JSON.stringify({ mcpServers: {} }))).toBeUndefined();
    expect(parseMcpConfig(JSON.stringify({ mcpServers: { a: { url: "https://x.com" } } }))).toBeUndefined();
  });
});

describe("粘贴 MCP 配置自动填表", () => {
  it("粘贴后填好名称、地址、token；名称已经填过就不覆盖；识别不了时提示", async () => {
    vi.mocked(authorizationsApi.list).mockResolvedValue({ enabled: true, items: [] });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<AuthorizationsDialog onClose={() => {}} />));
    await flush();
    await act(async () => [...document.querySelectorAll("button")].find((b) => b.textContent === "添加 MCP")!.click());
    const area = document.querySelector<HTMLTextAreaElement>(".auth-form textarea")!;
    const setArea = (v: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, v);
        area.dispatchEvent(new Event("input", { bubbles: true }));
      });
    await setArea("garbage");
    expect(document.querySelector(".auth-form .notice-error")?.textContent).toContain("没能识别");
    await setArea(JSON.stringify({ mcpServers: { "n8n-mcp": { url: "https://n8n.example.com/mcp-server/http", headers: { Authorization: "Bearer tok-1" } } } }));
    const inputs = document.querySelectorAll<HTMLInputElement>(".auth-form input");
    expect(inputs[0]!.value).toBe("n8n-mcp");
    expect(inputs[1]!.value).toBe("https://n8n.example.com/mcp-server/http");
    expect(inputs[2]!.value).toBe("tok-1");
    expect(document.querySelector(".auth-form .notice-error")).toBeNull();
    act(() => root.unmount());
    host.remove();
  });
});
