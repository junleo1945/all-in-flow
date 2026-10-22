import { CORE_SECTIONS, INTRO, type SectionId } from "./core.js";

/** 适配独有的小节：核心里没有、只在某个运行环境里需要的内容 */
export interface ExtraSection {
  /** 放在哪个位置之后：开场白，或某个核心小节 */
  after: "intro" | SectionId;
  heading: string;
  body: string;
}

/**
 * 运行环境适配：告诉模型在这个环境里怎么落实核心规则。
 * notes 紧跟在对应核心小节的正文后面（每行一条，以「- 」开头）。
 */
export interface RuntimeAdapter {
  /** 接在开场白后面的句子 */
  introTail?: string;
  notes: Partial<Record<SectionId, string>>;
  extras: ExtraSection[];
}

const section = (heading: string, body: string) => `## ${heading}\n${body}`;

/**
 * 核心 + 适配 → 完整的提示词正文。结果只取决于核心和适配，不含任何运行时的变量，
 * 所以网页访谈的系统提示词保持完全静态，可以命中模型缓存。
 */
export function composePrompt(adapter: RuntimeAdapter): string {
  const parts: string[] = [INTRO + (adapter.introTail ?? "")];
  const extrasAfter = (id: ExtraSection["after"]) => adapter.extras.filter((e) => e.after === id).map((e) => section(e.heading, e.body));

  parts.push(...extrasAfter("intro"));
  for (const core of CORE_SECTIONS) {
    const note = adapter.notes[core.id];
    parts.push(section(core.heading, note ? `${core.body}\n${note}` : core.body));
    parts.push(...extrasAfter(core.id));
  }
  return parts.join("\n\n");
}
