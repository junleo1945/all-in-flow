import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import JSZip from "jszip";
import { ApiError } from "../lib/api";
import { accessTokensApi, buildSkillZip, connectSnippet, localSkillApi, mcpUrl, saveBlob, type AccessToken, type SkillPackage } from "../lib/localSkill";
import LocalSkillPage from "../pages/LocalSkill";

// @ts-expect-error 测试环境使用 React 的 act 标记
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/useMe", () => ({ useMe: () => ({ me: undefined }), formatTokens: (n: number) => String(n) }));
vi.mock("../lib/clipboard", () => ({ copyText: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/localSkill", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/localSkill")>();
  return {
    ...actual,
    saveBlob: vi.fn(),
    localSkillApi: { get: vi.fn() },
    accessTokensApi: { list: vi.fn(), create: vi.fn(), remove: vi.fn() },
  };
});

// 假的令牌值在运行时拼出来：它们只是测试数据，不写成字面量，免得被密钥扫描误判
const SNIPPET_TOKEN = ["aif", "snippet", "value"].join("_");
const SHOWN_ONCE = ["aif", "shown", "once"].join("_");

const pkg: SkillPackage = {
  name: "all-in-flow",
  version: "abc123def456",
  files: [
    { path: "SKILL.md", content: "---\nname: all-in-flow\n---\n# 访谈" },
    { path: "references/ir-spec.md", content: "# IR" },
  ],
};
const token = (over: Partial<AccessToken> = {}): AccessToken => ({
  id: "t1",
  name: "我的 Claude Code",
  prefix: "aif_AbCd",
  expiresAt: "2027-01-20T00:00:00Z",
  lastUsedAt: null,
  createdAt: "2026-10-21T00:00:00Z",
  ...over,
});

describe("连接配置", () => {
  const url = mcpUrl("https://aif.example.com/");

  it("MCP 地址：去掉末尾斜杠，接上 /api/mcp", () => {
    expect(url).toBe("https://aif.example.com/api/mcp");
  });

  it("Claude Code：一条命令，带地址和令牌", () => {
    const [b] = connectSnippet("claude-code", { url, token: SNIPPET_TOKEN });
    expect(b!.text).toBe(`claude mcp add --transport http all-in-flow https://aif.example.com/api/mcp --header "Authorization: Bearer ${SNIPPET_TOKEN}"`);
  });

  it("Codex：令牌放环境变量，配置文件里只有地址和变量名", () => {
    const blocks = connectSnippet("codex", { url, token: SNIPPET_TOKEN });
    expect(blocks.map((b) => b.id)).toEqual(["env", "toml"]);
    expect(blocks[0]!.text).toBe(`export AIF_TOKEN="${SNIPPET_TOKEN}"`);
    expect(blocks[1]!.text).toContain('bearer_token_env_var = "AIF_TOKEN"');
    expect(blocks[1]!.text).not.toContain(SNIPPET_TOKEN);
  });

  it("通用 JSON 可以被解析，没有令牌时用占位符", () => {
    const [b] = connectSnippet("json", { url });
    const parsed = JSON.parse(b!.text);
    expect(parsed.mcpServers["all-in-flow"]).toEqual({ type: "http", url, headers: { Authorization: "Bearer <YOUR_TOKEN>" } });
  });
});

describe("下载包", () => {
  it("zip 里是一个以 Skill 名命名的文件夹", async () => {
    const zip = await JSZip.loadAsync(await buildSkillZip(pkg));
    expect(Object.keys(zip.files).filter((n) => !zip.files[n]!.dir).sort()).toEqual(["all-in-flow/SKILL.md", "all-in-flow/references/ir-spec.md"]);
    expect(await zip.file("all-in-flow/SKILL.md")!.async("string")).toBe(pkg.files[0]!.content);
  });
});

describe("本地 Skill 页", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    vi.mocked(localSkillApi.get).mockResolvedValue(pkg);
    vi.mocked(accessTokensApi.list).mockResolvedValue({ max: 5, items: [token()] });
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
  const render = async () => {
    await act(async () => root.render(<MemoryRouter><LocalSkillPage /></MemoryRouter>));
    await flush();
  };
  const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
  const typeInto = (el: HTMLInputElement, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });

  it("显示版本、安装位置和已有令牌，不显示令牌明文", async () => {
    await render();
    expect(host.textContent).toContain("版本 abc123def456");
    expect(host.textContent).toContain("~/.claude/skills/");
    const row = document.querySelector(".auth-list li")!;
    expect(row.textContent).toContain("我的 Claude Code");
    expect(row.textContent).toContain("aif_AbCd…");
    expect(row.textContent).toContain("还没用过");
  });

  it("点击下载：把清单打成 all-in-flow.zip 交给浏览器保存", async () => {
    await render();
    await act(async () => button("下载 Skill（.zip）").click());
    // 打包是异步的（动态加载 jszip 再生成），等它交给浏览器保存
    for (let i = 0; i < 50 && vi.mocked(saveBlob).mock.calls.length === 0; i++) await flush();
    expect(saveBlob).toHaveBeenCalledTimes(1);
    const [blob, filename] = vi.mocked(saveBlob).mock.calls[0]!;
    expect(filename).toBe("all-in-flow.zip");
    expect(blob.size).toBeGreaterThan(0);
  });

  it("生成令牌：明文只出现一次，连接命令里自动填好；关闭后明文消失", async () => {
    vi.mocked(accessTokensApi.create).mockResolvedValue({ ...token({ id: "t2", name: "新令牌" }), token: SHOWN_ONCE });
    await render();
    const input = host.querySelector<HTMLInputElement>('input[placeholder="例如：我的 Claude Code"]')!;
    expect(button("生成令牌").disabled).toBe(true);
    await typeInto(input, "  新令牌 ");
    await act(async () => button("生成令牌").click());
    await flush();

    expect(accessTokensApi.create).toHaveBeenCalledWith({ name: "新令牌", expiresInDays: 90 });
    expect(host.querySelector(".skill-created")!.textContent).toContain(SHOWN_ONCE);
    expect(host.textContent).toContain(`Bearer ${SHOWN_ONCE}`);

    await act(async () => button("我已保存，关闭").click());
    expect(host.textContent).not.toContain(SHOWN_ONCE);
    expect(host.textContent).toContain("<YOUR_TOKEN>");
  });

  it("切换到 Codex 显示两段配置", async () => {
    await render();
    await act(async () => button("Codex").click());
    expect(host.textContent).toContain('export AIF_TOKEN=');
    expect(host.textContent).toContain("[mcp_servers.all-in-flow]");
  });

  it("撤销令牌：确认后调用接口并刷新列表", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(accessTokensApi.remove).mockResolvedValue(null);
    await render();
    vi.mocked(accessTokensApi.list).mockResolvedValue({ max: 5, items: [] });
    await act(async () => button("撤销").click());
    await flush();
    expect(accessTokensApi.remove).toHaveBeenCalledWith("t1");
    expect(host.textContent).toContain("还没有令牌");
  });

  it("取消确认就不撤销", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await render();
    await act(async () => button("撤销").click());
    expect(accessTokensApi.remove).not.toHaveBeenCalled();
  });

  it("令牌数量到上限时不能再生成；接口报错时显示原因", async () => {
    vi.mocked(accessTokensApi.list).mockResolvedValue({ max: 1, items: [token()] });
    await render();
    await typeInto(host.querySelector<HTMLInputElement>('input[placeholder="例如：我的 Claude Code"]')!, "另一个");
    expect(button("生成令牌").disabled).toBe(true);

    vi.mocked(accessTokensApi.list).mockResolvedValue({ max: 5, items: [token()] });
    vi.mocked(accessTokensApi.create).mockRejectedValue(new ApiError(400, "最多同时保留 5 个有效令牌，请先撤销不用的", 400));
    await act(async () => root.unmount());
    root = createRoot(host);
    await render();
    await typeInto(host.querySelector<HTMLInputElement>('input[placeholder="例如：我的 Claude Code"]')!, "x");
    await act(async () => button("生成令牌").click());
    await flush();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("最多同时保留 5 个有效令牌");
  });
});
