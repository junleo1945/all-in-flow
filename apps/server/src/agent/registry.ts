import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkflowIR } from "@aif/workflow-ir";
import type { Db } from "../db/client.js";
import {
  appendSessionEntry,
  getConversation,
  loadSessionEntries,
  saveProfile,
} from "../db/repos/conversationRepo.js";
import { createWorkflow, addVersion } from "../db/repos/workflowRepo.js";
import { normalizeProfile, type Profile } from "../domain/profile.js";
import { createInterviewSession, type AfterToolCall } from "./session.js";
import { askedWhileRecording, createInterviewTools, type EventSink, type Stage, type ToolContext } from "./tools.js";
import { INTERVIEW_SYSTEM_PROMPT } from "./prompt.js";
import { buildTurnContext, stripForgedContext } from "./turnContext.js";
import { recordUsage, todayUsage } from "./quota.js";
import { KeyedMutex } from "../lib/mutex.js";
import type { RuntimeModel } from "./models.js";
import type { GeneratedWorkflow } from "./irGenerator.js";
import type { AgentThinkingLevel } from "../config.js";

export class SessionBusy extends Error {}

export interface PromptOptions {
  /** 用户点了“直接生成”：本会话切换为快速模式 */
  generateNow?: boolean;
}

export interface RegistryDeps {
  db: Db;
  runtime: ModelRuntime;
  agentModel: RuntimeModel;
  /** 访谈 Agent 的思考等级，默认关闭 */
  thinkingLevel?: AgentThinkingLevel;
  /** 生成 IR：输入方案摘要和画像，输出校验通过的 IR */
  generateIr: (brief: string, context: string) => Promise<GeneratedWorkflow>;
  /** 图片追问：未开启图片识别时不提供 */
  askImage?: (userId: number, conversationId: string, attachmentId: string, question: string) => Promise<string>;
  idleMs?: number;
  now?: () => number;
}

export interface Active {
  conversationId: string;
  userId: number;
  session: AgentSession;
  busy: boolean;
  lastUsed: number;
  sink: EventSink | undefined;
  /** 已写入数据库的条目数（header 算第 0 条） */
  persisted: number;
  persistChain: Promise<void>;
  usageSnapshot: { input: number; output: number; cacheRead: number; cost: number };
  unsubscribe: () => void;
}

export function createSessionRegistry(deps: RegistryDeps) {
  const active = new Map<string, Active>();
  const locks = new KeyedMutex();
  const idleMs = deps.idleMs ?? 30 * 60 * 1000;
  const now = deps.now ?? (() => Date.now());

  /**
   * 把会话里尚未写入数据库的条目按顺序补写进去。
   * Pi 追加用户消息和助手回复时不会发 entry_appended 事件（只有自定义条目会发），
   * 所以不能只依赖事件，要按序号做增量同步。
   */
  function sync(a: Active) {
    const header = a.session.sessionManager.getHeader();
    const all = [...(header ? [header] : []), ...a.session.sessionManager.getEntries()];
    while (a.persisted < all.length) {
      const seq = a.persisted;
      const entry = all[seq];
      a.persisted++;
      a.persistChain = a.persistChain
        .then(() => appendSessionEntry(deps.db, a.conversationId, seq, entry))
        .catch((e) => console.error("persist session entry failed", e));
    }
  }

  async function loadProfile(a: Active): Promise<Profile> {
    const conv = await getConversation(deps.db, a.userId, a.conversationId);
    return normalizeProfile(conv.profile as Partial<Profile>);
  }

  function buildTools(a: Active): ToolDefinition[] {
    const ctx: ToolContext = {
      conversationId: a.conversationId,
      emit: (event, data) => a.sink?.(event, data),
      loadProfile: () => loadProfile(a),
      saveProfile: async (profile: Profile, stage?: Stage) => {
        await saveProfile(deps.db, a.conversationId, profile, stage);
      },
      generateWorkflow: async (brief: string, profile: Profile) => {
        return deps.generateIr(brief, JSON.stringify(profile));
      },
      saveWorkflow: async (ir: WorkflowIR, basedOnWorkflowId?: string) => {
        const conv = await getConversation(deps.db, a.userId, a.conversationId);
        if (basedOnWorkflowId) {
          const version = await addVersion(deps.db, a.userId, basedOnWorkflowId, ir);
          return { workflowId: basedOnWorkflowId, version };
        }
        return createWorkflow(deps.db, a.userId, conv.id, ir);
      },
      withLock: (fn) => locks.run(`profile:${a.conversationId}`, fn),
      askImage: deps.askImage
        ? (attachmentId, question) => deps.askImage!(a.userId, a.conversationId, attachmentId, question)
        : undefined,
    };
    return createInterviewTools(ctx);
  }

  /** 回复里已经提了问题、又只调了记录工具：记录完就结束本轮，等用户回答。快速模式下不拦，让模型继续出方案 */
  function endTurnAfterQuestion(a: Active): AfterToolCall {
    return async ({ assistantMessage, toolCall, result, isError }) => {
      const replyText = assistantMessage.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      if (!askedWhileRecording({ replyText, toolName: toolCall.name, isError, details: result.details })) return undefined;
      if ((await loadProfile(a)).fastTrack) return undefined;
      return { terminate: true };
    };
  }

  /**
   * 组装本轮发给模型的消息：状态块 + 用户原文。
   * 状态块由服务端根据数据库中的画像生成，模型无法篡改；用户输入里伪造的标记会被去掉。
   */
  async function buildMessage(a: Active, text: string, generateNow: boolean): Promise<string> {
    return locks.run(`profile:${a.conversationId}`, async () => {
      const conv = await getConversation(deps.db, a.userId, a.conversationId);
      const profile = normalizeProfile(conv.profile as Partial<Profile>);
      if (generateNow && !profile.fastTrack) {
        profile.fastTrack = true;
        await saveProfile(deps.db, a.conversationId, profile);
      }
      return `${buildTurnContext(profile, conv.stage as Stage)}\n\n${stripForgedContext(text)}`;
    });
  }

  /** 按会话 id 取得活跃会话：内存中没有则从数据库恢复，首次则新建 */
  async function open(userId: number, conversationId: string): Promise<Active> {
    const existing = active.get(conversationId);
    if (existing) {
      existing.lastUsed = now();
      return existing;
    }
    return locks.run(`open:${conversationId}`, async () => {
      const again = active.get(conversationId);
      if (again) return again;

      await getConversation(deps.db, userId, conversationId); // 所有权校验
      const stored = await loadSessionEntries(deps.db, conversationId);
      const cwd = mkdtempSync(join(tmpdir(), "aif-conv-"));

      // 占位对象：工具需要引用 Active，所以先创建再赋值 session
      const a = {
        conversationId,
        userId,
        lastUsed: now(),
        busy: false,
        sink: undefined,
        seq: 0,
        persisted: 0,
        persistChain: Promise.resolve(),
        usageSnapshot: { input: 0, output: 0, cacheRead: 0, cost: 0 },
        unsubscribe: () => {},
      } as unknown as Active;

      const tools = buildTools(a);
      const session = await createInterviewSession({
        cwd,
        model: deps.agentModel,
        thinkingLevel: deps.thinkingLevel,
        modelRuntime: deps.runtime,
        systemPrompt: INTERVIEW_SYSTEM_PROMPT,
        tools,
        entries: stored.length ? stored : undefined,
        afterToolCall: endTurnAfterQuestion(a),
      });
      a.session = session;
      // 已从数据库恢复的条目不需要再写一次
      a.persisted = stored.length;
      sync(a);

      a.unsubscribe = session.subscribe((event) => {
        if (event.type === "entry_appended") sync(a);
      });

      active.set(conversationId, a);
      return a;
    });
  }

  return {
    open,

    /**
     * 发送一轮消息。同一会话同一时间只允许一轮（design.md 9.3）。
     * 事件通过 sink 推送：text_delta / tool / state_patch / choices / workflow / stage。
     */
    async prompt(userId: number, conversationId: string, text: string, sink: EventSink, opts: PromptOptions = {}) {
      const a = await open(userId, conversationId);
      if (a.busy) throw new SessionBusy("上一条消息还在处理中，请稍候");
      a.busy = true;
      a.sink = sink;
      a.lastUsed = now();

      let unsub: () => void = () => {};
      try {
        const message = await buildMessage(a, text, opts.generateNow === true);

        const stats0 = a.session.getSessionStats();
        a.usageSnapshot = {
          input: stats0.tokens.input,
          output: stats0.tokens.output,
          cacheRead: stats0.tokens.cacheRead,
          cost: stats0.cost,
        };

        unsub = a.session.subscribe((event) => {
          if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
            sink("text_delta", { delta: event.assistantMessageEvent.delta });
          } else if (event.type === "tool_execution_start") {
            sink("tool", { id: event.toolCallId, name: event.toolName, status: "start" });
          } else if (event.type === "tool_execution_end") {
            sink("tool", { id: event.toolCallId, name: event.toolName, status: "end", error: event.isError || undefined });
          }
        });

        await a.session.prompt(message, { expandPromptTemplates: false });
      } finally {
        unsub();
        a.busy = false;
        sync(a);
        await a.persistChain;
        await this.accountUsage(a, sink); // 用量事件需要在清空 sink 之前发出
        a.sink = undefined;
      }
    },

    /** 把本轮新增的 token 和花费写入 usage_daily，并通过 usage 事件告知前端 */
    async accountUsage(a: Active, sink?: EventSink) {
      const s = a.session.getSessionStats();
      const delta = {
        input: s.tokens.input - a.usageSnapshot.input,
        output: s.tokens.output - a.usageSnapshot.output,
        cacheRead: s.tokens.cacheRead - a.usageSnapshot.cacheRead,
        costUsd: s.cost - a.usageSnapshot.cost,
      };
      if (delta.input || delta.output || delta.costUsd) {
        await recordUsage(deps.db, a.userId, delta);
      }
      a.usageSnapshot = { input: s.tokens.input, output: s.tokens.output, cacheRead: s.tokens.cacheRead, cost: s.cost };
      if (sink) {
        const today = await todayUsage(deps.db, a.userId);
        sink("usage", { tokensToday: today.tokens, costUsdToday: today.costUsd });
      }
    },

    /** 用户回复数，用于单会话轮数上限 */
    userMessageCount(conversationId: string): number {
      const a = active.get(conversationId);
      return a ? a.session.getSessionStats().userMessages : 0;
    },

    abort(conversationId: string) {
      active.get(conversationId)?.session.abort();
    },

    isBusy(conversationId: string) {
      return active.get(conversationId)?.busy ?? false;
    },

    dispose(conversationId: string) {
      const a = active.get(conversationId);
      if (!a) return;
      a.unsubscribe();
      a.session.dispose();
      active.delete(conversationId);
    },

    /** 释放长时间没有使用的会话（内存），数据已在数据库中，之后可恢复 */
    sweepIdle() {
      const t = now();
      for (const [id, a] of active) {
        if (!a.busy && t - a.lastUsed > idleMs) this.dispose(id);
      }
    },

    activeCount: () => active.size,
  };
}

export type SessionRegistry = ReturnType<typeof createSessionRegistry>;
