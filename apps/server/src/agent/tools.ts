import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkflowIR } from "@aif/workflow-ir";
import { DURATION_BUCKETS, DURATION_KEYS, MAX_NOTES, STAGES, progressLine, upsertPainPoint, upsertTask, type Candidate, type PainPoint, type Profile, type Stage } from "../domain/profile.js";
import { randomUUID } from "node:crypto";
import type { GeneratedWorkflow } from "./irGenerator.js";
import { fastTrackNextStep } from "./turnContext.js";

export { STAGES, type Stage };

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

/** retry：结果要求模型重新调用一次（例如痛点没关联上工作项），本轮不能就此结束 */
const text = (t: string, opts: { terminate?: boolean; retry?: boolean } = {}) => ({
  content: [{ type: "text" as const, text: t }],
  details: opts.retry ? { retry: true } : {},
  ...(opts.terminate ? { terminate: true } : {}),
});

const Frequency = Type.Union([
  Type.Literal("daily"),
  Type.Literal("weekly"),
  Type.Literal("monthly"),
  Type.Literal("ad_hoc"),
]);

/** 耗时档位：用户在选择题里选的档，说不准填 unknown */
const DurationBucket = Type.Union(
  DURATION_KEYS.map((k) => Type.Literal(k)),
  {
    description:
      "用户选的单次耗时档位：" +
      Object.entries(DURATION_BUCKETS)
        .map(([k, b]) => `${k}=${b.label}`)
        .join("，") +
      "，unknown=说不准（问过但用户说不准，之后不要再问）",
  },
);

const Score = Type.Integer({ minimum: 1, maximum: 5, description: "1 到 5 的整数" });

/** 带 id 更新时只传要改的字段：没传的沿用已有的值。去掉值为 undefined 的键，免得覆盖已有的值 */
function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** 新建时缺必填字段：说清楚是新建还是 id 没找到，让模型知道该怎么补 */
function missingFields(kind: string, id: string | undefined, fields: string[]): Error {
  const why = id ? `找不到 id 为 ${id} 的${kind}（要用记录时返回的 id），按新建处理` : `新建${kind}`;
  return new Error(`${why}时必须填写 ${fields.join("、")}。更新已有的${kind}时带上它的 id，只传要改的字段即可。`);
}

const Focus = Type.Optional(Type.Boolean({ description: "这就是用户选定、本次访谈要深挖的那一个时填 true" }));

/** 记录工具的参数：新建要填全，带 id 更新时只传要改的字段 */
type TaskPatch = Omit<Parameters<typeof upsertTask>[1], "title" | "frequency"> & Partial<Pick<Parameters<typeof upsertTask>[1], "title" | "frequency">>;
type PainPointPatch = { id?: string } & Partial<Omit<PainPoint, "id" | "score" | "assumed">>;

export function createInterviewTools(ctx: ToolContext): ToolDefinition[] {
  const setStage = {
    name: "set_stage",
    label: "切换阶段",
    description: `同步当前访谈阶段。顺序：${STAGES.join(" → ")}。`,
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
    description:
      "新增或更新用户做的一件工作。本次访谈只记录用户选定要深挖的那一件。新建时必须填 title 和 frequency；提供 id 则更新已有工作，只传要改的字段，其余沿用已有的值。单次耗时：用户选了档位就填 durationBucket；用户直接说出了分钟数才填 minutesPerRun；用户说不准就填 durationBucket=unknown。不确定时不要猜，也不要为了耗时反复追问。",
    parameters: Type.Object({
      id: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      frequency: Type.Optional(Frequency),
      durationBucket: Type.Optional(DurationBucket),
      minutesPerRun: Type.Optional(Type.Number({ minimum: 0 })),
      steps: Type.Optional(Type.Array(Type.String())),
      systems: Type.Optional(Type.Array(Type.String())),
      focus: Focus,
    }),
    execute: async (_id: string, { focus, ...p }: TaskPatch & { focus?: boolean }) => {
      const { task, progress } = await ctx.withLock(async () => {
        const profile = await ctx.loadProfile();
        const prev = profile.tasks.find((t) => t.id === p.id);
        const title = p.title ?? prev?.title;
        const frequency = p.frequency ?? prev?.frequency;
        if (!title || !frequency) throw missingFields("工作", p.id, ["title", "frequency"]);
        const t = upsertTask(profile, { ...p, title, frequency });
        if (focus) profile.focusTaskId = t.id;
        await ctx.saveProfile(profile);
        return { task: t, progress: progressLine(profile) };
      });
      ctx.emit("state_patch", { task, ...(focus ? { profile: { focusTaskId: task.id } } : {}) });
      return text(`已记录工作：${task.title}（id: ${task.id}）。${progress}`);
    },
  };

  const recordPainPoint = {
    name: "record_pain_point",
    label: "记录痛点",
    description: "新增或更新一个痛点。本次访谈只记录用户选定要解决的那一个。新建时必须填 title、detail、severity、automatable；提供 id 则更新已有痛点，只传要改的字段，其余沿用已有的值。severity 是痛苦程度，automatable 是可自动化程度，都是 1 到 5。evidence 写明依据（用户原话或具体事例）。",
    parameters: Type.Object({
      id: Type.Optional(Type.String()),
      taskId: Type.Optional(Type.String({ description: "所属工作项的 id，即 record_task 返回的 id，不是工作项的名称" })),
      title: Type.Optional(Type.String()),
      detail: Type.Optional(Type.String()),
      severity: Type.Optional(Score),
      automatable: Type.Optional(Score),
      evidence: Type.Optional(Type.String()),
      focus: Focus,
    }),
    execute: async (_id: string, { focus, ...p }: PainPointPatch & { focus?: boolean }) => {
      const { point, taskId, progress } = await ctx.withLock(async () => {
        const profile = await ctx.loadProfile();
        const prev = profile.painPoints.find((x) => x.id === p.id);
        const { score: _score, assumed: _assumed, ...kept } = prev ?? ({} as Partial<PainPoint>);
        const merged = { ...kept, ...defined(p) };
        const { title, detail, severity, automatable } = merged;
        if (title === undefined || detail === undefined || severity === undefined || automatable === undefined) {
          throw missingFields("痛点", p.id, ["title", "detail", "severity", "automatable"]);
        }
        const pt = upsertPainPoint(profile, { ...merged, title, detail, severity, automatable });
        if (focus) profile.focusPainPointId = pt.id;
        await ctx.saveProfile(profile);
        return { point: pt, taskId: merged.taskId, progress: progressLine(profile) };
      });
      ctx.emit("state_patch", { painPoint: point, ...(focus ? { profile: { focusPainPointId: point.id } } : {}) });
      if (point.score === null) {
        // 没有关联到工作项就算不出分数：把原因和补救办法告诉模型，让它用正确的 id 重新记录
        const why = taskId ? "taskId 找不到对应的工作项（要用 record_task 返回的 id，不是工作项的名称）" : "还没有关联工作项";
        return text(`已记录痛点：${point.title}，但${why}，暂不计分。请用 record_task 返回的 id 作为 taskId，带上这个痛点的 id（${point.id}）再记录一次。${progress}`, { retry: true });
      }
      const score = point.assumed ? `优先级 ${point.score}，耗时待确认，暂按默认值估算，不必为此追问用户` : `优先级 ${point.score}`;
      return text(`已记录痛点：${point.title}（${score}）。${progress}`);
    },
  };

  const askChoices = {
    name: "ask_choices",
    label: "给出选项",
    description: "向用户展示选择题。question 就是要问的问题，正文里不要再写一遍，最多一句不带问号的引导。调用后请结束本轮回复，等待用户选择。",
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
    description: "围绕聚焦的痛点给出 2 个自动化程度不同的候选方案。每个方案说明解决的痛点（painPointIds）、预计每周节省分钟数、依赖的外部系统。",
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

/** 只把信息写进画像的工具：结果不需要模型接着处理 */
const RECORD_TOOL_NAMES = new Set(["set_stage", "update_profile", "record_task", "record_pain_point", "record_note"]);

/**
 * 回复里已经用文字提了问题、同时调用的是记录工具时，工具执行完就该结束本轮。
 * 否则 Agent 循环会把工具结果交回模型，模型看不到用户的回答，就会接着再问一个问题。
 * 工具出错或要求重新记录时不结束，让模型修正。快速模式由调用方另行排除。
 */
export function askedWhileRecording(call: {
  replyText: string;
  toolName: string;
  isError: boolean;
  details: unknown;
}): boolean {
  if (call.isError || !RECORD_TOOL_NAMES.has(call.toolName)) return false;
  if ((call.details as { retry?: boolean } | undefined)?.retry) return false;
  return /[?？]/.test(call.replyText);
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

