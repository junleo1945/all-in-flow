import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { usageDaily } from "../db/schema/index.js";

export class QuotaExceeded extends Error {}

export const today = () => new Date().toISOString().slice(0, 10);

export interface UsageDelta {
  input: number;
  output: number;
  cacheRead: number;
  costUsd: number;
}

/** 累加当日用量（原子 upsert） */
export async function recordUsage(db: Db, userId: number, d: UsageDelta, day = today()) {
  await db
    .insert(usageDaily)
    .values({
      userId,
      day,
      inputTokens: d.input,
      outputTokens: d.output,
      cacheReadTokens: d.cacheRead,
      costUsd: d.costUsd.toFixed(6),
    })
    .onConflictDoUpdate({
      target: [usageDaily.userId, usageDaily.day],
      set: {
        inputTokens: sql`${usageDaily.inputTokens} + ${d.input}`,
        outputTokens: sql`${usageDaily.outputTokens} + ${d.output}`,
        cacheReadTokens: sql`${usageDaily.cacheReadTokens} + ${d.cacheRead}`,
        costUsd: sql`${usageDaily.costUsd} + ${d.costUsd.toFixed(6)}`,
      },
    });
}

export async function todayUsage(db: Db, userId: number, day = today()) {
  const [row] = await db
    .select()
    .from(usageDaily)
    .where(and(eq(usageDaily.userId, userId), eq(usageDaily.day, day)));
  const input = row?.inputTokens ?? 0;
  const output = row?.outputTokens ?? 0;
  return { tokens: input + output, costUsd: Number(row?.costUsd ?? 0) };
}

/** 全站当日花费 */
export async function todayTotalCost(db: Db, day = today()): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${usageDaily.costUsd}), 0)` })
    .from(usageDaily)
    .where(eq(usageDaily.day, day));
  return Number(row?.total ?? 0);
}

/** 对话前检查：个人配额、全站花费上限 */
export async function assertBudget(
  db: Db,
  userId: number,
  limits: { dailyTokenQuotaPerUser: number; dailyCostLimitUsd: number },
) {
  if (await todayTotalCost(db) >= limits.dailyCostLimitUsd) {
    throw new QuotaExceeded("今日全站用量已达上限，请明天再试");
  }
  const mine = await todayUsage(db, userId);
  if (mine.tokens >= limits.dailyTokenQuotaPerUser) {
    throw new QuotaExceeded("今日的 token 配额已用完，请明天再试");
  }
}
