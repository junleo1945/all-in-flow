import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export function createDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL 未配置");
  const sql = postgres(url, { max: 10 });
  return { sql, db: drizzle(sql, { schema }) };
}

export type Db = ReturnType<typeof createDb>["db"];
