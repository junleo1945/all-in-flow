import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lower, migrateIr, type WorkflowIR } from "@aif/workflow-ir";
import { skillExporter, renderSkillMd, conditionText } from "../src/index.js";
import { planScripts, renderEnvExample } from "../src/scripts.js";
import { orderSteps } from "../src/index.js";

/** 一个包含 API、Webhook、数据整理和条件分支的工作流 */
const ir = (): WorkflowIR => ({
  version: 2,
  kind: "automation",
  slug: "order-report",
  name: "订单报告",
  description: "汇总订单并发送通知。当用户需要订单报告时使用。",
  trigger: { type: "manual", detail: "手动" },
  inputs: [{ name: "week", type: "string", description: "周次", required: true }],
  integrations: [
    { id: "erp", name: "ERP", purpose: "订单", access: "api" },
    { id: "dingtalk-bot", name: "钉钉群机器人", purpose: "通知", access: "webhook" },
  ],
  nodes: [
    { id: "s", type: "start", title: "开始" },
    {
      id: "n1",
      type: "step",
      title: "拉取订单",
      executor: "deterministic",
      integration: "erp",
      instructions: "拉取本周订单",
      action: { kind: "integration", integration: "erp", operation: "listOrders", params: { start: "{{input.week}}", end: "2026-10-07" } },
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
      integration: "dingtalk-bot",
      instructions: "发送摘要",
      action: { kind: "integration", integration: "dingtalk-bot", operation: "sendText", params: { content: "{{n2.summary}}" } },
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

/** 假的 curl：把收到的参数原样记录到日志文件，便于检查脚本拼出的请求 */
function fakeCurl(exitCode = 0): { dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "aif-fake-curl-"));
  const log = join(dir, "args.log");
  writeFileSync(join(dir, "curl"), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${log}"\nexit ${exitCode}\n`);
  chmodSync(join(dir, "curl"), 0o755);
  return { dir, log };
}

describe("脚本生成", () => {
  it("API 操作生成 bash 脚本，参数顺序与操作声明一致，接口路径未确认时要求环境变量", () => {
    const plan = plansOf(ir()).plans.get("n1")!;
    expect(plan.path).toBe("scripts/01-listOrders.sh");
    expect(plan.args).toEqual(["{{input.week}}", "2026-10-07"]);
    expect(plan.content).toMatch(/^#!\/usr\/bin\/env bash/);
    expect(plan.content).toContain("ERP_LISTORDERS_PATH");
    expect(plan.content).toContain('--data-urlencode "start=$1"');
    expect(plan.content).toContain('--data-urlencode "end=$2"');
    expect(plan.content).toContain('-H "Authorization: Bearer $ERP_TOKEN"');
  });

  it("生成的 bash 脚本语法正确", () => {
    const plan = plansOf(ir()).plans.get("n1")!;
    const file = writeScript(plan.content, "01-listOrders.sh");
    expect(() => execFileSync("bash", ["-n", file])).not.toThrow();
  });

  it("API 脚本实际运行：参数进入查询串，鉴权头带上令牌", () => {
    const plan = plansOf(ir()).plans.get("n1")!;
    const file = writeScript(plan.content, "01-listOrders.sh");
    const curl = fakeCurl();
    execFileSync(file, ["2026-10-01", "2026-10-07"], {
      env: { ...process.env, PATH: `${curl.dir}:${process.env.PATH}`, ERP_BASE_URL: "http://127.0.0.1:4100", ERP_TOKEN: "dev-token", ERP_LISTORDERS_PATH: "/api/orders" },
    });
    const args = readFileSync(curl.log, "utf8").trim().split("\n");
    expect(args).toContain("http://127.0.0.1:4100/api/orders");
    expect(args).toContain("start=2026-10-01");
    expect(args).toContain("end=2026-10-07");
    expect(args).toContain("Authorization: Bearer dev-token");
  });

  it("接口路径没有配置时，脚本直接报错，不会去请求错误的地址", () => {
    const plan = plansOf(ir()).plans.get("n1")!;
    const file = writeScript(plan.content, "01-listOrders.sh");
    const r = spawnSync(file, ["2026-10-01", "2026-10-07"], {
      env: { PATH: process.env.PATH, ERP_BASE_URL: "http://127.0.0.1:4100", ERP_TOKEN: "x" },
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/ERP_LISTORDERS_PATH/);
  });

  it("参数个数不对时打印用法并退出", () => {
    const plan = plansOf(ir()).plans.get("n1")!;
    const file = writeScript(plan.content, "01-listOrders.sh");
    const r = spawnSync(file, ["only-one"], { env: { PATH: process.env.PATH, ERP_BASE_URL: "x", ERP_TOKEN: "x", ERP_LISTORDERS_PATH: "/x" }, encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/用法/);
  });

  it("Webhook 脚本会转义参数里的引号，保证 JSON 合法", () => {
    const plan = plansOf(ir()).plans.get("n3")!;
    const file = writeScript(plan.content, "03-sendText.sh");
    const curl = fakeCurl();
    execFileSync(file, ['订单 "A" 已处理'], {
      env: { ...process.env, PATH: `${curl.dir}:${process.env.PATH}`, DINGTALK_BOT_WEBHOOK_URL: "http://hook.test/x" },
    });
    const args = readFileSync(curl.log, "utf8").trim().split("\n");
    const body = args[args.indexOf("-d") + 1]!;
    expect(JSON.parse(body)).toEqual({ msgtype: "text", text: { content: '订单 "A" 已处理' } });
  });

  it("数据整理脚本（.mjs）实际运行：引用按顺序替换为参数", () => {
    const plan = plansOf(ir()).plans.get("n2")!;
    expect(plan.path).toBe("scripts/02-transform.mjs");
    expect(plan.args).toEqual(["{{n1.orders}}", "{{input.week}}"]);
    const file = writeScript(plan.content, "02-transform.mjs");
    const out = execFileSync("node", [file, "A", "B"], { encoding: "utf8" });
    expect(out).toBe("订单 A 共 B 周");
  });

  it("没有登记参数的操作不生成脚本，并给出原因", () => {
    const w = ir();
    (w.nodes.find((n) => n.id === "n1") as any).action = { kind: "integration", integration: "erp", operation: "listOrders", params: { start: "x" } };
    const r = plansOf(w);
    expect(r.plans.has("n1")).toBe(false);
    expect(r.unsupported.find((u) => u.stepId === "n1")?.reason).toMatch(/缺少必填参数：end/);
  });

  it("LLM 和人工步骤不生成脚本，也不发出警告", () => {
    const w = ir();
    w.nodes.push({ id: "h", type: "step", title: "确认", executor: "human", instructions: "确认", action: { kind: "human", message: "确认" } });
    const r = plansOf(w);
    expect(r.plans.has("h")).toBe(false);
    expect(r.unsupported.some((u) => u.stepId === "h")).toBe(false);
  });
});

describe("环境变量清单", () => {
  it(".env.example 列出所有配置项和接口路径覆盖项，值留空", () => {
    const env = renderEnvExample(ir())!;
    expect(env).toMatch(/^ERP_BASE_URL=$/m);
    expect(env).toMatch(/^ERP_TOKEN=$/m);
    expect(env).toMatch(/^ERP_LISTORDERS_PATH=$/m);
    expect(env).toMatch(/^DINGTALK_BOT_WEBHOOK_URL=$/m);
    expect(env).not.toMatch(/=\S/);
  });
});

describe("SKILL.md", () => {
  it("确定性步骤写明运行的脚本、参数和输出", () => {
    const w = ir();
    const md = renderSkillMd(w, plansOf(w).plans);
    expect(md).toContain("运行 `scripts/01-listOrders.sh`，参数依次为：`{{input.week}}`、`2026-10-07`");
    expect(md).toContain("输出：`orders`（array，订单列表）");
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
      integrations: [],
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
    expect(files).toContain("order-report/skills/order-report/scripts/01-listOrders.sh");
    expect(files).toContain("order-report/skills/order-report/.env.example");
  });

  it("zip 打包：脚本位于 <slug>/scripts 下", () => {
    const files = skillExporter.compile(lower(ir()), { target: "generic", packaging: "zip" }).map((f) => f.path);
    expect(files).toContain("order-report/scripts/01-listOrders.sh");
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

describe("脚本的运行时行为", () => {
  it(".env 不覆盖 shell 中显式设置的变量", () => {
    const plan = plansOf(ir()).plans.get("n1")!;
    const file = writeScript(plan.content, "01-listOrders.sh");
    writeFileSync(join(file, "..", "..", ".env"), "ERP_BASE_URL=http://file.test\nERP_TOKEN=from-file\nERP_LISTORDERS_PATH=/api/orders\n");
    const curl = fakeCurl();
    execFileSync(file, ["2026-10-01", "2026-10-07"], {
      env: { PATH: `${curl.dir}:${process.env.PATH}`, ERP_TOKEN: "from-shell" },
    });
    const args = readFileSync(curl.log, "utf8").trim().split("\n");
    expect(args).toContain("Authorization: Bearer from-shell");
    expect(args).toContain("http://file.test/api/orders");
  });

  it("HTTP 错误让脚本失败，而不是把错误响应当成结果", () => {
    const plan = plansOf(ir()).plans.get("n1")!;
    const file = writeScript(plan.content, "01-listOrders.sh");
    const curl = fakeCurl(22);
    const r = spawnSync(file, ["2026-10-01", "2026-10-07"], {
      env: { PATH: `${curl.dir}:${process.env.PATH}`, ERP_BASE_URL: "http://x", ERP_TOKEN: "x", ERP_LISTORDERS_PATH: "/api" },
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
  });
});
