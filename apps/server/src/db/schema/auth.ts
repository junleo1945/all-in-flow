import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users.js";

/** aif_sid 对应的服务端会话。erp_sid 仅保存在服务端，不返回给浏览器。 */
export const authSessions = pgTable(
  "auth_sessions",
  {
    sid: text("sid").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id),
    erpSid: text("erp_sid").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("auth_sessions_user_idx").on(t.userId)],
);
