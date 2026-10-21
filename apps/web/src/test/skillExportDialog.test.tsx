import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { WorkflowIR } from "@aif/workflow-ir";
import { api, ApiError } from "../lib/api";
import * as skillExport from "../lib/skillExport";
import * as ex from "../lib/exporters";
import { SkillExportDialog } from "../components/SkillExportDialog";

// @ts-expect-error 测试环境使用 React 的 act 标记
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// lib/exporters 会加载 Excalidraw（测试环境无法解析），换成替身
vi.mock("../lib/exporters", () => ({
  promptGaps: vi.fn(() => []),
  applyPromptAnswers: vi.fn((ir: unknown, answers: Record<string, string>) => ({ ...(ir as object), patched: answers })),
  buildSkill: vi.fn(),
  issueText: (i: { message: string }) => i.message,
  zipFiles: vi.fn(async () => new Blob(["zip"])),
  download: vi.fn(),
}));

const ir = { slug: "weekly", name: "周报", nodes: [] } as unknown as WorkflowIR;
const result: skillExport.SkillExportResult = {
  version: 2,
  files: [
    { path: "weekly/SKILL.md", content: "# 周报" },
    { path: "weekly/evals/evals.json", content: "{}" },
  ],
  filename: "weekly.skill.zip",
  issues: [{ level: "warning", message: "description 缺少使用时机" }],
  warnings: ["正文偏长"],
  todo: ["确认周报模板"],
  fallback: false,
};
const gap = { nodeId: "n1", kind: "template" as const, title: "生成周报", question: "「生成周报」用什么模板或输出格式？" };

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("导出 Agent Skill 弹窗", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    vi.mocked(ex.promptGaps).mockReturnValue([]);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });
  const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
  const render = async (props: Partial<Parameters<typeof SkillExportDialog>[0]> = {}) => {
    await act(async () => root.render(<SkillExportDialog ir={ir} workflowId="wf-1" version={2} onClose={() => {}} {...props} />));
    await flush();
  };
  const typeInto = async (el: HTMLTextAreaElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("没有缺口：自动开始，显示进度；完成后预览文件，带上运行条件、警告和待确认，可以下载 zip", async () => {
    let finish!: (r: skillExport.SkillExportResult) => void;
    vi.spyOn(skillExport, "exportSkill").mockImplementation((_id, _body, onProgress) => {
      onProgress("analyze");
      onProgress("write");
      return new Promise((resolve) => (finish = resolve));
    });
    await render();
    expect(skillExport.exportSkill).toHaveBeenCalledWith("wf-1", { version: 2, target: "generic", packaging: "zip" }, expect.any(Function), expect.anything());
    expect([...document.querySelectorAll(".n8n-export-steps li")].map((s) => s.className)).toEqual(["done", "now", ""]);
    expect([...document.querySelectorAll(".n8n-export-steps li")].map((s) => s.textContent)).toEqual(["分析流程图", "撰写 Skill", "校验"]);

    await act(async () => finish(result));
    await flush();
    expect(document.querySelector(".ep-code")?.textContent).toBe("# 周报");
    const text = document.body.textContent!;
    for (const part of ["注意：description 缺少使用时机", "注意：正文偏长", "待确认：确认周报模板"]) expect(text).toContain(part);
    expect(text).not.toContain("已使用基础版本");
    expect(ex.buildSkill).not.toHaveBeenCalled();

    await act(async () => button("下载 .zip").click());
    await flush();
    expect(ex.zipFiles).toHaveBeenCalledWith(result.files);
    expect(ex.download).toHaveBeenCalledWith(expect.any(Blob), "weekly.skill.zip");
  });

  it("服务端回退到基础版本时，说明原因", async () => {
    vi.spyOn(skillExport, "exportSkill").mockResolvedValue({ ...result, fallback: true, fallbackReason: "模型暂时不可用，已使用基础版本", todo: [] });
    await render();
    expect(document.body.textContent).toContain("已使用基础版本：模型暂时不可用，已使用基础版本");
  });

  it("有缺口：先显示表单，不自动开始；填写后随请求带上，不填的不带", async () => {
    vi.mocked(ex.promptGaps).mockReturnValue([gap]);
    vi.spyOn(skillExport, "exportSkill").mockResolvedValue(result);
    await render();
    expect(skillExport.exportSkill).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(gap.question);
    expect(document.body.textContent).toContain("Skill 里会提醒 Agent 先向用户确认");
    await typeInto(document.querySelector("textarea")!, "三段：销售额、环比、Top 3");
    await act(async () => button("开始生成").click());
    await flush();
    expect(skillExport.exportSkill).toHaveBeenCalledWith("wf-1", { version: 2, target: "generic", packaging: "zip", answers: { n1: "三段：销售额、环比、Top 3" } }, expect.any(Function), expect.anything());
  });

  it("有缺口但什么都不填：照样可以生成，请求里没有 answers", async () => {
    vi.mocked(ex.promptGaps).mockReturnValue([gap]);
    vi.spyOn(skillExport, "exportSkill").mockResolvedValue(result);
    await render();
    await act(async () => button("开始生成").click());
    await flush();
    expect(vi.mocked(skillExport.exportSkill).mock.calls[0]![1]).not.toHaveProperty("answers");
  });

  it("保存为新版本：写回工作流，之后按新版本导出，回答不再重复带上", async () => {
    vi.mocked(ex.promptGaps).mockReturnValue([gap]);
    const post = vi.spyOn(api, "post").mockResolvedValue({ version: 3 });
    vi.spyOn(skillExport, "exportSkill").mockResolvedValue(result);
    const onSaved = vi.fn();
    await render({ onSaved });
    expect(button("保存为新版本").disabled).toBe(true);
    await typeInto(document.querySelector("textarea")!, "三段");
    await act(async () => button("保存为新版本").click());
    await flush();
    expect(post).toHaveBeenCalledWith("/workflows/wf-1/versions", { ir: expect.objectContaining({ patched: { n1: "三段" } }) });
    expect(onSaved).toHaveBeenCalledWith(3);
    expect(document.body.textContent).toContain("已保存为 v3");
    await act(async () => button("开始生成").click());
    await flush();
    expect(vi.mocked(skillExport.exportSkill).mock.calls[0]![1]).toEqual({ version: 3, target: "generic", packaging: "zip" });
  });

  it("服务端没有启用（503）：不打扰用户，直接给浏览器内的基础版本，并说明", async () => {
    vi.spyOn(skillExport, "exportSkill").mockRejectedValue(new ApiError(503, "Skill 生成未启用", 503));
    vi.mocked(ex.buildSkill).mockResolvedValue({ files: [{ path: "weekly/SKILL.md", content: "# 基础" }], filename: "weekly.skill.zip", warnings: ["注意项"] } as never);
    await render();
    expect(ex.buildSkill).toHaveBeenCalledWith(expect.objectContaining({ patched: {} }), { target: "generic", packaging: "zip" });
    expect(document.querySelector(".ep-code")?.textContent).toBe("# 基础");
    expect(document.body.textContent).toContain("没有连上生成服务，已使用基础版本");
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("没有所属工作流（无法请求服务端）：直接用基础版本", async () => {
    const spy = vi.spyOn(skillExport, "exportSkill");
    vi.mocked(ex.buildSkill).mockResolvedValue({ files: [{ path: "a/SKILL.md", content: "x" }], filename: "a.skill.zip", warnings: [] } as never);
    await render({ workflowId: undefined });
    expect(spy).not.toHaveBeenCalled();
    expect(ex.buildSkill).toHaveBeenCalled();
  });

  it("其他失败：显示原因，可以重试，也可以改用基础版本", async () => {
    const spy = vi.spyOn(skillExport, "exportSkill").mockRejectedValueOnce(new Error("导出太频繁，请稍后再试")).mockResolvedValueOnce(result);
    await render();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("导出太频繁");
    expect(button("使用基础版本")).toBeDefined();
    await act(async () => button("重试").click());
    await flush();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector(".ep-code")?.textContent).toBe("# 周报");
  });

  it("失败后选择基础版本", async () => {
    vi.spyOn(skillExport, "exportSkill").mockRejectedValue(new Error("网络错误"));
    vi.mocked(ex.buildSkill).mockResolvedValue({ files: [{ path: "a/SKILL.md", content: "# 基础" }], filename: "a.skill.zip", warnings: [] } as never);
    await render();
    await act(async () => button("使用基础版本").click());
    await flush();
    expect(document.querySelector(".ep-code")?.textContent).toBe("# 基础");
  });

  it("生成进行中关闭需要确认；确认后卸载会取消请求", async () => {
    let signal: AbortSignal | undefined;
    vi.spyOn(skillExport, "exportSkill").mockImplementation((_id, _body, _p, s) => {
      signal = s;
      return new Promise(() => {});
    });
    const onClose = vi.fn();
    await render({ onClose });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    await act(async () => document.querySelector<HTMLElement>(".modal-back")!.click());
    expect(onClose).not.toHaveBeenCalled(); // 点遮罩不会关闭
    await act(async () => document.querySelector<HTMLButtonElement>(".modal .x")!.click());
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => document.querySelector<HTMLButtonElement>(".modal .x")!.click());
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
    await act(async () => root.unmount());
    expect(signal?.aborted).toBe(true);
  });
});
