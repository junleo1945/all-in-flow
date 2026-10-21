/**
 * 模型撰写的 Skill 草稿（skill-export-v3.md 5.3）：协议、解析和基本形状检查。
 * 模型只产出 JSON，SKILL.md 由 assembleSkill 按固定顺序拼装，frontmatter 和各节的顺序不会被模型改坏。
 * 内容是否合规、是否忠实于流程图，由 validate.ts 检查。
 */

/** 模型负责撰写的各节，键名即协议里的字段名 */
export const SECTION_KEYS = ["overview", "prerequisites", "inputs", "steps", "output", "edgeCases", "conventions"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

/** 各节在 SKILL.md 中的标题；「执行步骤」这个标题校验器依赖，不能改 */
export const SECTION_HEADINGS: Record<SectionKey, string> = {
  overview: "概述",
  prerequisites: "前置条件",
  inputs: "输入",
  steps: "执行步骤",
  output: "完成标准与输出",
  edgeCases: "边界情况",
  conventions: "执行约定",
};

/** 必须有内容的节；其余可以留空（留空则不出现这一节） */
const REQUIRED: SectionKey[] = ["overview", "steps", "output", "edgeCases", "conventions"];

export interface AuthorDraft {
  description: string;
  sections: Record<SectionKey, string>;
  /** 模型新增的参考文件，只能是 references/ 下的 Markdown */
  references: Array<{ path: string; content: string }>;
  /** 给用户在本地用 skill-creator 评测的测试提示 */
  evals: Array<{ prompt: string; expected_output: string }>;
  /** 留给用户确认的事项 */
  todo: string[];
}

export const MAX_REFERENCES = 5;
export const MAX_SECTION_CHARS = 20_000;
export const MAX_TODO = 20;
const REFERENCE_PATH = /^references\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const HEADING = /^#{1,2}\s/m;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/**
 * 解析模型输出的 done 对象。问题的说明写给模型看。
 * reserved 是骨架里已有的文件路径，模型新增的文件不能与之重名。
 */
export function parseAuthorDraft(raw: unknown, reserved: ReadonlySet<string> = new Set()): { draft?: AuthorDraft; problems: string[] } {
  const problems: string[] = [];
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const description = str(o.description)?.trim() ?? "";
  if (!description) problems.push("缺少 description（字符串）");

  const rawSections = (o.sections && typeof o.sections === "object" ? o.sections : {}) as Record<string, unknown>;
  const sections = {} as Record<SectionKey, string>;
  for (const key of SECTION_KEYS) {
    const text = str(rawSections[key])?.trim() ?? "";
    sections[key] = text;
    if (!text && REQUIRED.includes(key)) problems.push(`sections.${key} 不能为空`);
    if (text.length > MAX_SECTION_CHARS) problems.push(`sections.${key} 太长（超过 ${MAX_SECTION_CHARS} 字符），把细节移到 references 文件`);
    if (HEADING.test(text)) problems.push(`sections.${key} 里不要写一、二级标题（# 或 ##），这一节的标题由系统添加；需要小标题时用 ### 或加粗`);
  }

  const references: AuthorDraft["references"] = [];
  const rawRefs = Array.isArray(o.references) ? o.references : o.references === undefined ? [] : null;
  if (rawRefs === null) problems.push("references 必须是数组");
  else {
    if (rawRefs.length > MAX_REFERENCES) problems.push(`references 最多 ${MAX_REFERENCES} 个文件`);
    for (const r of rawRefs.slice(0, MAX_REFERENCES) as Array<Record<string, unknown>>) {
      const path = str(r?.path);
      const content = str(r?.content);
      if (!path || !REFERENCE_PATH.test(path)) problems.push(`references 的路径 ${JSON.stringify(path)} 不合法：只能是 references/小写英文-连字符.md`);
      else if (reserved.has(path) || references.some((x) => x.path === path)) problems.push(`references 的路径 ${path} 重复或与已有文件重名`);
      else if (!content?.trim()) problems.push(`${path} 的内容不能为空`);
      else if (content.length > MAX_SECTION_CHARS) problems.push(`${path} 太长（超过 ${MAX_SECTION_CHARS} 字符），请拆开`);
      else references.push({ path, content });
    }
  }

  const evals: AuthorDraft["evals"] = [];
  if (!Array.isArray(o.evals)) problems.push("evals 必须是恰好 3 条测试提示的数组");
  else {
    for (const e of o.evals as Array<Record<string, unknown>>) {
      const prompt = str(e?.prompt)?.trim();
      const expected = str(e?.expected_output)?.trim();
      if (prompt && expected) evals.push({ prompt, expected_output: expected });
      else problems.push("evals 的每一条都要有非空的 prompt 和 expected_output");
    }
    if (o.evals.length !== 3) problems.push(`evals 必须恰好 3 条，现在是 ${o.evals.length} 条`);
  }

  const todo = (Array.isArray(o.todo) ? o.todo : []).filter((t): t is string => typeof t === "string" && !!t.trim()).slice(0, MAX_TODO).map((t) => t.trim().slice(0, 200));

  if (problems.length) return { problems };
  return { draft: { description, sections, references, evals, todo }, problems };
}

/** skill-creator 的 evals/evals.json 格式 */
export function evalsJson(skillName: string, draft: Pick<AuthorDraft, "evals">): string {
  return (
    JSON.stringify(
      { skill_name: skillName, evals: draft.evals.map((e, i) => ({ id: i + 1, prompt: e.prompt, expected_output: e.expected_output, files: [] })) },
      null,
      2,
    ) + "\n"
  );
}
