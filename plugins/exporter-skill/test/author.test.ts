import { describe, expect, it } from "vitest";
import { lower, type ExportFile, type WorkflowIR } from "@aif/workflow-ir";
import { skillExporter, assembleSkill, packageFiles, parseAuthorDraft, skillFacts, unconfirmedPaths, validateSkill, type AuthorDraft, type SkillFacts } from "../src/index.js";
import { loopIr, salesIr } from "./fixtures.js";

const OPTIONS = { target: "generic", packaging: "zip" } as const;

/** 按事实清单写出合规的步骤（模拟模型的好输出） */
function stepsFor(facts: SkillFacts): string {
  return facts.steps
    .map((s) => {
      const indent = "   ".repeat(s.number.split(".").length - 1);
      const head = `${indent}${s.number}. **${s.heading}**`;
      if (s.kind === "decision") return [head, ...(s.branches ?? []).map((b) => `${indent}   - ${b.label} → ${b.target === "结束" ? "结束" : `第 ${b.target} 步`}`)].join("\n");
      if (s.kind === "foreach") return `${head} 对每一项依次执行下面的子步骤。`;
      if (s.script) return `${head} 运行 \`${s.script.path}\`，把上一步的输出传入。`;
      if (s.executor === "human") return `${head} 把情况告诉用户，暂停，等用户回复后再继续。`;
      return `${head} 完成这一步。`;
    })
    .join("\n");
}

const draftFor = (facts: SkillFacts, over: Partial<AuthorDraft> = {}): AuthorDraft => ({
  description: "Reviews expense reports line by line and builds a result table. 当用户需要核对报销单、对账、检查发票金额时使用。",
  sections: {
    overview: "逐张核对报销单，给出核对结果表。",
    prerequisites: "需要 Node.js 20 及以上，见 `INSTALL.md`。",
    inputs: "向用户索取本周的报销单列表。",
    steps: stepsFor(facts),
    output: "一张核对结果表。",
    edgeCases: "报销单列表为空时，告诉用户没有可核对的内容。",
    conventions: "不要替用户做复核。因为复核结果决定是否放款。",
  },
  references: [],
  evals: [1, 2, 3].map((i) => ({ prompt: `帮我核对这批报销单 ${i}`, expected_output: "逐张核对并给出结果表" })),
  todo: [],
  ...over,
});

describe("parseAuthorDraft", () => {
  const good = () => JSON.parse(JSON.stringify({ ...draftFor(skillFacts(loopIr(), OPTIONS)), action: "done" }));

  it("合规的输出被接受", () => {
    const r = parseAuthorDraft(good());
    expect(r.problems).toEqual([]);
    expect(r.draft!.sections.steps).toContain("1.1.");
  });

  it("缺字段、空节、节里写了一二级标题时给出可读的问题", () => {
    const bad = good();
    delete bad.description;
    bad.sections.edgeCases = "  ";
    bad.sections.output = "## 自己加的标题\n内容";
    const { problems } = parseAuthorDraft(bad);
    expect(problems).toEqual(expect.arrayContaining(["缺少 description（字符串）", "sections.edgeCases 不能为空", expect.stringContaining("sections.output 里不要写一、二级标题")]));
    expect(parseAuthorDraft(null).problems.length).toBeGreaterThan(3);
  });

  it("可选的节可以留空；### 小标题允许", () => {
    const d = good();
    d.sections.prerequisites = "";
    d.sections.steps += "\n\n### 说明\n补充";
    expect(parseAuthorDraft(d).problems).toEqual([]);
  });

  it("references：路径白名单、不重名、不能为空；最多 5 个", () => {
    const d = good();
    d.references = [
      { path: "references/report-template.md", content: "模板" },
      { path: "../etc/passwd", content: "x" },
      { path: "references/Bad_Name.md", content: "x" },
      { path: "references/workflow.json", content: "x" },
      { path: "references/empty.md", content: " " },
    ];
    const { problems } = parseAuthorDraft(d, new Set(["references/workflow.mmd"]));
    expect(problems.filter((p) => p.includes("不合法"))).toHaveLength(3);
    expect(problems.some((p) => p.includes("references/empty.md 的内容不能为空"))).toBe(true);
    d.references = [{ path: "references/notes.md", content: "x" }];
    expect(parseAuthorDraft(d, new Set(["references/notes.md"])).problems[0]).toContain("重名");
    d.references = [{ path: "references/a.md", content: "x" }, { path: "references/a.md", content: "y" }];
    expect(parseAuthorDraft(d).problems[0]).toContain("重复");
    d.references = Array.from({ length: 6 }, (_, i) => ({ path: `references/a-${i}.md`, content: "x" }));
    expect(parseAuthorDraft(d).problems).toContain("references 最多 5 个文件");
  });

  it("evals 必须恰好 3 条", () => {
    const d = good();
    d.evals = d.evals.slice(0, 2);
    expect(parseAuthorDraft(d).problems).toContain("evals 必须恰好 3 条，现在是 2 条");
    d.evals = [...d.evals, { prompt: "x" }, { prompt: "y", expected_output: "z" }];
    expect(parseAuthorDraft(d).problems.some((p) => p.includes("非空的 prompt 和 expected_output"))).toBe(true);
  });

  it("todo 截断到 20 条、每条 200 字", () => {
    const d = good();
    d.todo = Array.from({ length: 30 }, () => "字".repeat(300));
    const { draft } = parseAuthorDraft(d);
    expect(draft!.todo).toHaveLength(20);
    expect(draft!.todo[0]).toHaveLength(200);
  });
});

describe("assembleSkill", () => {
  const ir = loopIr();
  const facts = skillFacts(ir, OPTIONS);
  const assembled = (over: Partial<AuthorDraft> = {}) => assembleSkill(ir, OPTIONS, draftFor(facts, over)).files;
  const skill = (files: ExportFile[]) => String(files.find((f) => f.path === "SKILL.md")!.content);

  it("SKILL.md 按固定顺序拼装，frontmatter 用模型的 description 和系统的 name", () => {
    const md = skill(assembled());
    expect(md).toMatch(/^---\nname: expense-check\ndescription: ".*Reviews expense reports.*"\n/);
    const order = ["# 报销单核对", "## 概述", "## 触发方式", "## 前置条件", "## 输入", "## 流程图", "## 执行步骤", "## 数据引用", "## 完成标准与输出", "## 边界情况", "## 执行约定"].map((h) => md.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(md).toContain("用户主动要求核对报销单时。");
  });

  it("留空的可选节不出现", () => {
    const md = skill(assembled({ sections: { ...draftFor(facts).sections, prerequisites: "", inputs: "" } }));
    expect(md).not.toContain("## 前置条件");
    expect(md).not.toContain("## 输入");
  });

  it("加入 references、evals/evals.json，INSTALL.md 末尾说明怎么继续打磨", () => {
    const files = assembled({ references: [{ path: "references/report-template.md", content: "# 模板" }] });
    expect(files.map((f) => f.path)).toEqual(expect.arrayContaining(["references/report-template.md", "evals/evals.json", "scripts/01-02-code.mjs"]));
    const evals = JSON.parse(String(files.find((f) => f.path === "evals/evals.json")!.content));
    expect(evals).toMatchObject({ skill_name: "expense-check", evals: [{ id: 1, files: [] }, { id: 2 }, { id: 3 }] });
    expect(String(files.find((f) => f.path === "INSTALL.md")!.content)).toContain("评测并改进这个 skill");
  });

  it("好草稿通过全部检查；骨架文件没有被改动", () => {
    const files = assembled();
    expect(validateSkill(files, { facts, requireEvals: true }).filter((i) => i.level === "error")).toEqual([]);
    const plain = skillExporter.compile(lower(ir), OPTIONS).map((f) => f.path.replace(/^expense-check\//, ""));
    expect(files.map((f) => f.path)).toEqual(expect.arrayContaining(plain));
  });

  it("模型写漏步骤、写出地址、引用了没有的文件、没有链接新增的 references 时被拦下", () => {
    const steps = stepsFor(facts).split("\n").filter((l) => !l.includes("1.2.")).join("\n");
    const bad = assembled({
      sections: { ...draftFor(facts).sections, steps: `${steps}\n见 \`references/missing.md\`。接口在 https://erp.corp.example/api。` },
      references: [{ path: "references/unused.md", content: "x" }],
    });
    const codes = validateSkill(bad, { facts, requireEvals: true }).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["step-missing", "missing-file", "secret", "reference-unlinked"]));
  });

  it("packageFiles 与 compile 的目录结构一致", () => {
    const files = assembled();
    expect(packageFiles(ir, files, { packaging: "zip" }).map((f) => f.path)[0]).toBe("expense-check/SKILL.md");
    const plugin = packageFiles(ir, files, { packaging: "claude-plugin" }).map((f) => f.path);
    expect(plugin[0]).toBe("expense-check/.claude-plugin/plugin.json");
    expect(plugin).toContain("expense-check/skills/expense-check/evals/evals.json");
  });
});

describe("unconfirmedPaths", () => {
  it("列出用到的、接口路径尚未确认的操作，没有用到时为空", () => {
    expect(unconfirmedPaths(loopIr())).toEqual([]);
    const w: WorkflowIR = salesIr();
    w.nodes = w.nodes.map((n) =>
      n.id === "n1" && n.type === "step"
        ? { ...n, action: { kind: "integration" as const, integration: "erp", operation: "listOrders", params: { start: "a", end: "b" } } }
        : n,
    );
    expect(unconfirmedPaths(w)).toEqual([expect.stringContaining("ERP_LISTORDERS_PATH")]);
  });
});
