import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { actionCoverage, executability, validateWorkflow } from "@aif/workflow-ir";
import { PERSONAS, type Persona, type EvalRun, scoreRun, countTimeQuestions, type RunMetrics } from "@aif/evals";
import type { Db } from "../db/client.js";
import { createConversation, getConversation } from "../db/repos/conversationRepo.js";
import { createSessionRegistry } from "../agent/registry.js";
import type { RuntimeModel } from "../agent/models.js";
import type { GeneratedWorkflow } from "../agent/irGenerator.js";

/** 模拟用户的系统提示词必须包含"扮演"，运行时据此区分用户模拟与访谈 Agent（见 test/eval.test.ts 的假模型） */
export const USER_SIM_MARKER = "你正在扮演";

export function userSimPrompt(p: Persona): string {
  const hidden = p.hiddenPainPoints.map((h) => `- ${h.description}`).join("\n");
  return [
    `${USER_SIM_MARKER}一位真实的职场人，正在接受 AI 流程顾问的访谈。`,
    `人设：${p.role}。${p.background}`,
    `说话风格：${p.style}。`,
    "规则：",
    "- 你的真实痛点如下，但只有当顾问问到具体实例（时间、频率、耗时、卡在哪一步）时才透露，不要一次全部说完：",
    hidden,
    ...(p.cannotEstimate
      ? [
          "- 你对每件事要花多久其实没认真算过。顾问问到单次耗时时：如果给了几个档位选项，你可以选一个最接近的；如果要你说具体分钟数、或者问上一次花了多久，你就说“不好说，没算过”。同一件事被追问第二次，你会明显不耐烦，说“真的说不准，别问时间了”。",
        ]
      : []),
    "- 每次回复 1 到 3 句话，口语化。",
    "- 不要提及这是模拟或访谈评测。",
    "- 直接输出你要说的话，不加引号或说明。",
  ].join("\n");
}

export interface EvalOptions {
  db: Db;
  runtime: ModelRuntime;
  agentModel: RuntimeModel;
  userModel: RuntimeModel;
  generateIr: (brief: string, context: string) => Promise<GeneratedWorkflow>;
  /** 访谈最多进行的用户轮数 */
  maxTurns: number;
  /** 评测专用用户（需要存在于 users 表） */
  evalUserId: number;
  log?: (msg: string) => void;
}

export interface PersonaResult {
  metrics: RunMetrics;
  run: EvalRun;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
}

export async function runPersona(opts: EvalOptions, persona: Persona): Promise<PersonaResult> {
  const log = opts.log ?? (() => {});
  const conv = await createConversation(opts.db, opts.evalUserId, `评测：${persona.role}`);
  const registry = createSessionRegistry({ db: opts.db, runtime: opts.runtime, agentModel: opts.agentModel, generateIr: opts.generateIr });

  const transcript: PersonaResult["transcript"] = [];
  const run: EvalRun = {
    personaId: persona.id,
    painPoints: [],
    taskCount: 0,
    turns: 0,
    workflowValidity: [],
    actionCoverage: [],
    executability: [],
  };
  const taskIds = new Set<string>();

  let userMsg = "你好，我想聊聊我的日常工作，看看哪些可以自动化。";
  let workflowTurnsLeft = -1;

  for (let turn = 1; turn <= opts.maxTurns; turn++) {
    run.turns = turn;
    transcript.push({ role: "user", text: userMsg });
    let reply = "";
    let turnIsWorkflow = false;
    let proposed = false;

    await registry.prompt(opts.evalUserId, conv.id, userMsg, (event, data: any) => {
      if (event === "text_delta") reply += data.delta;
      if (event === "state_patch") {
        if (data.task) taskIds.add(data.task.id);
        if (data.profile?.fastTrack === true) run.fastTrack = true;
        if (Array.isArray(data.candidates) && run.firstProposeTurn === undefined) {
          run.firstProposeTurn = turn;
          run.tasksAtFirstPropose = taskIds.size;
          proposed = true;
        }
      }
      if (event === "workflow") {
        const { ratio } = actionCoverage(data.ir);
        if (ratio !== null) run.actionCoverage!.push(ratio);
        run.executability!.push(executability(data.ir));
      }
      if (event === "tool" && data.name === "emit_workflow" && data.status === "end") {
        run.workflowValidity.push(!data.error);
        if (!data.error) {
          turnIsWorkflow = true;
          if (run.firstWorkflowTurn === undefined) run.firstWorkflowTurn = turn;
        }
      }
    });
    if (reply) transcript.push({ role: "assistant", text: reply });
    log(`[${persona.id}] 第 ${turn} 轮 ${proposed ? "（提出方案）" : ""}${turnIsWorkflow ? "（生成工作流）" : ""}`);

    // 生成工作流后再多聊两轮，给 Agent 修改的机会，然后结束
    if (run.firstWorkflowTurn !== undefined && workflowTurnsLeft < 0) workflowTurnsLeft = 2;
    else if (workflowTurnsLeft >= 0) workflowTurnsLeft -= 1;
    if (workflowTurnsLeft === 0) break;

    userMsg = await simulateUser(opts, persona, transcript);
    if (!userMsg) break;
  }

  // 最终画像从数据库读取，确保评分的是真正保存下来的内容
  const saved = await getConversation(opts.db, opts.evalUserId, conv.id);
  const profile = saved.profile as any;
  run.painPoints = (profile.painPoints ?? []).map((p: any) => ({ title: p.title, detail: p.detail, score: p.score, assumed: p.assumed }));
  run.timeQuestions = countTimeQuestions(transcript.filter((m) => m.role === "assistant").map((m) => m.text));
  run.taskCount = (profile.tasks ?? []).length;

  registry.dispose(conv.id);
  return { metrics: scoreRun(persona, run), run, transcript };
}

async function simulateUser(opts: EvalOptions, persona: Persona, transcript: PersonaResult["transcript"]): Promise<string> {
  // 不伪造 assistant 消息（缺少 usage 等字段会导致模型适配器报错），而是把对话记录整理成一条文本，
  // 让模拟用户只输出它的下一句回复
  const history = transcript
    .map((m) => `${m.role === "user" ? "你（职场人）" : "顾问"}：${m.text}`)
    .join("\n");
  const reply = await opts.runtime.completeSimple(opts.userModel, {
    systemPrompt: userSimPrompt(persona),
    messages: [
      {
        role: "user",
        content: [{ type: "text" as const, text: `以下是到目前为止的访谈记录：\n${history}\n\n请以"你（职场人）"的身份，写出下一句回复。只输出回复内容。` }],
        timestamp: Date.now(),
      },
    ],
  } as any);
  if (reply.stopReason === "error") throw new Error(`模拟用户调用失败：${reply.errorMessage ?? "未知错误"}`);
  return (reply.content as any[])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

export async function runEval(opts: EvalOptions, personas: Persona[] = PERSONAS) {
  const results: PersonaResult[] = [];
  for (const p of personas) {
    results.push(await runPersona(opts, p));
  }
  return results;
}

export { validateWorkflow };
