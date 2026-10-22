import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";

/**
 * 个人访问令牌：用户在自己的本地 Agent（Claude Code、Codex 等）里调用平台 MCP 时使用。
 * 令牌明文只在创建时返回一次；库里只存 SHA-256 摘要（令牌本身是 256 位随机数，不需要加盐慢哈希）。
 */
export const accessTokens = pgTable(
  "access_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: integer("user_id").notNull().references(() => users.id),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    /** 令牌开头的几位，用于在列表里辨认是哪一个 */
    prefix: text("prefix").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("access_tokens_user_idx").on(t.userId)],
);
