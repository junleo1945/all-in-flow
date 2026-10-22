import { describe, expect, it } from "vitest";
import { validateSkill } from "@aif/plugin-exporter-skill";
import { IR_SPEC, IR_SYSTEM_PROMPT } from "../src/agent/irPrompt.js";
import { DEFAULT_MINUTES_PER_RUN, DURATION_BUCKETS, FREQ_PER_WEEK } from "../src/domain/profile.js";
import { buildSkillPackage, SKILL_NAME } from "../src/skillPackage/index.js";
import { createMcpTools } from "../src/mcp/tools.js";

const pkg = buildSkillPackage({ baseUrl: "https://aif.example.com/" });
const file = (path: string) => pkg.files.find((f) => f.path === path)!.content;
const skillMd = file("SKILL.md");

describe("本地 Skill 下载包", () => {
  it("符合 Agent Skills 规范：没有错误级别的问题", () => {
    // 校验器的「含网址」规则是给导出的工作流 Skill 防止泄漏带凭证的地址用的；
    // 这个 Skill 本来就要写网站地址，所以这条规则改成下面的白名单检查
    const issues = validateSkill(pkg.files, { name: SKILL_NAME }).filter((i) => i.code !== "secret");
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
  });

  it("文件里只出现两种网址：网站的连接指引页，和 IR 示例里的示例域名；没有令牌", () => {
    const urls = new Set(pkg.files.flatMap((f) => f.content.match(/https?:\/\/[^\s)>"'`]+/g) ?? []));
    expect([...urls].map((u) => u.replace(/[?{].*$/, "")).sort()).toEqual(["https://aif.example.com/skill", "https://erp.example.com/api/orders"]);
    for (const f of pkg.files) expect(f.content).not.toMatch(/aif_[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9]/);
  });

  it("只含 SKILL.md 和 references/，且 SKILL.md 引用的文件都存在", () => {
    expect(pkg.files.map((f) => f.path).sort()).toEqual(["SKILL.md", "references/interview-state.md", "references/ir-spec.md"]);
    for (const ref of skillMd.match(/references\/[\w-]+\.md/g) ?? []) expect(pkg.files.some((f) => f.path === ref)).toBe(true);
  });

  it("版本随内容变化，相同内容版本稳定；网站地址去掉末尾斜杠后写入", () => {
    expect(pkg.version).toMatch(/^[0-9a-f]{12}$/);
    expect(buildSkillPackage({ baseUrl: "https://aif.example.com" }).version).toBe(pkg.version);
    expect(buildSkillPackage({ baseUrl: "https://other.example.com" }).version).not.toBe(pkg.version);
    expect(skillMd).toContain("https://aif.example.com/skill");
    expect(skillMd).not.toContain("com//skill");
  });

  it("打分用的频率系数来自代码常量，不手写", () => {
    for (const [freq, n] of Object.entries(FREQ_PER_WEEK)) expect(skillMd).toContain(`${freq}=${n}`);
  });

  describe("与平台 MCP 工具保持一致", () => {
    const tools = createMcpTools({ db: undefined as never, publicBaseUrl: "http://x" });
    const importTool = tools.find((t) => t.name === "import_workflow")!;
    const props = (importTool.inputSchema as any).properties as Record<string, any>;

    it("SKILL.md 里提到的工具都存在", () => {
      const mentioned = new Set((skillMd.match(/`(\w+_workflow)`/g) ?? []).map((s) => s.replace(/`/g, "")));
      expect([...mentioned].sort()).toEqual(tools.map((t) => t.name).sort());
    });

    it("SKILL.md 里列出的参数名和字段名，都在工具的参数定义里", () => {
      for (const arg of ["ir", "workflowId", "role", "tasks", "painPoints"]) {
        expect(props[arg], arg).toBeDefined();
        expect(skillMd).toContain(`\`${arg}\``);
      }
      const taskFields = Object.keys(props.tasks.items.properties);
      const painFields = Object.keys(props.painPoints.items.properties);
      for (const f of ["id", "title", "frequency", "durationBucket", "minutesPerRun", "steps", "systems"]) expect(taskFields).toContain(f);
      for (const f of ["id", "taskId", "title", "detail", "severity", "automatable", "evidence"]) expect(painFields).toContain(f);
      expect(skillMd).toContain("id、title、frequency、durationBucket、minutesPerRun、steps、systems");
      expect(skillMd).toContain("id、taskId、title、detail、severity、automatable、evidence");
    });

    it("状态文件模板和 SKILL.md 里的耗时规则：档位文字、说不准、默认耗时都来自代码常量", () => {
      const state = file("references/interview-state.md");
      for (const b of Object.values(DURATION_BUCKETS)) expect(skillMd).toContain(`${b.label}=${b.minutes}`);
      expect(skillMd).toContain(`按 ${DEFAULT_MINUTES_PER_RUN} 分钟算`);
      expect(state).toContain("说不准");
      expect(state).toContain("未量化");
    });

    it("状态文件模板里的频率取值与工具定义一致", () => {
      const values = props.tasks.items.properties.frequency.enum as string[];
      for (const v of values) expect(file("references/interview-state.md")).toContain(v);
    });
  });

  it("IR 规范与编译器提示词共用同一份，且编译器提示词保持静态", () => {
    expect(file("references/ir-spec.md")).toContain(IR_SPEC);
    expect(IR_SYSTEM_PROMPT.endsWith(IR_SPEC)).toBe(true);
  });
});
