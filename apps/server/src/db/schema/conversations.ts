import { bigserial, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: integer("user_id").notNull().references(() => users.id),
    title: text("title").notNull().default("新访谈"),
    stage: text("stage").notNull().default("role"),
    /** 角色、任务、痛点、候选方案的整体画像 */
    profile: jsonb("profile").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** 置顶时间；为空表示未置顶 */
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("conversations_user_idx").on(t.userId, t.updatedAt)],
);

/** Pi SessionEntry 原样保存，恢复会话时按 seq 顺序重放。 */
export const sessionEntries = pgTable(
  "session_entries",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id),
    seq: integer("seq").notNull(),
    entry: jsonb("entry").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("session_entries_conv_seq").on(t.conversationId, t.seq)],
);
