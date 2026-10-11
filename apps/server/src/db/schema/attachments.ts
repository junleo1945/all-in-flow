import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { conversations } from "./conversations.js";

export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id),
    userId: integer("user_id").notNull().references(() => users.id),
    storageKey: text("storage_key").notNull(),
    mime: text("mime").notNull(),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    /** processing | ready | failed */
    status: text("status").notNull().default("processing"),
    /** 识别结果（VisionResult） */
    vision: jsonb("vision"),
    visionModel: text("vision_model"),
    error: text("error"),
    /** ask_image 已追问次数 */
    askCount: integer("ask_count").notNull().default(0),
    /** 随哪条用户消息发送；未发送为空 */
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("attachments_conv_idx").on(t.conversationId),
    index("attachments_user_day_idx").on(t.userId, t.createdAt),
  ],
);
