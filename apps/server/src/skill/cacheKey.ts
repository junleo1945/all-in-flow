import { createHash } from "node:crypto";
import type { WorkflowIR } from "@aif/workflow-ir";
import { AUTHOR_SYSTEM_PROMPT } from "./prompt.js";

/**
 * 改了拼装、校验等不在提示词里的逻辑、需要让已有缓存全部失效时，把它加一。
 * 提示词本身变化会自动改变键，不用动这里。
 */
export const SKILL_CACHE_REV = 1;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const PROMPT_HASH = sha(AUTHOR_SYSTEM_PROMPT);

/**
 * Skill 导出结果的缓存键：由模型实际看到的流程图（已套用补充回答）、导出选项和提示词版本决定。
 * 访谈画像摘录不参与：它只是辅助背景，不值得因为它变化就重新花一次 token；想要新结果可以「重新生成」。
 */
export function skillCacheKey(input: { ir: WorkflowIR; target: string; packaging: string }): string {
  return sha(JSON.stringify([SKILL_CACHE_REV, PROMPT_HASH, input.target, input.packaging, input.ir]));
}
