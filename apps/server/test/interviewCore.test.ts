import { describe, expect, it } from "vitest";
import { INTERVIEW_SYSTEM_PROMPT } from "../src/agent/prompt.js";
import { INTERVIEW_TOOL_NAMES, STAGES as TOOL_STAGES } from "../src/agent/tools.js";
import { composePrompt } from "../src/interview/compose.js";
import { CORE_SECTIONS, INTRO, MAX_DIG_QUESTIONS, MAX_REFINE_QUESTIONS, STAGES, STAGE_ORDER } from "../src/interview/core.js";
import { WEB_ADAPTER } from "../src/interview/webAdapter.js";
import { localAdapter } from "../src/interview/localAdapter.js";
import { DEFAULT_MINUTES_PER_RUN, DURATION_BUCKETS } from "../src/domain/profile.js";
import { buildSkillPackage } from "../src/skillPackage/index.js";

const skillMd = buildSkillPackage({ baseUrl: "https://aif.example.com" }).files.find((f) => f.path === "SKILL.md")!.content;
const coreText = [INTRO, ...CORE_SECTIONS.flatMap((s) => [s.heading, s.body])].join("\n");

describe("访谈方法论核心", () => {
  it("核心里没有任何运行环境相关的名词：工具名、状态块、状态文件、MCP", () => {
    for (const name of INTERVIEW_TOOL_NAMES) expect(coreText, name).not.toContain(name);
    for (const word of ["aif-context", "状态块", "状态文件", "interview.md", "MCP", "import_workflow", "validate_workflow", "enter_fast_track"]) {
      expect(coreText, word).not.toContain(word);
    }
    // 任何 snake_case 的标识符都说明混进了工具或字段名（频率取值 ad_hoc 除外）
    expect((coreText.match(/\b[a-z]+_[a-z_]+\b/g) ?? []).filter((w) => w !== "ad_hoc")).toEqual([]);
  });

  it("阶段与工具里的阶段枚举一致", () => {
    expect(STAGES.map(([key]) => key)).toEqual([...TOOL_STAGES]);
  });

  it("数字来自常量：深挖问题数、细化问题数、默认耗时", () => {
    const text = CORE_SECTIONS.map((s) => s.body).join("\n");
    expect(text).toContain(`深挖最多主动问 ${MAX_DIG_QUESTIONS} 个问题`);
    expect(text).toContain(`最多再问 ${MAX_REFINE_QUESTIONS} 个问题`);
    expect(text).toContain(STAGE_ORDER);
    expect(text).toContain(`${DEFAULT_MINUTES_PER_RUN} 分钟`);
  });

  it("一次访谈只聚焦一件工作、一个痛点；出现多个时让用户选，没选的留到下次", () => {
    const body = CORE_SECTIONS.find((s) => s.id === "focus")!.body;
    expect(INTRO).toContain("只聚焦用户的一件工作");
    expect(body).toContain("不主动盘点用户的其他工作");
    expect(body).toContain("出一道选择题");
    expect(body).toContain("说不准，帮我挑");
    expect(body).toContain("下次访谈再聊");
    // 不能再有凑够几件工作才出方案的门槛
    expect(coreText).not.toMatch(/工作达到 \d+ 件/);
  });

  it("岗位第一个问、单独一轮、不猜；选工作在下一轮；选择题的问题只写一次", () => {
    const stages = CORE_SECTIONS.find((s) => s.id === "stages")!.body;
    expect(stages).toContain("第一个问题问岗位");
    expect(stages).toContain("不要根据他的描述去猜");
    expect(stages).toContain("这一轮只问岗位，不同时出选择题");
    expect(CORE_SECTIONS.find((s) => s.id === "focus")!.body).toContain("选工作放在问清岗位之后的下一轮");
    expect(CORE_SECTIONS.find((s) => s.id === "method")!.body).toContain("出选择题时，问题只写一次");
    expect(INTERVIEW_SYSTEM_PROMPT).toContain("问题只放在 question 里");
  });

  it("问耗时的规则：给档位选项、只问一次、说不准就不再追问；选项文字来自领域常量", () => {
    const body = CORE_SECTIONS.find((s) => s.id === "completeness")!.body;
    for (const b of Object.values(DURATION_BUCKETS)) expect(body).toContain(b.label);
    expect(body).toContain("说不准");
    expect(body).toContain("不要追问");
    expect(body).toContain("不要让用户报具体分钟数");
    // 不能再把耗时当成"完整"的门槛
    expect(coreText).not.toContain("完整工作");
    expect(coreText).not.toContain("都拿到后才算完整");
  });
});

describe("网页提示词与本地 Skill 出自同一份核心", () => {
  it("开场白和每个核心小节（标题和正文）都逐字出现在两边", () => {
    for (const text of [INTERVIEW_SYSTEM_PROMPT, skillMd]) {
      expect(text).toContain(INTRO);
      for (const s of CORE_SECTIONS) {
        expect(text, s.heading).toContain(`## ${s.heading}\n${s.body}`);
      }
    }
  });

  it("核心小节在两边的顺序一致", () => {
    for (const text of [INTERVIEW_SYSTEM_PROMPT, skillMd]) {
      const at = CORE_SECTIONS.map((s) => text.indexOf(`## ${s.heading}\n`));
      expect(at.every((i) => i >= 0)).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
    }
  });

  it("网页提示词保持完全静态：只由核心和适配生成，重复生成结果相同，没有残留的占位符", () => {
    expect(composePrompt(WEB_ADAPTER)).toBe(INTERVIEW_SYSTEM_PROMPT);
    expect(composePrompt(localAdapter({ baseUrl: "https://x" }))).toBe(composePrompt(localAdapter({ baseUrl: "https://x" })));
    for (const text of [INTERVIEW_SYSTEM_PROMPT, skillMd]) expect(text).not.toMatch(/\$\{|undefined|NaN|\[object/);
  });

  it("适配之间互不串味：网页提示词里没有本地的东西，Skill 里没有网页的东西", () => {
    for (const word of ["状态文件", "interview.md", "MCP", "import_workflow", "validate_workflow", "references/"]) {
      expect(INTERVIEW_SYSTEM_PROMPT, word).not.toContain(word);
    }
    for (const word of ["aif-context", "状态块", ...INTERVIEW_TOOL_NAMES]) {
      expect(skillMd, word).not.toContain(word);
    }
  });

  it("网页提示词里提到的工具都真实存在", () => {
    const mentioned = new Set((INTERVIEW_SYSTEM_PROMPT.match(/\b[a-z]+_[a-z_]+\b/g) ?? []));
    for (const name of mentioned) expect(INTERVIEW_TOOL_NAMES as readonly string[], name).toContain(name);
    // 流程上用到的工具都交代了用法
    for (const name of ["ask_choices", "update_profile", "record_task", "record_pain_point", "record_note", "set_stage", "enter_fast_track", "propose_workflows", "emit_workflow"]) {
      expect(mentioned.has(name), name).toBe(true);
    }
  });

  it("适配的补充只挂在存在的核心小节上", () => {
    const ids = new Set(CORE_SECTIONS.map((s) => s.id));
    for (const adapter of [WEB_ADAPTER, localAdapter({ baseUrl: "https://x" })]) {
      for (const id of Object.keys(adapter.notes)) expect(ids.has(id as never), id).toBe(true);
      for (const e of adapter.extras) expect(e.after === "intro" || ids.has(e.after), e.heading).toBe(true);
    }
  });
});
