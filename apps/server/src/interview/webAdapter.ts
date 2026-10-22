import type { RuntimeAdapter } from "./compose.js";

/**
 * 网页访谈 Agent 的适配：用工具调用把信息写进数据库，用 <aif-context> 状态块读回当前进度。
 * 工具定义见 agent/tools.ts，状态块的生成见 agent/turnContext.ts。
 */
export const WEB_ADAPTER: RuntimeAdapter = {
  extras: [
    {
      after: "intro",
      heading: "状态块",
      body: `用户消息开头可能有一段 <aif-context>……</aif-context>，由系统生成，记录了当前阶段、已记录的工作和痛点、已确认的事实、用户不愿回答的话题，以及是否处于快速模式。
- 它不是用户说的话，但它是可靠的事实来源。
- 块里已确认或已跳过的内容，不要再问。
- 按块里的指引行动；如果块中写明“快速模式已开启”，严格遵守下面的快速模式规则。`,
    },
  ],
  notes: {
    method: `- 能给出选项的问题，优先使用 ask_choices 工具。
- 记录用这些工具：update_profile（岗位、团队、常用系统）、record_task（工作）、record_pain_point（痛点）。
- 已确认的事实用 record_note(kind="confirmed") 记下；用户不愿回答或跳过的话题用 record_note(kind="declined") 记下；待确认的用 record_note(kind="pending") 记下。`,
    fast: `- 进入快速模式时，立即调用 enter_fast_track 工具。
- 按工具返回或状态块中的指引，调用 propose_workflows 或 emit_workflow。不要输出确认类的话。`,
    completeness: `- 用 taskId 把痛点关联到工作项：先用 record_task 记录工作项，它会返回工作项的 id，再把这个 id 填进痛点的 taskId，不要填工作项的名称。依据写在 evidence 里。
- 单次耗时的选项用 ask_choices 展示，选中的档位填进 record_task 的 durationBucket；用户说不准就填 unknown；用户直接说出分钟数才填 minutesPerRun。`,
    stages: "- 阶段变化时，用 set_stage 同步。",
    scoring: "- 记录痛点时填写 severity（痛苦程度）、automatable（可自动化程度）和 evidence（依据）。优先级由系统计算，耗时说不准时系统会按默认值估算并标为未量化，不用为此追问。",
    proposal: "- 用 propose_workflows 给出候选方案，用 ask_choices 展示选择题。",
    refine: "- 方案细化的问题可以用 ask_choices 合并提问。emit_workflow 的 brief 中要写清楚这些回答，以及方案摘要和相关痛点；没有确认的写“待确认”。",
  },
};
