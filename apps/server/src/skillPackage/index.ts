import { createHash } from "node:crypto";
import { IR_SPEC } from "../agent/irPrompt.js";
import { composePrompt } from "../interview/compose.js";
import { IR_FILE, STATE_FILE, localAdapter } from "../interview/localAdapter.js";

/**
 * 下载给用户的本地 Skill（agentskills.io 规范，Claude Code、Codex 等通用）：
 * 把平台的访谈能力搬到用户自己的 Agent 里，访谈结束后通过平台 MCP 导入工作流，换回流程图链接。
 *
 * SKILL.md 的正文和网页访谈 Agent 的系统提示词（agent/prompt.ts）出自同一份方法论核心（interview/core.ts），
 * 各自只叠加自己运行环境的适配：网页用工具调用写数据库，这里读写本地状态文件、调用平台 MCP。
 * IR 规范（references/ir-spec.md）同样与编译器提示词共用一份（IR_SPEC）。
 */

export const SKILL_NAME = "all-in-flow";

export interface SkillFile {
  path: string;
  content: string;
}

export interface SkillPackage {
  name: string;
  /** 内容摘要的前 12 位：内容变了版本就变，页面据此提示用户重新下载 */
  version: string;
  files: SkillFile[];
}

const DESCRIPTION =
  "通过多轮访谈挖掘用户日常工作中最值得自动化的痛点，按频率、耗时、痛苦程度量化排序，提出自动化方案，再生成可视化的流程图链接和可执行的工作流。当用户想梳理自己的工作、找出哪些事可以自动化、把重复工作画成流程图，或提到 All-in-Flow 时使用。";

function skillMd(baseUrl: string): string {
  return `---
name: ${SKILL_NAME}
description: ${DESCRIPTION}
---

# All-in-Flow：工作痛点访谈与流程图

${composePrompt(localAdapter({ baseUrl }))}
`;
}

function stateMd(): string {
  return `# 访谈记录状态文件

\`${STATE_FILE}\` 的格式。每轮开始前读，信息有变化就改，保持表格对齐不是必须的，但列不能少。id 用简短稳定的编号（工作项 t1、t2……，痛点 p1、p2……），创建后不要改，痛点和工作流都靠 id 引用。

## 模板

\`\`\`markdown
# 访谈记录

阶段：role
快速模式：否
工作流 ID：（导入后填写）

## 角色
- 岗位：
- 团队：
- 常用系统：
- 概括：

## 工作项
| id | 工作 | 频率 | 单次耗时 | 涉及系统 |
|----|------|------|----------|----------|
| t1 | 写销售周报 | weekly | 一两个小时 | ERP、Excel |
| t2 | 核对异常订单 | daily | 说不准 | ERP |

## 痛点
| id | 所属工作 | 痛点 | 详情 | 痛苦(1-5) | 可自动化(1-5) | 依据 | 优先级 |
|----|----------|------|------|-----------|---------------|------|--------|
| p1 | t1 | 手工做透视表 | 每周从 ERP 导出订单再手工汇总 | 4 | 5 | 上周花了 3.5 小时 | 1800 |
| p2 | t2 | 异常订单靠肉眼找 | 每天逐条看 | 3 | 4 | 经常漏看 | 900（未量化） |

## 已确认
- 订单数据都在 ERP 的订单查询页

## 已跳过
- 用户不愿聊绩效考核相关的事

## 待确认
- 异常订单的金额阈值

## 候选方案
- 方案 A：……（解决 p1、p2，预计每周节省 150 分钟，依赖 ERP）
\`\`\`

## 填写规则

- **阶段**：role、inventory、dig、rank、propose、generate 之一。
- **频率**：daily、weekly、monthly、ad_hoc 之一。
- **单次耗时**：问用户时给档位选项，不要让他报分钟数。填档位文字、用户直接说出的分钟数，或「说不准」。说不准就不再追问；用户估算的在痛点的依据里写「估算」。
- **优先级**：每周发生次数 × 单次耗时 × 痛苦 × 可自动化。耗时说不准的按默认耗时算，并在后面标「（未量化）」，照样参与排序。
- **已跳过**的话题以后不再追问。
`;
}

function irSpecMd(): string {
  return `# Workflow IR v2 规范

访谈得出的工作流要写成下面规定的 JSON 对象（Workflow IR v2），再交给 \`validate_workflow\` 校验、\`import_workflow\` 导入。

使用时注意：

- JSON 只放在工具的 \`ir\` 参数里，不要在聊天里贴给用户。
- 下面的规则写给「工作流编译器」，其中「只输出 JSON、不要解释」之类的要求在这里不适用，其余规则全部适用。
- 校验器会一次列出所有问题，按提示逐条修改即可。

## 格式、节点与规则

${IR_SPEC}
`;
}

/** 生成下载包的全部文件。baseUrl 是网站地址，写进「没有 MCP 工具时」的指引里 */
export function buildSkillPackage(opts: { baseUrl: string }): SkillPackage {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const files: SkillFile[] = [
    { path: "SKILL.md", content: skillMd(baseUrl) },
    { path: "references/interview-state.md", content: stateMd() },
    { path: "references/ir-spec.md", content: irSpecMd() },
  ];
  const hash = createHash("sha256");
  for (const f of files) hash.update(f.path).update("\0").update(f.content).update("\0");
  return { name: SKILL_NAME, version: hash.digest("hex").slice(0, 12), files };
}
