import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, index } from "drizzle-orm/pg-core";
import type { StoredWorkflowIR } from "@aif/workflow-ir";
import { users } from "./users.js";
import { conversations } from "./conversations.js";

export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id),
    userId: integer("user_id").notNull().references(() => users.id),
    name: text("name").notNull(),
    latestVersion: integer("latest_version").notNull().default(0),
    /** 从分享复制出来时记录来源，循环引用由应用层处理，这里不设外键 */
    forkedFromShareId: uuid("forked_from_share_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workflows_user_idx").on(t.userId, t.updatedAt)],
);

export const workflowVersions = pgTable(
  "workflow_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id").notNull().references(() => workflows.id),
    version: integer("version").notNull(),
    // 历史数据可能是 v1，读取时经 migrateIr 转换为 v2
    ir: jsonb("ir").$type<StoredWorkflowIR>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("workflow_versions_wf_ver").on(t.workflowId, t.version)],
);
