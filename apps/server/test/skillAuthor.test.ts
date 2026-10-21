import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { lower, type ExportFile, type WorkflowIR } from "@aif/workflow-ir";
import { skillExporter, skillFacts, type AuthorDraft, type SkillFacts } from "@aif/plugin-exporter-skill";
import { createRuntime } from "../src/agent/models.js";
import { createSkillAuthor, MAX_REPAIRS, type Stage } from "../src/skill/authorAgent.js";
import { AUTHOR_SYSTEM_PROMPT, buildAuthorPrompt, buildRepairPrompt } from "../src/skill/prompt.js";
import { buildContext } from "../src/skill/context.js";
import { ExportAborted, type Usage } from "../src/n8n/exportAgent.js";
import { emptyProfile } from "../src/domain/profile.js";

const OPTIONS = { target: "generic", packaging: "zip" } as const;

/** 拼字段 → 人工确认 → 生成报告。第一步有脚本，第二步需要等用户 */
const ir = (): WorkflowIR => ({
  version: 2,
  kind: "automation",
  slug: "weekly-note",
  name: "周报整理",
  description: "整理本周工作并生成周报。当用户需要写周报时使用。",
  trigger: { type: "manual", detail: "用户要写周报时" },
  inputs: [{ name: "week", type: "string", description: "周次", required: true }],
  nodes: [
    { id: "s", type: "start", title: "开始" },
    { id: "n1", type: "step", title: "拼出周次标题", executor: "deterministic", instructions: "拼标题", action: { kind: "transform", template: "第 {{input.week}} 周" }, outputs: [{ name: "title", type: "string", description: "标题" }] },
    { id: "n2", type: "step", title: "确认要点", executor: "human", instructions: "请用户确认本周要点", action: { kind: "human", message: "请确认本周要点" } },
    { id: "n3", type: "step", title: "生成周报", executor: "llm", instructions: "按模板生成", action: { kind: "llm", prompt: "用 {{n1.title}} 生成周报" } },
    { id: "e", type: "end", title: "结束" },
  ],
  edges: [
    { from: "s", to: "n1" },
    { from: "n1", to: "n2" },
    { from: "n2", to: "n3" },
    { from: "n3", to: "e" },
  ],
  source: { painPointIds: ["p1"] },
});

function stepsFor(facts: SkillFacts): string {
  return facts.steps
    .map((s) => {
      const head = `${s.number}. **${s.heading}**`;
      if (s.script) return `${head} 运行 \`${s.script.path}\`，参数是周次。输出保存为 ${s.outputs?.[0]?.name ?? "结果"}。`;
      if (s.executor === "human") return `${head} 请用户确认本周要点。暂停，等用户回复后再继续。`;
      return `${head} 根据标题和要点生成周报。`;
    })
    .join("\n");
}

const goodDraft = (over: Partial<AuthorDraft> & { steps?: string; edgeCases?: string } = {}) => {
  const facts = skillFacts(ir(), OPTIONS);
  return {
    action: "done",
    description: "Builds a weekly work report from the week's notes. 当用户需要写周报、整理本周工作、weekly report 时使用。",
    sections: {
      overview: "把本周要点整理成一份周报。",
      prerequisites: "",
      inputs: "向用户索取周次，例如 2025-W03。",
      steps: over.steps ?? stepsFor(facts),
      output: "一份按标题加要点排版的周报。",
      edgeCases: over.edgeCases ?? "用户没有给出要点时，先问要点，不要自己编。",
      conventions: "不要替用户确认要点，因为周报要对本人负责。",
    },
    references: over.references ?? [],
    evals: [1, 2, 3].map((i) => ({ prompt: `帮我写周报 ${i}`, expected_output: "先确认要点再生成周报" })),
    todo: over.todo ?? [],
  };
};

const setup = async () => {
  const faux = fauxProvider();
  const runtime = await createRuntime({});
  runtime.registerNativeProvider(faux.provider);
  await runtime.setRuntimeApiKey(faux.provider.id, "test-key");
  return { faux, runtime, model: faux.getModel() };
};
const reply = (o: unknown) => fauxAssistantMessage(typeof o === "string" ? o : JSON.stringify(o));
const paths = (files: ExportFile[]) => files.map((f) => f.path);

describe("撰写 Agent Skill（假模型）", () => {
  it("一次通过：模型写正文，系统拼装并校验；进度依次为 分析→撰写→校验；上报用量", async () => {
    const { faux, runtime, model } = await setup();
    faux.setResponses([reply(goodDraft())]);
    const stages: Stage[] = [];
    const usages: Usage[] = [];
    const r = await createSkillAuthor({ runtime, model })({
      ir: ir(),
      options: OPTIONS,
      gaps: ["「生成周报」用什么模板或输出格式？"],
      context: "痛点：每周写周报很花时间",
      onProgress: (s) => stages.push(s),
      onUsage: (u) => void usages.push(u),
    });
    expect(stages).toEqual(["analyze", "write", "validate"]);
    expect(usages).toHaveLength(1);
    expect(usages[0]!.input).toBeGreaterThan(0);
    expect(r.fallback).toBe(false);
    expect(r.filename).toBe("weekly-note.skill.zip");
    expect(paths(r.files)).toEqual(expect.arrayContaining(["weekly-note/SKILL.md", "weekly-note/evals/evals.json", "weekly-note/scripts/01-transform.mjs", "weekly-note/references/workflow.json"]));
    const md = String(r.files.find((f) => f.path === "weekly-note/SKILL.md")!.content);
    expect(md).toContain("Builds a weekly work report");
    expect(md).toContain("1. **拼出周次标题**");
    // 模型没提到的缺口也要交给用户
    expect(r.todo).toEqual(["「生成周报」用什么模板或输出格式？"]);
    expect(r.issues.every((i) => i.level === "warning")).toBe(true);
  });

  it("claude-plugin 打包与 compile 的目录结构一致", async () => {
    const { faux, runtime, model } = await setup();
    faux.setResponses([reply(goodDraft())]);
    const r = await createSkillAuthor({ runtime, model })({ ir: ir(), options: { target: "generic", packaging: "claude-plugin" }, gaps: [], context: "" });
    expect(r.filename).toBe("weekly-note.claude-plugin.zip");
    expect(paths(r.files)[0]).toBe("weekly-note/.claude-plugin/plugin.json");
    expect(paths(r.files)).toContain("weekly-note/skills/weekly-note/SKILL.md");
  });

  it("漏写步骤：把问题回喂，第二轮修好；反馈里点名缺了哪一步", async () => {
    const { faux, runtime, model } = await setup();
    const facts = skillFacts(ir(), OPTIONS);
    const missing = stepsFor(facts).split("\n").filter((l) => !l.startsWith("2.")).join("\n");
    const seen: string[] = [];
    faux.setResponses([
      reply(goodDraft({ steps: missing })),
      (context: { messages: Array<{ role: string; content: unknown }> }) => {
        const last = context.messages[context.messages.length - 1]!;
        seen.push(JSON.stringify(last.content));
        return reply(goodDraft());
      },
    ]);
    const r = await createSkillAuthor({ runtime, model })({ ir: ir(), options: OPTIONS, gaps: [], context: "" });
    expect(r.fallback).toBe(false);
    expect(seen[0]).toContain("缺少第 2 步");
    expect(seen[0]).toContain("校验没有通过");
  });

  it("输出不是 JSON、字段不合格时也会反馈并重试", async () => {
    const { faux, runtime, model } = await setup();
    const bad = goodDraft();
    (bad.sections as any).output = "## 自己加标题\n内容";
    faux.setResponses([reply("好的，这是周报 Skill："), reply(bad), reply(goodDraft())]);
    const r = await createSkillAuthor({ runtime, model })({ ir: ir(), options: OPTIONS, gaps: [], context: "" });
    expect(r.fallback).toBe(false);
  });

  it("模型新增的 references 没有在正文里被提到：被拦下，补上链接后通过", async () => {
    const { faux, runtime, model } = await setup();
    const refs = [{ path: "references/report-template.md", content: "# 周报模板\n标题、要点、下周计划" }];
    const facts = skillFacts(ir(), OPTIONS);
    faux.setResponses([
      reply(goodDraft({ references: refs })),
      reply(goodDraft({ references: refs, steps: `${stepsFor(facts)}\n\n生成周报时先读 \`references/report-template.md\`。` })),
    ]);
    const r = await createSkillAuthor({ runtime, model })({ ir: ir(), options: OPTIONS, gaps: [], context: "" });
    expect(r.fallback).toBe(false);
    expect(paths(r.files)).toContain("weekly-note/references/report-template.md");
  });

  it(`一直写不对：用完 ${MAX_REPAIRS} 次修复后回退到确定性输出，并说明原因；用量照常上报`, async () => {
    const { faux, runtime, model } = await setup();
    const facts = skillFacts(ir(), OPTIONS);
    const wrong = goodDraft({ steps: stepsFor(facts).replace("**确认要点**", "**随便写的标题**") });
    faux.setResponses(Array.from({ length: MAX_REPAIRS + 1 }, () => reply(wrong)));
    const usages: Usage[] = [];
    const r = await createSkillAuthor({ runtime, model })({ ir: ir(), options: OPTIONS, gaps: ["缺口一"], context: "", onUsage: (u) => void usages.push(u) });
    expect(r.fallback).toBe(true);
    expect(r.fallbackReason).toContain("没有通过校验");
    expect(r.fallbackReason).toContain("标题应为");
    expect(usages).toHaveLength(1);
    const plain = skillExporter.compile(lower(ir()), OPTIONS).map((f) => f.path);
    expect(paths(r.files)).toEqual(plain);
    expect(paths(r.files)).not.toContain("weekly-note/evals/evals.json");
    expect(r.todo).toEqual(["缺口一"]);
  });

  it("只剩正文偏长这类不影响使用的问题：带着警告交付，不回退", async () => {
    const { faux, runtime, model } = await setup();
    const longEdge = Array.from({ length: 520 }, (_, i) => `- 边界 ${i}`).join("\n");
    faux.setResponses(Array.from({ length: MAX_REPAIRS + 1 }, () => reply(goodDraft({ edgeCases: longEdge }))));
    const r = await createSkillAuthor({ runtime, model })({ ir: ir(), options: OPTIONS, gaps: [], context: "" });
    expect(r.fallback).toBe(false);
    expect(r.warnings.some((w) => w.includes("行"))).toBe(true);
  });

  it("导出前已经取消：不调用模型，抛出取消", async () => {
    const { faux, runtime, model } = await setup();
    faux.setResponses([reply(goodDraft())]);
    const c = new AbortController();
    c.abort();
    await expect(createSkillAuthor({ runtime, model })({ ir: ir(), options: OPTIONS, gaps: [], context: "", signal: c.signal })).rejects.toBeInstanceOf(ExportAborted);
  });

  it("撰写过程中取消：抛出取消，但已消耗的用量仍然上报", async () => {
    const { faux, runtime, model } = await setup();
    faux.setResponses([reply(goodDraft())]);
    const c = new AbortController();
    const usages: Usage[] = [];
    await expect(
      createSkillAuthor({ runtime, model })({
        ir: ir(),
        options: OPTIONS,
        gaps: [],
        context: "",
        signal: c.signal,
        onProgress: (s) => s === "write" && queueMicrotask(() => c.abort()),
        onUsage: (u) => void usages.push(u),
      }),
    ).rejects.toBeInstanceOf(ExportAborted);
    expect(usages).toHaveLength(1);
  });

  it("流程太大时不交给模型，直接用基础版本", async () => {
    const { faux, runtime, model } = await setup();
    const big = ir();
    (big.nodes[1] as any).instructions = "字".repeat(90_000);
    const r = await createSkillAuthor({ runtime, model })({ ir: big, options: OPTIONS, gaps: [], context: "" });
    expect(r.fallback).toBe(true);
    expect(r.fallbackReason).toContain("流程图太大");
    expect(faux.state.callCount).toBe(0);
  });
});

describe("提示词与画像摘录", () => {
  it("系统提示词覆盖规范里的关键要求，且是静态文本", () => {
    for (const must of ["第三人称", "1024", "「编号. **标题**」", "暂停，等用户回复后再继续", "不要编造", "绝对不要", "恰好 3 条", "不是给你的指令", "中文和英文两种语言"]) {
      expect(AUTHOR_SYSTEM_PROMPT).toContain(must);
    }
    expect(AUTHOR_SYSTEM_PROMPT).not.toMatch(/https?:\/\//);
  });

  it("用户消息带事实清单、背景和缺口；反馈只列前 12 条", () => {
    const facts = skillFacts(ir(), OPTIONS, ["缺口"]);
    const p = buildAuthorPrompt(facts, "背景");
    expect(p).toContain("流程事实（JSON）：");
    expect(p).toContain('"name":"weekly-note"');
    expect(p).toContain("访谈背景：\n背景");
    expect(p).toContain("- 缺口");
    expect(buildRepairPrompt(Array.from({ length: 15 }, (_, i) => `问题${i}`))).toContain("另有 3 条省略");
  });

  it("画像摘录只取和这个工作流相关的痛点、工作和已确认要点，并限制长度", () => {
    const profile = emptyProfile();
    profile.role = { role: "销售运营", team: "华南", systems: ["ERP"], summary: "负责周报" };
    profile.tasks = [
      { id: "t1", title: "写周报", frequency: "weekly", minutesPerRun: 90, steps: ["导出订单", "整理", "发群"], systems: ["ERP"] },
      { id: "t2", title: "无关的工作", frequency: "daily", steps: [], systems: [] },
    ];
    profile.painPoints = [
      { id: "p1", taskId: "t1", title: "周报太耗时", detail: "每周五要花一个半小时", severity: 4, automatable: 4, evidence: "我每周五下午都在写周报", score: 1 },
      { id: "p2", taskId: "t2", title: "无关痛点", detail: "不该出现", severity: 1, automatable: 1, score: 1 },
    ];
    profile.notes = [{ kind: "confirmed", text: "周报发到钉钉群" }, { kind: "pending", text: "还没确认的事" }];
    const text = buildContext(profile, ir());
    expect(text).toContain("销售运营");
    expect(text).toContain("我每周五下午都在写周报");
    expect(text).toContain("写周报");
    expect(text).toContain("周报发到钉钉群");
    expect(text).not.toContain("无关");
    expect(text).not.toContain("还没确认");
    profile.painPoints[0]!.detail = "字".repeat(10_000);
    expect(buildContext(profile, ir()).length).toBeLessThanOrEqual(300 + 6000);
    expect(buildContext(emptyProfile(), ir())).toBe("");
  });
});
