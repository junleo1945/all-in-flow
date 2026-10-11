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

/** 空的 agentDir：Pi 不会读取 ~/.pi 下的任何配置、扩展或技能。 */
const EMPTY_AGENT_DIR = mkdtempSync(join(tmpdir(), "aif-agentdir-"));

export interface SessionOptions {
  /** 每个会话一个空的临时目录，即使有疏漏也碰不到项目文件 */
  cwd: string;
  model: RuntimeModel;
  modelRuntime: ModelRuntime;
  systemPrompt: string;
  /** 自定义工具，名称同时作为白名单 */
  tools: ToolDefinition[];
  /** 恢复时传入已持久化的条目（第一条为 header） */
  entries?: FileEntry[];
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
    thinkingLevel: "off",
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
  return session;
}
