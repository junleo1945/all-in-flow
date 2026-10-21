import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";

/**
 * 用户的授权：平台代用户访问外部服务所需的凭据。目前只有用户添加的 MCP 服务。
 * secret 是加密后的密文（见 auth/secretBox.ts），任何接口都不会返回它。
 */
export const authorizations = pgTable(
  "authorizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: integer("user_id").notNull().references(() => users.id),
    kind: text("kind", { enum: ["mcp"] }).notNull(),
    name: text("name").notNull(),
    /** MCP 服务的完整地址 */
    url: text("url").notNull(),
    secret: text("secret").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("authorizations_user_idx").on(t.userId)],
);
