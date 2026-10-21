import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { WorkflowIR } from "@aif/workflow-ir";
import { PromptExportPreview } from "../components/PromptExportPreview";

// @ts-expect-error 测试环境使用 React 的 act 标记
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const post = vi.fn();
// lib/exporters 会加载 Excalidraw（测试环境里无法解析），这里用真实的导出插件搭一个等价的替身
vi.mock("../lib/exporters", async () => {
  const plugin = await import("@aif/plugin-exporter-prompt");
  const { lower } = await import("@aif/workflow-ir");
  return {
    promptGaps: plugin.promptGaps,
    applyPromptAnswers: plugin.applyPromptAnswers,
    promptPrep: plugin.promptPrep,
    exportPrompt: async (ir: WorkflowIR) => ({
      files: await plugin.promptExporter.compile(lower(ir), plugin.promptExporter.defaultOptions),
      filename: `${ir.slug}.prompt.zip`,
      warnings: [],
    }),
    download: () => {},
    zipFiles: async () => new Blob(),
  };
});
vi.mock("../lib/api", () => ({ api: { post: (...a: unknown[]) => post(...a) } }));

const IR: WorkflowIR = {
  version: 2,
  kind: "automation",
  slug: "demo",
  name: "演示",
  description: "生成周报。当用户需要周报时使用。",
  trigger: { type: "manual", detail: "用户发起" },
  inputs: [],
  nodes: [
    { id: "s", type: "start", title: "开始" },
    { id: "n1", type: "step", title: "生成周报", executor: "llm", instructions: "按模板汇总", action: { kind: "llm", prompt: "按模板生成周报" } },
    { id: "e", type: "end", title: "结束" },
  ],
  edges: [
    { from: "s", to: "n1" },
    { from: "n1", to: "e" },
  ],
  source: { painPointIds: [] },
};

describe("PromptExportPreview：导出前补缺口", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    post.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
  });

  const render = async (onSaved = vi.fn()) => {
    await act(async () => root.render(<PromptExportPreview ir={IR} workflowId="wf1" onSaved={onSaved} onClose={() => {}} />));
    return onSaved;
  };
  const type = async (el: HTMLTextAreaElement, value: string) => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const code = () => (document.querySelector(".ep-code") ?? document.querySelector(".ep-doc"))?.textContent ?? "";
  const saveBtn = () => [...document.querySelectorAll<HTMLButtonElement>(".ep-gap-actions .btn")][0];

  it("复制是主按钮，没有文件树和文件名，下载是次要的文本文件", async () => {
    await render();
    expect(document.querySelector(".ep-tree")).toBeNull();
    expect(document.querySelector(".ep-path")).toBeNull();
    const foot = [...document.querySelectorAll<HTMLButtonElement>(".ep-foot .btn")];
    expect(foot.map((b) => [b.textContent, b.classList.contains("btn-ink")])).toEqual([
      ["下载为文本文件", false],
      ["复制", true],
    ]);
    expect(document.querySelector(".ep-notes")?.textContent).toContain("怎么用");
  });

  it("默认排成易读的文档，可切换查看原文；原文里仍是 Markdown", async () => {
    await render();
    expect(document.querySelector(".ep-doc")).not.toBeNull();
    expect(document.querySelector(".ep-code")).toBeNull();
    expect(document.querySelector(".ep-doc h3")?.textContent).toBe("任务：演示");
    expect(document.querySelector(".ep-doc")?.textContent).not.toContain("## ");
    expect(document.querySelectorAll(".ep-doc .pd-step").length).toBeGreaterThan(0);
    const toggle = document.querySelector<HTMLButtonElement>(".ep-bar .btn")!;
    expect(toggle.textContent).toBe("查看原文");
    await act(async () => toggle.click());
    expect(document.querySelector(".ep-code")?.textContent).toContain("## 执行步骤");
    expect(document.querySelector(".ep-doc")).toBeNull();
  });

  it("使用说明按用户用的 AI 显示，默认 ChatGPT", async () => {
    await render();
    const notes = document.querySelector(".ep-notes")?.textContent ?? "";
    expect(notes).toContain("打开 ChatGPT 新建一个对话");
    expect(notes).toContain("Projects");
    expect(document.querySelector(".ep-variants .ui-select")?.textContent).toContain("ChatGPT");
  });

  it("浏览器支持系统分享时显示「发送到其他设备」，分享的是当前选中的提示词", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    try {
      await render();
      const btn = [...document.querySelectorAll<HTMLButtonElement>(".ep-foot .btn")].find((b) => b.textContent === "发送到其他设备")!;
      expect(btn).toBeTruthy();
      await act(async () => btn.click());
      expect(share).toHaveBeenCalledTimes(1);
      expect(share.mock.calls[0]![0].text).toContain("# 任务：演示");
    } finally {
      delete (navigator as unknown as Record<string, unknown>).share;
    }
  });

  it("没有要准备的东西时不显示准备清单", async () => {
    await render();
    expect(document.querySelector(".ep-prep")).toBeNull();
  });

  it("按使用方式切换完整版和精简版", async () => {
    await render();
    expect(code()).toContain("每次回复开头用一行标明当前进度");
    const [, short] = [...document.querySelectorAll<HTMLButtonElement>(".ep-variants .seg button")];
    await act(async () => short!.click());
    expect(code()).toContain("收到后直接开始，不要复述这份指令");
    expect(code()).not.toContain("每次回复开头用一行标明当前进度");
  });

  it("有缺口时显示表单，填写后提示词实时更新", async () => {
    await render();
    expect(document.querySelectorAll(".ep-gap")).toHaveLength(1);
    expect(code()).toContain("用什么模板或输出格式");
    await type(document.querySelector<HTMLTextAreaElement>(".ep-gap textarea")!, "三段式：销售额、环比、Top 客户");
    expect(code()).toContain("必须按用户确认的模板或格式输出：三段式：销售额、环比、Top 客户");
    expect(code()).not.toContain("用什么模板或输出格式");
  });

  it("没填内容时不能保存；保存会提交补充后的工作流并通知新版本", async () => {
    post.mockResolvedValue({ version: 3 });
    const onSaved = await render();
    expect(saveBtn()!.disabled).toBe(true);
    await type(document.querySelector<HTMLTextAreaElement>(".ep-gap textarea")!, "三段式");
    expect(saveBtn()!.disabled).toBe(false);
    await act(async () => saveBtn()!.click());
    expect(post).toHaveBeenCalledTimes(1);
    const [path, body] = post.mock.calls[0] as [string, { ir: WorkflowIR }];
    expect(path).toBe("/workflows/wf1/versions");
    expect(JSON.stringify(body.ir)).toContain("三段式");
    expect(onSaved).toHaveBeenCalledWith(3);
    expect(document.querySelector(".ep-gaps")?.textContent).toContain("已保存为 v3");
    expect(document.querySelectorAll(".ep-gap")).toHaveLength(0);
  });

  it("保存失败时显示原因，表单内容保留", async () => {
    post.mockRejectedValue(new Error("工作流校验未通过"));
    await render();
    await type(document.querySelector<HTMLTextAreaElement>(".ep-gap textarea")!, "三段式");
    await act(async () => saveBtn()!.click());
    expect(document.querySelector(".ep-gaps .notice-error")?.textContent).toContain("工作流校验未通过");
    expect(document.querySelector<HTMLTextAreaElement>(".ep-gap textarea")!.value).toBe("三段式");
  });
});

describe("PromptExportPreview：复制前的准备清单", () => {
  it("有需要用户操作的步骤时，列出要准备的材料", async () => {
    const ir: WorkflowIR = {
      ...IR,
      inputs: [{ name: "week", type: "string", description: "周次", required: true }],
      nodes: [
        { id: "s", type: "start", title: "开始" },
        { id: "n0", type: "step", title: "拉取订单", executor: "deterministic", instructions: "调用 ERP", chatInstructions: "在 ERP 的订单查询里导出本周订单", action: { kind: "http", method: "GET", url: "https://erp.example.com/api/orders" }, outputs: [{ name: "orders", type: "array", description: "订单列表" }] },
        { id: "e", type: "end", title: "结束" },
      ],
      edges: [
        { from: "s", to: "n0" },
        { from: "n0", to: "e" },
      ],
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<PromptExportPreview ir={ir} onClose={() => {}} />));
    const items = [...document.querySelectorAll(".ep-prep li")].map((li) => li.textContent);
    expect(items).toEqual(["周次", "「拉取订单」：在 ERP 的订单查询里导出本周订单，准备好订单列表"]);
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
  });
});
