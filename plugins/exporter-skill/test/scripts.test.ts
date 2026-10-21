import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lower, migrateIr, type WorkflowIR } from "@aif/workflow-ir";
import { skillExporter, renderSkillMd, conditionText } from "../src/index.js";
import { planScripts } from "../src/scripts.js";
import { orderSteps } from "../src/index.js";

/** 一个包含 HTTP 请求和数据整理的工作流 */
const ir = (): WorkflowIR => ({
  version: 2,
  kind: "automation",
  slug: "order-report",
  name: "订单报告",
  description: "汇总订单并发送通知。当用户需要订单报告时使用。",
  trigger: { type: "manual", detail: "手动" },
  inputs: [{ name: "week", type: "string", description: "周次", required: true }],
  nodes: [
    { id: "s", type: "start", title: "开始" },
    {
      id: "n1",
      type: "step",
      title: "拉取订单",
      executor: "deterministic",
      instructions: "拉取本周订单",
      action: { kind: "http", method: "GET", url: "https://erp.example.com/api/orders?week={{input.week}}" },
      outputs: [{ name: "orders", type: "array", description: "订单列表" }],
    },
    {
      id: "n2",
      type: "step",
      title: "整理摘要",
      executor: "deterministic",
      instructions: "拼接摘要",
      action: { kind: "transform", template: "订单 {{n1.orders}} 共 {{input.week}} 周" },
      outputs: [{ name: "summary", type: "string", description: "摘要" }],
    },
    {
      id: "n3",
      type: "step",
      title: "发送通知",
      executor: "deterministic",
      instructions: "发送摘要",
      action: { kind: "http", method: "POST", url: "https://hook.example.com/send", body: "{{n2.summary}}" },
    },
    { id: "e", type: "end", title: "结束" },
  ],
  edges: [
    { from: "s", to: "n1" },
    { from: "n1", to: "n2" },
    { from: "n2", to: "n3" },
    { from: "n3", to: "e" },
  ],
  source: { painPointIds: [] },
});

const plansOf = (w: WorkflowIR) => planScripts(w, orderSteps(w).number);

/** 把脚本写到临时目录，返回路径 */
function writeScript(content: string, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "aif-scripts-"));
  mkdirSync(join(dir, "scripts"));
  const file = join(dir, "scripts", name);
  writeFileSync(file, content);
  chmodSync(file, 0o755);
  return file;
}

describe("脚本生成", () => {
  it("数据整理脚本（.mjs）实际运行：引用按顺序替换为参数", () => {
    const plan = plansOf(ir()).plans.get("n2")!;
    expect(plan.path).toBe("scripts/02-transform.mjs");
    expect(plan.args).toEqual(["{{n1.orders}}", "{{input.week}}"]);
    const file = writeScript(plan.content, "02-transform.mjs");
    const out = execFileSync("node", [file, "A", "B"], { encoding: "utf8" });
    expect(out).toBe("订单 A 共 B 周");
  });

  it("HTTP 步骤不生成脚本，并给出原因", () => {
    const r = plansOf(ir());
    expect(r.plans.has("n1")).toBe(false);
    expect(r.unsupported.find((u) => u.stepId === "n1")?.reason).toMatch(/HTTP/);
    expect(r.unsupported.find((u) => u.stepId === "n3")?.reason).toMatch(/HTTP/);
  });

  it("LLM 和人工步骤不生成脚本，也不发出警告", () => {
    const w = ir();
    w.nodes.push({ id: "h", type: "step", title: "确认", executor: "human", instructions: "确认", action: { kind: "human", message: "确认" } });
    const r = plansOf(w);
    expect(r.plans.has("h")).toBe(false);
    expect(r.unsupported.some((u) => u.stepId === "h")).toBe(false);
  });
});

describe("SKILL.md", () => {
  it("数据整理步骤写明运行的脚本、参数和输出", () => {
    const w = ir();
    const md = renderSkillMd(w, plansOf(w).plans);
    expect(md).toContain("运行 `scripts/02-transform.mjs`，参数依次为：`{{n1.orders}}`、`{{input.week}}`");
    expect(md).toContain("输出：`summary`（string，摘要）");
  });

  it("条件表达式翻译成中文，默认分支写明其他情况", () => {
    expect(conditionText({ all: [{ left: "n2.results", op: "not_empty" }, { left: "input.week", op: "gt", right: 3 }] })).toBe(
      "`n2.results` 不为空 且 `input.week` 大于 3",
    );
    const w = migrateIr({
      version: 1,
      kind: "automation",
      slug: "x",
      name: "x",
      description: "x 时使用",
      trigger: { type: "manual", detail: "手动" },
      inputs: [],
      nodes: [{ id: "s", type: "start", title: "开始" }, { id: "e", type: "end", title: "结束" }],
      edges: [{ from: "s", to: "e" }],
      source: { painPointIds: [] },
    } as any);
    w.nodes = [
      { id: "s", type: "start", title: "开始" },
      { id: "d", type: "decision", title: "是否异常", mode: "expr" },
      { id: "e", type: "end", title: "结束" },
    ];
    w.edges = [
      { from: "s", to: "d" },
      { from: "d", to: "e", label: "异常", condition: { left: "input.x", op: "is_true" } },
      { from: "d", to: "e", label: "正常", default: true },
    ];
    const md = renderSkillMd(w);
    expect(md).toContain("- 异常（条件：`input.x` 为真）");
    expect(md).toContain("- 正常（其他情况）");
  });
});

describe("打包与检查", () => {
  it("claude-plugin：生成插件清单，技能文件放在 skills/<slug>/ 下", () => {
    const files = skillExporter.compile(lower(ir()), { target: "generic", packaging: "claude-plugin" }).map((f) => f.path);
    expect(files).toContain("order-report/.claude-plugin/plugin.json");
    expect(files).toContain("order-report/skills/order-report/SKILL.md");
    expect(files).toContain("order-report/skills/order-report/scripts/02-transform.mjs");
  });

  it("zip 打包：脚本位于 <slug>/scripts 下", () => {
    const files = skillExporter.compile(lower(ir()), { target: "generic", packaging: "zip" }).map((f) => f.path);
    expect(files).toContain("order-report/scripts/02-transform.mjs");
    expect(files).toContain("order-report/SKILL.md");
  });

  it("description 没有写明使用时机时给出警告", () => {
    const w = ir();
    w.description = "汇总订单";
    const issues = skillExporter.supports(lower(w));
    expect(issues.some((i) => i.level === "warning" && i.message.includes("什么时候使用"))).toBe(true);
  });

  it("无法生成脚本的 HTTP 步骤给出警告，而不是静默丢弃", () => {
    const w = ir();
    w.nodes.push({ id: "h", type: "step", title: "调接口", executor: "deterministic", instructions: "调接口", action: { kind: "http", method: "GET", url: "https://x" } });
    w.edges.splice(2, 0, { from: "n3", to: "h" });
    w.edges.push({ from: "h", to: "e" });
    w.edges = w.edges.filter((e) => !(e.from === "n3" && e.to === "e"));
    w.edges.push({ from: "n3", to: "h" });
    const issues = skillExporter.supports(lower(w));
    expect(issues.some((i) => i.nodeId === "h" && i.message.includes("无法生成脚本"))).toBe(true);
  });
});
