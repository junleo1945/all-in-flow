import { DEFAULT_MINUTES_PER_RUN, DURATION_BUCKETS, FREQ_PER_WEEK } from "../domain/profile.js";
import type { RuntimeAdapter } from "./compose.js";

/** 状态文件的位置（相对用户的当前工作目录） */
export const STATE_FILE = ".all-in-flow/interview.md";
export const IR_FILE = ".all-in-flow/workflow.json";
/** 网站上说明如何连接的页面路径 */
export const SETUP_PATH = "/skill";

const durationTable = Object.values(DURATION_BUCKETS).map((b) => `${b.label}=${b.minutes}`).join("，");
const freqTable = (["daily", "weekly", "monthly", "ad_hoc"] as const).map((f) => `${f}=${FREQ_PER_WEEK[f]}`).join("，");

/**
 * 本地 Skill 的适配：信息写进本地状态文件，工作流由本地模型按 IR 规范写出，
 * 再通过平台 MCP 校验、导入，换回流程图链接。工具定义见 mcp/tools.ts。
 */
export function localAdapter(opts: { baseUrl: string }): RuntimeAdapter {
  return {
    introTail: "访谈结束后，你要生成一个流程图页面链接交给用户。",
    extras: [
      {
        after: "intro",
        heading: "开始之前",
        body: `1. 看当前目录下有没有 \`${STATE_FILE}\`。有，就读完，告诉用户上次进行到哪一步，问是继续还是重新开始；没有，就按 references/interview-state.md 的模板创建。
2. 看一下有没有 \`import_workflow\` 和 \`validate_workflow\` 工具（来自名为 all-in-flow 的 MCP 服务）。没有也可以访谈，只是最后拿不到流程图链接，见「生成工作流」一节末尾。`,
      },
      {
        after: "method",
        heading: "状态文件",
        body: `\`${STATE_FILE}\` 是你的记忆：每轮开始前先读一遍，信息有变化就立即更新。格式见 references/interview-state.md。
- 里面已确认或已跳过的内容，不要再问。
- 里面可能有工作细节，提醒用户不要把 \`.all-in-flow/\` 目录提交到 git。
- 没有写文件的能力时，在关键进展后把当前记录用简短表格贴给用户，并在后续对话中沿用。`,
      },
      {
        after: "refine",
        heading: "生成工作流",
        body: `1. 读 references/ir-spec.md，按里面的规则写出 Workflow IR v2 的 JSON。把方案摘要、相关痛点，以及上一步确认的系统和判断依据都落实到步骤里，没有确认的写「待确认」。
2. 调用 \`validate_workflow\`，参数 \`ir\` 是这份 JSON。不通过就按提示修改后再校验，最多 3 轮。不要把整份 JSON 贴在聊天里给用户看。
3. 校验通过后调用 \`import_workflow\`：
   - \`ir\`：校验通过的那份 JSON；
   - \`role\`、\`tasks\`、\`painPoints\`：来自状态文件。tasks 的字段是 id、title、frequency、durationBucket、minutesPerRun、steps、systems（durationBucket 取 quick、half_hour、hours、half_day、day，说不准填 unknown；用户直接说出分钟数的才填 minutesPerRun）；painPoints 的字段是 id、taskId、title、detail、severity、automatable、evidence。ir.source.painPointIds 要引用这里的痛点 id；
   - 修改已导入的工作流时，再传 \`workflowId\`（上一次返回的），保存为新版本，链接不变，此时不用再传画像。
4. 把返回的流程图链接交给用户，说明要用公司账号登录后才能查看，也可以在网站工作台里继续修改。把返回的 workflowId 记进状态文件。
5. 用户对流程提出修改时，改 IR，再校验、导入（带 workflowId）。

**没有 \`import_workflow\` 工具时：** 把 IR 保存到 \`${IR_FILE}\`，用 Mermaid flowchart 在对话里把流程画出来，并告诉用户：打开 ${opts.baseUrl}${SETUP_PATH} 按页面指引连接 All-in-Flow，之后说「导入工作流」，你就把已保存的 IR 导入。`,
      },
    ],
    notes: {
      method: `- 能给出选项时，给 2 到 4 个编号选项，让用户回复编号或自己的话；环境里有提问工具（如 AskUserQuestion）时优先用它。
- 记录就是写进状态文件：工作项和痛点记到对应的表，确认的事实记到「已确认」，跳过的话题记到「已跳过」，待确认的记到「待确认」。`,
      fast: "- 把状态文件里的「快速模式」改成「是」。",
      completeness: `- 工作项和痛点记在状态文件的表格里，每个痛点的「所属工作」填工作项的 id，依据写在「依据」一列。
- 单次耗时记在「单次耗时」一列：用户选了档位就写档位文字，说不准写「说不准」，用户直接说出的写分钟数。`,
      stages: "- 每次切换阶段，更新状态文件里的「阶段」。",
      scoring: `- 每周发生次数：${freqTable}。优先级 = 每周发生次数 × 单次耗时（分钟） × 痛苦程度 × 可自动化程度，算出来填进状态文件的「优先级」一列。
- 档位对应的分钟数：${durationTable}。耗时说不准的，按 ${DEFAULT_MINUTES_PER_RUN} 分钟算，并在优先级后面标「（未量化）」。`,
      proposal: "- 候选方案记到状态文件的「候选方案」里。",
      refine: "- 用户的回答要落实到生成的工作流步骤里，没有确认的写「待确认」。",
      boundary: "- 工作流里也不要写入任何凭证。",
    },
  };
}
