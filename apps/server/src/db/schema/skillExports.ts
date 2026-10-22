import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { ExportIssue } from "@aif/workflow-ir";
import { workflows } from "./workflows.js";

/** 缓存的 Skill 导出结果：只缓存模型写出并通过校验的版本，回退的基础版本不缓存 */
export interface StoredSkillExport {
  files: Array<{ path: string; content: string }>;
  filename: string;
  issues: ExportIssue[];
  warnings: string[];
  todo: string[];
}

/**
 * 用模型撰写 Skill 要花 token，同一张流程图、同样的选项再导出一次没有必要重来。
 * cacheKey 由导出选项、提示词版本和补充回答之后的流程图算出（见 skill/cacheKey.ts），
 * 流程图或提示词一变，键就变，旧缓存自然不会被命中。
 */
export const skillExports = pgTable(
  "skill_exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id").notNull().references(() => workflows.id),
    cacheKey: text("cache_key").notNull(),
    result: jsonb("result").$type<StoredSkillExport>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("skill_exports_wf_key").on(t.workflowId, t.cacheKey), index("skill_exports_wf_created").on(t.workflowId, t.createdAt)],
);
