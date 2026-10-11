import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/** 服务启动时执行迁移；迁移文件由 drizzle-kit generate 生成并提交到仓库。 */
export async function runMigrations(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL 未配置");
  const sql = postgres(url, { max: 1 });
  try {
    await migrate(drizzle(sql), {
      migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
    });
  } finally {
    await sql.end();
  }
}

// 直接运行：tsx src/db/migrate.ts
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runMigrations();
  console.log("migrations applied");
}
