import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ExportPreview, type ExportPreviewSpec } from "../components/ExportPreview";

// @ts-expect-error 测试环境使用 React 的 act 标记
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SPEC: ExportPreviewSpec = {
  title: "Agent Skill 预览",
  files: [
    { path: "demo/SKILL.md", content: "# 技能正文" },
    { path: "demo/references/workflow.mmd", content: "flowchart TD" },
    { path: "demo/logo.bin", content: new Uint8Array([1, 2, 3]) },
  ],
  notes: ["运行前需要：ERP 账号"],
  downloadLabel: "下载 .zip",
  onDownload: vi.fn(),
};

describe("ExportPreview", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  const render = (spec: ExportPreviewSpec = SPEC) => {
    act(() => root.render(<ExportPreview spec={spec} onClose={() => {}} />));
  };
  const fileButtons = () => [...document.querySelectorAll<HTMLButtonElement>(".ep-file")];
  const code = () => document.querySelector(".ep-code")?.textContent;

  it("左侧显示文件树，默认预览第一个文件，点击其他文件切换内容", () => {
    render();
    expect(fileButtons().map((b) => b.textContent)).toEqual(["SKILL.md", "workflow.mmd", "logo.bin"]);
    expect(code()).toBe("# 技能正文");
    expect(document.querySelector(".ep-path")?.textContent).toBe("demo/SKILL.md");

    act(() => fileButtons()[1]!.click());
    expect(code()).toBe("flowchart TD");
    expect(document.querySelector(".ep-path")?.textContent).toBe("demo/references/workflow.mmd");
  });

  it("二进制文件不能复制，给出说明", () => {
    render();
    act(() => fileButtons()[2]!.click());
    expect(code()).toBeUndefined();
    expect(document.querySelector(".ep-empty")?.textContent).toContain("二进制文件");
    expect(document.querySelector<HTMLButtonElement>(".ep-bar .btn")!.disabled).toBe(true);
  });

  it("复制当前文件的内容", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render();
    await act(async () => document.querySelector<HTMLButtonElement>(".ep-bar .btn")!.click());
    expect(writeText).toHaveBeenCalledWith("# 技能正文");
    expect(document.querySelector(".ep-bar .btn")!.textContent).toBe("已复制");
  });

  it("只有一个文件时不显示文件树", () => {
    render({ ...SPEC, files: [{ path: "x.prompt.md", content: "内容" }] });
    expect(document.querySelector(".ep-tree")).toBeNull();
    expect(code()).toBe("内容");
  });
});
