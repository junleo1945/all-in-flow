import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type FileEntry,
  type ModelRuntime,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { RuntimeModel } from "./models.js";
import type { AgentThinkingLevel } from "../config.js";

type AgentHooks = AgentSession["agent"];
/** 工具执行完后的钩子，可以改写结果，例如设置 terminate 结束本轮 */
export type AfterToolCall = NonNullable<AgentHooks["afterToolCall"]>;

/** 空的 agentDir：Pi 不会读取 ~/.pi 下的任何配置、扩展或技能。 */
const EMPTY_AGENT_DIR = mkdtempSync(join(tmpdir(), "aif-agentdir-"));

export interface SessionOptions {
  /** 每个会话一个空的临时目录，即使有疏漏也碰不到项目文件 */
  cwd: string;
  model: RuntimeModel;
  /** 思考等级，默认关闭；目前只有访谈 Agent 按配置开启 */
  thinkingLevel?: AgentThinkingLevel;
  modelRuntime: ModelRuntime;
  systemPrompt: string;
  /** 自定义工具，名称同时作为白名单 */
  tools: ToolDefinition[];
  /** 恢复时传入已持久化的条目（第一条为 header） */
  entries?: FileEntry[];
  afterToolCall?: AfterToolCall;
}

/**
 * 完全自定义的资源加载器（参照 Pi 官方示例 12-full-control）。
 * 不发现任何扩展、技能、上下文文件或提示词模板，系统提示词固定。
 */
export function staticResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  } as unknown as ResourceLoader;
}

export async function createInterviewSession(opts: SessionOptions): Promise<AgentSession> {
  const sessionManager = opts.entries?.length
    ? SessionManager.inMemory(opts.cwd, {}, opts.entries)
    : SessionManager.inMemory(opts.cwd);

  const { session } = await createAgentSession({
    cwd: opts.cwd,
    agentDir: EMPTY_AGENT_DIR,
    model: opts.model,
    thinkingLevel: opts.thinkingLevel ?? "off",
    modelRuntime: opts.modelRuntime,
    resourceLoader: staticResourceLoader(opts.systemPrompt),
    customTools: opts.tools,
    tools: opts.tools.map((t) => t.name), // 白名单：只启用自定义工具，内置的 read/bash/edit/write 全部禁用
    sessionManager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 2 },
    }),
  });
  if (opts.afterToolCall) {
    // AgentSession 自己已经装了一个钩子（扩展和图片处理），接在它后面，两者的改写合并
    const own = session.agent.afterToolCall;
    const extra = opts.afterToolCall;
    session.agent.afterToolCall = async (context, signal) => {
      const base = await own?.(context, signal);
      const more = await extra(context, signal);
      return base || more ? { ...base, ...more } : undefined;
    };
  }
  return session;
}
