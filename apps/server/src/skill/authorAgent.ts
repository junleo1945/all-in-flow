import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { checkExport, lower, type ExportFile, type ExportIssue, type WorkflowIR } from "@aif/workflow-ir";
import {
  assembleSkill,
  packageFiles,
  parseAuthorDraft,
  skeleton,
  skillExporter,
  skillFacts,
  validateSkill,
  type SkillIssue,
  type SkillOptions,
} from "@aif/plugin-exporter-skill";
import { createInterviewSession } from "../agent/session.js";
import { parseJson } from "../agent/irGenerator.js";
import type { RuntimeModel } from "../agent/models.js";
import { ExportAborted, type Usage } from "../n8n/exportAgent.js";
import { AUTHOR_SYSTEM_PROMPT, buildAuthorPrompt, buildRepairPrompt } from "./prompt.js";

/**
 * 用模型撰写 Agent Skill：
 * 确定性骨架 → 模型写正文（固定 JSON 协议，没有工具）→ 校验器检查 → 不通过就回喂修正；
 * 模型不可用或修复失败时回退到确定性输出，导出永不阻塞。
 */

export type Stage = "analyze" | "write" | "validate";

export interface SkillAuthorInput {
  ir: WorkflowIR;
  options: SkillOptions;
  /** 导出前仍然空缺的信息（判断标准、模板） */
  gaps: string[];
  /** 访谈画像里与这个工作流相关的摘录 */
  context: string;
  onProgress?: (stage: Stage) => void;
  /** 使用者关掉弹窗或断开连接时取消：停止模型调用，不再继续消耗配额 */
  signal?: AbortSignal;
  /** 结束时（成功、失败或取消）报告本次消耗的 token 与花费 */
  onUsage?: (usage: Usage) => void | Promise<void>;
}

export interface SkillAuthorResult {
  /** 带 zip 外层目录的文件，可以直接预览和打包 */
  files: ExportFile[];
  filename: string;
  /** 导出检查（checkExport）里的警告，界面按语言翻译 */
  issues: ExportIssue[];
  /** 校验器给出的警告 */
  warnings: string[];
  /** 留给用户确认的事项 */
  todo: string[];
  /** 是否回退到了确定性输出 */
  fallback: boolean;
  fallbackReason?: string;
}

export type SkillAuthor = (input: SkillAuthorInput) => Promise<SkillAuthorResult>;

export const MAX_REPAIRS = 3;
/** 事实清单超过这个长度就不交给模型（流程太大，模型会丢步骤） */
export const MAX_FACTS_CHARS = 80_000;
/** 修复后仍存在、但不影响使用的错误：带着警告交付，而不是整个回退 */
const SOFT_CODES = new Set(["body-length", "nested-reference"]);

export function createSkillAuthor(opts: { runtime: ModelRuntime; model: RuntimeModel }): SkillAuthor {
  return async function author(input) {
    const { ir, options, gaps, signal } = input;
    const graph = lower(ir);
    const issues = checkExport(skillExporter, graph).filter((i) => i.level !== "error");
    const filename = `${ir.slug}.${options.packaging === "claude-plugin" ? "claude-plugin" : "skill"}.zip`;
    const check = () => {
      if (signal?.aborted) throw new ExportAborted();
    };

    const fallback = (reason: string): SkillAuthorResult => ({
      files: skillExporter.compile(graph, options) as ExportFile[],
      filename,
      issues,
      warnings: [],
      todo: gaps,
      fallback: true,
      fallbackReason: reason,
    });

    input.onProgress?.("analyze");
    check();
    const facts = skillFacts(ir, options, gaps);
    const reserved = new Set(skeleton(ir, options).files.map((f) => f.path));
    const factsText = JSON.stringify(facts);
    if (factsText.length > MAX_FACTS_CHARS) return fallback("流程图太大，已使用基础版本");

    let session: Awaited<ReturnType<typeof createInterviewSession>>;
    try {
      session = await createInterviewSession({
        cwd: mkdtempSync(join(tmpdir(), "aif-skill-author-")),
        model: opts.model,
        modelRuntime: opts.runtime,
        systemPrompt: AUTHOR_SYSTEM_PROMPT,
        tools: [],
      });
    } catch (e) {
      console.error("skill author session failed:", (e as Error).name);
      return fallback("模型暂时不可用，已使用基础版本");
    }
    const onAbort = () => void session.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      input.onProgress?.("write");
      let prompt = buildAuthorPrompt(facts, input.context);
      let validating = false;
      let last: { files: ExportFile[]; todo: string[]; issues: SkillIssue[] } | undefined;
      let lastProblems: string[] = [];

      for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
        check();
        try {
          await session.prompt(prompt, { expandPromptTemplates: false });
        } catch (e) {
          check();
          console.error("skill author model call failed:", (e as Error).name);
          return fallback("模型调用失败，已使用基础版本");
        }
        check();
        if (!validating) {
          validating = true;
          input.onProgress?.("validate");
        }

        const parsed = parseJson(session.getLastAssistantText() ?? "") as Record<string, unknown> | undefined;
        if (!parsed || parsed.action !== "done") {
          lastProblems = ["输出不是合法的 JSON 对象，或 action 不是 done。请只输出一个 JSON 对象。"];
          last = undefined;
          prompt = buildRepairPrompt(lastProblems);
          continue;
        }
        const { draft, problems } = parseAuthorDraft(parsed, reserved);
        if (!draft) {
          lastProblems = problems;
          last = undefined;
          prompt = buildRepairPrompt(problems);
          continue;
        }

        const { files } = assembleSkill(ir, options, draft);
        const found = validateSkill(files, { name: ir.slug, facts });
        const errors = found.filter((i) => i.level === "error");
        const todo = [...draft.todo, ...gaps.filter((g) => !draft.todo.includes(g))];
        last = { files, todo, issues: found };
        if (errors.length === 0) return success(ir, options, files, found, todo);
        lastProblems = errors.map((e) => e.message);
        prompt = buildRepairPrompt(lastProblems);
      }

      // 修复次数用完。只剩不影响使用的问题时带着警告交付，否则回退
      if (last && last.issues.filter((i) => i.level === "error").every((i) => SOFT_CODES.has(i.code))) {
        return success(ir, options, last.files, last.issues, last.todo);
      }
      return fallback(`模型写出的内容没有通过校验，已使用基础版本：${lastProblems.slice(0, 3).join("；")}`);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      const stats = session.getSessionStats();
      await Promise.resolve(input.onUsage?.({ input: stats.tokens.input, output: stats.tokens.output, cacheRead: stats.tokens.cacheRead, costUsd: stats.cost })).catch(() => undefined);
      session.dispose();
    }

    function success(irx: WorkflowIR, o: SkillOptions, files: ExportFile[], found: SkillIssue[], todo: string[]): SkillAuthorResult {
      return {
        files: packageFiles(irx, files, o),
        filename,
        issues,
          warnings: found.map((i) => i.message),
        todo,
        fallback: false,
      };
    }
  };
}
