import { bigint, date, integer, numeric, pgTable, primaryKey } from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const usageDaily = pgTable(
  "usage_daily",
  {
    userId: integer("user_id").notNull().references(() => users.id),
    day: date("day").notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
);
