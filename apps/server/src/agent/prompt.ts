import { composePrompt } from "../interview/compose.js";
import { WEB_ADAPTER } from "../interview/webAdapter.js";

/**
 * 访谈 Agent 的系统提示词（design.md 5.2）。
 * 方法论来自与本地 Skill 共用的核心（interview/core.ts），再叠加网页环境的适配（interview/webAdapter.ts：
 * 工具调用与状态块）。要改方法论改核心，要改工具用法改适配，不要在这里直接写文案。
 * 必须保持完全静态：静态前缀才能命中 DeepSeek 的缓存。动态信息只放在用户消息开头的 <aif-context> 块里。
 */
export const INTERVIEW_SYSTEM_PROMPT = composePrompt(WEB_ADAPTER);
