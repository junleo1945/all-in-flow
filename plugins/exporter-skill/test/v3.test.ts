import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lower, validateWorkflow, type ExportFile, type WorkflowIR } from "@aif/workflow-ir";
import { loopIr, salesIr } from "./fixtures.js";
import { findIntegration } from "@aif/integrations";
import { skillExporter, renderSkillMd, skillFacts, compatibilityText } from "../src/index.js";
import { skeleton } from "../src/index.js";
import { planScripts } from "../src/scripts.js";
import { orderSteps } from "@aif/workflow-ir";
import { validateSkill, findSecrets, referencedPaths, parseFrontmatter } from "../src/validate.js";

const OPTIONS = { target: "generic", packaging: "zip" } as const;
const filesOf = (ir: WorkflowIR) => skeleton(ir, OPTIONS).files;
const skillMd = (files: ExportFile[]) => String(files.find((f) => f.path === "SKILL.md")!.content);
/** 替换 SKILL.md，模拟模型写出的内容 */
const withSkill = (files: ExportFile[], change: (md: string) => string): ExportFile[] =>
  files.map((f) => (f.path === "SKILL.md" ? { ...f, content: change(String(f.content)) } : f));
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe("测试用的工作流本身有效", () => {
  it("通过 IR 校验", () => {
    expect(validateWorkflow(loopIr(), { resolveOperation: undefined as never }).ok).toBe(true);
    expect(validateWorkflow(salesIr()).ok).toBe(true);
  });
});

describe("F1：foreach 子流程展开", () => {
  it("SKILL.md 把子步骤写成 1.1、1.2……，不再指向 workflow.json", () => {
    const md = renderSkillMd(loopIr(), planScripts(loopIr(), orderSteps(loopIr()).number).plans);
    expect(md).toContain("1. **逐条核对** 对 `input.expense_list` 中的每一项（当前项记为 `expense`）依次执行下面的子步骤");
    expect(md).toMatch(/^ {3}1\.1\. \*\*生成单号摘要\*\*〔脚本〕/m);
    expect(md).toMatch(/^ {3}1\.2\. \*\*计算差额\*\*〔脚本〕/m);
    expect(md).toMatch(/^ {3}1\.3\. \*\*复核差额\*\*〔需要确认〕/m);
    expect(md).not.toContain("references/workflow.json）");
    expect(md).toMatch(/^2\. \*\*生成核对结果表\*\*〔AI〕/m);
  });

  it("子流程里的结束语只针对本轮，主流程的结束语不受影响", () => {
    const md = renderSkillMd(loopIr());
    expect(md).toContain("本项完成，继续循环中的下一项");
    expect(md).toMatch(/2\. \*\*生成核对结果表\*\*〔AI〕.*至此流程结束。/);
  });

  it("子步骤的脚本按子流程编号，文件名不重名", () => {
    const { plans } = planScripts(loopIr(), orderSteps(loopIr()).number);
    expect([...plans.values()].map((p) => p.path)).toEqual(["scripts/01-01-transform.mjs", "scripts/01-02-code.mjs"]);
    expect(plans.get("calc")!.content).toContain("第 1.1 步「生成单号摘要」");
  });

  it("SKILL.md 说明 {{节点id.变量}} 对应哪一步，以及循环里当前项的含义", () => {
    const md = renderSkillMd(loopIr());
    expect(md).toContain("## 数据引用");
    expect(md).toContain("`{{input.名字}}`");
    expect(md).toContain("- `calc` → 第 1.1 步「生成单号摘要」");
    expect(md).toContain("- `n_split` → 第 1 步「逐条核对」");
    expect(md).toContain("`expense` 是当前正在处理的那一项");
  });

  it("没有输出变量也没有循环时不写数据引用一节", () => {
    const w = salesIr();
    expect(renderSkillMd(w)).not.toContain("## 数据引用");
  });
});

describe("F2：code 脚本可以运行", () => {
  const write = (name: string, content: string) => {
    const dir = mkdtempSync(join(tmpdir(), "aif-code-"));
    const file = join(dir, name);
    writeFileSync(file, content);
    return file;
  };
  const codePlan = (source: string, language: "javascript" | "python" = "javascript") => {
    const w = loopIr();
    const foreach = w.nodes.find((n) => n.type === "foreach") as any;
    foreach.body.nodes.find((n: any) => n.id === "diff").action = { kind: "code", language, source };
    return planScripts(w, orderSteps(w).number).plans.get("diff")!;
  };

  it("按生成 IR 时约定的写法执行：$input.first().json 读上游，return [{ json }] 返回", () => {
    const file = write("code.mjs", codePlan('const row = $input.first().json;\nreturn [{ json: { summary: row.label + "!" } }];').content);
    expect(execFileSync("node", ["--check", file])).toBeDefined();
    expect(execFileSync("node", [file, '{"label":"A"}'], { encoding: "utf8" })).toBe('{"summary":"A!"}');
  });

  it("上游输出也可以通过标准输入传入", () => {
    const file = write("code.mjs", codePlan('return [{ json: { summary: $input.first().json.label } }];').content);
    expect(execFileSync("node", [file], { input: '{"label":"B"}', encoding: "utf8" })).toBe('{"summary":"B"}');
  });

  it("上游是数组时每个元素算一项", () => {
    const file = write("code.mjs", codePlan("return [{ json: { n: $input.all().length } }];").content);
    expect(execFileSync("node", [file, "[1,2,3]"], { encoding: "utf8" })).toBe('{"n":3}');
  });

  it("输入不是 JSON、代码抛错时打印原因并以非 0 退出", () => {
    const bad = spawnSync("node", [write("a.mjs", codePlan("return [];").content), "not json"], { encoding: "utf8" });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("输入不是合法的 JSON");
    const boom = spawnSync("node", [write("b.mjs", codePlan('throw new Error("坏了");').content), "{}"], { encoding: "utf8" });
    expect(boom.status).not.toBe(0);
    expect(boom.stderr).toContain("代码执行失败：坏了");
  });

  it("SKILL.md 写明代码步骤怎么传入上游输出", () => {
    const w = loopIr();
    const md = renderSkillMd(w, planScripts(w, orderSteps(w).number).plans);
    expect(md).toContain("运行 `scripts/01-02-code.mjs`，把直接上游步骤的输出（JSON）作为第一个参数传入");
  });

  const hasPython = spawnSync("python3", ["--version"]).status === 0;
  it.skipIf(!hasPython)("Python 步骤：源码放进函数体，可以用 input_json 并 return 结果", () => {
    const file = write("code.py", codePlan('return {"summary": input_json["label"] + "!"}', "python").content);
    expect(execFileSync("python3", [file, '{"label":"A"}'], { encoding: "utf8" })).toBe('{"summary": "A!"}');
    const bad = spawnSync("python3", [file, "oops"], { encoding: "utf8" });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("输入不是合法的 JSON");
  });
});

describe("F3：触发方式不重复", () => {
  it("手动触发的说明里已经写了用户要求时，不再补一句", () => {
    const md = renderSkillMd(loopIr());
    expect(md).toContain("## 触发方式\n\n用户主动要求核对报销单时。");
    expect(md).not.toContain("时，或用户主动要求时");
  });

  it("手动触发的说明里没有写时补上；定时触发不补", () => {
    const w = loopIr();
    w.trigger = { type: "manual", detail: "每周核对一次" };
    expect(renderSkillMd(w)).toContain("每周核对一次，或用户主动要求时。");
    expect(renderSkillMd(salesIr())).toContain("每周五 17:00。");
  });
});

describe("F4：compatibility 写运行环境", () => {
  it("按产物推导：脚本需要的解释器和 curl", () => {
    const w = loopIr();
    expect(compatibilityText(w, planScripts(w, orderSteps(w).number).plans)).toBe("需要：Node.js 20 及以上");
  });

  it("API 脚本需要 bash、curl 和对外部系统的访问；MCP 与命令行工具分别列出", () => {
    const w = salesIr();
    w.nodes = w.nodes.map((n) =>
      n.id === "n1" && n.type === "step"
        ? { ...n, action: { kind: "integration" as const, integration: "erp", operation: "listOrders", params: { start: "a", end: "b" } } }
        : n,
    );
    w.integrations = [
      { id: "erp", name: "ERP", purpose: "订单", access: "api" },
      { id: "dingtalk-doc", name: "钉钉文档", purpose: "发布", access: "mcp" },
      { id: "github-cli", name: "GitHub CLI", purpose: "PR", access: "cli" },
    ];
    expect(compatibilityText(w, planScripts(w, orderSteps(w).number).plans)).toBe("需要：bash、curl、MCP 服务「钉钉文档」、gh 命令行工具、能访问 ERP");
  });

  it("没有任何环境要求时不写这一栏；人工操作的系统不算", () => {
    const w = salesIr();
    w.integrations = [];
    expect(compatibilityText(w)).toBeUndefined();
    expect(renderSkillMd(w)).not.toContain("compatibility:");
    w.integrations = [{ id: "mail", name: "邮箱", purpose: "收件", access: "manual" }];
    expect(compatibilityText(w)).toBeUndefined();
  });

  it("不超过 500 字符", () => {
    const w = salesIr();
    w.integrations = Array.from({ length: 80 }, (_, i) => ({ id: `sys${i}`, name: `业务系统${i}号`, purpose: "x", access: "api" as const }));
    expect(compatibilityText(w)!.length).toBeLessThanOrEqual(500);
  });
});

describe("F5：description 检查与语言无关", () => {
  const issuesFor = (description: string) => {
    const w = salesIr();
    w.description = description;
    return skillExporter.supports(lower(w)).map((i) => i.message);
  };

  it("英文的 Use when 也算写明了使用时机", () => {
    expect(issuesFor("Summarizes weekly ERP orders into a sales report. Use when the user asks for a weekly report.").some((m) => m.includes("什么时候使用"))).toBe(false);
    expect(issuesFor("汇总订单").some((m) => m.includes("什么时候使用"))).toBe(true);
  });

  it("不是第三人称、或超过 1024 字符时给出警告", () => {
    expect(issuesFor("我可以帮你汇总订单。当用户需要周报时使用。").some((m) => m.includes("第三人称"))).toBe(true);
    expect(issuesFor("You can use this to summarize orders. Use when asked.").some((m) => m.includes("第三人称"))).toBe(true);
    expect(issuesFor(`汇总订单。当用户需要周报时使用。${"字".repeat(1100)}`).some((m) => m.includes("1024"))).toBe(true);
    expect(issuesFor("汇总订单。当用户需要周报时使用。").filter((m) => m.includes("description"))).toEqual([]);
  });
});

describe("F6：执行约定", () => {
  it("每条约定说明原因，并写明数据怎么在步骤间传递", () => {
    const md = renderSkillMd(loopIr());
    expect(md).toContain("替用户回答会让结果不可信");
    expect(md).toContain("跳过会让结果悄悄出错");
    expect(md).toContain("脚本打印到标准输出的内容就是该步骤的输出");
    expect(md).toContain("缺失时，先向用户索取，不要自行猜测");
  });

  it("没有输入时不写索取输入的约定；只有存在 CONNECTIONS.md 时才引用它", () => {
    const w = salesIr();
    expect(renderSkillMd(w)).not.toContain("先向用户索取");
    expect(renderSkillMd(w)).toContain("按 `CONNECTIONS.md` 调用");
    w.integrations = [];
    expect(renderSkillMd(w)).not.toContain("CONNECTIONS.md");
  });
});

describe("F7：事实清单", () => {
  const facts = () => skillFacts(loopIr(), OPTIONS, ["「复核差额」的模板"]);

  it("步骤编号与 SKILL.md 一致，子流程是 1.1、1.2……", () => {
    expect(facts().steps.map((s) => s.number)).toEqual(["1", "1.1", "1.2", "1.3", "2"]);
    const loop = facts().steps[0]!;
    expect(loop).toMatchObject({ kind: "foreach", over: "input.expense_list", item: "expense", loopBody: ["1.1", "1.2", "1.3"], next: "2" });
  });

  it("脚本带路径、参数和运行时；人工步骤没有脚本", () => {
    const steps = facts().steps;
    expect(steps.find((s) => s.id === "calc")!.script).toEqual({ path: "scripts/01-01-transform.mjs", args: ["{{expense.id}}"], runtime: "node" });
    expect(steps.find((s) => s.id === "diff")!.script!.runtime).toBe("node");
    expect(steps.find((s) => s.id === "ok")!.script).toBeUndefined();
    expect(steps.find((s) => s.id === "ok")!.noScriptReason).toBeUndefined();
  });

  it("判断节点列出出边和目标步骤；确定性却没有脚本的步骤给出原因", () => {
    const f = skillFacts(salesIr(), OPTIONS);
    const decision = f.steps.find((s) => s.kind === "decision")!;
    expect(decision.heading).toBe("判断：有异常订单？");
    expect(decision.branches).toEqual([
      { label: "有", target: "3" },
      { label: "没有", target: "4" },
    ]);
    expect(f.steps.find((s) => s.id === "n1")!.noScriptReason).toBeTruthy();
    expect(f.steps.find((s) => s.id === "n4")!.next).toBe("结束");
  });

  it("包含骨架里的文件、集成、触发方式和缺口，且没有地址或密钥", () => {
    const f = facts();
    expect(f.files).toEqual(expect.arrayContaining(["SKILL.md", "scripts/01-01-transform.mjs", "references/workflow.json"]));
    expect(f.gaps).toEqual(["「复核差额」的模板"]);
    expect(f.trigger).toEqual({ type: "manual", detail: "用户主动要求核对报销单时" });
    const erp = skillFacts(salesIr(), OPTIONS).integrations[0]!;
    expect(erp).toMatchObject({ id: "erp", registered: true, fields: expect.arrayContaining(["ERP_TOKEN"]) });
    expect(findSecrets(JSON.stringify(f))).toEqual([]);
  });
});

describe("校验器：规范层", () => {
  it("确定性导出的 Skill 没有规范层错误", () => {
    for (const ir of [loopIr(), salesIr()]) {
      expect(validateSkill(filesOf(ir), { name: ir.slug }).filter((i) => i.level === "error")).toEqual([]);
    }
  });

  it("frontmatter：缺失、name 不一致、description 问题", () => {
    const base = filesOf(loopIr());
    expect(codes(validateSkill(withSkill(base, (md) => md.replace(/^---[\s\S]*?---\n/, "")), { name: "expense-check" }))).toContain("frontmatter");
    expect(codes(validateSkill([{ path: "x.md", content: "" }], {}))).toEqual(["skill-md-missing"]);
    expect(codes(validateSkill(withSkill(base, (md) => md.replace("name: expense-check", "name: other")), { name: "expense-check" }))).toContain("name-mismatch");

    const desc = (value: string) => validateSkill(withSkill(base, (md) => md.replace(/^description: .*$/m, `description: ${JSON.stringify(value)}`)), { name: "expense-check" });
    expect(codes(desc("你可以用它核对报销单。当用户需要时使用。"))).toContain("description-person");
    expect(codes(desc("核对报销单。当用户需要时使用。<b>x</b>"))).toContain("description-xml");
    expect(codes(desc(`核对报销单。当用户需要时使用。${"字".repeat(1100)}`))).toContain("description-length");
    expect(codes(desc("核对报销单"))).toContain("description-when");
    expect(codes(desc("Reviews expense reports. Use when the user mentions expense checks."))).not.toContain("description-when");
    expect(codes(desc("核对报销单。当用户需要时使用。 <填写 X>"))).not.toContain("description-xml");
  });

  it("没有 when 的 description：有事实清单时是错误，没有时只是警告", () => {
    const base = withSkill(filesOf(loopIr()), (md) => md.replace(/^description: .*$/m, 'description: "核对报销单"'));
    expect(validateSkill(base, {}).find((i) => i.code === "description-when")!.level).toBe("warning");
    expect(validateSkill(base, { facts: skillFacts(loopIr(), OPTIONS) }).find((i) => i.code === "description-when")!.level).toBe("error");
  });

  it("name 的格式问题只警告（来自 slug，模型改不了）", () => {
    const base = filesOf(loopIr());
    const renamed = withSkill(base, (md) => md.replace("name: expense-check", "name: claude-expense"));
    const issues = validateSkill(renamed, {});
    expect(issues.find((i) => i.code === "name-reserved")!.level).toBe("warning");
  });

  it("正文超过 500 行、compatibility 超长", () => {
    const base = filesOf(loopIr());
    expect(codes(validateSkill(withSkill(base, (md) => `${md}${"补充说明\n".repeat(500)}`), { name: "expense-check" }))).toContain("body-length");
    const long = withSkill(base, (md) => md.replace(/^compatibility: .*\n/m, "").replace(/^---\n/, `---\ncompatibility: ${JSON.stringify("x".repeat(501))}\n`));
    expect(codes(validateSkill(long, { name: "expense-check" }))).toContain("compatibility-length");
  });

  it("正文引用不存在的文件是错误；references 里再引用别的 references 是警告", () => {
    const base = filesOf(loopIr());
    const bad = validateSkill(withSkill(base, (md) => `${md}\n见 \`references/missing.md\` 和 [说明](docs/guide.md)。运行 scripts/09-nothing.sh 即可。`), { name: "expense-check" });
    expect(bad.filter((i) => i.code === "missing-file").map((i) => i.message)).toEqual([
      expect.stringContaining("references/missing.md"),
      expect.stringContaining("docs/guide.md"),
      expect.stringContaining("scripts/09-nothing.sh"),
    ]);
    const nested: ExportFile[] = [...base, { path: "references/a.md", content: "见 `references/b.md`" }, { path: "references/b.md", content: "b" }];
    expect(codes(validateSkill(nested, { name: "expense-check" }))).toContain("nested-reference");
    expect(validateSkill(base, { name: "expense-check" }).some((i) => i.code === "missing-file")).toBe(false);
  });

  it("文档里出现地址或疑似密钥是错误，占位符不是", () => {
    const base = filesOf(loopIr());
    const leak = (extra: string) => validateSkill([...base, { path: "references/notes.md", content: extra }], { name: "expense-check" }).some((i) => i.code === "secret");
    expect(leak("接口在 https://erp.corp.example/api")).toBe(true);
    expect(leak(`Authorization: Bearer ${"abcdefgh"}${"12345678"}`)).toBe(true);
    expect(leak(`token = ${"abcdefghijkl"}${"1234"}`)).toBe(true);
    // 假密钥在运行时拼出，避免源码里出现完整的密钥样字面量
    expect(leak(`key: ${"sk"}-${"abcdefghijklmnopqrstu"}`)).toBe(true);
    expect(leak("Authorization: Bearer <填写 ERP_TOKEN>，ERP_TOKEN=，token: $ERP_TOKEN")).toBe(false);
    // 流程图原文可以带地址，不在检查范围
    expect(validateSkill([...base, { path: "references/extra.json", content: '{"url":"https://x.test/a"}' }], { name: "expense-check" }).some((i) => i.code === "secret")).toBe(false);
  });

  it("evals：必须恰好 3 条，各有 prompt 和 expected_output", () => {
    const base = filesOf(loopIr());
    const evals = (value: unknown): ExportFile[] => [...base, { path: "evals/evals.json", content: typeof value === "string" ? value : JSON.stringify(value) }];
    const item = { id: 1, prompt: "帮我核对本周报销单", expected_output: "逐条核对并给出结果表", files: [] };
    const run = (files: ExportFile[]) => validateSkill(files, { name: "expense-check", requireEvals: true });
    expect(run(evals({ skill_name: "expense-check", evals: [item, item, item] })).filter((i) => i.level === "error")).toEqual([]);
    expect(codes(run(evals({ evals: [item] })))).toContain("evals-count");
    expect(codes(run(evals({ evals: [item, item, { prompt: "x" }] })))).toContain("evals-invalid");
    expect(codes(run(evals("{oops")))).toContain("evals-invalid");
    expect(codes(run(base))).toContain("evals-missing");
    expect(codes(validateSkill(base, { name: "expense-check" }))).not.toContain("evals-missing");
  });

  it("工具函数：frontmatter 解析与引用提取", () => {
    expect(parseFrontmatter('---\nname: a\ndescription: "x: y"\nmetadata:\n  k: v\n---\n正文')).toEqual({ fields: { name: "a", description: "x: y" }, body: "正文" });
    expect(parseFrontmatter("没有")).toBeUndefined();
    expect(referencedPaths("见 `scripts/a.sh`、[x](references/b.md#c)、`CONNECTIONS.md`。运行 scripts/d.mjs。网址 [y](https://x.test) 不算")).toEqual(
      expect.arrayContaining(["scripts/a.sh", "references/b.md", "CONNECTIONS.md", "scripts/d.mjs"]),
    );
    expect(referencedPaths("[y](https://x.test)")).toEqual([]);
  });
});

describe("校验器：忠实度层", () => {
  const facts = () => skillFacts(loopIr(), OPTIONS);
  const check = (change: (md: string) => string, ir = loopIr()) =>
    validateSkill(withSkill(filesOf(ir), change), { facts: skillFacts(ir, OPTIONS) });

  it("确定性导出本身满足忠实度检查（含子流程）", () => {
    expect(validateSkill(filesOf(loopIr()), { facts: facts() }).filter((i) => i.level === "error")).toEqual([]);
  });

  it("缺少步骤、重复步骤、多出步骤、标题不对、顺序错乱", () => {
    const missing = check((md) => md.split("\n").filter((l) => !l.includes("1.2. **计算差额**")).join("\n"));
    expect(missing.find((i) => i.code === "step-missing")!.message).toContain("1.2");
    expect(codes(check((md) => `${md.replace("## 数据引用", "   1.1. **生成单号摘要** 又写一遍\n\n## 数据引用")}`))).toContain("step-duplicate");
    expect(codes(check((md) => md.replace("## 数据引用", "3. **凭空多出来的步骤** 做点什么\n\n## 数据引用")))).toContain("step-unknown");
    expect(codes(check((md) => md.replace("**计算差额**", "**算一下差额**")))).toContain("step-heading");
    const swapped = check((md) => md.replace("2. **生成核对结果表**", "9. **生成核对结果表**").replace("1. **逐条核对**", "2. **逐条核对**").replace("9. **生成核对结果表**", "1. **生成核对结果表**"));
    expect(codes(swapped)).toEqual(expect.arrayContaining(["step-order"]));
  });

  it("没有「执行步骤」一节", () => {
    expect(codes(check((md) => md.replace("## 执行步骤", "## 做法")))).toContain("steps-missing");
  });

  it("判断分支：缺分支、目标不对", () => {
    const sales = salesIr();
    expect(codes(check((md) => md.replace("   - 没有 → 第 4 步\n", ""), sales))).toContain("branch-missing");
    expect(codes(check((md) => md.replace("- 有 → 第 3 步", "- 有 → 第 4 步"), sales))).toContain("branch-target");
  });

  it("脚本要在对应步骤里写明运行；人工确认要写明等用户", () => {
    expect(codes(check((md) => md.replaceAll("scripts/01-02-code.mjs", "代码")))).toContain("script-unreferenced");
    expect(codes(check((md) => md.replace("暂停，等用户回复后再继续", "自行判断")))).toContain("human-wait");
  });

  it("没有脚本的确定性步骤不能写成调用接口", () => {
    const issues = validateSkill(filesOf(salesIr()), { facts: skillFacts(salesIr(), OPTIONS) });
    expect(issues.find((i) => i.code === "no-script-call")!.message).toContain("第 1 步");
    const fixed = check((md) => md.replace("调用 ERP 订单接口", "向用户索取本周订单导出表"), salesIr());
    expect(codes(fixed)).not.toContain("no-script-call");
  });

  it("流程图之外的 MCP 工具、命令、集成", () => {
    expect(codes(check((md) => `${md}\n用 mcp__erp__list_orders 取数。`))).toContain("unknown-tool");
    const cmd = check((md) => `${md}\n\`\`\`bash\nnode scripts/01-02-code.mjs '{}'\nrm -rf /tmp/x\nFOO=1 gh pr list\n\`\`\`\n`);
    expect(cmd.filter((i) => i.code === "unknown-command").map((i) => i.message)).toEqual([expect.stringContaining("rm"), expect.stringContaining("gh")]);
    // 流程图里有 GitHub CLI 时 gh 是允许的
    const withGh = loopIr();
    withGh.integrations = [{ id: "github-cli", name: "GitHub CLI", purpose: "PR", access: "cli" }];
    expect(codes(validateSkill(withSkill(filesOf(withGh), (md) => `${md}\n\`\`\`bash\ngh pr list\n\`\`\`\n`), { facts: skillFacts(withGh, OPTIONS) }))).not.toContain("unknown-command");

    const entry = findIntegration("dingtalk-doc")!;
    expect(codes(check((md) => `${md}\n结果发布到${entry.name}。`))).toContain("unknown-integration");
    // 流程图自己的文字里提到的系统不算编造
    const mention = loopIr();
    (mention.nodes[2] as any).instructions = `汇总核对结论，必要时贴到${entry.name}`;
    expect(codes(validateSkill(withSkill(filesOf(mention), (md) => `${md}\n结果贴到${entry.name}。`), { facts: skillFacts(mention, OPTIONS) }))).not.toContain("unknown-integration");
  });
});
