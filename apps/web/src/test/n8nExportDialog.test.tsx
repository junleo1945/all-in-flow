import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { authorizationsApi } from "../lib/authorizations";
import * as n8nExport from "../lib/n8nExport";
import { parseSseChunk } from "../lib/sse";
import { N8nExportDialog } from "../components/N8nExportDialog";

// @ts-expect-error 测试环境使用 React 的 act 标记
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/authorizations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/authorizations")>();
  return { ...actual, authorizationsApi: { list: vi.fn(), create: vi.fn(), rename: vi.fn(), remove: vi.fn() } };
});
// lib/exporters 会加载 Excalidraw（测试环境无法解析），下载按钮用替身
const downloaded: string[] = [];
vi.mock("../lib/exporters", () => ({ download: (_b: Blob, name: string) => void downloaded.push(name) }));

const result: n8nExport.N8nExportResult = {
  version: 2,
  workflow: { name: "晨间邮件", nodes: [{ name: "收邮件" }], connections: {}, settings: { executionOrder: "v1" } },
  summary: "从读取新邮件开始，分析后发到钉钉群",
  excluded: [{ title: "到公司", reason: "人的行为" }],
  todo: ["为「发钉钉」选择 httpQueryAuth 凭证"],
  problems: [],
};

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("导出 n8n 工作流弹窗", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    downloaded.length = 0;
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });
  const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
  const render = async (props: Partial<Parameters<typeof N8nExportDialog>[0]> = {}) => {
    await act(async () =>
      root.render(<N8nExportDialog workflowId="wf-1" version={2} slug="morning" onOpenAuth={props.onOpenAuth ?? (() => {})} onClose={props.onClose ?? (() => {})} />),
    );
    await flush();
  };

  it("没有授权：提示先添加，按钮打开授权管理并关闭自己；不会发起导出", async () => {
    vi.mocked(authorizationsApi.list).mockResolvedValue({ enabled: true, items: [] });
    const spy = vi.spyOn(n8nExport, "exportToN8n");
    const onOpenAuth = vi.fn();
    const onClose = vi.fn();
    await render({ onOpenAuth, onClose });
    expect(document.body.textContent).toContain("需要先添加你的 n8n 的 MCP");
    await act(async () => button("去添加 MCP").click());
    expect(onOpenAuth).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled(); // 由调用方把本弹窗换成授权管理
    expect(spy).not.toHaveBeenCalled();
  });

  it("服务端没有启用授权时说明原因", async () => {
    vi.mocked(authorizationsApi.list).mockResolvedValue({ enabled: false, items: [] });
    await render();
    expect(document.body.textContent).toContain("AUTH_SECRET_KEY");
    expect(button("开始导出")).toBeUndefined();
  });

  it("只有一个授权时直接使用；点开始后显示进度，完成后显示切段说明、待办，并可以复制与下载", async () => {
    vi.mocked(authorizationsApi.list).mockResolvedValue({ enabled: true, items: [{ id: "a1", kind: "mcp", name: "我的 n8n", url: "https://n8n.example.com", createdAt: "" }] });
    let finish!: (r: n8nExport.N8nExportResult) => void;
    const stages: string[] = [];
    vi.spyOn(n8nExport, "exportToN8n").mockImplementation((_id, _body, onProgress) => {
      onProgress("analyze");
      onProgress("match");
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    await render();
    expect(document.body.textContent).toContain("将使用「我的 n8n」");
    await act(async () => button("开始导出").click());
    expect(n8nExport.exportToN8n).toHaveBeenCalledWith("wf-1", { authorizationId: "a1", version: 2 }, expect.any(Function), expect.anything());
    const steps = [...document.querySelectorAll(".n8n-export-steps li")];
    expect(steps.map((s) => s.className)).toEqual(["done", "now", ""]);
    stages.push(steps.map((s) => s.textContent).join("|"));
    expect(stages[0]).toBe("分析流程图|匹配 n8n 节点|校验");

    await act(async () => finish(result));
    await flush();
    expect(document.body.textContent).toContain("从读取新邮件开始");
    expect(document.body.textContent).toContain("到公司");
    expect(document.body.textContent).toContain("人的行为");
    expect(document.body.textContent).toContain("httpQueryAuth");
    expect(document.querySelector(".notice-error")).toBeNull();

    await act(async () => button("复制").click());
    await flush();
    expect(write).toHaveBeenCalledWith(JSON.stringify(result.workflow, null, 2));
    expect(button("已复制")).toBeDefined();
    await act(async () => button("下载 .json").click());
    expect(downloaded).toEqual(["morning.n8n.json"]);
  });

  it("有多个授权时可以选择；有没解决的问题时醒目提示", async () => {
    vi.mocked(authorizationsApi.list).mockResolvedValue({
      enabled: true,
      items: [
        { id: "a1", kind: "mcp", name: "A", url: "https://a.example.com", createdAt: "" },
        { id: "a2", kind: "mcp", name: "B", url: "https://b.example.com", createdAt: "" },
      ],
    });
    vi.spyOn(n8nExport, "exportToN8n").mockResolvedValue({ ...result, problems: ["「发钉钉」parameters.url：必填"] });
    await render();
    expect(document.querySelector("button.ui-select")).not.toBeNull();
    await act(async () => button("开始导出").click());
    await flush();
    expect(document.querySelector(".notice-error")?.textContent).toContain("parameters.url：必填");
  });

  it("导出失败时显示原因，可以重试", async () => {
    vi.mocked(authorizationsApi.list).mockResolvedValue({ enabled: true, items: [{ id: "a1", kind: "mcp", name: "A", url: "https://a.example.com", createdAt: "" }] });
    vi.spyOn(n8nExport, "exportToN8n").mockRejectedValueOnce(new Error("n8n 拒绝了该 MCP token")).mockResolvedValueOnce(result);
    await render();
    await act(async () => button("开始导出").click());
    await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("拒绝了该 MCP token");
    await act(async () => button("开始导出").click());
    await flush();
    expect(document.body.textContent).toContain("从读取新邮件开始");
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("导出 n8n 的 SSE 解析", () => {
  it("progress / result / error 事件按规范解析", () => {
    const text = 'event: progress\ndata: {"stage":"match"}\n\nevent: result\ndata: {"summary":"ok"}\n\n';
    expect(parseSseChunk(text).events).toEqual([
      { event: "progress", data: { stage: "match" } },
      { event: "result", data: { summary: "ok" } },
    ]);
  });
});

describe("导出进行中关闭弹窗", () => {
  it("需要确认；确认后关闭并取消导出，不确认则继续", async () => {
    vi.mocked(authorizationsApi.list).mockResolvedValue({ enabled: true, items: [{ id: "a1", kind: "mcp", name: "A", url: "https://a.example.com", createdAt: "" }] });
    let signal: AbortSignal | undefined;
    vi.spyOn(n8nExport, "exportToN8n").mockImplementation((_id, _body, _onProgress, s) => {
      signal = s;
      return new Promise(() => {}); // 一直不结束
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const onClose = vi.fn();
    await act(async () => root.render(<N8nExportDialog workflowId="wf-1" slug="x" onOpenAuth={() => {}} onClose={onClose} />));
    await flush();
    await act(async () => [...document.querySelectorAll("button")].find((b) => b.textContent === "开始导出")!.click());
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const x = () => document.querySelector<HTMLButtonElement>(".modal .x")!;
    // 点遮罩不会关闭
    await act(async () => document.querySelector<HTMLElement>(".modal-back")!.click());
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => x().click());
    expect(onClose).not.toHaveBeenCalled();
    expect(signal?.aborted).toBe(false);
    await act(async () => x().click());
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
    // 卸载（弹窗关闭）时取消导出
    await act(async () => root.unmount());
    expect(signal?.aborted).toBe(true);
    host.remove();
  });
});
