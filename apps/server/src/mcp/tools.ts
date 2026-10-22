import { z } from "zod";
import { validateWorkflow, type ValidationIssue, type WorkflowIR } from "@aif/workflow-ir";
import type { Db } from "../db/client.js";
import { FixedWindowLimiter } from "../auth/limiter.js";
import type { TokenUser } from "../db/repos/accessTokenRepo.js";
import { importNewVersion, importNewWorkflow } from "../db/repos/importRepo.js";
import { NotFoundError } from "../db/repos/workflowRepo.js";
import { ConversationNotFound } from "../db/repos/conversationRepo.js";
import { DURATION_BUCKETS, DURATION_KEYS, emptyProfile, upsertPainPoint, upsertTask, type Profile } from "../domain/profile.js";
import { errorResult, textResult, type ToolDef, type ToolResult } from "./protocol.js";

export interface McpToolContext {
  user: TokenUser;
}

export interface McpToolDeps {
  db: Db;
  publicBaseUrl: string;
  /** 测试里可替换限流器 */
  validateLimiter?: FixedWindowLimiter;
  importLimiter?: FixedWindowLimiter;
}

const MAX_ISSUES_SHOWN = 20;

const id = z.string().min(1).max(64);
const TaskInput = z.object({
  id,
  title: z.string().min(1).max(200),
  frequency: z.enum(["daily", "weekly", "monthly", "ad_hoc"]),
  durationBucket: z.enum(DURATION_KEYS).optional(),
  minutesPerRun: z.number().min(0).max(100_000).optional(),
  steps: z.array(z.string().max(500)).max(30).optional(),
  systems: z.array(z.string().max(100)).max(20).optional(),
});
const PainPointInput = z.object({
  id,
  taskId: id.optional(),
  title: z.string().min(1).max(200),
  detail: z.string().max(2000).default(""),
  severity: z.number().int().min(1).max(5),
  automatable: z.number().int().min(1).max(5),
  evidence: z.string().max(2000).optional(),
});
const RoleInput = z.object({
  role: z.string().max(100).optional(),
  team: z.string().max(100).optional(),
  systems: z.array(z.string().max(100)).max(30).default([]),
  summary: z.string().max(500).optional(),
});

/** ir 可以是对象，也可以是 JSON 字符串（部分模型会把对象序列化后传入） */
const IrInput = z.union([z.record(z.string(), z.unknown()), z.string().min(2)]);

const ValidateArgs = z.object({ ir: IrInput });
const ImportArgs = z.object({
  ir: IrInput,
  workflowId: z.uuid().optional(),
  role: RoleInput.optional(),
  tasks: z.array(TaskInput).max(30).optional(),
  painPoints: z.array(PainPointInput).max(30).optional(),
});

function parseIr(raw: z.infer<typeof IrInput>): unknown {
  if (typeof raw !== "string") return raw;
  const body = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function zodMessage(e: z.ZodError): string {
  return e.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "参数"}：${i.message}`)
    .join("；");
}

function issueLines(issues: ValidationIssue[]): string {
  const shown = issues.slice(0, MAX_ISSUES_SHOWN).map((i, n) => `${n + 1}. ${i.nodeId ? `[${i.nodeId}] ` : ""}${i.message}`);
  const more = issues.length > MAX_ISSUES_SHOWN ? [`……另有 ${issues.length - MAX_ISSUES_SHOWN} 个问题`] : [];
  return [...shown, ...more].join("\n");
}

/** 校验 ir，成功返回 WorkflowIR，失败返回给模型看的错误结果 */
function checkIr(raw: z.infer<typeof IrInput>): { ir: WorkflowIR; warnings: string[] } | ToolResult {
  const parsed = parseIr(raw);
  if (parsed === undefined || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return errorResult("ir 不是合法的 JSON 对象。请直接传入 Workflow IR v2 的对象，不要加解释文字。");
  }
  const result = validateWorkflow(parsed);
  if (!result.ok) {
    return errorResult(`工作流校验未通过，请按下面的问题修改后重新提交（共 ${result.issues.length} 个）：\n${issueLines(result.issues)}`);
  }
  return { ir: result.ir, warnings: result.warnings };
}

function buildProfile(input: z.infer<typeof ImportArgs>): Profile {
  const profile = emptyProfile();
  if (input.role) profile.role = { ...input.role };
  for (const t of input.tasks ?? []) upsertTask(profile, t);
  // 痛点指向的工作不存在时去掉关联，避免出现悬空引用
  const taskIds = new Set(profile.tasks.map((t) => t.id));
  for (const p of input.painPoints ?? []) upsertPainPoint(profile, { ...p, taskId: p.taskId && taskIds.has(p.taskId) ? p.taskId : undefined });
  return profile;
}

const IR_PROP = {
  type: "object",
  description: "Workflow IR v2 的 JSON 对象（version 为 2，含 nodes、edges 等）。字段和约束见 Skill 里的 references/ir-spec.md。",
};

export function createMcpTools(deps: McpToolDeps): ToolDef<McpToolContext>[] {
  const validateLimiter = deps.validateLimiter ?? new FixedWindowLimiter(60, 60_000);
  const importLimiter = deps.importLimiter ?? new FixedWindowLimiter(20, 60_000);
  const base = deps.publicBaseUrl.replace(/\/+$/, "");

  const validateTool: ToolDef<McpToolContext> = {
    name: "validate_workflow",
    title: "校验工作流",
    description:
      "校验一份 Workflow IR v2。导入前先调用它：通过才能导入；不通过会列出所有问题，按提示修改后再校验。只读，不会保存任何内容。",
    inputSchema: { type: "object", properties: { ir: IR_PROP }, required: ["ir"] },
    async call(args, ctx) {
      const parsed = ValidateArgs.safeParse(args);
      if (!parsed.success) return errorResult(`参数不正确：${zodMessage(parsed.error)}`);
      if (!validateLimiter.hit(`validate:${ctx.user.id}`)) return errorResult("调用过于频繁，请稍后再试。");
      const checked = checkIr(parsed.data.ir);
      if ("content" in checked) return checked;
      const lines = [`校验通过：「${checked.ir.name}」，共 ${checked.ir.nodes.length} 个节点。`];
      if (checked.warnings.length) lines.push("提示：", ...checked.warnings.map((w) => `- ${w}`));
      return textResult(lines.join("\n"), { ok: true, name: checked.ir.name, nodes: checked.ir.nodes.length });
    },
  };

  const importTool: ToolDef<McpToolContext> = {
    name: "import_workflow",
    title: "导入工作流并生成流程图链接",
    description:
      "把访谈得出的工作流导入 All-in-Flow，返回一个流程图页面链接（画布渲染，公司内登录后可看）。会先做同样的校验，不通过不会保存。" +
      "首次导入会在用户的工作台新建一个工作流，并带上访谈画像（role、tasks、painPoints，可选）。" +
      "修改已导入的工作流时，传入 workflowId 保存为新版本，链接不变，此时画像参数会被忽略。",
    inputSchema: {
      type: "object",
      properties: {
        ir: IR_PROP,
        workflowId: { type: "string", description: "已导入的工作流 ID（上一次导入时返回）。传入则保存为这个工作流的新版本，不传则新建。" },
        role: {
          type: "object",
          description: "用户的岗位画像（可选）",
          properties: {
            role: { type: "string" },
            team: { type: "string" },
            systems: { type: "array", items: { type: "string" }, description: "常用系统" },
            summary: { type: "string", description: "一句话概括" },
          },
        },
        tasks: {
          type: "array",
          description: "访谈中记录的工作项（可选）",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "工作项 ID，痛点用 taskId 引用它" },
              title: { type: "string" },
              frequency: { type: "string", enum: ["daily", "weekly", "monthly", "ad_hoc"] },
              durationBucket: {
                type: "string",
                enum: [...DURATION_KEYS],
                description: `用户选的单次耗时档位：${Object.entries(DURATION_BUCKETS).map(([k, b]) => `${k}=${b.label}`).join("，")}；说不准填 unknown`,
              },
              minutesPerRun: { type: "number", description: "用户直接说出的单次耗时（分钟）；说不准时不要填" },
              steps: { type: "array", items: { type: "string" } },
              systems: { type: "array", items: { type: "string" } },
            },
            required: ["id", "title", "frequency"],
          },
        },
        painPoints: {
          type: "array",
          description: "访谈中记录的痛点（可选）。ir.source.painPointIds 应引用这里的 id。优先级由平台按 频率×耗时×痛苦程度×可自动化程度 计算，耗时说不准的按默认值估算并标为未量化。",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              taskId: { type: "string" },
              title: { type: "string" },
              detail: { type: "string" },
              severity: { type: "integer", minimum: 1, maximum: 5, description: "痛苦程度" },
              automatable: { type: "integer", minimum: 1, maximum: 5, description: "可自动化程度" },
              evidence: { type: "string", description: "依据：用户原话或具体事例" },
            },
            required: ["id", "title", "severity", "automatable"],
          },
        },
      },
      required: ["ir"],
    },
    async call(args, ctx) {
      const parsed = ImportArgs.safeParse(args);
      if (!parsed.success) return errorResult(`参数不正确：${zodMessage(parsed.error)}`);
      if (!importLimiter.hit(`import:${ctx.user.id}`)) return errorResult("导入过于频繁，请稍后再试。");
      const checked = checkIr(parsed.data.ir);
      if ("content" in checked) return checked;

      let result;
      try {
        result = parsed.data.workflowId
          ? await importNewVersion(deps.db, ctx.user.id, parsed.data.workflowId, checked.ir)
          : await importNewWorkflow(deps.db, ctx.user.id, checked.ir, buildProfile(parsed.data));
      } catch (e) {
        if (e instanceof NotFoundError || e instanceof ConversationNotFound) {
          return errorResult("找不到这个工作流，或它已被删除。去掉 workflowId 可以作为新工作流导入。");
        }
        throw e;
      }

      const shareUrl = `${base}/s/${result.shareToken}`;
      const workbenchUrl = `${base}/c/${result.conversationId}`;
      const lines = [
        `已导入工作流「${checked.ir.name}」（第 ${result.version} 版）。`,
        `- 流程图链接（公司内登录后可看）：${shareUrl}`,
        `- 在工作台继续修改：${workbenchUrl}`,
        `- 工作流 ID：${result.workflowId}（之后修改这个工作流，再次调用时传入 workflowId，链接不变）`,
        "请把流程图链接发给用户。",
      ];
      if (checked.warnings.length) lines.push("提示：", ...checked.warnings.map((w) => `- ${w}`));
      return textResult(lines.join("\n"), {
        shareUrl,
        workbenchUrl,
        workflowId: result.workflowId,
        version: result.version,
      });
    },
  };

  return [validateTool, importTool];
}
