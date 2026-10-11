import { boolean, integer, pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { workflows } from "./workflows.js";

export const shares = pgTable(
  "shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 22 位随机字符串，唯一索引 */
    token: text("token").notNull().unique(),
    workflowId: uuid("workflow_id").notNull().references(() => workflows.id),
    /** 为空表示始终显示最新版本 */
    version: integer("version"),
    userId: integer("user_id").notNull().references(() => users.id),
    visibility: text("visibility", { enum: ["internal", "public"] }).notNull().default("internal"),
    includePainPoints: boolean("include_pain_points").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    viewCount: integer("view_count").notNull().default(0),
    lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("shares_user_idx").on(t.userId)],
);
