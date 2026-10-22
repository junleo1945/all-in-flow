import { describe, expect, it } from "vitest";
import type { WorkflowIR } from "@aif/workflow-ir";
import { SKILL_CACHE_REV, skillCacheKey } from "../src/skill/cacheKey.js";

const ir = (title = "生成周报"): WorkflowIR =>
  ({
    version: 2,
    kind: "automation",
    slug: "weekly",
    name: "周报",
    description: "汇总周报。",
    trigger: { type: "manual", detail: "手动" },
    inputs: [],
    nodes: [{ id: "n1", type: "step", title, executor: "llm", instructions: "汇总", action: { kind: "llm", prompt: "生成" } }],
    edges: [],
    source: { painPointIds: [] },
  }) as unknown as WorkflowIR;

describe("Skill 导出的缓存键", () => {
  it("相同输入得到相同的键；流程图、目标、打包方式任何一个不同，键都不同", () => {
    const base = skillCacheKey({ ir: ir(), target: "generic", packaging: "zip" });
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(skillCacheKey({ ir: ir(), target: "generic", packaging: "zip" })).toBe(base);
    expect(skillCacheKey({ ir: ir("改了标题"), target: "generic", packaging: "zip" })).not.toBe(base);
    expect(skillCacheKey({ ir: ir(), target: "pi", packaging: "zip" })).not.toBe(base);
    expect(skillCacheKey({ ir: ir(), target: "generic", packaging: "claude-plugin" })).not.toBe(base);
  });

  it("有版本号常量，用来在拼装或校验逻辑变化时让旧缓存失效", () => {
    expect(Number.isInteger(SKILL_CACHE_REV)).toBe(true);
  });
});
