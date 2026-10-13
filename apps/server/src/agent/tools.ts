import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkflowIR } from "@aif/workflow-ir";
import { MAX_NOTES, progressLine, upsertPainPoint, upsertTask, type Candidate, type Profile } from "../domain/profile.js";
import { randomUUID } from "node:crypto";
import type { GeneratedWorkflow } from "./irGenerator.js";
import { fastTrackNextStep } from "./turnContext.js";

export const STAGES = ["role", "inventory", "dig", "rank", "propose", "generate"] as const;
export type Stage = (typeof STAGES)[number];

export type EventSink = (event: string, data: unknown) => void;

/** 工具运行所需的依赖。所有读写都限定在当前会话内，conversationId 由服务端注入，不来自模型参数。 */
export interface ToolContext {
  conversationId: string;
  emit: EventSink;
  /** 读取画像；工具之间通过它串行化读写 */
  loadProfile(): Promise<Profile>;
  saveProfile(profile: Profile, stage?: Stage): Promise<void>;
  /** 把方案摘要交给 IR 生成器，返回校验通过的 IR */
  generateWorkflow(brief: string, profile: Profile): Promise<GeneratedWorkflow>;
  /** 保存生成的工作流（新建或新增版本），返回版本信息 */
  saveWorkflow(ir: WorkflowIR, basedOnWorkflowId?: string): Promise<{ workflowId: string; version: number }>;
  /** 用于串行化同一会话内的画像修改 */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  /** 针对会话中的图片追问（仅图片识别开启时提供） */
  askImage?: (attachmentId: string, question: string) => Promise<string>;
}

const text = (t: string, opts: { terminate?: boolean } = {}) => ({
  content: [{ type: "text" as const, text: t }],
  details: {},
  ...(opts.terminate ? { terminate: true } : {}),
});

const Frequency = Type.Union([
  Type.Literal("daily"),
  Type.Literal("weekly"),
  Type.Literal("monthly"),
  Type.Literal("ad_hoc"),
]);

const Score = Type.Integer({ minimum: 1, maximum: 5, description: "1 到 5 的整数" });

export function createInterviewTools(ctx: ToolContext): ToolDefinition[] {
  const setStage = {
    name: "set_stage",
    label: "切换阶段",
    description: "同步当前访谈阶段。顺序：role → inventory → dig → rank → propose → generate。",
    parameters: Type.Object({ stage: Type.Union(STAGES.map((s) => Type.Literal(s))) }),
    execute: async (_id: string, p: { stage: Stage }) => {
      await ctx.withLock(async () => {
        const profile = await ctx.loadProfile();
        await ctx.saveProfile(profile, p.stage);
      });
      ctx.emit("stage", { stage: p.stage });
      return text(`阶段已切换为 ${p.stage}`);
    },
  };

  const updateProfile = {
    name: "update_profile",
    label: "记录角色",
    description: "记录用户的岗位、团队、常用系统和一句话概括。只传需要更新的字段。",
    parameters: Type.Object({
      role: Type.Optional(Type.String()),
      team: Type.Optional(Type.String()),
      systems: Type.Optional(Type.Array(Type.String())),
      summary: Type.Optional(Type.String()),
    }),
    execute: async (_id: string, p: { role?: string; team?: string; systems?: string[]; summary?: string }) => {
      const { role, progress } = await ctx.withLock(async () => {
        const profile = await ctx.loadProfile();
        profile.role = {
          role: p.role ?? profile.role.role,
          team: p.team ?? profile.role.team,
          systems: p.systems ?? profile.role.systems,
          summary: p.summary ?? profile.role.summary,
        };
        await ctx.saveProfile(profile);
        return { role: profile.role, progress: progressLine(profile) };
      });
      ctx.emit("state_patch", { profile: { role } });
      return text(`角色信息已记录。${progress}`);
    },
  };

  const recordTask = {
    name: "record_task",
    label: "记录工作",
    description: "新增或更新用户做的一件工作。提供 id 则更新已有工作。minutesPerRun 是单次耗时（分钟），不确定时不要猜。",
    parameters: Type.Object({
      id: Type.Optional(Type.String()),
      title: Type.String(),
      frequency: Frequency,
      minutesPerRun: Type.Optional(Type.Number({ minimum: 0 })),
      steps: Type.Optional(Type.Array(Type.String())),
      systems: Type.Optional(Type.Array(Type.String())),
    }),
    execute: async (_id: string, p: Parameters<typeof upsertTask>[1]) => {
      const { task, progress } = await ctx.withLock(async () => {
        const profile = await ctx.loadProfile();
        const t = upsertTask(profile, p);
        await ctx.saveProfile(profile);
        return { task: t, progress: progressLine(profile) };
      });
      ctx.emit("state_patch", { task });
      return text(`已记录工作：${task.title}（id: ${task.id}）。${progress}`);
    },
  };

  const recordPainPoint = {
    name: "record_pain_point",
    label: "记录痛点",
    description: "新增或更新一个痛点。severity 是痛苦程度，automatable 是可自动化程度，都是 1 到 5。evidence 写明依据（用户原话或具体事例）。",
    parameters: Type.Object({
      id: Type.Optional(Type.String()),
      taskId: Type.Optional(Type.String()),
      title: Type.String(),
      detail: Type.String(),
      severity: Score,
      automatable: Score,
      evidence: Type.Optional(Type.String()),
    }),
    execute: async (_id: string, p: Parameters<typeof upsertPainPoint>[1]) => {
      const { point, progress } = await ctx.withLock(async () => {
        const profile = await ctx.loadProfile();
        const pt = upsertPainPoint(profile, p);
        await ctx.saveProfile(profile);
        return { point: pt, progress: progressLine(profile) };
      });
      ctx.emit("state_patch", { painPoint: point });
      const score = point.score === null ? "耗时未知，暂不计分" : `优先级 ${point.score}`;
      return text(`已记录痛点：${point.title}（${score}）。${progress}`);
    },
  };

  const askChoices = {
    name: "ask_choices",
    label: "给出选项",
    description: "向用户展示选择题。调用后请结束本轮回复，等待用户选择。",
    parameters: Type.Object({
      question: Type.String(),
      options: Type.Array(Type.String(), { minItems: 2, maxItems: 6 }),
      multi: Type.Optional(Type.Boolean()),
      allowOther: Type.Optional(Type.Boolean()),
    }),
    execute: async (_id: string, p: { question: string; options: string[]; multi?: boolean; allowOther?: boolean }) => {
      // 快速模式下服务端拦截提问：不展示选项，并让模型直接推进
      const profile = await ctx.loadProfile();
      if (profile.fastTrack) {
        return text(`用户已要求直接出结果，不再提问。${fastTrackNextStep(profile)}`);
      }
      ctx.emit("choices", { question: p.question, options: p.options, multi: p.multi ?? false, allowOther: p.allowOther ?? true });
      return text("选项已展示给用户，请等待用户回答。", { terminate: true });
    },
  };

  const recordNote = {
    name: "record_note",
    label: "记录要点",
    description:
      "记录访谈中确定的事实。用户回答了一个事实时用 confirmed；用户明确不愿回答或跳过某个话题时用 declined；仍需确认的问题用 pending。每次只记一条，text 写简短的事实或话题。",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("confirmed"), Type.Literal("declined"), Type.Literal("pending")]),
      text: Type.String({ maxLength: 200 }),
    }),
    execute: async (_id: string, p: { kind: "confirmed" | "declined" | "pending"; text: string }) => {
      const { progress } = await ctx.withLock(async () => {
        const profile = await ctx.loadProfile();
        const exists = profile.notes.some((n) => n.kind === p.kind && n.text === p.text);
        if (!exists) profile.notes = [...profile.notes, { kind: p.kind, text: p.text }].slice(-MAX_NOTES);
        await ctx.saveProfile(profile);
        return { progress: progressLine(profile) };
      });
      return text(`已记录要点。${progress}`);
    },
  };

  const enterFastTrack = {
    name: "enter_fast_track",
    label: "直接出结果",
    description:
      "用户表达想直接要结果、不想再回答问题时调用（例如“够了，出吧”“先这样，生成”“没有了，直接给我方案”等）。调用后整个会话不再追问，直接进入方案和生成。",
    parameters: Type.Object({ reason: Type.Optional(Type.String({ maxLength: 200 })) }),
    execute: async (_id: string, p: { reason?: string }) => {
      const next = await ctx.withLock(async () => {
        const profile = await ctx.loadProfile();
        profile.fastTrack = true;
        await ctx.saveProfile(profile);
        return fastTrackNextStep(profile);
      });
      ctx.emit("state_patch", { profile: { fastTrack: true } });
      return text(`已进入快速模式${p.reason ? `（${p.reason}）` : ""}，不再提问。${next}`);
    },
  };

  const proposeWorkflows = {
    name: "propose_workflows",
    label: "提出方案",
    description: "给出 2 到 3 个候选自动化方案。每个方案说明解决哪些痛点（painPointIds）、预计每周节省分钟数、依赖的外部系统。",
    parameters: Type.Object({
      candidates: Type.Array(
        Type.Object({
          title: Type.String(),
          painPointIds: Type.Array(Type.String()),
          summary: Type.String(),
          savedMinutesPerWeek: Type.Optional(Type.Number({ minimum: 0 })),
          systems: Type.Array(Type.String()),
        }),
        { minItems: 1, maxItems: 3 },
      ),
    }),
    execute: async (_id: string, p: { candidates: Omit<Candidate, "id">[] }) => {
      const candidates: Candidate[] = p.candidates.map((c) => ({ ...c, id: randomUUID() }));
      const fastTrack = await ctx.withLock(async () => {
        const profile = await ctx.loadProfile();
        profile.candidates = candidates;
        await ctx.saveProfile(profile, "propose");
        return profile.fastTrack;
      });
      ctx.emit("state_patch", { candidates });
      // 快速模式下方案直接进入生成，不等待用户选择
      if (fastTrack) {
        return text(`已提出 ${candidates.length} 个方案。用户已要求直接生成，请立即使用第一个方案调用 emit_workflow。`);
      }
      return text(`已提出 ${candidates.length} 个方案，请等待用户选择。`, { terminate: true });
    },
  };

  const emitWorkflow = {
    name: "emit_workflow",
    label: "生成工作流",
    description: "用户选定方案后调用。brief 写清楚方案摘要、相关痛点，以及每一步用到的系统、判断依据和需要人确认的环节（没有确认的写待确认）。basedOnWorkflowId 用于修改已有工作流（新增版本），否则新建工作流。",
    parameters: Type.Object({
      brief: Type.String(),
      basedOnWorkflowId: Type.Optional(Type.String()),
    }),
    execute: async (_id: string, p: { brief: string; basedOnWorkflowId?: string }) => {
      const profile = await ctx.withLock(async () => {
        const pr = await ctx.loadProfile();
        await ctx.saveProfile(pr, "generate");
        return pr;
      });
      const { ir, warnings } = await ctx.generateWorkflow(p.brief, profile);
      const saved = await ctx.saveWorkflow(ir, p.basedOnWorkflowId);
      ctx.emit("workflow", { workflowId: saved.workflowId, version: saved.version, ir });
      const notes = warnings.map((w) => `注意：${w}`).join("\n");
      return text(`已生成工作流《${ir.name}》，版本 v${saved.version}。${notes ? `\n${notes}` : ""}`);
    },
  };

  const askImage = ctx.askImage && {
    name: "ask_image",
    label: "追问图片",
    description: "针对本会话中已上传的某张图片追问细节（例如表格有哪些列、界面上有哪些按钮）。attachmentId 使用消息中给出的附件 id。每张图最多追问 5 次。",
    parameters: Type.Object({ attachmentId: Type.String(), question: Type.String() }),
    execute: async (_id: string, p: { attachmentId: string; question: string }) => {
      const answer = await ctx.askImage!(p.attachmentId, p.question);
      return text(answer);
    },
  };

  const tools: unknown[] = [
    setStage,
    updateProfile,
    recordTask,
    recordPainPoint,
    recordNote,
    enterFastTrack,
    askChoices,
    proposeWorkflows,
    emitWorkflow,
  ];
  if (askImage) tools.push(askImage);
  return tools as ToolDefinition[];
}

export const INTERVIEW_TOOL_NAMES = [
  "set_stage",
  "update_profile",
  "record_task",
  "record_pain_point",
  "record_note",
  "enter_fast_track",
  "ask_choices",
  "propose_workflows",
  "emit_workflow",
] as const;

