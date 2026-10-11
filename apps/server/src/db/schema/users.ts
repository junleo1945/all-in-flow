import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** 用户主键直接使用 ERP 的 UserId，不另外生成。 */
export const users = pgTable("users", {
  id: integer("id").primaryKey(),
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }).notNull().defaultNow(),
});
