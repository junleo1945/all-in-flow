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
  const code = () => document.querySelector(".ep-code")?.textContent ?? "";
  const saveBtn = () => [...document.querySelectorAll<HTMLButtonElement>(".ep-gap-actions .btn")][0];

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
